/**
 * Regression for cache recovery — the heatmap's folded history lives ONLY in
 * `<DSH_HOME>/storages/token-heatmap-cache.json`, so one bad overwrite erased
 * 49 days of it (measured 2026-10-08: 590 folded sessions / 380 KB replaced by
 * 8 live sessions / 4 days). Two independent defects are pinned here:
 *
 *   1. Startup recovery. A failed `rename` strands each write as a
 *      `<cache>.<pid>.<ms>.tmp` snapshot holding the COMPLETE previous
 *      document; the loader now merges the live document, the pre-overwrite
 *      `.bak`, and every same-version snapshot into the most complete copy of
 *      each session, instead of silently starting from an empty cache.
 *   2. Cursor gap. A session resumed after the cache was rebuilt (or after a
 *      repair) publishes live events at a seq far past the folded cursor;
 *      folding only the new event and then jumping the cursor over the gap
 *      skipped that history FOR GOOD (measured 2026-10-11: session 7815c4ab
 *      had 9151 of its 9152 events marked consumed while its folded days
 *      covered only the last two).
 *
 * Every scenario runs against a throwaway DSH_HOME, and each one imports its
 * own module instance because `loadedCache` is process-global and must be
 * loaded once per scenario.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cache from "../lib/cache.js";
import * as usage from "../lib/usage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexUrl = pathToFileURL(join(root, "lib/index.js")).href;

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

/** A fresh module instance: `loadedCache` is loaded once per process. */
const loadIndex = (scenario) => import(`${indexUrl}?scenario=${scenario}`);

const buckets = (inputTokens) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** One session entry of a cache document, in the on-disk shape. */
const sessionDoc = ({ kind = "live", consumed = 0, skipUntil = 0, days = {} }) => ({
	kind,
	consumed,
	...(skipUntil === 0 ? {} : { skipUntil }),
	days: Object.fromEntries(Object.entries(days).map(([date, tokens]) => [date, { totals: buckets(tokens), models: {} }])),
	lastSample: null,
	currentModel: null
});

const homes = [];
function freshHome(prefix) {
	const home = mkdtempSync(join(tmpdir(), prefix));
	homes.push(home);
	process.env.DSH_HOME = home;
	mkdirSync(join(home, "storages"), { recursive: true });
	return { home, cachePath: join(home, "storages", "token-heatmap-cache.json") };
}

const silentCtx = () => ({ get: () => void 0, logger: { warn() {} } });

