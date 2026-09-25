/**
 * Cross-version compatibility smoke: asserts the plugin takes exactly ONE
 * settings branch per DSH train, and that reads/writes depend only on the
 * API surface both trains share.
 *
 * 0.1.5-rc.3 — SettingsProvider exposes register(ns, schema, options) and
 *              get(ns); there is no configure().
 * 0.1.7-rc.2 — SettingsForms has NO register() and NO get(ns); it exposes
 *              configure(presentation, owner) and projects forms from the
 *              plugin's Config export.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply, serveConfig, SETTINGS_NAMESPACE, collectUsage } from "../lib/index.js";

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

/** Minimal ctx whose settings surface mimics one DSH train. */
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
	let snapshot = { status: "loading", value: void 0, writable: false, mode: "host" };
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
		set: async () => {},
		unset: async () => {}
	};
}

/**
 * A client context for one train. The root context and the child handed to
 * ctx.inject's callback share one slot recorder — in cordis the child inherits
 * the parent's slot service, so registrations made inside a branch must be
 * visible on the root.
 */
function makeClientCtx(providedServices) {
	const registered = [];
	const injectedSlots = [];
	const slots = {
		register: (options, component) => { registered.push({ options, component }); return () => {}; },
		// Execute the factory so the registration's options land in `registered`;
		// the real slot runtime does the same once the slot is declared.
		inject: (name, factory) => { injectedSlots.push(name); if (typeof factory === "function") factory(); return () => {}; }
	};
	const ctx = {
		registered,
		injectedSlots,
		slots,
		locale: { register: () => () => {}, bind: () => (key) => key },
		effect: (fn) => fn(),
		// cordis semantics: the callback runs ONLY when every requested service
		// is present; otherwise that fiber stays pending, silently. The child
		// handed to the callback shares the root's slot service.
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
	// ---- persisted enumeration uses ONLY list() ------------------------
	// readFrom()/listSnapshots() do not exist on SessionPersistence in EITHER
	// train (the abstract class has create/open/flush/stat/list only). The
	// old code called them anyway, so every request logged a warning that was
	// swallowed. The cleanup must: collect ids through list(), never touch the
	// absent members, and still let the call succeed.
	const logged = [];
	const ctxPersist = {
		logger: { warn: (m) => logged.push(String(m)) },
		get: (name) => {
			if (name === "sessions") return { list: () => [] };
			if (name === "sessionPersistence") {
				return {
					list: async () => [{ header: { id: "persisted-1" } }],
					// Trap accessors: merely READING either member fails loudly
					// instead of passing the way a mock method implementation would.
					get listSnapshots() { throw new Error("listSnapshots() must not be read"); },
					get readFrom() { throw new Error("readFrom() must not be read"); }
				};
			}
			return void 0;
		}
	};
	const persistResult = await collectUsage(ctxPersist);
	check("persisted enumeration succeeds with list() alone", persistResult !== void 0 && typeof persistResult.total === "number");
	check("absent listSnapshots/readFrom are never touched", logged.length === 0, logged.join(" | "));

	// ---- branch A: 0.1.5-rc.3 shape (register present) ----------------
	const calls015 = { registered: [] };
	const ctx015 = makeCtx({
		register: (ns, schema) => { calls015.registered.push({ ns, schema }); return { get: () => ({}) }; },
		// Sentinel: taking 0.1.7's branch on a 0.1.5 host would land here.
		configure: () => { throw new Error("0.1.5 must not call settings.configure()"); },
		describe: () => [{ ns: SETTINGS_NAMESPACE, value: { enabled: false, colorScheme: "blue" } }],
		update: async () => {}
	});
	apply(ctx015);
	check("0.1.5: settings.register called", calls015.registered.length === 1, `count=${calls015.registered.length}`);
	check("0.1.5: register got the exact namespace", calls015.registered[0]?.ns === "token-heatmap");
	check("0.1.5: register got the schema", typeof calls015.registered[0]?.schema === "function");
	check("0.1.5: no unrelated warning", ctx015.warns.length === 0, ctx015.warns.join(" | "));

	// ---- branch B: 0.1.7-rc.2 shape (register absent) -----------------
	const calls017 = { registered: 0, configured: [] };
	const ctx017 = makeCtx({
		register: void 0,                                    // 0.1.7 SettingsForms has none
		get: void 0,                                         // ...and no get(ns)
		configure: (presentation, owner) => { calls017.configured.push({ presentation, owner }); return () => {}; },
		describe: () => [{ ns: SETTINGS_NAMESPACE, value: { enabled: true, colorScheme: "purple" } }],
		update: async () => {}
	});
	apply(ctx017);
	check("0.1.7: settings.register NOT called", calls017.registered === 0);
	check("0.1.7: settings.configure called", calls017.configured.length === 1, `count=${calls017.configured.length}`);
	check("0.1.7: configure suppresses auto page", calls017.configured[0]?.presentation?.auto === false, JSON.stringify(calls017.configured[0]?.presentation));
	check("0.1.7: configure bound to the caller fiber", calls017.configured[0]?.owner === ctx017.fiber);
	check("0.1.7: no unrelated warning", ctx017.warns.length === 0, ctx017.warns.join(" | "));

	// ---- reads go through describe(), present on BOTH trains ----------
	const served015 = serveConfig(ctx015);
	check("serveConfig(0.1.5) reads describe()", served015.enabled === false && served015.colorScheme === "blue", JSON.stringify(served015));
	const served017 = serveConfig(ctx017);
	check("serveConfig(0.1.7) reads describe()", served017.enabled === true && served017.colorScheme === "purple", JSON.stringify(served017));

	// A Host that serves nothing falls back to defaults instead of throwing.
	const servedEmpty = serveConfig(makeCtx({ describe: () => [], update: async () => {} }));
	check("serveConfig falls back to defaults when the namespace is not served",
		servedEmpty.enabled === true && servedEmpty.colorScheme === "green", JSON.stringify(servedEmpty));

	// A settings service with NEITHER register nor configure must not crash
	// apply() — the plugin still registers its routes and listeners.
	const ctxBare = makeCtx({ describe: () => [], update: async () => {} });
	apply(ctxBare);
	check("apply survives a settings service with no register/configure", true);

	// ---- client: one branch per train ---------------------------------
	// The browser half must register with the inject set BOTH trains provide,
	// then take exactly one of the two configuration paths.
	globalThis.window = {};
	let bundle = null;
	globalThis.window.__ModuleLoader__ = { load: (spec) => { bundle = spec; } };
	const reactPkg = [
		join(process.env.USERPROFILE ?? os.homedir(), ".dsh", "profiles", "node_modules", "react", "package.json"),
		join(process.cwd(), "node_modules", "react", "package.json")
	].find((p) => existsSync(p));
	assert.ok(reactPkg, "react must be resolvable for the client half of this smoke");
	const requireReact = createRequire(pathToFileURL(reactPkg));
	// Pass the URL itself: on Windows `new URL(...).pathname` yields "/D:/..."
	// and re-wrapping that in pathToFileURL produces a "D:\D:\..." path.
	await import(new URL("../lib/client.js", import.meta.url).href);
	const clientExports = bundle.factory((name) => requireReact(name));

	check("client inject is the two-train intersection",
		JSON.stringify(clientExports.inject) === JSON.stringify(["slots", "locale", "connection", "remote"]),
		JSON.stringify(clientExports.inject));
	check("client inject must NOT name settingsScope",
		!clientExports.inject.includes("settingsScope"), JSON.stringify(clientExports.inject));

	// 0.1.5 train: settingsScope present, configForms absent. The service is
	// hung on ctx.child (the object ctx.inject's callback receives) BEFORE
	// apply() runs.
	const scopeBindings = [];
	const ctxClient015 = makeClientCtx(new Map([["settingsScope", null]]));
	ctxClient015.child.settingsScope = { bind: (spec) => { scopeBindings.push(spec); return makeMinimalScope(); } };
	clientExports.apply(ctxClient015);
	check("0.1.5 client binds settingsScope",
		scopeBindings.length === 1 && scopeBindings[0].namespace === "token-heatmap", JSON.stringify(scopeBindings));
	check("0.1.5 client registers the settings tab",
		ctxClient015.injectedSlots.includes("settings.plugins.tab"), JSON.stringify(ctxClient015.injectedSlots));

	// 0.1.7 train: configForms present, settingsScope absent.
	const formBindings = [];
	const ctxClient017 = makeClientCtx(new Map([["configForms", null]]));
	ctxClient017.child.configForms = { get: (ns) => { formBindings.push(ns); return makeMinimalScope(); } };
	clientExports.apply(ctxClient017);
	check("0.1.7 client asks configForms for the namespace",
		formBindings.length === 1 && formBindings[0] === "token-heatmap", JSON.stringify(formBindings));
	check("0.1.7 client registers the settings tab",
		ctxClient017.injectedSlots.includes("settings.plugins.tab"), JSON.stringify(ctxClient017.injectedSlots));
	check("0.1.7 client never binds settingsScope",
		scopeBindings.length === 1, `scopeBindings=${scopeBindings.length}`);

	// BOTH trains must land on the SAME slot — that is the whole point of the
	// settings.plugins.tab seat: it is declared by ui-settings-plugins on either
	// train, unlike settings.plugin.item (0.1.5 only) and plugins.bundle.config
	// (0.1.7 only, and only with the official ui-plugin-manager installed).
	check("both trains use the same shared slot",
		ctxClient015.injectedSlots.includes("settings.plugins.tab") && ctxClient017.injectedSlots.includes("settings.plugins.tab"));
	check("neither train uses a train-specific settings slot",
		![...ctxClient015.injectedSlots, ...ctxClient017.injectedSlots]
			.some((n) => n === "settings.plugin.item" || n === "plugins.bundle.config"),
		JSON.stringify([...ctxClient015.injectedSlots, ...ctxClient017.injectedSlots]));

	// The tab registration must be a well-formed LIST entry: id, order, label.
	const tab = ctxClient015.registered.find((e) => e.options.name === "settings.plugins.tab");
	check("settings tab registration found", tab !== void 0);
	check("settings tab carries id/order/label",
		tab !== void 0 && tab.options.id === "token-heatmap" && typeof tab.options.order === "number" && typeof tab.options.label === "function",
		JSON.stringify(tab?.options));
	check("settings tab label resolves through the dictionary",
		tab !== void 0 && tab.options.label() === "settingsTabLabel", String(tab?.options.label?.()));
	check("settings tab mounts the settings card component",
		tab !== void 0 && tab.component === clientExports.TokenHeatmapSettingsCard);
} finally {
	rmSync(home, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\ncompat smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
