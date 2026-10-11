/**
 * Offline rebuild of per-day token usage from stored session logs.
 *
 *   node scripts/rebuild-from-logs.mjs <sessions-root> [--from YYYY-MM-DD]
 *                                      [--ledger <usage-ledger.json>]
 *                                      [--write <cache-document>]
 *
 * WHY THIS EXISTS. The heatmap's folded history lives ONLY in
 * `<DSH_HOME>/storages/token-heatmap-cache.json`; by design the plugin never
 * re-reads stored logs (doing so stalls the endpoint on a large profile — see
 * the note in lib/index.js). So when that one document is lost or overwritten,
 * the history it carried is unrecoverable from the plugin's own state — but it
 * IS reproducible from the session logs, which are append-only and complete.
 *
 * This tool folds them offline and prints per-day totals, optionally
 * reconciling against the official dsh-usage ledger (an independent source) so
 * you can see exactly which days it can vouch for.
 *
 * FIDELITY, measured 2026-10-12 against `~/.dsh/dsh-usage/usage-ledger.json`:
 *   - 2026-09-26 onward: matches the ledger to the printed precision.
 *   - 2026-09-22..09-25: over-counts (fork markers in that era are not the
 *     `session/end-seed` shape this tool derives the cut from).
 *   - before 2026-09-13: under-counts (v3/v0 logs predate the usage-event
 *     shape this fold reads).
 * Use `--from` to restrict a rebuild to the range it can vouch for; days
 * outside it should keep whatever the cache already had.
 *
 * The fork cut is derived from the log, because the header line carries
 * `isSeeded` but NOT `inheritedEventCount`: DSH projects that count into the
 * log as the LAST `session/end-seed` event carrying `{ inherited: true }` (an
 * unmarked `session/end-seed` is a compaction boundary, not a fork cut).
 * Folding a fork's inherited prefix counts the parent's tokens twice —
 * measured 2026-09-14: 8.34e8 inflated to 13.15e8.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { applyUsageDelta, createUsageState, mergeInto, renderUsage, totalTokens } from "../lib/usage.js";
import { parseCacheDocument, serializeCacheDocument } from "../lib/cache.js";

/** Session log file names this tool folds, across every stored generation. */
const LOG_NAME = /^session(\.v\d+)?\.jsonl\.zstd$/;

/** Read one log's header line (the first line) without folding it. */
async function readHeader(path) {
	const rl = createInterface({ input: createReadStream(path).pipe(createZstdDecompress()), crlfDelay: Infinity });
	for await (const line of rl) {
		if (line.length === 0) continue;
		try {
			return JSON.parse(line);
		} catch {
			return null;
		}
	}
	return null;
}

/** Fork-inherited prefix length stored in a log, or 0 when it is not a fork. */
async function findForkCut(path) {
	const rl = createInterface({ input: createReadStream(path).pipe(createZstdDecompress()), crlfDelay: Infinity });
	let cut = 0;
	for await (const line of rl) {
		if (line.length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "session/end-seed" && event.data?.inherited === true && typeof event.seq === "number") cut = event.seq + 1;
	}
	return cut;
}

/**
 * Fold one log from `cut` onward.
 * @returns `{ state, header, nextSeq }` — `nextSeq` is one past the last seq
 *   seen, which is the cursor a live fold would continue from.
 */
async function foldLog(path, cut) {
	const state = createUsageState();
	const rl = createInterface({ input: createReadStream(path).pipe(createZstdDecompress()), crlfDelay: Infinity });
	let header = null;
	let nextSeq = 0;
	let batch = [];
	for await (const line of rl) {
		if (line.length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (header === null) {
			header = event;
			continue;
		}
		const index = typeof event.seq === "number" ? event.seq : nextSeq;
		nextSeq = Math.max(nextSeq, index + 1);
		if (index < cut) continue;
		batch.push(event);
		if (batch.length >= 4000) {
			applyUsageDelta(state, batch);
			batch = [];
		}
	}
	if (batch.length > 0) applyUsageDelta(state, batch);
	return { state, header, nextSeq };
}

/** Every session log under `root`, recursively. */
async function collectLogs(root, out = []) {
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) await collectLogs(path, out);
		else if (LOG_NAME.test(entry.name)) out.push(path);
	}
	return out;
}

/** Sum the official dsh-usage ledger into per-day totals. */
function ledgerTotals(ledger) {
	const days = new Map();
	for (const [date, providers] of Object.entries(ledger?.days ?? {})) {
		let sum = 0;
		for (const models of Object.values(providers)) {
			for (const stats of Object.values(models)) {
				sum += (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0) + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
			}
		}
		days.set(date, sum);
	}
	return days;
}

const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? void 0 : argv[index + 1];
};
const root = argv[0];
if (root === void 0 || root.startsWith("--")) {
	console.error("usage: node scripts/rebuild-from-logs.mjs <sessions-root> [--from YYYY-MM-DD] [--ledger <file>] [--write <cache-document>]");
	process.exit(2);
}
const fromDay = flag("--from");
const ledgerPath = flag("--ledger");
const writePath = flag("--write");

