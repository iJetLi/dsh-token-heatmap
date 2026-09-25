/**
 * Cross-version compatibility smoke: asserts the plugin takes exactly ONE
 * settings branch per DSH train, and that reads/writes depend only on the API
 * surface both trains share.
 *
 * 0.1.5-rc.3 — `SettingsProvider` exposes `register(ns, schema, options)` and
 *              `get(ns)`; there is no `configure()`. The browser half provides
 *              the `settingsScope` service.
 * 0.1.7-rc.2 — `SettingsForms` has NO `register()` and NO `get(ns)`; it exposes
 *              `configure(presentation, owner)` and projects the form from the
 *              plugin's `Config` export. The browser half renamed
 *              `settingsScope` to `configForms`.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply, serveConfig, SETTINGS_NAMESPACE, collectUsage } from "../lib/index.js";

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

/** Minimal host ctx whose settings surface mimics one DSH train. */
function makeCtx(settings) {
	const warns = [];
	return {
		warns,
		settings,
		logger: { warn: (msg) => warns.push(String(msg)) },
		effect: (fn) => fn(),
		on: () => () => {},
		get: (name) => (name === "sessions" ? { list: () => [] } : void 0),
		webServer: { register: () => () => {} },
		fiber: { uid: "test-fiber" }
	};
}

/** A scope stub exposing exactly the intersection both trains share. */
function makeMinimalScope() {
	const snapshot = { status: "loading", value: void 0, writable: false, mode: "host" };
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		set: async () => {},
		unset: async () => {}
	};
}

/**
 * A client context for one train. The root context and the child handed to
 * ctx.inject's callback share one slot recorder — in cordis the child inherits
 * the parent's slot service, so registrations made inside a branch are visible
 * on the root.
 */
function makeClientCtx(providedServices) {
	const registered = [];
	const injectedSlots = [];
	const slots = {
		register: (options, component) => { registered.push({ options, component }); return () => {}; },
		// Run the factory so registrations land in `registered`; the real slot
		// runtime does the same once the slot is declared.
		inject: (name, factory) => { injectedSlots.push(name); if (typeof factory === "function") factory(); return () => {}; }
	};
	const ctx = {
		registered,
		injectedSlots,
		slots,
		locale: { register: () => () => {}, bind: () => (key) => key },
		effect: (fn) => fn(),
		// cordis semantics: the callback runs ONLY when every requested service
		// is present; otherwise that fiber stays pending, silently.
		inject: (deps, callback) => {
			if (deps.every((d) => providedServices.has(d))) callback(ctx.child);
		}
	};
	ctx.child = { slots, effect: (fn) => fn() };
	return ctx;
}

const home = mkdtempSync(join(tmpdir(), "thm-compat-"));
process.env.DSH_HOME = home;

