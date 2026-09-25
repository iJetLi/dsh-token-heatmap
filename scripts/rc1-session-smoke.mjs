/**
 * Regression for DSH 0.1.2+ (rc.1): live sessions no longer expose an
 * `.events` array — the event count is `session.seq` and each event is read
 * via `session.eventAt(seq)` (0-based, the reads @deepseek-ai/dsh-token-meter
 * uses). collectUsage must fold such sessions — and survive a
 * sessionPersistence that exposes no list()/listSnapshots() enumeration —
 * instead of throwing "Cannot read properties of undefined (reading
 * 'length')" on `session.events.length`.
 *
 * Runs against a throwaway DSH_HOME so the real cache file is untouched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, apply } from "../lib/index.js";

function localDay(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const now = Date.now();
const events = [
	{ seq: 1, time: now, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 2, time: now, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } },
	{ seq: 3, time: now, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 4, time: now, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 300, outputTokens: 100 } } }
];

const makeCtx = (sessions) => ({
	get: (name) => (name === "sessions" ? sessions : void 0),
	logger: { warn() {} }
});

const tmpHome = mkdtempSync(join(tmpdir(), "thm-rc1-"));
process.env.DSH_HOME = tmpHome;

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

try {
	// rc.1 session shape: seq + eventAt, no .events array; persistence absent
	// on this context (the enumeration/read shapes are covered below).
	const rc1Session = { id: "rc1-s1", seq: events.length, eventAt: (n) => events[n] };
	const rc1Ctx = makeCtx({ list: () => [rc1Session] });

	const first = await collectUsage(rc1Ctx);
	const day = localDay(now);
	const dayEntry = first.days.find((entry) => entry.date === day);
	check("rc.1 session folded without throwing", first.total === 2100, `total=${first.total}`);
	check("rc.1 day total", dayEntry !== void 0 && dayEntry.tokens === 2100, JSON.stringify(dayEntry));
	check("model attribution", dayEntry?.models?.[0]?.model === "deepseek-official/deepseek-v4-flash");

	// Incremental: a second pass over the same session must not double count.
	const second = await collectUsage(rc1Ctx);
	check("incremental fold does not double count", second.total === 2100, `total=${second.total}`);

	// Legacy session shape (.events array) still folds identically. The cache
	// is shared across calls (collectUsage aggregates every known session), so
	// the legacy session ADDS its own 2100 on top of the rc.1 session.
	const legacySession = { id: "legacy-s1", events };
	const legacy = await collectUsage(makeCtx({ list: () => [legacySession] }));
	check("legacy .events shape still folds", legacy.total === 4200, `total=${legacy.total}`);

	// A sessionPersistence WITHOUT enumeration must not break the call either,
	// and the unenumerable persisted sessions stay in the cache (not dropped).
	const rc1WithPersistence = {
		get: (name) => name === "sessions" ? { list: () => [rc1Session] }
			: name === "sessionPersistence" ? { readFrom: async () => ({ events: [] }) } : void 0,
		logger: { warn() {} }
	};
	const persistedOk = await collectUsage(rc1WithPersistence);
	check("persistence without enumeration is tolerated", persistedOk.total === 4200, `total=${persistedOk.total}`);

	/**
	 * Stored sessions are ENUMERATED but never READ.
	 *
	 * Both `sessionPersistence` spellings return the WHOLE log, so folding N
	 * stored sessions re-reads all of their history on every request. On a
	 * profile with hundreds of stored sessions and hundreds of MB of history
	 * that stalled the endpoint indefinitely and starved every other plugin in
	 * the same process. `dsh-usage` (设置 → 使用统计) never touches
	 * sessionPersistence at all and folds only the live `session/event` stream,
	 * which is why it stays instant on the same data — so this plugin does the
	 * same and keeps the ids from `list()` only to tell an existing stored
	 * session from a deleted one.
	 *
	 * These checks pin that contract: `list()` is called, no log is ever opened,
	 * and a stored session's already-folded days are preserved rather than
	 * dropped.
	 */
	async function persistedSmokeChecks() {
		const home = mkdtempSync(join(tmpdir(), "thm-persisted-"));
		process.env.DSH_HOME = home;
		try {
			const listed = [];
			const opened = [];
			const persistence = {
				list: async () => { listed.push("list"); return [{ header: { id: "stored-s1" }, revision: "rev-1" }]; },
				// Trap: reaching for a log is the regression this guards against.
				get open() { opened.push("open"); throw new Error("persisted logs must not be read"); },
				get readFrom() { opened.push("readFrom"); throw new Error("persisted logs must not be read"); }
			};
			const storedCtx = {
				get: (service) => (service === "sessionPersistence" ? persistence : void 0),
				logger: { warn() {} }
			};

			const first = await collectUsage(storedCtx);
			check("stored sessions are enumerated", listed.length > 0, `list calls=${listed.length}`);
			check("no stored log is ever opened", opened.length === 0, opened.join(","));
			check("enumerate-only run succeeds", first !== void 0 && typeof first.total === "number");

			// A second pass is equally cheap: ids only, still no log reads.
			await collectUsage(storedCtx);
			check("repeat run still reads no logs", opened.length === 0, opened.join(","));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	await persistedSmokeChecks();

	// ---- session/event real-time fold ---------------------------------
	// apply() registers a session/event listener that folds each event into
	// the cache in real time, so live session usage is captured regardless of
	// hero-screen mounting — the rc.1 primary path that needs no third-party
	// plugin and no sessionPersistence enumeration.
	const seHome = mkdtempSync(join(tmpdir(), "thm-se-"));
	process.env.DSH_HOME = seHome;
	const seListeners = [];
	apply({
		logger: { warn() {} },
		effect: (fn) => fn(),
		on: (name, handler) => { seListeners.push({ name, handler }); return () => {}; },
		get: (n) => (n === "sessions" ? { list: () => [] } : void 0),
		webServer: { register() {} },
		settings: { register() {} },
	});
	const seListener = seListeners.find((e) => e.name === "session/event");
	check("session/event listener registered", seListener !== void 0);
	const seTime = Date.UTC(2026, 0, 20, 10, 0, 0);
	seListener.handler({ id: "se-s1" }, { seq: 0, time: seTime, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "buddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100 } } });
	await new Promise((r) => setTimeout(r, 50));
	const seResult = await collectUsage({ get: () => void 0, logger: { warn() {} } });
	const seDay = seResult.days.find((d) => d.date === "2026-01-20");
	check("session/event folded into cache", seDay !== void 0 && seDay.tokens === 800, JSON.stringify(seDay));
	check("session/event model attribution", seDay?.models?.[0]?.model === "buddy/deepseek-v4.1-flash");
	rmSync(seHome, { recursive: true, force: true });

	// ---- forked sessions fold from their fork cut ----------------------
	// A forked session (header.isSeeded) opens with a copy of its PARENT's
	// events; `inheritedEventCount` is the exact cut. That prefix is folded
	// when the parent is folded, so a child folding from seq 0 counts the same
	// tokens twice (measured 2026-09-14: 13.15e8 instead of 8.34e8).
	const forkHome = mkdtempSync(join(tmpdir(), "thm-fork-"));
	process.env.DSH_HOME = forkHome;
	const fTime = Date.UTC(2026, 1, 3, 10, 0, 0);
	const fModel = { provider: "buddy", model: "deepseek-v4.1-flash" };
	const usageEvent = (seq, turn, inputTokens) => ({
		seq, time: fTime, type: "assistant/message",
		data: { turn, step: 0, message: { source: fModel }, usage: { inputTokens } }
	});
	// Parent: two own usage samples (1500 total).
	const parentEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: fModel } } },
		usageEvent(1, 0, 1000),
		usageEvent(2, 1, 500)
	];
	const parent = { id: "fork-parent", seq: parentEvents.length, eventAt: (n) => parentEvents[n] };
	// Child: inherits the parent's prefix (seq 0..1), marks the cut at seq 2,
	// then adds ONE own sample (700) — only that sample may be folded.
	const childEvents = [
		parentEvents[0],
		parentEvents[1],
		{ seq: 2, time: fTime, type: "session/end-seed", data: { inherited: true } },
		usageEvent(3, 2, 700)
	];
	const child = {
		id: "fork-child",
		header: { isSeeded: true },
		inheritedEventCount: 2,
		seq: childEvents.length,
		eventAt: (n) => childEvents[n]
	};
	const forkCtx = makeCtx({ list: () => [parent, child] });
	const forkResult = await collectUsage(forkCtx);
	const forkDay = forkResult.days.find((d) => d.date === "2026-02-03");
	// parent own 1500 + child own 700; a fold from seq 0 reports 3700 here.
	check("fork child does not re-fold the inherited prefix", forkDay !== void 0 && forkDay.tokens === 2200, JSON.stringify(forkDay));
	check("fork child keeps model attribution", forkDay?.models?.[0]?.model === "buddy/deepseek-v4.1-flash");
	// A second pass must not add the prefix back on top of the folded days.
	const forkAgain = await collectUsage(forkCtx);
	const forkDayAgain = forkAgain.days.find((d) => d.date === "2026-02-03");
	check("fork child stays stable across passes", forkDayAgain !== void 0 && forkDayAgain.tokens === 2200, JSON.stringify(forkDayAgain));

	// A RESUMED session is NOT a fork: its constructor seed is its own stored
	// history, so the whole log folds (isSeeded false → no cut). The unmarked
	// `session/end-seed` here is a compaction boundary and must not be read as
	// a fork cut.
	const resumedEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: fModel } } },
		{ seq: 1, time: fTime, type: "session/end-seed", data: {} },
		usageEvent(2, 0, 400)
	];
	const resumed = { id: "resumed-s1", header: { isSeeded: false }, seq: resumedEvents.length, eventAt: (n) => resumedEvents[n] };
	const resumedResult = await collectUsage(makeCtx({ list: () => [resumed] }));
	const resumedDay = resumedResult.days.find((d) => d.date === "2026-02-03");
	// 2200 (fork) + this session's own 400; a bogus cut would drop it to 2200.
	check("resumed session folds its whole own log", resumedDay !== void 0 && resumedDay.tokens === 2600, JSON.stringify(resumedDay));
	rmSync(forkHome, { recursive: true, force: true });

	// ---- stored sessions are enumerated, never read ----------------------
	// Reading a stored log returns the WHOLE log, so this plugin enumerates ids
	// only — enough to keep a session that still exists from being evicted as
	// "vanished", without paying the read. The fork-cut semantics above stay
	// covered through the live path, which is the only path that folds logs.
	const storedHome = mkdtempSync(join(tmpdir(), "thm-stored-"));
	process.env.DSH_HOME = storedHome;
	const listedIds = [];
	const openedIds = [];
	const storedPersistence = {
		list: async () => { listedIds.push("list"); return [{ header: { id: "stored-keep-s1" }, revision: "rev-1" }]; },
		get open() { openedIds.push("open"); throw new Error("stored logs must not be read"); },
		get readFrom() { openedIds.push("readFrom"); throw new Error("stored logs must not be read"); }
	};
	const storedRun = await collectUsage({
		get: (service) => (service === "sessionPersistence" ? storedPersistence : void 0),
		logger: { warn() {} }
	});
	check("stored session ids are enumerated", listedIds.length > 0, `list calls=${listedIds.length}`);
	check("stored logs are never read", openedIds.length === 0, openedIds.join(","));
	check("enumerate-only fold returns a result", storedRun !== void 0 && typeof storedRun.total === "number");
	rmSync(storedHome, { recursive: true, force: true });
} finally {
	rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\nrc.1 session shape smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
