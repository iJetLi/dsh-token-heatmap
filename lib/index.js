/**
 * dsh-token-heatmap — server half.
 *
 * Registers two loopback-only endpoints on the web server:
 *   GET  /api/token-heatmap/usage  — per-day token usage across every session
 *   GET  /api/token-heatmap/config — the plugin's display settings
 *   POST /api/token-heatmap/config — persist display settings (switch + scheme)
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact route bypasses the RPC trust
 * fence); Host is checked only as an additional defense.
 *
 * Display settings (enabled + colorScheme) are owned by the plugin's
 * `token-heatmap` settings namespace — the config card in
 * 设置 → 插件 → 插件配置 reads/writes it through the settings scope, and the
 * legacy `<DSH_HOME>/storages/token-heatmap-config.json` document is
 * migrated into the namespace once at startup.
 *
 * Usage aggregation is INCREMENTAL: per-session fold state (day/model
 * buckets plus the last usage sample) is cached in memory and persisted to
 * `<DSH_HOME>/storages/token-heatmap-cache.json`. On each request only the
 * events added since the last fold are processed — live sessions fold their
 * in-memory tail — so steady-state cost stays O(new events) no matter how
 * large the logs grow.
 *
 * That document is the ONLY carrier of history (stored logs are deliberately
 * never re-read, see the note above collectUsage), so losing it loses the
 * heatmap's past. A failed `rename` strands each write as a
 * `<cache>.<pid>.<ms>.tmp` snapshot, and on 2026-10-08 the live document was
 * replaced by an almost empty one: 49 folded days (590 sessions) vanished.
 * `loadCache` therefore RECOVERS at startup — it merges the live document, the
 * pre-overwrite `<cache>.bak` and every same-version snapshot into the most
 * complete copy of each session (see ./cache.js) rather than silently starting
 * from nothing, and writes the merge back so the recovery outlives them.
 *
 * The fold semantics live in ./usage.js and mirror `dsh-token-meter`'s
 * `tokenUsage` projection (same semantics as the reference plugin
 * dsh-usage-stats, MIT © Ychris12138).
 *
 * @module dsh-token-heatmap
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { applyUsageDelta, createUsageState, mergeInto, renderUsage, totalTokens } from "./usage.js";
import { CACHE_VERSION, mergeCacheDocuments, mergeImproves, parseCacheDocument, serializeCacheDocument } from "./cache.js";
import { DEFAULT_CONFIG, VIEW_MODES, parseConfig } from "./config.js";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "token-heatmap";

/** Services required before this plugin activates. */
const inject = ["webServer", "sessions", "sessionPersistence", "settings"];

//#region settings namespace
/**
 * Settings namespace owned by this plugin. Registering it makes the Host
 * serve a `token-heatmap` section (resolved from schema defaults, then any
 * composition `base`, then the user settings.yaml layer), which is exactly
 * what the official 设置 → 插件 → 插件配置 tab dispatches on: it renders the
 * card registered into `settings.plugin.item` whose `key` matches a served
 * namespace. The card edits `enabled` + `colorScheme` through the settings
 * scope; the legacy `<DSH_HOME>/storages/token-heatmap-config.json` document
 * is migrated once at startup (see migrateLegacyConfig).
 * DSH 0.1.2 起 `@deepseek-ai/dsh-settings` 不再导出 settingsNamespace 帮助函数：
 * namespace 直接以字面量传入（register/get/update 内部仍按
 * /^[a-z][a-z0-9-]*$/ 校验）。
 */
const SETTINGS_NAMESPACE = "token-heatmap";

/**
 * Durable display preferences; also the wire envelope the browser scope
 * validates against. Scheme membership is deliberately NOT enforced (a newer
 * client may know a palette the server does not — the client falls back to
 * green); only the same shape bounds parseConfig applies: a short, non-blank
 * string. `defaultView` is bounded to the rendered view modes (year/month).
 *
 * The 0.1.x `enabled` master switch is gone: the card is always rendered on
 * the hero screen, so the field is neither accepted nor served (an old
 * settings.yaml keeps its dead `enabled` key, and nothing reads it).
 */
const TokenHeatmapSettingsSchema = z.object({
	colorScheme: z.string().min(1).max(32).default("green"),
	defaultView: z.union(VIEW_MODES.map((mode) => z.const(mode))).default("year")
});

/**
 * Cordis plugin Config schema — the source DSH 0.1.7 projects its settings form
 * from (`SettingsForms` reads `entry.fiber.runtime.Config` and keeps only fields
 * marked volatile). On 0.1.5 cordis merely resolves it into `ctx.config`
 * defaults instead, which this plugin never reads, so exporting it
 * unconditionally is safe on both trains.
 *
 * The volatile marker is `extra("volatile", true)` rather than `.volatile()`:
 * schemastery 3.18.2 (bundled with 0.1.5) has no `volatile()` method, and on
 * 3.18.4 (0.1.7) `.volatile()` IS `extra('volatile', true)`.
 */
export const Config = z.object({
	colorScheme: z.string().min(1).max(32).default("green").extra("volatile", true),
	defaultView: z.union(VIEW_MODES.map((mode) => z.const(mode))).default("year").extra("volatile", true)
});
//#endregion

const USAGE_PATH = "/api/token-heatmap/usage";
const CONFIG_PATH = "/api/token-heatmap/config";
/** Name of the durable cache document; its recovery snapshots share this prefix. */
const CACHE_FILE_NAME = "token-heatmap-cache.json";
/**
 * Upper bound on the events folded in ONE cursor-gap backfill (see the
 * `session/event` listener in apply). A larger gap belongs to a session this
 * fold was never meant to replay, and blocking the event loop on it would
 * stall every other plugin sharing the process — the same reason stored logs
 * are never read at all.
 */