try {
	// ---- stored-session enumeration across the two API generations --------
	// The stored-session read interface changed once: the 0.1.2 line spells the
	// snapshot list `listSnapshots()` and the log reader `readFrom(id, fromSeq)`,
	// while 0.1.3+ uses `list()` plus `open(id,"read")`/`handle.read()`. Probing
	// BOTH is correct and required — so this backend RECORDS access instead of
	// trapping it. What must hold: a list()-only backend is tolerated, and with
	// no sessions to read, the log reader is never invoked.
	const logged = [];
	const touched = [];
	const ctxPersist = {
		logger: { warn: (m) => logged.push(String(m)) },
		get: (name) => {
			if (name === "sessions") return { list: () => [] };
			if (name === "sessionPersistence") {
				return {
					list: async () => [],
					get listSnapshots() { touched.push("listSnapshots"); return void 0; },
					get readFrom() { touched.push("readFrom"); return void 0; }
				};
			}
			return void 0;
		}
	};
	const persistResult = await collectUsage(ctxPersist);
	check("list()-only backend is tolerated", persistResult !== void 0 && typeof persistResult.total === "number");
	check("probes the 0.1.2 snapshot spelling", touched.includes("listSnapshots"), touched.join(",") || "(none)");
	check("never reaches the log reader with nothing to read", !touched.includes("readFrom"), touched.join(",") || "(none)");
	check("no warning on the happy path", logged.length === 0, logged.join(" | "));

	// ---- branch A: 0.1.5-rc.3 host shape (register present) --------------
	const calls015 = { registered: [] };
	const ctx015 = makeCtx({
		register: (ns, schema) => { calls015.registered.push({ ns, schema }); return { get: () => ({}) }; },
		// Sentinel: taking 0.1.7's branch on a 0.1.5 host would land here.
		configure: () => { throw new Error("0.1.5 must not call settings.configure()"); },
		describe: () => [{ ns: SETTINGS_NAMESPACE, value: { colorScheme: "blue", defaultView: "month" } }],
		update: async () => {}
	});
	apply(ctx015);
	check("0.1.5: settings.register called", calls015.registered.length === 1, `count=${calls015.registered.length}`);
	check("0.1.5: register got the exact namespace", calls015.registered[0]?.ns === "token-heatmap");
	check("0.1.5: register got the schema", typeof calls015.registered[0]?.schema === "function");
	check("0.1.5: no unrelated warning", ctx015.warns.length === 0, ctx015.warns.join(" | "));

	// ---- branch B: 0.1.7-rc.2 host shape (register absent) --------------
	const calls017 = { configured: [] };
	const ctx017 = makeCtx({
		register: void 0,                                    // 0.1.7 SettingsForms has none
		get: void 0,                                         // ...and no get(ns)
		configure: (presentation, owner) => { calls017.configured.push({ presentation, owner }); return () => {}; },
		describe: () => [{ ns: SETTINGS_NAMESPACE, value: { colorScheme: "purple", defaultView: "year" } }],
		update: async () => {}
	});
	apply(ctx017);
	check("0.1.7: settings.configure called", calls017.configured.length === 1, `count=${calls017.configured.length}`);
	check("0.1.7: configure suppresses the auto page", calls017.configured[0]?.presentation?.auto === false, JSON.stringify(calls017.configured[0]?.presentation));
	check("0.1.7: configure bound to the caller fiber", calls017.configured[0]?.owner === ctx017.fiber);
	check("0.1.7: no unrelated warning", ctx017.warns.length === 0, ctx017.warns.join(" | "));

	// ---- serveConfig reads describe(), present on BOTH trains -----------
	// `get(ns)` does not exist on 0.1.7, so describe() is the only shared read.
	const served015 = serveConfig(ctx015);
	check("serveConfig(0.1.5) reads describe()",
		served015.colorScheme === "blue" && served015.defaultView === "month", JSON.stringify(served015));
	const served017 = serveConfig(ctx017);
	check("serveConfig(0.1.7) reads describe()",
		served017.colorScheme === "purple" && served017.defaultView === "year", JSON.stringify(served017));
	check("serveConfig reports the retired enabled switch as constant true",
		served015.enabled === true && served017.enabled === true, JSON.stringify([served015.enabled, served017.enabled]));

	// A Host that serves nothing falls back to defaults instead of throwing.
	const servedEmpty = serveConfig(makeCtx({ describe: () => [], update: async () => {} }));
	check("serveConfig falls back to defaults when the namespace is not served",
		servedEmpty.colorScheme === "green" && servedEmpty.defaultView === "year", JSON.stringify(servedEmpty));

	// An unknown view mode must not leak through the read path either.
	const servedJunk = serveConfig(makeCtx({ describe: () => [{ ns: SETTINGS_NAMESPACE, value: { colorScheme: "teal", defaultView: "week" } }], update: async () => {} }));
	check("serveConfig rejects an unknown view mode", servedJunk.defaultView === "year", JSON.stringify(servedJunk));

	// A settings service with NEITHER register nor configure must not crash
	// apply() — the plugin still registers its routes and listeners.
	apply(makeCtx({ describe: () => [], update: async () => {} }));
	check("apply survives a settings service with no register/configure", true);

	// ---- client: one settings branch per train --------------------------
	globalThis.window = {};
	let bundle = null;
	globalThis.window.__ModuleLoader__ = { load: (spec) => { bundle = spec; } };
	// Resolve the React peers from whichever tree carries them: react/react-dom
	// may sit in the DSH profiles dir or in this repo's node_modules.
	const reactBases = [
		join(process.env.USERPROFILE ?? os.homedir(), ".dsh", "profiles", "node_modules", "react", "package.json"),
		join(process.cwd(), "node_modules", "react", "package.json")
	].filter(existsSync);
	assert.ok(reactBases.length > 0, "react must be resolvable for the client half of this smoke");
	const peers = {};
	for (const name of ["react", "react/jsx-runtime", "react-dom"]) {
		for (const candidate of reactBases) {
			try {
				peers[name] = createRequire(pathToFileURL(candidate))(name);
				break;
			} catch { /* try the next tree */ }
		}
		assert.ok(peers[name] !== void 0, `${name} must be resolvable (the card portals through react-dom)`);
	}
	await import(new URL("../lib/client.js", import.meta.url).href);
	const clientExports = bundle.factory((name) => {
		if (peers[name] !== void 0) return peers[name];
		throw new Error(`unexpected require: ${name}`);
	});

	check("client inject is the two-train intersection",
		JSON.stringify(clientExports.inject) === JSON.stringify(["slots", "locale", "connection", "remote"]),
		JSON.stringify(clientExports.inject));
	check("client inject must NOT name settingsScope",
		!clientExports.inject.includes("settingsScope"), JSON.stringify(clientExports.inject));

	// 0.1.5 train: settingsScope present, configForms absent. The service is hung
	// on ctx.child (what ctx.inject's callback receives) BEFORE apply() runs.
	const scopeBindings = [];
	const ctxClient015 = makeClientCtx(new Map([["settingsScope", null]]));
	ctxClient015.child.settingsScope = { bind: (spec) => { scopeBindings.push(spec); return makeMinimalScope(); } };
	clientExports.apply(ctxClient015);
	check("0.1.5 client binds settingsScope",
		scopeBindings.length === 1 && scopeBindings[0].namespace === "token-heatmap", JSON.stringify(scopeBindings));
	check("0.1.5 client registers the heatmap dock entry",
		ctxClient015.injectedSlots.includes("conversation.input.dock"), JSON.stringify(ctxClient015.injectedSlots));

	// 0.1.7 train: configForms present, settingsScope absent.
	const formBindings = [];
	const ctxClient017 = makeClientCtx(new Map([["configForms", null]]));
	ctxClient017.child.configForms = { get: (ns) => { formBindings.push(ns); return makeMinimalScope(); } };
	clientExports.apply(ctxClient017);
	check("0.1.7 client asks configForms for the namespace",
		formBindings.length === 1 && formBindings[0] === "token-heatmap", JSON.stringify(formBindings));
	check("0.1.7 client never binds settingsScope",
		scopeBindings.length === 1, `scopeBindings=${scopeBindings.length}`);

	// Both trains register the SAME dock entry and neither claims a settings
	// card seat: the card configures itself through its own ⚙ panel, so the
	// official 插件配置 seat must stay untouched on either train.
	check("both trains register the same dock entry",
		ctxClient015.injectedSlots.includes("conversation.input.dock") && ctxClient017.injectedSlots.includes("conversation.input.dock"));
	check("neither train claims a settings card seat",
		![...ctxClient015.injectedSlots, ...ctxClient017.injectedSlots]
			.some((n) => n === "settings.plugin.item" || n === "plugins.bundle.config" || n === "settings.plugins.tab"),
		JSON.stringify([...ctxClient015.injectedSlots, ...ctxClient017.injectedSlots]));
	check("dock registration keeps id/locale/order",
		ctxClient015.registered.length === 1
			&& ctxClient015.registered[0].options.id === "token-heatmap"
			&& ctxClient015.registered[0].options.order === 10
			&& ctxClient015.registered[0].options.locale === "tokenHeatmap",
		JSON.stringify(ctxClient015.registered[0]?.options));
} finally {
	rmSync(home, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\ncompat smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
