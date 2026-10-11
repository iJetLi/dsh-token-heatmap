/**
 * dsh-token-heatmap — cache document model.
 *
 * The folded per-day/per-model usage lives ONLY in
 * `<DSH_HOME>/storages/token-heatmap-cache.json`: the plugin deliberately
 * never re-reads stored session logs (see the file note in ./index.js), so
 * that one document IS the history it renders.
 *
 * Each write is `writeFile(tmp) + rename(tmp, path)`, and that rename fails
 * while anything holds the target — leaving the previous document in place
 * and the new one stranded as a `<path>.<pid>.<ms>.tmp` snapshot. Measured on
 * this machine: three such snapshots (2026-09-15, 10-03, 10-07), while the
 * official usage ledger has ten. When the live document was then replaced by
 * an almost empty one on 2026-10-08, 49 days of folded history (590 sessions,
 * 380 KB) vanished from the UI — recoverable only from those snapshots.
 *
 * This module makes them recoverable. `mergeCacheDocuments()` folds every
 * usable document into ONE per-session state map. The unit is the SESSION,
 * never the day: a session's `days` and its `consumed` cursor are one fold
 * state, and a cursor paired with days it did not produce either double
 * counts that stretch (it gets folded a second time) or skips it forever. So
 * the winning record supplies the CURSOR while the folded days become the
 * UNION of every copy — a day only one document saw is real usage — and a
 * union wider than the winner's own days is marked `kind: "merged"` so the
 * next fold rebuilds that session from scratch instead of trusting a cursor
 * that no longer describes its days. The merge is idempotent, which is what
 * makes it safe to repeat on every boot.
 *
 * Imported by ./index.js; kept free of cordis and fs so it unit-tests
 * directly.
 *
 * @module dsh-token-heatmap/cache
 */

import { createUsageState, totalTokens, zeroBuckets } from "./usage.js";

/**
 * Cache format version. 2 folds every session from its fork cut (see
 * `forkCutOf` in ./index.js): a version-1 cache may hold a forked child's
 * inherited prefix — the parent's tokens, already folded under the parent —
 * so it is rebuilt instead of merged.
 */
export const CACHE_VERSION = 2;

/** Serialize one session's fold state (Maps → plain objects). */
export function serializeSession(state) {
	const days = {};
	for (const [date, entry] of state.days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		days[date] = { totals: { ...entry.totals }, models };
	}
	return {
		kind: state.kind ?? "persisted",
		consumed: state.consumed ?? 0,
		...(state.skipUntil === void 0 || state.skipUntil === 0 ? {} : { skipUntil: state.skipUntil }),
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			buckets: { ...state.lastSample.buckets }
		},
		currentModel: state.currentModel
	};
}