// A log whose newest event predates `fromDay` cannot contribute a rebuilt day,
// so it is skipped entirely — this is what keeps a full-profile pass cheap.
const mtimeFloor = fromDay === void 0 ? 0 : Date.parse(`${fromDay}T00:00:00+08:00`) - 24 * 3600 * 1000;

const logs = await collectLogs(root);
const selected = [];
for (const path of logs) {
	if (mtimeFloor === 0) {
		selected.push(path);
		continue;
	}
	const info = await stat(path);
	if (info.mtimeMs >= mtimeFloor) selected.push(path);
}

console.log(`logs: ${selected.length} of ${logs.length} selected${fromDay === void 0 ? "" : ` (--from ${fromDay})`}`);
const byDay = new Map();
const rebuilt = new Map();
let forked = 0;
let done = 0;
const started = Date.now();
for (const path of selected) {
	const header = await readHeader(path);
	if (header?.id === void 0) continue;
	const cut = header.isSeeded === true ? await findForkCut(path) : 0;
	if (cut > 0) forked += 1;
	const { state, nextSeq } = await foldLog(path, cut);
	rebuilt.set(header.id, { state, cut, nextSeq, cwd: header.cwd ?? "" });
	mergeInto(byDay, state.days);
	done += 1;
	if (done % 200 === 0) console.log(`  … ${done}/${selected.length} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

const rendered = renderUsage(byDay, Date.now());
// `--from` is an mtime PREFILTER: logs touched after it may still contain
// earlier days, so a day before `fromDay` is folded from only SOME logs and its
// total is partial. Such days are withheld rather than printed as if they were
// real, which is why `--from` also bounds the reported range.
const reportable = fromDay === void 0 ? rendered.days : rendered.days.filter((day) => day.date >= fromDay);
console.log(`\nfolded ${done} logs (${forked} forked) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (fromDay !== void 0 && reportable.length < rendered.days.length) {
	console.log(`withheld ${rendered.days.length - reportable.length} day(s) before ${fromDay} (partial: not every log was folded)`);
}
console.log("per-day totals:");
for (const day of reportable) console.log(`  ${day.date}  ${(day.tokens / 1e8).toFixed(2)}e8  models=${day.models.length}`);

if (ledgerPath !== void 0) {
	const official = ledgerTotals(JSON.parse(await readFile(ledgerPath, "utf8")));
	console.log(`\nvs ledger (${ledgerPath}):`);
	for (const day of reportable) {
		const reference = official.get(day.date);
		if (reference === void 0) continue;
		const delta = (day.tokens - reference) / 1e8;
		console.log(`  ${Math.abs(delta) < 0.05 ? "ok  " : "DIFF"} ${day.date}  rebuilt=${(day.tokens / 1e8).toFixed(2)}e8  ledger=${(reference / 1e8).toFixed(2)}e8  delta=${delta.toFixed(2)}e8`);
	}
}

if (writePath !== void 0) {
	// Overlay the rebuilt days onto an existing cache document, keeping days
	// the rebuild cannot vouch for (before `--from`) exactly as they were.
	const existing = parseCacheDocument(await readFile(writePath, "utf8"));
	if (existing === null) {
		console.error(`\nrefusing to write: ${writePath} is not a usable cache document`);
		process.exit(1);
	}
	const merged = { ...existing };
	let replaced = 0;
	let added = 0;
	for (const [id, fresh] of rebuilt) {
		const state = merged[id];
		if (state === void 0) {
			merged[id] = { ...fresh.state, kind: "live", skipUntil: fresh.cut, consumed: fresh.nextSeq };
			added += 1;
			continue;
		}
		const days = new Map();
		for (const [date, entry] of state.days) {
			if (fromDay === void 0 || date < fromDay) days.set(date, entry);
		}
		for (const [date, entry] of fresh.state.days) {
			if (fromDay === void 0 || date >= fromDay) days.set(date, entry);
		}
		merged[id] = { ...fresh.state, days, kind: "live", skipUntil: fresh.cut, consumed: fresh.nextSeq };
		replaced += 1;
	}
	// The rebuilt days are the COMPLETE log's result, which is strictly better
	// than re-folding whatever a process holds in memory, so these sessions are
	// marked `live` with the cursor that log ended at.
	const { writeFile } = await import("node:fs/promises");
	const stamp = `${process.pid}.${Date.now()}`;
	await writeFile(`${writePath}.${stamp}.tmp`, JSON.stringify(serializeCacheDocument(merged)), "utf8");
	await writeFile(writePath, JSON.stringify(serializeCacheDocument(merged)), "utf8");
	console.log(`\nwrote ${writePath}: ${Object.keys(merged).length} sessions (${replaced} replaced, ${added} added), snapshot at ${writePath}.${stamp}.tmp`);
}

// Keep the reference to `totalTokens` meaningful for readers of this tool.
void totalTokens;
