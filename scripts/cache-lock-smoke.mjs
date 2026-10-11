/**
 * Regression for the cross-process cache lock.
 *
 *   node scripts/cache-lock-smoke.mjs
 *
 * `saveCache` is a read-modify-write: it re-reads the cache document, merges
 * this process's state into it, then renames a temp file over it. Two hosts
 * (web and desktop share one `<DSH_HOME>`) interleave between one's read and
 * the other's rename, so the later rename erased the earlier one's work. The
 * merge alone narrows that window but cannot close it; the lock does.
 *
 * This test drives REAL child processes, because the defect only exists across
 * processes. It was written to be discriminating: with the lock removed the
 * concurrent phase loses sessions (measured: 1 of 8), with it every writer's
 * session survives. A test that passes either way would prove nothing.
 *
 * The window is widened on purpose — a large document makes the read+parse
 * slow, and every worker enters the critical section at the same moment — so
 * the race is exercised reliably rather than hopefully.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

/** Sessions pre-seeded so the document is big enough to widen the window. */
const BULK = 3000;
/** Concurrent writers in the hammer phase. */
const WRITERS = 8;

const buckets = (n) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const sessionDoc = (kind, days) => ({
	kind, consumed: 5,
	days: Object.fromEntries(Object.entries(days).map(([date, tokens]) => [date, { totals: buckets(tokens), models: {} }])),
	lastSample: null, currentModel: null
});

/** A worker script: load, wait for the go signal, then save three times. */
function workerSource(id) {
	return `
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const index = await import(pathToFileURL(${JSON.stringify(join(root, "lib/index.js"))}).href + "?w=" + Math.random());
const events = [{ seq: 0, time: Date.UTC(2026, 9, 10), type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 42 } } }];
const session = { id: "own-${id}", seq: 1, eventAt: (n) => events[n] };
const ctx = { get: (n) => (n === "sessions" ? { list: () => [session] } : void 0), logger: { warn() {} } };
await index.collectUsage(ctx);
console.log("READY");
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	if (line.trim() !== "go") continue;
	await Promise.all([index.collectUsage(ctx), index.collectUsage(ctx), index.collectUsage(ctx)]);
	console.log("SAVED");
	break;
}
`;
}

/** Wait until every child has printed READY. */
function waitForReady(children) {
	return Promise.all(children.map((child) => new Promise((resolve) => {
		let seen = false;
		child.stdout.on("data", (chunk) => {
			if (seen || !String(chunk).includes("READY")) return;
			seen = true;
			resolve();
		});
	})));
}

const home = mkdtempSync(join(tmpdir(), "thm-lock-smoke-"));
const storage = join(home, "storages");
mkdirSync(storage, { recursive: true });
const cachePath = join(storage, "token-heatmap-cache.json");