/** Parse a serialized session entry back into fold state (lenient). */
export function parseSession(raw) {
	const state = createUsageState();
	if (raw === null || typeof raw !== "object") return state;
	state.kind = typeof raw.kind === "string" ? raw.kind : "persisted";
	state.consumed = Number.isSafeInteger(raw.consumed) ? raw.consumed : 0;
	// Missing in a hand-edited or legacy entry: 0 means "no fork cut known",
	// which only re-folds the inherited prefix once, on the next pass.
	state.skipUntil = Number.isSafeInteger(raw.skipUntil) && raw.skipUntil > 0 ? raw.skipUntil : 0;
	if (typeof raw.revision === "string") state.revision = raw.revision;
	if (raw.days !== null && typeof raw.days === "object") {
		for (const [date, entry] of Object.entries(raw.days)) {
			if (entry === null || typeof entry !== "object") continue;
			const target = { totals: zeroBuckets(), models: new Map() };
			const totals = entry.totals;
			if (totals !== null && typeof totals === "object") {
				target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
				target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
				target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
				target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
			}
			if (entry.models !== null && typeof entry.models === "object") {
				for (const [model, buckets] of Object.entries(entry.models)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.models.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			state.days.set(date, target);
		}
	}
	if (raw.lastSample !== null && raw.lastSample !== void 0 && typeof raw.lastSample === "object" && typeof raw.lastSample.key === "string" && typeof raw.lastSample.day === "string") {
		const buckets = raw.lastSample.buckets ?? {};
		state.lastSample = {
			key: raw.lastSample.key,
			day: raw.lastSample.day,
			model: typeof raw.lastSample.model === "string" ? raw.lastSample.model : "unknown",
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			}
		};
	}
	if (typeof raw.currentModel === "string") state.currentModel = raw.currentModel;
	return state;
}

/**
 * How far along the log one session's fold state is: DAYS first, because a
 * state covering more days is strictly further along, then total tokens,
 * which separates two states folded to the same day boundary.
 */
export function sessionScore(state) {
	let tokens = 0;
	for (const entry of state.days.values()) tokens += totalTokens(entry.totals);
	return { days: state.days.size, tokens };
}

/** Whether `candidate` is a more complete copy of a session than `current`. */
export function isMoreComplete(candidate, current) {
	if (current === void 0) return true;
	const candidateScore = sessionScore(candidate);
	const currentScore = sessionScore(current);
	return candidateScore.days > currentScore.days
		|| (candidateScore.days === currentScore.days && candidateScore.tokens > currentScore.tokens);
}

/**
 * Merge two copies of the SAME session. The more complete record supplies the
 * cursor (`consumed` / `lastSample` / `skipUntil` / `revision`), while the
 * folded days become the UNION of both: a day only one copy knows about is
 * real usage and must not be dropped along with the copy that saw it.
 *
 * A day BOTH copies know takes the LARGER value rather than the winner's. The
 * winner is chosen by breadth (days covered, then total tokens), so a copy can
 * win while knowing less about one particular day — measured: a snapshot with
 * a single day at 7000 loses to a live record covering three days, and taking
 * the winner's 500 for that shared day silently shrank history by 6500. Both
 * copies are folds of the same log, so the larger number is the one that saw
 * more of it; nothing is double counted because the day is still counted once.
 *
 * A union wider than the winning record's own days means its cursor no longer
 * describes those days, so the result is marked `kind: "merged"`. The next
 * fold refreshes such a state from scratch — collectUsage resets every state
 * whose `kind` is not `"live"` — which rebuilds those days exactly for a
 * session that can still be read, and leaves the union intact for one that
 * cannot.
 * @param current - the state held so far.
 * @param incoming - the state of another copy of the same session.
 * @returns the merged state (a new object only when days changed).
 */
function mergeSessions(current, incoming) {
	const winner = isMoreComplete(incoming, current) ? incoming : current;
	const loser = winner === incoming ? current : incoming;
	const days = new Map(winner.days);
	let changed = false;
	for (const [date, entry] of loser.days) {
		const held = days.get(date);
		if (held === void 0) {
			days.set(date, entry);
			changed = true;
			continue;
		}
		if (totalTokens(entry.totals) > totalTokens(held.totals)) {
			days.set(date, entry);
			changed = true;
		}
	}
	return changed ? { ...winner, days, kind: "merged" } : winner;
}

/**
 * Merge every usable cache document into one per-session state map: the
 * winning record per session (widest `days`, then largest token total) plus
 * the union of every copy's days. Order-independent and idempotent —
 * re-running it over the same documents, or over its own output, cannot
 * change the result, so a startup recovery is safe to repeat on every boot.
 *
 * Keeping the winning record's own `consumed`/`lastSample` is exactly what
 * lets a resumed live session re-fold the events between an older cursor and
 * its current position, and never what would double count them.
 *
 * @param documents - per-session state maps, most authoritative first.
 * @returns the merged per-session state map.
 */
export function mergeCacheDocuments(documents) {
	const merged = {};
	for (const document of documents) {
		if (document === null || document === void 0) continue;
		for (const [id, state] of Object.entries(document)) {
			const current = merged[id];
			merged[id] = current === void 0 ? state : mergeSessions(current, state);
		}
	}
	return merged;
}

/**
 * Whether a merge recovered anything the live document did not already carry
 * (so a redundant write can be skipped) and is worth persisting on its own.
 * @param primary - the live document's sessions, or null when unusable.
 * @param merged - the merged sessions.
 */
export function mergeImproves(primary, merged) {
	for (const [id, state] of Object.entries(merged)) {
		if (isMoreComplete(state, primary?.[id])) return true;
	}
	return false;
}

/**
 * Parse one raw cache document into per-session fold state.
 * @param raw - the document text.
 * @returns the session map, or null when the document is unusable: invalid
 *   JSON, a shape this build cannot fold, or a foreign `version`. A version-1
 *   document is deliberately refused rather than merged — its days may hold a
 *   forked child's inherited prefix, which version 2 folds only under the
 *   parent.
 */
export function parseCacheDocument(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	if (parsed.version !== CACHE_VERSION) return null;
	if (parsed.sessions === null || typeof parsed.sessions !== "object") return null;
	const sessions = {};
	for (const [id, entry] of Object.entries(parsed.sessions)) {
		if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
	}
	return sessions;
}

/** Render per-session fold state into the durable document. */
export function serializeCacheDocument(sessions) {
	const document = { version: CACHE_VERSION, sessions: {} };
	for (const [id, state] of Object.entries(sessions)) document.sessions[id] = serializeSession(state);
	return document;
}
