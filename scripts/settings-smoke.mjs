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
assert.deepEqual(TokenHeatmapSettingsSchema({}), { enabled: true, colorScheme: "green" });

// Explicit values pass through.
assert.deepEqual(TokenHeatmapSettingsSchema({ enabled: false, colorScheme: "blue" }), { enabled: false, colorScheme: "blue" });

// Non-boolean enabled is rejected → the Host refuses the write.
assert.throws(() => TokenHeatmapSettingsSchema({ enabled: "yes" }), /enabled/, "non-boolean enabled must throw");

// Blank scheme is rejected (min length 1).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "" }), /colorScheme/, "blank scheme must throw");

// Overlong scheme is rejected (max length 32, matching parseConfig).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "x".repeat(40) }), /colorScheme/, "overlong scheme must throw");

// Unknown-but-well-formed scheme is preserved verbatim, so a newer client's
// palette survives (the client falls back to green while rendering).
const resolved = TokenHeatmapSettingsSchema({ colorScheme: "rainbow" });
assert.deepEqual(resolved, { enabled: true, colorScheme: "rainbow" }, "unknown scheme must be preserved");

// ---- Cordis Config export (DSH 0.1.7 projects the settings form from it) ----
// It MUST be exported for 0.1.7 (SettingsForms reads entry.fiber.runtime.Config),
// and MUST be harmless on 0.1.5 (cordis resolveConfig turns it into ctx.config
// defaults, which this plugin never reads).
assert.equal(typeof Config, "function", "Config schema must be exported");
// `toJSON()` emits a flat reference table ({uid, refs}), so walk the live
// schema's own `dict` for the field set rather than dereferencing refs.
assert.deepEqual(Object.keys(Config.dict).sort(), ["colorScheme", "enabled"], "Config must expose exactly the two settings fields");
assert.equal(typeof Config.toJSON, "function", "Config must serialize for the settings wire");
assert.ok(Config.toJSON().refs, "serialized Config must carry the reference table the settings form consumes");

// Both fields must be marked volatile — 0.1.7's volatileForm() keeps only
// meta.volatile nodes, so an unmarked field never reaches the settings form
// and `settings.update()` refuses with "has no volatile fields".
assert.equal(Config.dict.enabled.meta.volatile, true, "enabled must be volatile");
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
assert.equal(unwrap(defaults.enabled), true, "enabled default");
assert.equal(unwrap(defaults.colorScheme), "green", "colorScheme default");
const explicit = Config({ enabled: false, colorScheme: "teal" });
assert.equal(unwrap(explicit.enabled), false, "explicit enabled");
assert.equal(unwrap(explicit.colorScheme), "teal", "explicit scheme");

console.log("settings schema contract smoke passed");