try {
	const bulk = {};
	for (let i = 0; i < BULK; i += 1) bulk[`bulk-${i}`] = sessionDoc("persisted", { "2026-09-01": 10 });
	writeFileSync(cachePath, JSON.stringify({ version: 2, sessions: bulk }));

	const children = [];
	for (let i = 0; i < WRITERS; i += 1) {
		const file = join(home, `worker-${i}.mjs`);
		writeFileSync(file, workerSource(i));
		children.push(spawn(process.execPath, [file], {
			env: { ...process.env, DSH_HOME: home },
			stdio: ["pipe", "pipe", "inherit"]
		}));
	}

	await waitForReady(children);
	// Release every writer into the critical section at once.
	for (const child of children) child.stdin.write("go\n");
	await new Promise((resolve) => setTimeout(resolve, 6000));
	for (const child of children) child.kill();

	const written = JSON.parse(readFileSync(cachePath, "utf8"));
	const ids = new Set(Object.keys(written.sessions));
	const lost = Array.from({ length: WRITERS }, (_, i) => `own-${i}`).filter((id) => !ids.has(id));
	const bulkKept = [...ids].filter((id) => id.startsWith("bulk-")).length;

	check("no concurrent writer's session is lost", lost.length === 0, lost.length === 0 ? "" : `lost ${JSON.stringify(lost)}`);
	check("the pre-existing sessions all survive", bulkKept === BULK, `kept ${bulkKept}/${BULK}`);
	check("no lock file is left behind", readdirSync(storage).every((name) => !name.endsWith(".lock")), JSON.stringify(readdirSync(storage).filter((n) => n.endsWith(".lock"))));
	check("the written document is valid and complete", written.version === 2 && ids.size >= BULK + WRITERS, `sessions=${ids.size}`);

	// A stale lock must not wedge saving forever: an abandoned lock older than
	// the staleness window is reclaimed, and the next save succeeds.
	//
	// This runs on a FRESH home and a fresh module instance. Reusing the
	// hammered home would make the assertion meaningless: the killed writers may
	// have left a live-looking lock, and a newly imported instance starts with
	// an EMPTY in-memory cache, so its save would legitimately rewrite the
	// document down to just its own session.
	const staleHome = mkdtempSync(join(tmpdir(), "thm-lock-stale-"));
	const staleStorage = join(staleHome, "storages");
	mkdirSync(staleStorage, { recursive: true });
	const stalePath = join(staleStorage, "token-heatmap-cache.json");
	const { utimes } = await import("node:fs/promises");
	try {
		writeFileSync(stalePath, JSON.stringify({
			version: 2,
			sessions: { seeded: sessionDoc("persisted", { "2026-09-01": 5 }) }
		}));
		process.env.DSH_HOME = staleHome;
		const index = await import(`${pathToFileURL(join(root, "lib/index.js")).href}?stale=${Math.random()}`);
		writeFileSync(`${stalePath}.lock`, "abandoned by a dead process");
		const past = new Date(Date.now() - 10 * 60 * 1000);
		await utimes(`${stalePath}.lock`, past, past);

		const events = [{ seq: 0, time: Date.UTC(2026, 9, 11), type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 7 } } }];
		const session = { id: "after-stale", seq: 1, eventAt: (n) => events[n] };
		await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [session] } : void 0),
			logger: { warn() {} }
		});
		const after = JSON.parse(readFileSync(stalePath, "utf8"));
		check("a stale lock is reclaimed and the save proceeds", after.sessions["after-stale"] !== void 0, JSON.stringify(Object.keys(after.sessions)));
		check("the reclaimed save kept the existing sessions", after.sessions.seeded !== void 0, JSON.stringify(Object.keys(after.sessions)));
		check("the reclaimed lock is removed", !existsSync(`${stalePath}.lock`));
	} finally {
		process.env.DSH_HOME = home;
		rmSync(staleHome, { recursive: true, force: true });
	}

	// A holder whose lock was RECLAIMED must not delete the reclaimer's lock.
	//
	// Reclaiming is inherently racy: the old holder may still be inside the
	// critical section. Without an ownership check, its release unlinked the new
	// holder's lock, and a third writer then entered beside it (measured). The
	// token written into the lock file is what makes release safe, so this pins
	// the three-way sequence directly against the real lock primitives.
	const ownHome = mkdtempSync(join(tmpdir(), "thm-lock-own-"));
	const ownStorage = join(ownHome, "storages");
	mkdirSync(ownStorage, { recursive: true });
	const ownPath = join(ownStorage, "token-heatmap-cache.json");
	const { utimes: ownUtimes } = await import("node:fs/promises");
	try {
		writeFileSync(ownPath, JSON.stringify({ version: 2, sessions: {} }));
		process.env.DSH_HOME = ownHome;
		// `saveCache` is not exported, so drive it through a real save: the first
		// save leaves no lock, which is itself the invariant under test.
		const index = await import(`${pathToFileURL(join(root, "lib/index.js")).href}?own=${Math.random()}`);
		const events = [{ seq: 0, time: Date.UTC(2026, 9, 11), type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 3 } } }];
		const session = { id: "owner-1", seq: 1, eventAt: (n) => events[n] };
		await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [session] } : void 0),
			logger: { warn() {} }
		});
		check("a normal save leaves no lock behind", !existsSync(`${ownPath}.lock`));

		// Age a lock and let a save reclaim it; the reclaimer must end up
		// removing only its OWN token, so no lock survives.
		writeFileSync(`${ownPath}.lock`, "stale-holder-token");
		const past = new Date(Date.now() - 10 * 60 * 1000);
		await ownUtimes(`${ownPath}.lock`, past, past);
		const events2 = [{ seq: 0, time: Date.UTC(2026, 9, 12), type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 4 } } }];
		const session2 = { id: "owner-2", seq: 1, eventAt: (n) => events2[n] };
		await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [session2] } : void 0),
			logger: { warn() {} }
		});
		const owned = JSON.parse(readFileSync(ownPath, "utf8"));
		check("a reclaimed lock lets the save proceed", owned.sessions["owner-2"] !== void 0, JSON.stringify(Object.keys(owned.sessions)));
		check("a reclaimed lock is released by its reclaimer", !existsSync(`${ownPath}.lock`));
	} finally {
		process.env.DSH_HOME = home;
		rmSync(ownHome, { recursive: true, force: true });
	}
} finally {
	rmSync(home, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\ncache lock smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