const MAX_GAP_EVENTS = 20000;
/**
 * Upper bound on per-pass `sessionPersistence.stat()` existence probes. A
 * stored session the backend's `list()` did not mention is probed by id
 * before its folded history may be dropped; the bound keeps one request from
 * walking a profile with thousands of stored sessions (the rest are probed on
 * later passes). See the eviction note in collectUsage.
 */
const EVICTION_PROBE_LIMIT = 200;
/**
 * Upper bound on the cache snapshots merged at startup, newest first. One
 * `.tmp` accumulates per failed `rename` and nothing prunes them; see
 * snapshotPaths.
 */
const SNAPSHOT_LIMIT = 32;
/**
 * Age after which a cache write lock is treated as abandoned and reclaimed.
 * A save takes ~5 ms on a 490 KB document, so a lock this old means its holder
 * died or is wedged; without reclaiming it, every later save would be refused
 * forever.
 */
const LOCK_STALE_MS = 30000;
/**
 * How long a save waits for a busy lock before deferring to the next save, and
 * how often it re-tries. A save takes ~5 ms, so this is hundreds of writers'
 * worth of patience; the bound exists only so a pathologically busy cache
 * cannot wedge a request.
 */
const LOCK_WAIT_MS = 5000;
/** Poll interval while waiting for a busy lock. */
const LOCK_POLL_MS = 25;

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const hostName = hostNameOf(req.headers.host);
	return hostName === "localhost" || isLoopbackAddress(hostName);
}