try {
	// ---------------------------------------------------- cache.js (pure)
	console.log("cache.js");
	check("merging nothing yields nothing", Object.keys(cache.mergeCacheDocuments([])).length === 0);
	check("a foreign version is refused", cache.parseCacheDocument(JSON.stringify({ version: 1, sessions: { a: {} } })) === null);
	check("torn JSON is refused", cache.parseCacheDocument("{not json") === null);
	check("a document without sessions is refused", cache.parseCacheDocument(JSON.stringify({ version: 2 })) === null);
	const roundTrip = cache.parseCacheDocument(JSON.stringify({ version: 2, sessions: { s1: sessionDoc({ consumed: 7, days: { "2026-10-01": 900 } }) } }));
	check("a document round-trips", roundTrip !== null && roundTrip.s1.consumed === 7 && roundTrip.s1.days.get("2026-10-01").totals.inputTokens === 900);
	// Two copies of one session, each covering days the other never saw: the
	// wider one wins the cursor, the days are the union of both.
	const olderCopy = cache.parseCacheDocument(JSON.stringify({ version: 2, sessions: { s1: sessionDoc({ kind: "live", consumed: 2, days: { "2026-10-01": 900, "2026-10-02": 100 } }) } })).s1;
	const newerCopy = cache.parseCacheDocument(JSON.stringify({ version: 2, sessions: { s1: sessionDoc({ kind: "live", consumed: 9, days: { "2026-10-03": 500, "2026-10-04": 600, "2026-10-05": 700 } }) } })).s1;
	const once = cache.mergeCacheDocuments([{ s1: olderCopy }, { s1: newerCopy }]);
	check("the wider record wins the cursor", once.s1.consumed === 9, `consumed=${once.s1.consumed}`);
	check("days are the union of both copies", once.s1.days.size === 5, `days=${once.s1.days.size}`);
	check("a widened union is marked for refold", once.s1.kind === "merged", `kind=${once.s1.kind}`);
	const twice = cache.mergeCacheDocuments([once]);
	check("the merge is idempotent", twice.s1.days.size === 5 && twice.s1.consumed === 9 && twice.s1.kind === "merged");

	// Malformed documents must never throw: the loader feeds this function
	// whatever it finds on disk, including hand-edited and torn files.
	const malformed = [
		"", "null", "[]", "0", '"str"', "{}", '{"version":2}', '{"version":2,"sessions":null}',
		'{"version":2,"sessions":[]}', '{"version":"2","sessions":{}}', '{"sessions":{}}',
		'{"version":2,"sessions":{"a":null}}', '{"version":2,"sessions":{"":{}}}',
		'{"version":2,"sessions":{"a":{"days":null}}}', '{"version":2,"sessions":{"a":{"days":[]}}}',
		'{"version":2,"sessions":{"a":{"days":{"2026-01-01":null}}}}',
		'{"version":2,"sessions":{"a":{"days":{"2026-01-01":{"totals":"x"}}}}}',
		'{"version":2,"sessions":{"a":{"consumed":-1,"skipUntil":99999,"lastSample":{"key":1,"day":2}}}}',
		'{"version":2,"sessions":{"a":{"consumed":1.5,"currentModel":{}}}}',
		'{"version":2,"sessions":{"a":{"days":{},"lastSample":{"key":"k","day":"d","model":"m","buckets":null}}}}'
	];
	let malformedThrew = 0;
	for (const raw of malformed) {
		try {
			cache.parseCacheDocument(raw);
		} catch (error) {
			malformedThrew += 1;
			console.error(`    threw on ${raw.slice(0, 50)}: ${String(error)}`);
		}
	}
	check("malformed documents never throw", malformedThrew === 0, `threw=${malformedThrew}`);
	check("merging malformed-derived documents never throws", (() => {
		try {
			cache.mergeCacheDocuments(malformed.map((raw) => cache.parseCacheDocument(raw)).filter((parsed) => parsed !== null));
			return true;
		} catch {
			return false;
		}
	})());
	// Two finite 1e308 buckets sum past Number.MAX_VALUE; the accumulators clamp
	// so a corrupt document cannot turn every later total into Infinity.
	const big = cache.parseCacheDocument('{"version":2,"sessions":{"a":{"days":{"2026-01-01":{"totals":{"inputTokens":1e308,"outputTokens":1e308}}}}}}');
	const big2 = cache.parseCacheDocument('{"version":2,"sessions":{"a":{"days":{"2026-01-02":{"totals":{"inputTokens":1e308,"outputTokens":1e308}}}}}}');
	const bigDays = new Map();
	for (const state of Object.values(cache.mergeCacheDocuments([big, big2]))) usage.mergeInto(bigDays, state.days);
	const bigRendered = usage.renderUsage(bigDays, Date.now());
	check("an overflowing sum stays finite", bigRendered.days.every((day) => Number.isFinite(day.tokens)) && Number.isFinite(bigRendered.total), `total=${bigRendered.total}`);
	check("clamped buckets stay non-negative", bigRendered.days.every((day) => day.inputTokens >= 0 && day.inputTokens <= 1e15), JSON.stringify(bigRendered.days.map((day) => day.inputTokens)));

	// ------------------------------------------- A: startup recovery
	console.log("startup recovery");
	{
		const index = await loadIndex("a");
		const { cachePath } = freshHome("thm-recover-a-");
		// The live document only knows the newest day of `live-a`.
		writeFileSync(cachePath, JSON.stringify({
			version: 2,
			sessions: {
				"live-a": sessionDoc({ kind: "live", consumed: 9151, days: { "2026-10-10": 500 } }),
				"live-only": sessionDoc({ kind: "live", consumed: 3, days: { "2026-10-09": 70 } })
			}
		}));
		// A snapshot stranded by a failed rename still holds 49 days of history.
		writeFileSync(`${cachePath}.31372.1791346952592.tmp`, JSON.stringify({
			version: 2,
			sessions: {
				"live-a": sessionDoc({ kind: "live", consumed: 3926, days: { "2026-10-03": 1000, "2026-10-04": 2000 } }),
				"stored-b": sessionDoc({ kind: "persisted", consumed: 10, days: { "2026-09-10": 4000 } })
			}
		}));

		const usage = await index.collectUsage(silentCtx());
		const byDate = new Map(usage.days.map((entry) => [entry.date, entry.tokens]));
		check("a snapshot-only session is recovered", byDate.get("2026-09-10") === 4000, JSON.stringify([...byDate]));
		check("a snapshot-only day of a shared session is recovered", byDate.get("2026-10-03") === 1000 && byDate.get("2026-10-04") === 2000, JSON.stringify([...byDate]));
		check("a day only the live document had is kept", byDate.get("2026-10-10") === 500, JSON.stringify([...byDate]));
		check("a live-only session is kept", byDate.get("2026-10-09") === 70, JSON.stringify([...byDate]));
		check("days from both documents are all rendered", usage.days.length === 5, `days=${usage.days.length}`);
		check("totals add up across the merge", usage.total === 7570, `total=${usage.total}`);

		const written = JSON.parse(readFileSync(cachePath, "utf8"));
		check("the recovery is written back", written.version === 2 && written.sessions["stored-b"] !== void 0);
		check("a widened record is marked for refold", written.sessions["live-a"].kind === "merged", JSON.stringify(written.sessions["live-a"]).slice(0, 120));
		check("the winning cursor is kept for the refold", written.sessions["live-a"].consumed === 3926, `consumed=${written.sessions["live-a"].consumed}`);
		check("an untouched record keeps its kind", written.sessions["live-only"].kind === "live");
	}

	// ------------------------------ B: torn document + foreign snapshot
	console.log("torn document");
	{
		const index = await loadIndex("b");
		const { cachePath } = freshHome("thm-recover-b-");
		writeFileSync(cachePath, "{ this document is torn");
		writeFileSync(`${cachePath}.999.1.tmp`, JSON.stringify({
			version: 2,
			sessions: { "stored-c": sessionDoc({ kind: "persisted", days: { "2026-09-20": 1234 } }) }
		}));
		// A version-1 document is refused: its days may hold a forked child's
		// inherited prefix, which version 2 folds only under the parent.
		writeFileSync(`${cachePath}.888.1.tmp`, JSON.stringify({
			version: 1,
			sessions: { "double-counted": sessionDoc({ kind: "persisted", days: { "2026-09-21": 9999 } }) }
		}));

		const usage = await index.collectUsage(silentCtx());
		const byDate = new Map(usage.days.map((entry) => [entry.date, entry.tokens]));
		check("a torn document is quarantined, not overwritten", existsSync(`${cachePath}.corrupt`));
		check("history is recovered from the snapshot", byDate.get("2026-09-20") === 1234, JSON.stringify([...byDate]));
		check("a foreign-version snapshot is not merged", byDate.get("2026-09-21") === void 0, JSON.stringify([...byDate]));
		const rewritten = JSON.parse(readFileSync(cachePath, "utf8"));
		check("the recovered document is valid", rewritten.version === 2 && rewritten.sessions["stored-c"] !== void 0);
	}

	// ------------------------------------------------ C: eviction guard
	console.log("eviction guard");
	{
		const stored = ["stored-1", "stored-2", "stored-3", "stored-4", "stored-5"];
		const seededDoc = () => JSON.stringify({
			version: 2,
			sessions: Object.fromEntries(stored.map((id, index2) => [
				id,
				sessionDoc({ kind: "persisted", days: { [`2026-09-0${index2 + 1}`]: 100 } })
			]))
		});

		/**
		 * Eviction requires that THIS process saw a session before it may
		 * conclude the session is gone, so every scenario here first runs a pass
		 * whose live `sessions` list contains the ids, then a pass where they
		 * have disappeared.
		 * @param id - scenario tag, for a fresh module instance.
		 * @param persistence - the backend to drive both passes with.
		 * @param liveIds - ids the first pass reports as live sessions.
		 */
		const runEviction = async (id, persistence, liveIds = stored) => {
			const index = await loadIndex(id);
			const { cachePath } = freshHome(`thm-recover-${id}-`);
			writeFileSync(cachePath, seededDoc());
			const mkCtx = (ids) => ({
				get: (name) => (name === "sessionPersistence" ? persistence : name === "sessions" ? { list: () => ids.map((sessionId) => ({ id: sessionId, seq: 0, eventAt: () => void 0 })) } : void 0),
				logger: { warn() {} }
			});
			await index.collectUsage(mkCtx(liveIds));
			return { index, cachePath, mkCtx };
		};

		// A backend that lists nothing AND has no stat() must not evict: the
		// cache is the only carrier of those sessions' history.
		{
			const { index, mkCtx } = await runEviction("blind", { list: async () => [] });
			const kept = await index.collectUsage(mkCtx([]));
			check("an enumeration that proves nothing does not evict history", kept.days.length === 5, `days=${kept.days.length}`);
		}

		// An EMPTY enumeration disables eviction even when stat() would answer:
		// "this backend sees nothing" is far more likely an unusable view (a
		// fresh process, a different storage root) than "every session was
		// deleted". Measured 2026-10-12: a fresh process listed nothing while
		// the cache held 807 sessions of real history.
		{
			const emptyListProbes = [];
			const persistence = {
				list: async () => [],
				stat: async (id) => { emptyListProbes.push(id); return void 0; }
			};
			const { index, mkCtx } = await runEviction("emptylist", persistence);
			emptyListProbes.length = 0;
			const keptOnEmptyList = await index.collectUsage(mkCtx([]));
			check("an empty enumeration evicts nothing", keptOnEmptyList.days.length === 5, `days=${keptOnEmptyList.days.length}`);
			check("an empty enumeration does not even probe", emptyListProbes.length === 0, JSON.stringify(emptyListProbes));
		}

		// `list()` omits a session but `stat()` finds it: it is a HISTORICAL
		// format the current build's list() skips (measured 2026-10-12: 195 of
		// 805 stored sessions, exactly the oldest days), so it must be kept.
		{
			const probed = [];
			const persistence = {
				list: async () => stored.slice(0, 4).map((id) => ({ header: { id } })),
				stat: async (id) => { probed.push(id); return { header: { id } }; }
			};
			const { index, mkCtx } = await runEviction("historical", persistence);
			probed.length = 0;
			const survived = await index.collectUsage(mkCtx([]));
			check("a session stat() still finds is kept", survived.days.length === 5, `days=${survived.days.length}`);
			check("only the unlisted session is probed", probed.length === 1 && probed[0] === "stored-5", JSON.stringify(probed));
		}

		// `stat()` reporting absence, for a session this process HAD seen, is the
		// only accepted proof — and it is the intended eviction.
		{
			const persistence = {
				list: async () => stored.slice(0, 4).map((id) => ({ header: { id } })),
				stat: async () => void 0
			};
			const { index, mkCtx } = await runEviction("gone", persistence);
			const after = await index.collectUsage(mkCtx([]));
			check("a session stat() cannot find is evicted", after.days.length === 4, `days=${after.days.length}`);
		}

		// A session this process never saw is NEVER evictable, however narrow the
		// backend's view is: that record may have been folded by another process
		// whose storage view this one does not share. Measured: 800 sessions
		// written by one process were evicted in four passes by another whose
		// backend simply could not see them.
		{
			const persistence = {
				list: async () => [{ header: { id: "stored-1" } }],
				stat: async () => void 0
			};
			const { index, mkCtx } = await runEviction("foreign", persistence, []);
			const kept = await index.collectUsage(mkCtx([]));
			check("a session this process never saw is not evictable", kept.days.length === 5, `days=${kept.days.length}`);
		}

		// A throwing probe proves nothing either, so no history is dropped.
		{
			const persistence = {
				list: async () => [{ header: { id: "stored-1" } }],
				stat: async () => { throw new Error("duplicate id across project directories"); }
			};
			const { index, mkCtx } = await runEviction("failing", persistence);
			const resilient = await index.collectUsage(mkCtx([]));
			check("a failing probe keeps the history", resilient.days.length === 5, `days=${resilient.days.length}`);
		}

		// An eviction must SURVIVE the recovery path. Proving a session gone
		// removes it from the live document, but the next save copies the
		// document that still had it to `<cache>.bak`, and a later startup's
		// merge reads it back — measured: A evicted a session, a fresh B loaded
		// and saved, and the session returned. The tombstone is what makes the
		// decision outlast the copies that disagree with it.
		{
			const { index, cachePath, mkCtx } = await runEviction("resurrect", {
				list: async () => stored.slice(0, 4).map((id) => ({ header: { id } })),
				stat: async () => void 0
			});
			const evictedRun = await index.collectUsage(mkCtx([]));
			check("the eviction took effect", evictedRun.days.length === 4, `days=${evictedRun.days.length}`);

			// A FRESH module instance, exactly like a process restart: it must not
			// resurrect the session from the backup or a snapshot.
			const restarted = await loadIndex("resurrect-restart");
			const afterRestart = await restarted.collectUsage(mkCtx([]));
			check("a restart does not resurrect an evicted session", afterRestart.days.length === 4, `days=${afterRestart.days.length}`);
			const doc = JSON.parse(readFileSync(cachePath, "utf8"));
			check("the evicted session stays out of the document", doc.sessions["stored-5"] === void 0, JSON.stringify(Object.keys(doc.sessions)));
		}
	}

	// ------------------------------- E: a refold must not drop recovered days
	console.log("refold keeps recovered days");
	{
		// A startup merge can put days into a session's state that this
		// process's in-memory log does NOT cover (truncated, compacted, or just
		// a short live tail). Refolding used to clear `days` outright and then
		// read a SHORTER span than it deleted — measured: a snapshot's
		// 2026-09-01/09-02 (10000 tokens) vanished the moment the live session
		// was refolded, leaving only the 333 the log could reproduce.
		const index = await loadIndex("e");
		const { cachePath } = freshHome("thm-recover-e-");
		writeFileSync(cachePath, JSON.stringify({
			version: 2,
			sessions: {
				"live-x": sessionDoc({ kind: "live", consumed: 900, days: { "2026-10-10": 500 } })
			}
		}));
		writeFileSync(`${cachePath}.111.1.tmp`, JSON.stringify({
			version: 2,
			sessions: {
				"live-x": sessionDoc({ kind: "live", consumed: 10, days: { "2026-09-01": 7000, "2026-09-02": 3000 } })
			}
		}));

		const day = Date.UTC(2026, 9, 10);
		const events = [
			{ seq: 0, time: day, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 111 } } },
			{ seq: 1, time: day, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 222 } } }
		];
		const session = { id: "live-x", seq: events.length, eventAt: (n) => events[n] };
		const usage = await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [session] } : void 0),
			logger: { warn() {} }
		});
		const byDate = new Map(usage.days.map((entry) => [entry.date, entry.tokens]));
		check("a recovered day the live log cannot reproduce survives the refold", byDate.get("2026-09-01") === 7000, JSON.stringify([...byDate]));
		check("the second recovered day survives too", byDate.get("2026-09-02") === 3000, JSON.stringify([...byDate]));
		// The shared day must NOT be doubled: the refold reads the log, so its
		// result REPLACES the recovered value rather than being added to it.
		// (Which of the two is kept is the next check's subject.)
		check("a day the refold does reproduce is not doubled", byDate.get("2026-10-10") <= 500, JSON.stringify([...byDate]));
	}

	// ------------------- E2: a merge must keep the LARGER value of one day
	console.log("merge keeps the larger value of a shared day");
	{
		// The winner is chosen by BREADTH, so a record can win while knowing less
		// about one particular day. Measured: a snapshot whose only day was 7000
		// lost to a live record covering three days, and taking the winner's 500
		// for that shared day silently shrank history by 6500.
		const index = await loadIndex("e2");
		const { cachePath } = freshHome("thm-recover-e2-");
		const DAY = "2026-10-10";
		writeFileSync(cachePath, JSON.stringify({
			version: 2,
			sessions: {
				// WIDER (three days) but knows only 500 of DAY.
				"s1": sessionDoc({ kind: "live", consumed: 100, days: { [DAY]: 500, "2026-10-08": 10, "2026-10-07": 10 } })
			}
		}));
		writeFileSync(`${cachePath}.111.1.tmp`, JSON.stringify({
			version: 2,
			sessions: {
				// NARROWER, but knows DAY in full: 7000.
				"s1": sessionDoc({ kind: "live", consumed: 100, days: { [DAY]: 7000 } })
			}
		}));

		// No live session at all, so nothing refolds and the merge result is
		// what the UI renders.
		const usage = await index.collectUsage({ get: () => void 0, logger: { warn() {} } });
		const byDate = new Map(usage.days.map((entry) => [entry.date, entry.tokens]));
		check("a shared day keeps the larger value", byDate.get(DAY) === 7000, JSON.stringify([...byDate]));
		check("the narrower record's extra days are not lost either", byDate.get("2026-10-08") === 10 && byDate.get("2026-10-07") === 10, JSON.stringify([...byDate]));
	}

	// ------------------------- F: saving must not erase another process's work
	console.log("save merges the disk document");
	{
		// web and desktop share one DSH_HOME, so each process's in-memory map is
		// only its own view. Writing it blindly erased the other's history —
		// measured with two processes: B loads a 4-day cache, A writes 53 days,
		// B saves again and A's 53 days are gone.
		const index = await loadIndex("f");
		const { cachePath } = freshHome("thm-recover-f-");
		writeFileSync(cachePath, JSON.stringify({
			version: 2,
			sessions: {
				"from-other-process": sessionDoc({ kind: "persisted", consumed: 5, days: { "2026-09-01": 5000, "2026-09-02": 6000 } }),
				"own-session": sessionDoc({ kind: "live", consumed: 5, days: { "2026-10-10": 111 } })
			}
		}));

		const day = Date.UTC(2026, 9, 10);
		const events = [
			{ seq: 0, time: day, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 42 } } }
		];
		const session = { id: "own-session", seq: 1, eventAt: (n) => events[n] };
		const usage = await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [session] } : void 0),
			logger: { warn() {} }
		});
		const byDate = new Map(usage.days.map((entry) => [entry.date, entry.tokens]));
		check("another process's days are not erased by this save", byDate.get("2026-09-01") === 5000 && byDate.get("2026-09-02") === 6000, JSON.stringify([...byDate]));
		const written = JSON.parse(readFileSync(cachePath, "utf8"));
		check("the other process's sessions are persisted", written.sessions["from-other-process"] !== void 0, JSON.stringify(Object.keys(written.sessions)));
	}

	// ------------------------------------------------ D: cursor gap
	console.log("cursor gap");
	{
		const index = await loadIndex("d");
		freshHome("thm-recover-c-");
		const listeners = [];
		index.apply({
			logger: { warn() {} },
			effect: (fn) => fn(),
			on: (name, handler) => { listeners.push({ name, handler }); return () => {}; },
			// No live session is known at startup, exactly like a host that came
			// up before the session was resumed.
			get: (name) => (name === "sessions" ? { list: () => [] } : void 0),
			webServer: { register() {} },
			settings: { register() {} }
		});
		const listener = listeners.find((entry) => entry.name === "session/event");
		check("session/event listener registered", listener !== void 0);

		const time = Date.UTC(2026, 9, 10, 10, 0, 0);
		const source = { provider: "buddy", model: "deepseek-v4.1-flash" };
		const events = [
			{ seq: 0, time, type: "request/header", data: { header: { config: source } } },
			{ seq: 1, time, type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 1000, outputTokens: 0 } } },
			{ seq: 2, time, type: "tool/result", data: {} },
			{ seq: 3, time, type: "tool/result", data: {} },
			{ seq: 4, time, type: "tool/result", data: {} },
			{ seq: 5, time, type: "assistant/message", data: { turn: 1, step: 0, message: { source }, usage: { inputTokens: 700, outputTokens: 0 } } }
		];
		const session = { id: "resume-s1", seq: events.length, eventAt: (n) => events[n] };
		// The FIRST live event this feed carries is seq 5 — the gap 0..4 was
		// never folded by any pass, because the cache had been rebuilt.
		listener.handler(session, events[5]);
		await new Promise((resolve) => setTimeout(resolve, 60));

		const usage = await index.collectUsage(silentCtx());
		const day = usage.days.find((entry) => entry.date === "2026-10-10");
		check("the gap before a resumed live event is folded", day !== void 0 && day.tokens === 1700, JSON.stringify(day));
		check("the live event itself is counted once", usage.total === 1700, `total=${usage.total}`);

		// The cursor now sits past the gap: a later event must not re-fold it.
		listener.handler(session, { seq: 6, time, type: "assistant/message", data: { turn: 2, step: 0, message: { source }, usage: { inputTokens: 300, outputTokens: 0 } } });
		await new Promise((resolve) => setTimeout(resolve, 60));
		const later = await index.collectUsage(silentCtx());
		check("a following event folds only itself", later.total === 2000, `total=${later.total}`);
	}

	// --------------------- G: no state leaks across storage directories
	console.log("no leak across storage directories");
	{
		// `loadedCache` and the seen-here evidence are module-level singletons,
		// while the document they describe lives under `DSH_HOME`. A process
		// normally has one home, but tests (and any future multi-profile host)
		// switch it — and a stale singleton then gets written into the NEW home,
		// with its sessions evicted there because they were folded under the old
		// one. Measured before the fix: a session folded in home A was evicted in
		// home B.
		const index = await loadIndex("g");
		const homeA = freshHome("thm-recover-ga-");
		writeFileSync(homeA.cachePath, JSON.stringify({
			version: 2,
			sessions: { shared: sessionDoc({ kind: "persisted", days: { "2026-09-01": 100 } }) }
		}));

		// Home A: fold `shared` so it becomes seen-here evidence.
		const events = [{ seq: 0, time: Date.UTC(2026, 8, 1), type: "assistant/message", data: { turn: 0, step: 0, usage: { inputTokens: 1 } } }];
		await index.collectUsage({
			get: (name) => (name === "sessions" ? { list: () => [{ id: "shared", seq: 1, eventAt: (n) => events[n] }] } : void 0),
			logger: { warn() {} }
		});

		// Home B: a different document, also holding `shared` plus its own session.
		const homeB = freshHome("thm-recover-gb-");
		writeFileSync(homeB.cachePath, JSON.stringify({
			version: 2,
			sessions: {
				shared: sessionDoc({ kind: "persisted", days: { "2026-09-01": 100 } }),
				"b-only": sessionDoc({ kind: "persisted", days: { "2026-09-02": 200 } })
			}
		}));
		// A backend that sees only `b-only` and can prove nothing about `shared`.
		await index.collectUsage({
			get: (name) => (name === "sessionPersistence"
				? { list: async () => [{ header: { id: "b-only" } }], stat: async () => void 0 }
				: name === "sessions" ? { list: () => [] } : void 0),
			logger: { warn() {} }
		});

		const bDoc = JSON.parse(readFileSync(homeB.cachePath, "utf8"));
		check("home B's own session is kept", bDoc.sessions["b-only"] !== void 0, JSON.stringify(Object.keys(bDoc.sessions)));
		check("a session folded in home A is not evicted in home B", bDoc.sessions.shared !== void 0, JSON.stringify(Object.keys(bDoc.sessions)));
	}
} finally {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\ncache recovery smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
