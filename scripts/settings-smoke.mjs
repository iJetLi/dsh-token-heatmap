// Contract smoke for the Host-side settings namespace + schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as
// the settings service relies on (`schema(mergedSection)`): an empty user
// section resolves through the defaults, malformed writes are rejected, and
// an unknown-but-well-formed scheme survives (the client renders it with its
// green fallback, mirroring the legacy parseConfig leniency).
import assert from "node:assert/strict";
import { SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema, Config } from "../lib/index.js";

// Namespace branding: the exact string the client card keys on.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "token-heatmap", "namespace must be token-heatmap");

// Empty section → schema defaults.
assert.deepEqual(TokenHeatmapSettingsSchema({}), { colorScheme: "green", defaultView: "year" });

// Explicit values pass through.
assert.deepEqual(TokenHeatmapSettingsSchema({ colorScheme: "blue", defaultView: "month" }), { colorScheme: "blue", defaultView: "month" });

// The 0.1.x display switch is not part of the schema any more. Schemastery
// passes an undeclared key through untouched, so a stale `enabled` survives in
// the resolved section — which is fine: nothing reads it (serveConfig reports a
// constant true, and the client no longer gates on it).
assert.deepEqual(TokenHeatmapSettingsSchema({ enabled: false }), { enabled: false, colorScheme: "green", defaultView: "year" }, "retired enabled is inert");
assert.equal(TokenHeatmapSettingsSchema({ enabled: false }).colorScheme, "green", "retired enabled must not affect the resolved defaults");

// Blank scheme is rejected (min length 1).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "" }), /colorScheme/, "blank scheme must throw");

// Overlong scheme is rejected (max length 32, matching parseConfig).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "x".repeat(40) }), /colorScheme/, "overlong scheme must throw");

// Unknown-but-well-formed scheme is preserved verbatim, so a newer client's
// palette survives (the client falls back to green while rendering).
const resolved = TokenHeatmapSettingsSchema({ colorScheme: "rainbow" });
assert.deepEqual(resolved, { colorScheme: "rainbow", defaultView: "year" }, "unknown scheme must be preserved");

// The view mode IS enumerated (unlike the scheme): an unknown mode has no
// renderer to fall back to in the client, so the Host refuses the write.
assert.throws(() => TokenHeatmapSettingsSchema({ defaultView: "week" }), /defaultView/, "unknown view mode must throw");
assert.equal(TokenHeatmapSettingsSchema({ defaultView: "month" }).defaultView, "month");
assert.equal(TokenHeatmapSettingsSchema({}).defaultView, "year", "view default must be year");

// ---- Cordis Config export (DSH 0.1.7 projects the settings form from it) ----
// It MUST be exported for 0.1.7 (SettingsForms reads entry.fiber.runtime.Config),
// and MUST be harmless on 0.1.5 (cordis resolveConfig turns it into ctx.config
// defaults, which this plugin never reads).
assert.equal(typeof Config, "function", "Config schema must be exported");
// `toJSON()` emits a flat reference table ({uid, refs}), so walk the live
// schema's own `dict` for the field set rather than dereferencing refs.
assert.deepEqual(Object.keys(Config.dict).sort(), ["colorScheme", "defaultView"], "Config must expose exactly the two settings fields");
assert.equal(typeof Config.toJSON, "function", "Config must serialize for the settings wire");
assert.ok(Config.toJSON().refs, "serialized Config must carry the reference table the settings form consumes");

// Both fields must be marked volatile — 0.1.7's volatileForm() keeps only
// meta.volatile nodes, so an unmarked field never reaches the settings form
// and `settings.update()` refuses with "has no volatile fields".
assert.equal(Config.dict.defaultView.meta.volatile, true, "defaultView must be volatile");
assert.equal(Config.dict.colorScheme.meta.volatile, true, "colorScheme must be volatile");

// Defaults resolve so a profile entry with no config: block still serves a
// complete section. On schemastery >= 3.18.4 (bundled with DSH 0.1.7) a
// volatile field parses to a `Volatile<T>` wrapper carrying `.get()` — the
// exact type the official Config exports declare (`preference:
// Volatile<string>`) and what 0.1.7's plainConfig() unwraps via isVolatile().
// On 3.18.2 (DSH 0.1.5) the flag is inert and values stay plain. Accept both
// shapes so this smoke runs against either schemastery.
const unwrap = (value) => value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
const defaults = Config({});
assert.equal(unwrap(defaults.colorScheme), "green", "colorScheme default");
assert.equal(unwrap(defaults.defaultView), "year", "defaultView default");
const explicit = Config({ colorScheme: "teal", defaultView: "month" });
assert.equal(unwrap(explicit.colorScheme), "teal", "explicit scheme");
assert.equal(unwrap(explicit.defaultView), "month", "explicit view");

console.log("settings schema contract smoke passed");