/** Refuse callers whose peer socket is not loopback (Host header is defense-in-depth). */
function isLoopbackCaller(req) {
	const peer = req.socket?.remoteAddress;
	return isLoopbackAddress(peer) && isLoopbackHostHeader(req);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	if (isLoopbackCaller(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/** Refuse non-loopback callers and non-GET/POST methods before config work. */
function rejectForeignConfigCaller(req, res) {
	if (req.method !== "GET" && req.method !== "POST") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	if (isLoopbackCaller(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/** Collect a bounded request body as UTF-8 text. */
function readBody(req, limit = 4096) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#region incremental cache
/** Directory holding this plugin's durable documents under the dsh home. */
function storageDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages");
}

/** Durable cache document — the folded history this plugin renders. */
function cachePath() {
	return join(storageDir(), CACHE_FILE_NAME);
}

/** Previous good cache document, refreshed before every overwrite. */
function backupPath() {
	return `${cachePath()}.bak`;
}

let loadedCache = null;
let loadPromise = null;
let inflight = null;

/**
 * Session ids THIS process has folded itself, in this process's lifetime
 * (never persisted). Eviction needs it: `list()`/`stat()` describe this
 * process's storage view, so a session that arrived from another process's
 * cache document must not be deleted just because this backend cannot see it.
 * A session folded here, however, was genuinely visible to this process, so
 * its later disappearance is real evidence.
 *
 * Scoped to the storage directory it was gathered under: the evidence is about
 * one particular backend's view, so switching `DSH_HOME` (tests do; a real
 * process does not) must not carry it over. Measured: a session folded under
 * one home was evicted under another because the set leaked.
 */
let seenHere = new Set();
/** The storage directory `seenHere` was gathered under. */
let seenHereScope = null;

/** Drop the seen-here evidence when the storage directory changes. */
function scopeSeenHere() {
	const scope = storageDir();
	if (seenHereScope !== scope) {
		seenHereScope = scope;
		seenHere = new Set();
	}
	return seenHere;
}

/**
 * Snapshots a failed atomic write left behind (`<cache>.<pid>.<ms>.tmp`).
 * Each one is a COMPLETE document written just before a `rename` that could
 * not land, so they are the only surviving evidence of history a later
 * overwrite erased.
 *
 * Bounded to the newest SNAPSHOT_LIMIT files by the timestamp in their name:
 * one accumulates per failed rename and nothing ever deletes them, so an
 * unbounded read would let a pathological directory slow every startup. The
 * newest ones are kept because they are the most likely to describe recent
 * history; measured 2026-10-12, a real profile had 4 (1.18 MB total) and the
 * official dsh-usage 9, so the bound is never reached in practice.
 */
async function snapshotPaths() {
	try {
		const prefix = `${CACHE_FILE_NAME}.`;
		return (await readdir(storageDir()))
			.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
			// `<pid>.<ms>.tmp` — the ms field orders them chronologically.
			.sort((a, b) => {
				const stampOf = (name) => Number(name.slice(prefix.length).split(".")[1]) || 0;
				return stampOf(b) - stampOf(a);
			})
			.slice(0, SNAPSHOT_LIMIT)
			.map((entry) => join(storageDir(), entry));
	} catch {
		return [];
	}
}

/**
 * Read one cache document, distinguishing "this home has none yet" from "this
 * document cannot be folded" — the latter is quarantined, never silently
 * overwritten.
 * @returns `{ status: "ok", sessions }`, `{ status: "absent" }`, or
 *   `{ status: "unusable" }`.
 */
async function readCacheDocument(path) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { status: "absent" };
	}
	const sessions = parseCacheDocument(raw);
	return sessions === null ? { status: "unusable" } : { status: "ok", sessions };
}

/**
 * Keep one unreadable live document for post-mortem instead of overwriting it
 * (at most one: the previous quarantine is replaced).
 */
async function quarantineCache(ctx, path) {
	try {
		await rename(path, `${path}.corrupt`);
	} catch (error) {
		ctx?.logger?.warn(`token-heatmap: quarantining the unreadable cache failed: ${String(error)}`);
	}
}

/** Tombstone document: the ids this plugin has PROVEN gone. */
function evictedPath() {
	return `${cachePath()}.evicted`;
}

/**
 * Read the eviction tombstones.
 *
 * A separate file, not a field of the cache document, because it must survive
 * the document being replaced: the whole point is to outlast the copies that
 * still contain the evicted sessions. Best-effort — an unreadable tombstone
 * means "nothing was evicted", which errs toward keeping history.
 * @returns the recorded ids.
 */
async function readEvictedIds() {
	try {
		const parsed = JSON.parse(await readFile(evictedPath(), "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.ids)) return new Set();
		return new Set(parsed.ids.filter((id) => typeof id === "string" && id.length > 0));
	} catch {
		return new Set();
	}
}

/** Persist the eviction tombstones (best-effort). */
async function writeEvictedIds(ids) {
	try {
		await writeFile(evictedPath(), JSON.stringify({ version: 1, ids: [...ids] }), "utf8");
	} catch {
		/* best-effort: losing a tombstone only risks a resurrected session */
	}
}

/**
 * Refresh the pre-overwrite backup, throttled: the `session/event` listener
 * saves every couple of seconds and a 380 KB copy each time would be pure
 * churn. The backup is what makes an accidental overwrite undoable — it is
 * merged back at load time like any other snapshot.
 */
const BACKUP_INTERVAL_MS = 30000;
let lastBackupAt = 0;

async function backupBeforeOverwrite(path) {
	const now = Date.now();
	if (now - lastBackupAt < BACKUP_INTERVAL_MS) return;
	lastBackupAt = now;
	try {
		await copyFile(path, backupPath());
	} catch {
		/* no live document yet (first write into this home) — nothing to keep */
	}
}

/**
 * Load the cache once per process, RECOVERING every snapshot on the way.
 *
 * The live document is the primary source, but a failed `rename` leaves the
 * previous document in place while the new one is stranded as a `.tmp`
 * snapshot — and a document can also be lost outright (foreign version, torn
 * JSON, an external cleanup). Because history exists nowhere else, startup
 * merges the live document, the pre-overwrite backup and every same-version
 * snapshot into one per-session map (see ./cache.js), then writes the result
 * back so the recovery outlives the snapshots themselves being cleaned up.
 *
 * Sessions recorded as EVICTED are dropped again after the merge. Recovery and
 * eviction otherwise fight: proving a session gone removes it from the live
 * document, but the very next `backupBeforeOverwrite` copies the document that
 * still had it to `<cache>.bak`, and the next startup's merge reads it back —
 * measured: A evicted a session, a fresh B loaded and saved, and the session
 * returned. The tombstone is the record of a decision that recovery must not
 * overturn.
 *
 * The single-flight cache is keyed by the document path. A process normally
 * has one `DSH_HOME`, but tests switch it per case, and a stale in-memory
 * document would otherwise be written into the NEW home (and its sessions
 * evicted there) — measured. Re-loading on a path change keeps the singleton
 * honest.
 *
 * @param ctx - plugin context carrying the warning logger (optional).
 */
async function loadCache(ctx) {
	const path = cachePath();
	if (loadedCache !== null && loadedCache.path === path) return loadedCache;
	if (loadPromise === null || loadPromise.path !== path) {
		const pending = (async () => {
			const primary = await readCacheDocument(path);
			if (primary.status === "unusable") {
				ctx?.logger?.warn(`token-heatmap: cache document is unreadable; recovering from snapshots (kept as ${path}.corrupt)`);
				await quarantineCache(ctx, path);
			}
			const documents = [];
			if (primary.status === "ok") documents.push(primary.sessions);
			for (const snapshot of [backupPath(), ...(await snapshotPaths())]) {
				if (snapshot === path) continue;
				const document = await readCacheDocument(snapshot);
				if (document.status === "ok") documents.push(document.sessions);
			}
			const sessions = mergeCacheDocuments(documents);
			// Honour every eviction decision, including one another process made.
			const evicted = await readEvictedIds(path);
			for (const id of evicted) delete sessions[id];
			const cache = { version: CACHE_VERSION, sessions, path, evicted };
			if (mergeImproves(primary.status === "ok" ? primary.sessions : null, sessions)) {
				await saveCache(ctx, cache);
			}
			return cache;
		})();
		pending.path = path;
		loadPromise = pending;
	}
	loadedCache = await loadPromise;
	return loadedCache;
}

/**
 * Acquire the cross-process write lock for the cache document.
 *
 * `saveCache` is a read-modify-write: it re-reads the document, merges, then
 * renames a temp file over it. Two hosts (web and desktop share one
 * `<DSH_HOME>`) can interleave between one's read and the other's rename, so
 * the later rename still erases the earlier one's work — the merge narrows
 * that window but cannot close it. `open(path, "wx")` is the atomic
 * create-exclusive primitive every platform agrees on, so the lock is a file
 * whose mere existence means "a writer is inside the critical section".
 *
 * A busy lock is WAITED for, never abandoned: giving up would leave this
 * process's freshly folded usage only in memory, and nothing guarantees
 * another save ever comes (measured: 8 concurrent writers with a give-up
 * policy lost 2 sessions outright, because the losers' own state never reached
 * disk). The wait is bounded, and every attempt re-checks staleness so a dead
 * holder cannot block forever.
 *
 * A lock older than LOCK_STALE_MS is reclaimed: the holder is either dead or
 * has been stuck far longer than a write takes (measured: a 490 KB document
 * saves in ~5 ms). Reclaiming is inherently racy — the old holder may still be
 * inside — so the ownership token written into the file is what makes release
 * safe: a reclaimer overwrites the token, and the old holder then sees it no
 * longer owns the lock and leaves the file alone (see `releaseCacheLock`).
 * Without that check the old holder's release deleted the NEW holder's lock,
 * letting a third writer in beside it (measured).
 *
 * @returns the ownership token on success, or null when the lock stayed busy
 *   past LOCK_WAIT_MS.
 */
async function acquireCacheLock(path) {
	const lockPath = `${path}.lock`;
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			// ONE call creates the file AND writes the token. Creating it empty and
			// writing afterwards left a window where a reclaimer could install its
			// own token and the original holder would then overwrite it — both
			// would believe they held the lock (measured by reasoning, and it is
			// the same class of window as the release bug above).
			await writeFile(lockPath, token, { flag: "wx" });
			return token;
		} catch (error) {
			if (error?.code !== "EEXIST") return null;
			let age;
			try {
				age = Date.now() - (await stat(lockPath)).mtimeMs;
			} catch {
				continue; // vanished between the open and the stat — retry at once
			}
			if (age >= LOCK_STALE_MS) {
				// Take it over by REPLACING the token inside the EXISTING file, and
				// treat that as success — retrying the exclusive create could never
				// succeed while the file exists, and unlinking first would leave a
				// window where no lock exists at all. The replacement is what tells
				// the previous holder (if it is somehow still alive) that it no
				// longer owns the lock.
				try {
					await writeFile(lockPath, token, "utf8");
					return token;
				} catch {
					continue; // the stale file vanished — try to create our own
				}
			}
			if (Date.now() >= deadline) return null;
			await sleep(LOCK_POLL_MS);
		}
	}
}

/**
 * Release a cache lock, but only while this holder still owns it.
 *
 * A reclaimer replaces the token inside the file; a holder whose token is gone
 * must NOT unlink it, or it would delete the reclaimer's lock and let a third
 * writer into the critical section beside it (measured: A's release removed
 * B's lock and C entered while B was still inside).
 * @param path - the cache document path (its lock is `${path}.lock`).
 * @param token - the token returned by acquireCacheLock.
 */
async function releaseCacheLock(path, token) {
	const lockPath = `${path}.lock`;
	try {
		const held = await readFile(lockPath, "utf8");
		if (held !== token) return; // reclaimed by someone else — leave it
	} catch {
		return; // already gone
	}
	await rm(lockPath, { force: true }).catch(() => {});
}

/** Wait `ms` without blocking the event loop. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist the cache atomically (temp + rename); failures are logged, never
 * fatal.
 *
 * The document is re-merged with what is on disk IMMEDIATELY BEFORE writing,
 * because the in-memory map is only this process's view: another host (web and
 * desktop share one `<DSH_HOME>`) may have folded history this process never
 * saw. Writing the memory map blindly erased it — measured with two processes:
 * B loads a 4-day cache, A writes a 53-day one, B saves again and A's 53 days
 * are gone. Merging first makes a save additive: this process's own state wins
 * for the sessions it knows (it is the freshest for those), while sessions only
 * the disk knows are carried through.
 *
 * The read-merge-rename runs under `acquireCacheLock`, so the whole sequence is
 * exclusive across processes rather than merely narrow.
 *
 * `evicted` names sessions this process PROVED gone (`stat()` found nothing).
 * They are excluded from the merge so a deletion is not undone by the very
 * next write: without it, collectUsage deletes a vanished session and this
 * merge immediately restores it from disk, forever.
 *
 * The previous document is also copied to `<cache>.bak` first (throttled), so
 * the write that loses history is always undoable from the backup.
 * @param cache - the in-memory cache document (its `sessions` is replaced).
 * @param evicted - ids proven absent, to be kept out of the written document.
 */
async function saveCache(ctx, cache, evicted = null) {
	const path = cachePath();
	let token = null;
	try {
		await mkdir(dirname(path), { recursive: true });
		token = await acquireCacheLock(path);
		if (token === null) {
			// The lock stayed busy past the wait budget. This process's state is
			// kept in memory and the listener retries in a couple of seconds, so
			// it is a delay rather than a loss.
			ctx?.logger?.warn("token-heatmap: usage cache lock stayed busy; this save is deferred to the next one");
			return;
		}
		// Re-read INSIDE the lock, so the merge sees the other writer's result.
		const onDisk = await readCacheDocument(path);
		let sessions = cache.sessions;
		if (onDisk.status === "ok") {
			sessions = mergeCacheDocuments([sessions, onDisk.sessions]);
		}
		// Tombstones win over every copy, ours and the disk's: an eviction is a
		// decision, not a document that a later merge may outvote.
		const tombstones = cache.evicted ?? await readEvictedIds();
		if (evicted !== null) {
			for (const id of evicted) tombstones.add(id);
			cache.evicted = tombstones;
			await writeEvictedIds(tombstones);
		}
		for (const id of tombstones) delete sessions[id];
		cache.sessions = sessions;
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, JSON.stringify(serializeCacheDocument(sessions)), "utf8");
		await backupBeforeOverwrite(path);
		await rename(tmp, path);
	} catch (error) {
		ctx?.logger?.warn(`token-heatmap: saving usage cache failed: ${String(error)}`);
	} finally {
		if (token !== null) await releaseCacheLock(path, token);
	}
}

/** Single-flight guard: concurrent requests share one aggregation run. */
function withLock(run) {
	if (inflight !== null) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}
//#endregion

//#region config route + legacy migration
/** Legacy config file location under the dsh home (pre-0.1.2 storage). */
function configPath() {
	return join(storageDir(), "token-heatmap-config.json");
}

/**
 * One-time migration from the legacy config document
 * (`<DSH_HOME>/storages/token-heatmap-config.json`) into the registered
 * settings namespace. Runs once per process, best-effort: when the user has
 * no settings.yaml section yet, non-default values are imported through the
 * settings write path; the legacy file is removed either way (the namespace
 * becomes the single source of truth). A corrupt legacy document is dropped,
 * never imported. Failures are logged and never fatal.
 * @param ctx - plugin context carrying the settings service.
 */
async function migrateLegacyConfig(ctx) {
	try {
		const path = configPath();
		let rawText;
		try {
			rawText = await readFile(path, "utf8");
		} catch {
			return; // no legacy document
		}
		let legacy;
		try {
			legacy = parseConfig(JSON.parse(rawText));
		} catch {
			await rm(path, { force: true });
			return;
		}
		const descriptor = ctx.settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE);
		const userExists = descriptor !== void 0 && descriptor.user !== void 0;
		if (!userExists) {
			const patch = {};
			// The legacy document's `enabled` switch died with 0.2.0: import only
			// what the card still owns.
			if (legacy.colorScheme !== DEFAULT_CONFIG.colorScheme) patch.colorScheme = legacy.colorScheme;
			if (legacy.defaultView !== DEFAULT_CONFIG.defaultView) patch.defaultView = legacy.defaultView;
			if (Object.keys(patch).length > 0) await ctx.settings.update(SETTINGS_NAMESPACE, patch);
		}
		await rm(path, { force: true });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: migrating legacy config failed: ${String(error)}`);
	}
}

/**
 * Serve the resolved settings section (schema defaults + user layer).
 * `enabled` stays in the payload as a constant true: the legacy loopback
 * endpoint is a back-compat API, and a pre-0.2.0 client that reads it must not
 * lose the card over a switch this version no longer has.
 *
 * Read through `settings.describe()` rather than `settings.get(ns)`: 0.1.7's
 * `SettingsForms` has no `get(ns)`, while `describe()` exists on both trains
 * and returns descriptors carrying both `ns` and `value`.
 */
function serveConfig(ctx) {
	const descriptor = typeof ctx.settings.describe === "function"
		? ctx.settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
		: void 0;
	const section = descriptor?.value;
	const scheme = typeof section?.colorScheme === "string" && section.colorScheme.length > 0 ? section.colorScheme : DEFAULT_CONFIG.colorScheme;
	const view = typeof section?.defaultView === "string" && VIEW_MODES.includes(section.defaultView) ? section.defaultView : DEFAULT_CONFIG.defaultView;
	return { enabled: true, colorScheme: scheme, defaultView: view };
}

async function handleConfig(ctx, req, res) {
	if (rejectForeignConfigCaller(req, res)) return;
	try {
		if (req.method === "GET") {
			json(res, 200, { ok: true, ...serveConfig(ctx) });
			return;
		}
		let raw;
		try {
			raw = JSON.parse(await readBody(req));
		} catch (error) {
			json(res, 400, { ok: false, error: "bad-json", message: "request body must be a JSON object" });
			return;
		}
		// parseConfig coerces the write the same way the legacy file path did
		// (boolean check, scheme trimmed and shape-bounded, unknown schemes kept
		// verbatim); the settings schema then validates the canonical shape.
		const config = parseConfig(raw);
		await ctx.settings.update(SETTINGS_NAMESPACE, config);
		json(res, 200, { ok: true, ...serveConfig(ctx) });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: config ${req.method} failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion

/**
 * Enumerate a live session's events from an offset, across session shapes.
 *
 * Pre-0.1.2 sessions kept the whole log on the object as `.events`; DSH
 * 0.1.2+ (rc.1) live sessions expose no `.events` array — the count is
 * `session.seq` and each event is read via `session.eventAt(seq)` (0-based,
 * the same reads @deepseek-ai/dsh-token-meter uses).
 * @returns `{ count, events }` — `count` the session's total event count,
 *   `events` the events from `from` onward.
 */
function liveSessionEvents(session, from) {
	if (Array.isArray(session.events)) {
		return { count: session.events.length, events: session.events.slice(from) };
	}
	if (typeof session.seq !== "number" || typeof session.eventAt !== "function") {
		return { count: 0, events: [] };
	}
	const events = [];
	for (let seq = from; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== void 0) events.push(event);
	}
	return { count: session.seq, events };
}

/**
 * Events of a live session with `from <= seq < to`, for filling a fold-cursor
 * gap (see the `session/event` listener in apply). Reads through the same two
 * session shapes as `liveSessionEvents`, and refuses a gap larger than
 * MAX_GAP_EVENTS instead of replaying a log this fold was never meant to
 * touch.
 * @returns the events in seq order, or null when the gap is over the bound.
 */
function eventsInRange(session, from, to) {
	const span = to - from;
	if (span <= 0) return [];
	if (span > MAX_GAP_EVENTS) return null;
	if (Array.isArray(session.events)) return session.events.slice(from, to);
	if (typeof session.eventAt !== "function") return [];
	const events = [];
	for (let seq = from; seq < to; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== void 0) events.push(event);
	}
	return events;
}

/**
 * Fork-inherited prefix length of a live session: the number of leading
 * events copied from its parent at fork time. Those events carry the PARENT's
 * usage and are folded when the parent is folded, so a seeded child must skip
 * them or the same tokens are counted twice (measured 2026-09-14: 13.15e8
 * instead of 8.34e8).
 *
 * `header.isSeeded` marks fork lineage and `inheritedEventCount` is the exact
 * cut (both are official Session state on 0.1.2+, the cut is what
 * `Session.ownEvents()` starts from). `isSeeded` alone is NOT enough: a
 * resumed session also carries a constructor seed, but that seed is its OWN
 * history and must be folded in full.
 * @returns the inherited prefix length, or 0 when the session is not a fork.
 */
function forkCutOf(session) {
	if (session === null || typeof session !== "object") return 0;
	if (session.header?.isSeeded !== true) return 0;
	const inherited = session.inheritedEventCount;
	return typeof inherited === "number" && Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
}

/** First seq a session's fold may read: its fork cut, never past its cursor. */
function liveFoldFrom(consumed, cut) {
	return Math.max(consumed, cut);
}

/**
 * Refold a session from `cut`: reset the fold cursor so the next read starts
 * at the fork cut, WITHOUT discarding days the fold cannot reproduce.
 *
 * Clearing `days` outright is what makes a recovery self-destruct: a startup
 * merge can put days into a session's state that this process's in-memory log
 * does not cover (the log may have been truncated, compacted, or simply be a
 * short live tail), and the refold then reads a shorter span than the days it
 * just deleted — measured: a snapshot's 2026-09-01/09-02 (10000 tokens)
 * vanished the moment the live session was refolded, leaving only 333.
 *
 * So the previous days are KEPT as a floor and the refold ADDS the days it can
 * read. Days the refold cannot see stay visible; days it can see are replaced
 * rather than doubled, because the fold is rebuilt into a fresh map and then
 * merged back per day (see `replacedDays`).
 * @returns the days to keep, for the caller to merge back after refolding.
 */
function resetFold(state, cut) {
	const preserved = state.days;
	state.days = new Map();
	state.lastSample = null;
	state.currentModel = null;
	state.consumed = 0;
	state.skipUntil = cut;
	return preserved;
}

/**
 * Merge a refolded day map back over the days a reset preserved. Both sides
 * describe the same log, so a day BOTH produced takes the LARGER value: the
 * refold is authoritative only when it actually saw more of that day. Taking
 * the refolded value unconditionally shrank history whenever the in-memory log
 * covered less than the preserved copy — measured: a snapshot's day at 7000
 * became 3000 because this process's log only held part of it, and 4000 tokens
 * vanished with no error.
 * @param refolded - the freshly folded days.
 * @param preserved - days that existed before the refold.
 * @returns the merged day map.
 */
function mergeRefoldedDays(refolded, preserved) {
	if (preserved === void 0 || preserved.size === 0) return refolded;
	const merged = new Map(preserved);
	for (const [date, entry] of refolded) {
		const held = merged.get(date);
		if (held === void 0 || totalTokens(entry.totals) > totalTokens(held.totals)) merged.set(date, entry);
	}
	return merged;
}

/**
 * NOTE: reading a stored session's log is deliberately NOT implemented.
 *
 * Both `sessionPersistence` spellings return the WHOLE log — `readFrom(id,
 * fromSeq)` on the 0.1.2 line and `open(id,"read")` + `handle.read()` on
 * 0.1.3+ — so folding N stored sessions re-reads all of their history on every
 * request. On a profile with hundreds of stored sessions and hundreds of MB of
 * history that stalls this endpoint indefinitely and starves every other plugin
 * sharing the process. `dsh-usage` avoids the same cost by folding only the
 * live `session/event` stream; this plugin does the same, and keeps the ids
 * from `list()` solely so a stored session is not mistaken for a deleted one.
 */

/**
 * Collect per-day usage across live and persisted sessions, incrementally.
 *
 * Live sessions: fold only the in-memory events added since the last fold, and
 * the `session/event` listener (see apply) keeps that fold up to date in real
 * time.
 *
 * Persisted sessions: their ids come from `sessionPersistence.list()` (or
 * `listSnapshots()`) so one that still exists is not mistaken for a deleted
 * session, but their logs are NOT read — see the note above. Days folded
 * earlier stay in the cache and are still displayed; only newly appended
 * events, which the live listener already folded, are added.
 *
 * FORKED sessions (`header.isSeeded`) start their log with a copy of the
 * parent's events. That prefix belongs to the parent and is folded there, so
 * the live fold starts at the session's fork cut (`skipUntil`) instead of
 * seq 0.
 */
export async function collectUsage(ctx) {
	return withLock(async () => {
		// Primary: incremental session-event fold. The session/event listener
		// (see apply) folds live sessions in real time regardless of hero-screen
		// mounting; this request-time fold is a sync point that catches anything
		// the listener has not yet reached. Both share the per-session `consumed`
		// cursor, so they never double count.
		const cache = await loadCache(ctx);
		const live = ctx.get("sessions");
		const attached = new Set();
		const seen = scopeSeenHere();
		if (live !== void 0) {
			for (const session of live.list()) {
				attached.add(session.id);
				// This process has folded the session itself, so it is allowed to
				// conclude later that the session is gone (see the eviction note).
				seen.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				let preserved;
				if (state.kind !== "live" || (state.skipUntil ?? 0) !== cut) {
					// Live/persisted transition, or the fork cut was (re)discovered:
					// refold from the cut. The inherited prefix stays folded under
					// the parent, so starting at the cut avoids double counting it.
					// Days the in-memory log cannot reproduce are preserved (see
					// resetFold) instead of being deleted along with the cursor.
					preserved = resetFold(state, cut);
				}
				const from = liveFoldFrom(state.consumed ?? 0, cut);
				const { count, events } = liveSessionEvents(session, from);
				if (from < count) {
					applyUsageDelta(state, events);
					state.consumed = count;
				}
				if (preserved !== void 0) state.days = mergeRefoldedDays(state.days, preserved);
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
		}
		const persistence = ctx.get("sessionPersistence");
		const persistedIds = new Set();
		const canEnumeratePersisted = persistence !== void 0 && (
			typeof persistence.list === "function" || typeof persistence.listSnapshots === "function"
		);
		if (canEnumeratePersisted) {
			// Enumerate ids ONLY, to tell an existing stored session from one that
			// vanished. Never read the logs: `open()`/`readFrom()` return each
			// session's WHOLE log, so on a profile with hundreds of stored
			// sessions and hundreds of MB of history a single request would
			// re-read all of it — which stalled the endpoint and starved every
			// other plugin in the same process (measured: usage endpoint never
			// returned, CPU pinned, sibling RPCs failing with "signal timed out").
			//
			// dsh-usage (设置 → 使用统计) is the proof this is the right shape: it
			// never touches sessionPersistence at all and folds ONLY the live
			// `session/event` stream, which is why it stays instant on the same
			// data. History from before this process started is therefore not
			// recovered — already-folded days stay in the cache and are still
			// displayed, they just are not refreshed.
			let snapshots = null;
			if (typeof persistence.listSnapshots === "function") {
				try {
					snapshots = await persistence.listSnapshots();
				} catch (error) {
					ctx.logger.warn(`token-heatmap: listSnapshots failed, falling back to list(): ${String(error)}`);
				}
			}
			if (snapshots === null && typeof persistence.list === "function") snapshots = await persistence.list();
			const metas = snapshots !== null ? snapshots.map((entry) => entry.header) : await persistence.list();
			for (const meta of metas) persistedIds.add(meta.id);
		} else if (persistence !== void 0) {
			// DSH 0.1.2+ (rc.1): sessionPersistence exposes no session
			// enumeration (list/listSnapshots are gone). Previously folded
			// persisted days stay in the cache untouched — they are neither
			// refreshed (no enumeration to walk) nor dropped (they still
			// describe real past days).
			ctx.logger.warn("token-heatmap: sessionPersistence exposes no list()/listSnapshots() enumeration on this DSH; persisted-only history will not refresh");
		}
		// Evict a session only when the backend PROVES it is gone. The cache is
		// the only carrier of a session's folded history, so a wrong eviction is
		// permanent data loss, and `list()` is not proof of anything: it
		// enumerates only logs whose header is the CURRENT format version and
		// silently skips every historical one (measured 2026-10-12: of 805
		// stored sessions it listed 610, silently dropping 136 v3 + 59 v0 — and
		// those were exactly the 2026-08-15..09-25 sessions, which is why the
		// oldest days disappeared first). `stat(id)` resolves a session BY ID and
		// reads historical formats through the migration catalog, so it answers
		// "does this still exist" for every generation.
		//
		// Probes are bounded: only ids that `list()` did not mention are asked
		// about, at most EVICTION_PROBE_LIMIT per pass (the rest are retried on
		// later passes), and a backend without `stat()` evicts nothing.
		//
		// An EMPTY enumeration disables eviction entirely. `list()` returning
		// nothing is far more likely to mean "this process's storage view is not
		// up yet / points somewhere else" than "every session was deleted", and
		// a `stat()` that agrees proves only that this backend cannot see the
		// session — not that it is gone (measured 2026-10-12: a fresh process
		// listed nothing while the cache held 807 sessions of real history).
		// Deleting on that evidence would wipe the heatmap's entire past.
		//
		// A session is only evictable if THIS process folded it in this process
		// lifetime (`seenHere`). A record that arrived from another process's
		// document — merged in at load, or by saveCache's re-merge — carries
		// history this process has no other evidence about, and this process's
		// `list()`/`stat()` describe ITS storage view, which need not be the one
		// that record came from. Measured: 800 sessions written by one process
		// were evicted in four passes by another whose backend simply could not
		// see them.
		const known = Object.keys(cache.sessions);
		const canProveAbsence = canEnumeratePersisted && typeof persistence.stat === "function" && persistedIds.size > 0;
		const unresolved = canProveAbsence
			? known.filter((id) => !attached.has(id) && !persistedIds.has(id) && seen.has(id)).slice(0, EVICTION_PROBE_LIMIT)
			: [];
		const evicted = new Set();
		if (unresolved.length > 0) {
			const results = await Promise.all(unresolved.map(async (id) => {
				try {
					const snapshot = await persistence.stat(id);
					return { id, exists: snapshot !== void 0 && snapshot !== null };
				} catch (error) {
					// A probe that fails (I/O, duplicate id across project dirs, an
					// unreadable header) proves nothing — keep the session.
					ctx.logger.warn(`token-heatmap: probing stored session "${id}" failed, keeping its history: ${String(error)}`);
					return { id, exists: true };
				}
			}));
			for (const result of results) {
				if (result.exists) continue;
				// Re-check the gate at the DELETE site, not only when building the
				// candidate list: deleting is the irreversible step, so it must not
				// depend on a filter applied earlier in another scope. A wrong
				// deletion loses history permanently.
				if (!seen.has(result.id)) continue;
				delete cache.sessions[result.id];
				evicted.add(result.id);
			}
		} else if (canEnumeratePersisted && typeof persistence.stat !== "function" && known.some((id) => !attached.has(id) && !persistedIds.has(id))) {
			ctx.logger.warn("token-heatmap: sessionPersistence exposes no stat(); stored sessions that list() omits cannot be verified and are kept");
		} else if (canEnumeratePersisted && persistedIds.size === 0 && known.some((id) => !attached.has(id))) {
			ctx.logger.warn(`token-heatmap: the storage backend listed no sessions while the cache holds ${known.length}; treating that as an unusable view and evicting nothing`);
		}
		const byDay = new Map();
		for (const state of Object.values(cache.sessions)) mergeInto(byDay, state.days);
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file. `evicted` is
		// passed so the save's re-merge does not restore what was just proven
		// gone.
		await saveCache(ctx, cache, evicted.size > 0 ? evicted : null);
		return renderUsage(byDay, Date.now());
	});
}

async function handleUsage(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const result = await collectUsage(ctx);
		json(res, 200, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Plugin body: register the usage and config routes, the settings namespace
 * that backs the plugin configuration card (设置 → 插件 → 插件配置), and the
 * one-time legacy-config migration.
 * @param ctx - plugin context carrying webServer, sessions, sessionPersistence, and settings.
 */
function apply(ctx) {
	// Settings registration is train-specific, and the branch is a capability
	// test on a service already in `inject` — never a try/catch around an
	// uninjected service, which cordis rejects with `cannot get property ...
	// without inject`.
	if (typeof ctx.settings.register === "function") {
		// DSH 0.1.5-rc.3: SettingsProvider takes an explicit
		// register(ns, schema, options). The registration is fiber-bound:
		// disposing this plugin removes the namespace and its observers.
		// `settings` is a hard dependency (inject), so ctx.settings is
		// available here unconditionally.
		ctx.settings.register(SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema);
		// Best-effort, fire-and-forget: import the pre-0.1.2 config document
		// into the namespace and drop the file (see migrateLegacyConfig).
		migrateLegacyConfig(ctx);
	} else if (typeof ctx.settings.configure === "function") {
		// DSH 0.1.7-rc.2: SettingsForms has no register() at all — it projects
		// the form from this module's Config export, keyed by the profile entry
		// id (which is "token-heatmap", matching SETTINGS_NAMESPACE). The card
		// configures itself through its own inline ⚙ panel, so suppress the
		// auto-generated Settings page rather than shipping a second UI.
		ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), "token-heatmap: settings presentation");
	}
	// Real-time fold: listen to session/event and fold each usage event into
	// the cache immediately, so live session usage is captured regardless of
	// whether the hero screen is mounted (the client polls the usage endpoint
	// only there) and regardless of what sessionPersistence can enumerate —
	// this is the path that keeps counting on a host whose stored logs are
	// unreachable. The request-time fold in collectUsage stays as a sync point;
	// both share the per-session `consumed` cursor so they never double count.
	if (typeof ctx.on === "function") ctx.effect(() => {
		let saveTimer = null;
		let disposed = false;
		const disposer = ctx.on("session/event", (session, event) => {
			loadCache(ctx).then((cache) => {
				if (disposed) return;
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				if ((state.skipUntil ?? 0) !== cut) state.skipUntil = cut;
				const seq = typeof event.seq === "number" ? event.seq : void 0;
				const from = liveFoldFrom(state.consumed ?? 0, cut);
				// Constructor seeds (a fork's inherited prefix, or a resume's own
				// stored log) are never published here, so a live event at or after
				// the cut is the only thing this feed carries; the guard keeps a
				// stray replay of the parent's prefix from re-counting it.
				if (seq !== void 0 && seq < from) return;
				// A gap means the events between the cursor and this one were never
				// folded: a session resumed after the cache was rebuilt (or after a
				// repair) publishes its live events at a seq far past the cursor.
				// Folding only the new event and then jumping the cursor over the
				// gap would skip that history FOR GOOD — measured 2026-10-11:
				// session 7815c4ab had 9151 of its 9152 events marked consumed
				// while its folded days covered only the last two.
				if (seq !== void 0 && seq > from) {
					const gap = eventsInRange(session, from, seq);
					if (gap === null) {
						ctx.logger.warn(`token-heatmap: session "${session.id}" reported a live event at seq ${seq} with ${seq - from} unfolded events before it, over the ${MAX_GAP_EVENTS} backfill limit; that history stays unfolded`);
					} else if (gap.length > 0) {
						applyUsageDelta(state, gap);
					}
				}
				applyUsageDelta(state, [event]);
				if (seq !== void 0) state.consumed = seq + 1;
				state.kind = "live";
				// A live event proves this process sees the session.
				seenHere.add(session.id);
				cache.sessions[session.id] = state;
				if (saveTimer === null) {
					saveTimer = setTimeout(() => {
						saveTimer = null;
						saveCache(ctx, cache).catch(() => {});
					}, 2000);
				}
			}).catch(() => {});
		});
		return () => {
			disposed = true;
			if (saveTimer !== null) clearTimeout(saveTimer);
			if (typeof disposer === "function") disposer();
		};
	}, "token-heatmap: session/event fold");
	// Initial fold of live sessions that existed before this plugin loaded
	// (e.g. resumed sessions): fold their in-memory tail from the last cursor
	// so the heatmap has history before the first session/event arrives.
	ctx.effect(() => {
		let disposed = false;
		loadCache(ctx).then(async (cache) => {
			if (disposed) return;
			const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
			if (sessions === void 0) return;
			for (const session of sessions.list()) {
				if (disposed) return;
				seenHere.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				let preserved;
				if (state.kind !== "live" || (state.skipUntil ?? 0) !== cut) preserved = resetFold(state, cut);
				const from = liveFoldFrom(state.consumed ?? 0, cut);
				const { count, events } = liveSessionEvents(session, from);
				if (from < count) {
					applyUsageDelta(state, events);
					state.consumed = count;
				}
				if (preserved !== void 0) state.days = mergeRefoldedDays(state.days, preserved);
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
			if (!disposed) await saveCache(ctx, cache);
		}).catch(() => {});
		return () => { disposed = true; };
	}, "token-heatmap: initial live fold");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: USAGE_PATH,
		handler: (req, res) => handleUsage(ctx, req, res)
	}), "token-heatmap: usage route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: CONFIG_PATH,
		handler: (req, res) => handleConfig(ctx, req, res)
	}), "token-heatmap: config route");
}

export { apply, inject, name, CONFIG_PATH, USAGE_PATH, SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema, migrateLegacyConfig, serveConfig };
