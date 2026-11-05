#!/usr/bin/env node
// Settings-default drift gate.
//
// A setting's default can be written down in three places:
//
//   1. The manifest `config` default, the source of truth.
//   2. The settings control `default` in settings.js getSettings().
//   3. Code fallbacks (`config.x ?? 2`, `config.flag !== false`).
//
// What (2) and (3) do depends on the Kage host.
//
// Current hosts list 'config.manifest_defaults' in context.hostFeatures.
// context.config is the manifest defaults overlaid with the saved values,
// so every declared key is present and (3) never applies to it. Settings
// shows the manifest default for a declared id and ignores the control's
// own (2), and Save stores only the page's values that differ from the
// manifest default, keeping every other saved key. `enabled` is the host's:
// it is the Settings header's Disable/Enable switch, a saved value is
// ignored, and a settings control with that id is hidden and never saved.
//
// Older hosts give the extension the saved object as it is whenever one
// exists (the manifest defaults only when nothing was ever saved), so a key
// the saved object lacks is undefined and (3) applies. Settings shows (2)
// for a never-saved value, and Save replaces the whole stored object with
// every value control on the page, after normalize(). An `enabled` control
// is an ordinary checkbox there.
//
// An extension can't require a minimum host version, so until every
// supported Kage has 'config.manifest_defaults', the three must agree. When
// (1) and (2) disagreed, an older host's Settings page was wrong: Math's
// showed precision 2 while 29/34 rendered "= 1" (manifest default 0) for
// every user who had never saved Math settings. Keep (2) and (3) in one
// DEFAULTS constant in the extension's defaults.js (see extensions/math),
// which this script compares with (1).
//
// Checks, per extension:
//
// - Manifest: every config entry has a supported type and a default of
//   that type, and none of them is `enabled`.
// - defaults.js, if there is one: it exports a DEFAULTS object whose every
//   key the manifest declares with the same default, and code reads only
//   DEFAULTS keys that exist.
// - Settings controls (2). Providers build their schema in code (translated
//   strings, async lookups, values derived from config, branches on
//   hostFeatures), so a regex over settings.js can't see the real defaults.
//   This script imports each settings provider in Node and calls
//   getSettings() with stub contexts for a fresh install, once per host
//   generation. Both have invoke() resolving null for every command (no
//   extension data) and i18n.t backed by the extension's EN catalog. The
//   older host's has config {} (what its Settings window passes for an
//   unsaved extension) and no hostFeatures; the current host's has the
//   manifest defaults plus `enabled: true` as config and hostFeatures
//   including 'config.manifest_defaults'. For each value control:
//     - its id isn't `enabled`, in either schema;
//     - the manifest declares the id, with the same type;
//     - older hosts: what Save stores for an untouched control equals the
//       manifest default. That's the control default, coerced the way the
//       host renderer coerces it, then passed through the provider's
//       normalize() (window-walker shows "w" and stores "w "). A key
//       normalize() leaves out is stored as shown;
//     - current hosts, with the schema the provider builds there: normalize()
//       leaves the manifest default as it is. Otherwise saving an untouched
//       page stores the changed value as the user's own;
//     - a select's default is one of its options.
//   Helper fields are exempt: inputs for an action button (github's token
//   box), whose id starts with `__` and which the manifest doesn't declare.
//   getSettings() also runs under a pseudo-locale on the older host: a
//   translated default can't equal one fixed manifest value in every
//   language. (Current hosts show the manifest default instead.)
// - Code fallbacks (3), a best-effort static scan of every non-test .js
//   file. A literal fallback (`config.x ?? 5`, `config.x || 'gh'`) must
//   equal the manifest default. A boolean that defaults to true must not be
//   read by truthiness (`!config.x`, `config.x &&`, `if (config.x)`) or
//   compared with `true`, because that turns a missing key off, and one
//   that defaults to false must not be tested with `=== false` /
//   `!== false`. `enabled` counts as a boolean that defaults to true, since
//   older hosts leave it unset. The scan can't follow values through
//   helpers or variables. To skip a line, put `check-defaults: ignore` in a
//   comment on it.
//
// Runs against every extension every time (quick, and depends only on repo
// content), like validate-manifests and check-tests. Single pass: every
// issue is collected, then the script exits non-zero.

import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const GET_SETTINGS_TIMEOUT_MS = 5000;

/** The manifest config type each value-bearing control type stores. */
const CONTROL_VALUE_TYPE = Object.freeze({
    checkbox: 'boolean',
    text: 'string',
    select: 'string',
    number: 'number',
    range: 'number',
});

/** Types Kage's manifest `config` schema supports (docs/EXTENSIONS.md). */
const MANIFEST_TYPES = new Set(['boolean', 'string', 'number']);

const IGNORE_MARKER = 'check-defaults: ignore';

/** The host-owned config key: the Settings header's Disable/Enable switch. */
const ENABLED_KEY = 'enabled';

/**
 * How code must treat keys the host owns, which manifests don't declare.
 * `enabled` means on unless it's `false`: older hosts leave it unset.
 */
const HOST_KEYS = Object.freeze({ [ENABLED_KEY]: Object.freeze({ type: 'boolean', default: true }) });

/** Where an extension keeps its DEFAULTS constant (see extensions/math). */
const DEFAULTS_MODULE = 'defaults.js';

/**
 * `context.hostFeatures` of a current host. Mirrors HOST_FEATURES in Kage
 * ui/js/extension-sandbox/runtime/host-api.js.
 */
export const CURRENT_HOST_FEATURES = Object.freeze([
    'settings.copy_action',
    'invoke.error_kind',
    'config.manifest_defaults',
]);

/**
 * Id prefix for helper fields: inputs read by an action button (github's
 * `__token_input`, spotify's `__setup_client_id`), not config the extension
 * runs with. The repo's normalize() implementations strip them.
 */
const HELPER_PREFIX = '__';
const isHelperField = (id) => id.startsWith(HELPER_PREFIX);

// --- Host value semantics ---------------------------------------------------
// Mirrors Kage ui/js/shared/settings-renderer.js. Keep in sync.

/**
 * The value Settings shows for a never-saved control: coerceValue(ctrl,
 * ctrl.default). Current hosts first replace `ctrl.default` with the
 * manifest default for an id the manifest declares (withManifestDefault).
 */
export function shownDefault(ctrl) {
    const v = ctrl.default;
    switch (ctrl.type) {
        case 'checkbox':
            return !!v;
        case 'number':
        case 'range': {
            if (v == null || v === '') return ctrl.default ?? ctrl.min ?? 0;
            const n = Number(v);
            return Number.isFinite(n) ? n : (ctrl.default ?? ctrl.min ?? 0);
        }
        default:
            return v == null ? (ctrl.default ?? '') : String(v);
    }
}

/**
 * The value Save reads back from a control showing `value`:
 * _writeToControl then _readFromControl, the same on every host. Older
 * hosts store it as is; current hosts store it only when it differs from
 * the manifest default.
 */
export function storedValue(ctrl, value) {
    switch (ctrl.type) {
        case 'checkbox':
            return !!value;
        case 'number':
        case 'range': {
            const raw = ctrl.type === 'range' ? String(value) : value == null ? '' : String(value);
            if (raw === '') return ctrl.default ?? 0;
            const n = Number(raw);
            return Number.isFinite(n) ? n : (ctrl.default ?? 0);
        }
        default:
            return value == null ? '' : String(value);
    }
}

/**
 * `ctrl` as a current host renders it: with the manifest default for an id
 * the manifest declares (Kage RenderedSettings._withManifestDefaults).
 * Scratch (`__`) ids and `enabled` keep their own default, because the
 * host's manifestConfigDefaults leaves those keys out.
 */
export function withManifestDefault(ctrl, manifestConfig) {
    const id = ctrl.id;
    if (id === ENABLED_KEY || isHelperField(id)) return ctrl;
    const spec = manifestConfig?.[id];
    if (!spec || typeof spec !== 'object' || !Object.hasOwn(spec, 'default')) return ctrl;
    return { ...ctrl, default: spec.default };
}

// --- Settings provider harness ---------------------------------------------

function interpolate(template, vars) {
    if (typeof template !== 'string') return '';
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
        vars && name in vars ? String(vars[name]) : whole
    );
}

/**
 * The config a current host gives a never-saved extension: the manifest
 * defaults (without `__` ids and `enabled`, like Kage's
 * manifestConfigDefaults) and the host's `enabled`.
 */
export function currentHostConfig(manifestConfig) {
    const out = {};
    if (manifestConfig && typeof manifestConfig === 'object' && !Array.isArray(manifestConfig)) {
        for (const [key, spec] of Object.entries(manifestConfig)) {
            if (key === ENABLED_KEY || isHelperField(key)) continue;
            if (spec && typeof spec === 'object' && Object.hasOwn(spec, 'default')) out[key] = spec.default;
        }
    }
    out[ENABLED_KEY] = true;
    return out;
}

/**
 * A fresh install. On an older host (`current` null): config {} (what its
 * Settings window passes for an unsaved extension) and no hostFeatures, so
 * providers build the schema those hosts get, including anything kept only
 * for them. On a current host: config `current.config` and hostFeatures
 * CURRENT_HOST_FEATURES. `pseudo` wraps every translated string so a
 * default built from t() comes out different from the EN run.
 */
function makeStubContext(catalog, { pseudo = false, current = null } = {}) {
    const noop = () => {};
    const t = (key, vars) => {
        const text = interpolate(catalog?.[key]?.message ?? key, vars);
        return pseudo ? `⟦${text}⟧` : text;
    };
    const context = {
        config: current ? { ...current.config } : {},
        invoke: async () => null,
        log: { debug: noop, info: noop, warn: noop, error: noop },
        runSandboxed: async () => null,
        i18n: { t, language: () => (pseudo ? 'qps' : 'en'), isRtl: () => false },
        mascot: { setActivity: noop, clearActivity: noop },
        formatter: { requestReformat: noop },
    };
    if (current) context.hostFeatures = CURRENT_HOST_FEATURES;
    return context;
}

function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Instantiate the provider the way the sandbox runtime does and fetch its schema. */
async function runSettingsProvider(Cls, catalog, { pseudo = false, current = null, timeoutMs }) {
    const provider = new Cls();
    const init = provider.initialize?.(makeStubContext(catalog, { pseudo, current }));
    if (init && typeof init.then === 'function') init.catch(() => {});
    if (typeof provider.getSettings !== 'function') return { provider, schema: null };
    try {
        const schema = await withTimeout(
            Promise.resolve().then(() => provider.getSettings()),
            timeoutMs,
            'getSettings()'
        );
        return { provider, schema };
    } finally {
        try {
            provider.destroy?.();
        } catch {
            /* best effort */
        }
    }
}

function allControls(schema) {
    const out = [];
    for (const section of schema?.sections || []) {
        for (const ctrl of section?.controls || []) {
            if (ctrl && typeof ctrl === 'object') out.push(ctrl);
        }
    }
    return out;
}

function valueControls(schema) {
    return allControls(schema).filter(
        (ctrl) => typeof ctrl.id === 'string' && ctrl.type in CONTROL_VALUE_TYPE // not info, action, unknown
    );
}

const fmt = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

const ENABLED_CONTROL_ISSUE =
    `'${ENABLED_KEY}': no settings control may use the id "${ENABLED_KEY}", which belongs to the ` +
    `host. Current hosts hide such a control and never save it. Older hosts show it, and ` +
    `its value does nothing unless your code reads it. Users switch an extension off with ` +
    `the Disable/Enable button in its Settings header, so remove the control. (If it meant ` +
    `something else, give it another id.)`;

/**
 * normalize(values).values, or null when there's no normalize() or it
 * returned nothing usable: the runtime calls normalize() synchronously and
 * ignores anything without a `values` object (including a Promise).
 */
function runNormalize(normalize, values) {
    if (typeof normalize !== 'function') return { values: null };
    let out;
    try {
        out = normalize({ ...values });
    } catch (e) {
        return { values: null, error: e?.message || String(e) };
    }
    const ok = out && typeof out === 'object' && out.values && typeof out.values === 'object';
    return { values: ok ? out.values : null };
}

/**
 * What Save reads back from `ctrl`, which showed `shown`, after normalize().
 * The host writes back only the keys normalize() returned, then Save reads
 * every control, so a key normalize() left out is saved as shown.
 */
function savedValue(ctrl, shown, normalized) {
    return normalized !== null && Object.hasOwn(normalized, ctrl.id)
        ? storedValue(ctrl, normalized[ctrl.id])
        : shown;
}

const isSchema = (s) => !!s && typeof s === 'object' && Array.isArray(s.sections);

/** Value controls that hold config: all but an `enabled` one (reported on its own). */
const configControls = (schema) => valueControls(schema).filter((ctrl) => ctrl.id !== ENABLED_KEY);

/** Why a select control's shown value isn't one of its options, or null. */
function selectOptionIssue(ctrl, shownValue) {
    if (ctrl.type !== 'select' || !Array.isArray(ctrl.options)) return null;
    if (ctrl.options.some((o) => o && o.value === shownValue)) return null;
    return (
        `'${ctrl.id}': select default ${fmt(shownValue)} isn't one of its options ` +
        `(${ctrl.options.map((o) => fmt(o?.value)).join(', ')})`
    );
}

/**
 * Why `ctrl` can't be compared with its manifest entry `spec`, or null when
 * it can. `{ issue: null }` is an unsupported manifest type, which
 * checkManifestConfig reports.
 */
function declarationIssue(ctrl, spec, shownValue, stored) {
    const id = ctrl.id;
    const valueType = CONTROL_VALUE_TYPE[ctrl.type];
    if (!spec || typeof spec !== 'object') {
        return {
            issue:
                `'${id}': settings control has no manifest config entry, so a never-saved ` +
                `extension gets undefined while Settings shows ${fmt(shownValue)}. Add ` +
                `"${id}": { "type": "${valueType}", "default": ${fmt(stored)} } to the ` +
                `manifest's config. (If it's an input for an action button rather than ` +
                `config, give it an id starting with "${HELPER_PREFIX}".)`,
        };
    }
    if (!MANIFEST_TYPES.has(spec.type)) return { issue: null };
    if (spec.type !== valueType) {
        return {
            issue:
                `'${id}': ${ctrl.type} control stores a ${valueType} but the manifest ` +
                `declares type ${fmt(spec.type)}`,
        };
    }
    return null;
}

/**
 * Compare a provider's settings schemas against the manifest config: the
 * one it builds on an older host (Settings shows each control's own
 * default) and the one it builds on a current host (Settings shows the
 * manifest default). An id with an issue on the older host isn't checked
 * again for the current one.
 *
 * @param {object} schema           - getSettings() result on an older host (EN)
 * @param {object} manifestConfig   - manifest.config
 * @param {object} [opts]
 * @param {Function} [opts.normalize]        - the older-host provider's normalize, bound
 * @param {object}   [opts.pseudoSchema]     - getSettings() result on an older host, pseudo-locale
 * @param {object}   [opts.currentSchema]    - getSettings() result on a current host (default: `schema`)
 * @param {Function} [opts.currentNormalize] - the current-host provider's normalize, bound
 *                                             (default: opts.normalize)
 * @returns {string[]} issues
 */
export function compareSchemaToManifest(schema, manifestConfig, opts = {}) {
    const issues = [];
    if (!isSchema(schema)) {
        issues.push('getSettings() did not return a schema with a sections array');
        return issues;
    }
    const currentSchema = opts.currentSchema === undefined ? schema : opts.currentSchema;
    if (!isSchema(currentSchema)) {
        issues.push(
            `getSettings() did not return a schema with a sections array on a current host ` +
                `(context.hostFeatures including 'config.manifest_defaults')`
        );
        return issues;
    }
    if ([schema, currentSchema].some((s) => allControls(s).some((ctrl) => ctrl.id === ENABLED_KEY))) {
        issues.push(ENABLED_CONTROL_ISSUE);
    }

    // Older hosts: Settings shows each control's own default, and Save hands
    // normalize() every control's value.
    const controls = configControls(schema);
    const shown = {};
    for (const ctrl of controls) shown[ctrl.id] = storedValue(ctrl, shownDefault(ctrl));
    const older = runNormalize(opts.normalize, shown);

    // Current hosts: the schema the provider builds there, where a declared
    // id shows the manifest default.
    const currentControls = configControls(currentSchema).map((ctrl) => withManifestDefault(ctrl, manifestConfig));
    const currentShown = {};
    for (const ctrl of currentControls) currentShown[ctrl.id] = storedValue(ctrl, shownDefault(ctrl));
    const current = runNormalize(opts.currentNormalize ?? opts.normalize, currentShown);

    const threw = older.error ?? current.error;
    if (threw !== undefined) issues.push(`normalize() threw on the default values: ${threw}`);

    const pseudoShown = {};
    for (const ctrl of valueControls(opts.pseudoSchema)) {
        pseudoShown[ctrl.id] = storedValue(ctrl, shownDefault(ctrl));
    }

    const examined = new Set(); // ids the older-host pass compared
    const reported = new Set(); // ids with an issue (or an unsupported manifest type)
    const report = (id, message) => {
        if (message) issues.push(message);
        reported.add(id);
    };

    for (const ctrl of controls) {
        const id = ctrl.id;
        const spec = manifestConfig?.[id];
        // A helper field: input for an action button (e.g. a token box), not config.
        if (isHelperField(id) && !spec) continue;
        examined.add(id);

        const shownValue = shown[id];
        const stored = savedValue(ctrl, shownValue, older.values);

        if (Object.hasOwn(pseudoShown, id) && !Object.is(pseudoShown[id], shownValue)) {
            report(
                id,
                `'${id}': the control default depends on the UI language (it's built ` +
                    `from t()), but the manifest default is one fixed value, so in other ` +
                    `languages older hosts' Settings shows a different value from the one ` +
                    `the extension uses. Use a fixed default, show the translated text as a ` +
                    `placeholder, and fall back to it in code (see extensions/hello-world).`
            );
            continue;
        }

        const optionIssue = selectOptionIssue(ctrl, shownValue);
        if (optionIssue) report(id, optionIssue);

        const declared = declarationIssue(ctrl, spec, shownValue, stored);
        if (declared) {
            report(id, declared.issue);
            continue;
        }

        if (!Object.is(stored, spec.default)) {
            const via = Object.is(stored, shownValue)
                ? ''
                : ` (stored as ${fmt(stored)} after normalize())`;
            report(
                id,
                `'${id}': on older hosts Settings shows ${fmt(shownValue)}${via} for a ` +
                    `never-saved value and Save stores it, but the extension runs with the ` +
                    `manifest default ${fmt(spec.default)}. Make the control default and ` +
                    `manifest config.${id}.default the same (one DEFAULTS constant in ` +
                    `${DEFAULTS_MODULE}).`
            );
        }
    }

    for (const ctrl of currentControls) {
        const id = ctrl.id;
        const spec = manifestConfig?.[id];
        if (reported.has(id) || (isHelperField(id) && !spec)) continue;

        const shownValue = currentShown[id];
        const stored = savedValue(ctrl, shownValue, current.values);

        const optionIssue = selectOptionIssue(ctrl, shownValue);
        if (optionIssue) issues.push(optionIssue);

        // Already compared on the older host: the manifest declares it, same type.
        if (!examined.has(id)) {
            const declared = declarationIssue(ctrl, spec, shownValue, stored);
            if (declared) {
                if (declared.issue) issues.push(`${declared.issue} (Only on current hosts.)`);
                continue;
            }
        }

        if (!Object.is(stored, spec.default)) {
            issues.push(
                `'${id}': on current hosts Settings shows the manifest default ` +
                    `${fmt(spec.default)}, and normalize() turns it into ${fmt(stored)}, ` +
                    `so saving the page stores ${fmt(stored)} as the user's own value ` +
                    `even if they never changed it. normalize() must leave the manifest ` +
                    `default as it is.`
            );
        }
    }
    return issues;
}

/**
 * Manifest-only sanity: each config entry has a supported type and a
 * default of that type, and none is the host's `enabled`.
 */
export function checkManifestConfig(manifestConfig) {
    const issues = [];
    if (manifestConfig == null) return issues;
    if (typeof manifestConfig !== 'object' || Array.isArray(manifestConfig)) {
        return ['manifest "config" must be an object'];
    }
    for (const [key, spec] of Object.entries(manifestConfig)) {
        if (key === ENABLED_KEY) {
            issues.push(
                `config.${key}: don't declare "${key}", it belongs to the host (the ` +
                    `Disable/Enable button in the extension's Settings header). Current ` +
                    `hosts ignore this entry and set config.${key} themselves, and older ` +
                    `hosts hand its default to an extension that was never saved. Remove ` +
                    `it, and read \`config.${key} !== false\` where code needs it.`
            );
            continue;
        }
        if (!spec || typeof spec !== 'object') {
            issues.push(`config.${key} must be an object with "type" and "default"`);
            continue;
        }
        if (!MANIFEST_TYPES.has(spec.type)) {
            issues.push(
                `config.${key}.type must be one of ${[...MANIFEST_TYPES].join(', ')} (got ${fmt(spec.type)})`
            );
            continue;
        }
        if (typeof spec.default !== spec.type) {
            issues.push(
                `config.${key}.default ${fmt(spec.default)} is not a ${spec.type}`
            );
        }
    }
    return issues;
}

/**
 * defaults.js's DEFAULTS against the manifest: every key is declared there,
 * with the same default. (Not every manifest key needs to be in DEFAULTS,
 * only the ones a control or a code fallback uses.)
 *
 * @param {unknown} defaults - the module's DEFAULTS export
 * @param {object} manifestConfig - manifest.config
 * @returns {string[]} issues
 */
export function checkDefaultsModule(defaults, manifestConfig) {
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
        return ['must export a DEFAULTS object: `export const DEFAULTS = Object.freeze({ … })`'];
    }
    const issues = [];
    for (const [key, value] of Object.entries(defaults)) {
        if (key === ENABLED_KEY) {
            issues.push(
                `DEFAULTS.${key}: "${key}" belongs to the host, so it has no default to keep ` +
                    `here. Remove it, and read \`config.${key} !== false\`.`
            );
            continue;
        }
        const spec = manifestConfig?.[key];
        if (!spec || typeof spec !== 'object' || !Object.hasOwn(spec, 'default')) {
            issues.push(
                `DEFAULTS.${key} has no manifest config entry. Declare "${key}" in the ` +
                    `manifest's config with this default (current hosts take defaults only ` +
                    `from there), or remove it.`
            );
            continue;
        }
        if (!Object.is(value, spec.default)) {
            issues.push(
                `DEFAULTS.${key} is ${fmt(value)}, but the manifest default is ` +
                    `${fmt(spec.default)}. Older hosts use DEFAULTS and current hosts the ` +
                    `manifest, so the two must be equal.`
            );
        }
    }
    return issues;
}

// --- Static scan of code fallbacks -----------------------------------------

// `this.config.x`, `this._config?.x`, `config.x` (a parameter), `context.config.x`.
const REF = String.raw`\b_?config\??\.(\w+)`;
// Any receiver chain in front of `config`: `this.`, `this._`, `ctx?.`, ….
const RECEIVER = String.raw`(?:[\w$]+\??\.)*`;
// A number, a quoted string without escapes, or a boolean, followed by
// something that ends the operand (so `x || 5 * 60` isn't read as `|| 5`).
const LITERAL = String.raw`(-?\d+(?:\.\d+)?(?![\w.])|'[^'\\\n]*'|"[^"\\\n]*"|true\b|false\b)(?=\s*(?:[),;:\]}.?]|&&|\|\||$))`;
const LITERAL_FALLBACK_RE = new RegExp(
    String.raw`(?:Number\(\s*${RECEIVER}${REF}\s*\)|${REF})\s*(\?\?|\|\|)\s*${LITERAL}`,
    'g'
);

/** Patterns that read a boolean key so that a missing key reads as false. */
function truthinessPatterns(key) {
    const ref = String.raw`${RECEIVER}\b_?config\??\.${key}\b`;
    return [
        new RegExp(String.raw`!\s*${ref}`), // !config.x
        new RegExp(String.raw`!\s*\(\s*${ref}\s*\)`), // !(config.x)
        new RegExp(String.raw`${ref}\s*(?:&&|\?(?![?.]))`), // config.x && … / config.x ? … : …
        new RegExp(String.raw`&&\s*${ref}\s*(?:\)|&&|\?(?![?.]))`), // … && config.x)
        new RegExp(String.raw`\bif\s*\(\s*${ref}\s*\)`), // if (config.x)
        new RegExp(String.raw`${ref}\s*[!=]==\s*true\b`), // config.x === true
    ];
}

// `DEFAULTS.x` / `DEFAULTS?.x`.
const DEFAULTS_REF_RE = /\bDEFAULTS\??\.(\w+)/g;

function parseLiteral(src) {
    if (src === 'true') return true;
    if (src === 'false') return false;
    if (src.startsWith("'") || src.startsWith('"')) return src.slice(1, -1);
    return Number(src);
}

function isCommentLine(line) {
    const s = line.trimStart();
    return s.startsWith('//') || s.startsWith('/*') || s.startsWith('*');
}

/**
 * Scan one source file for code fallbacks that disagree with the manifest.
 *
 * @param {string} source
 * @param {object} manifestConfig
 * @returns {Array<{line: number, message: string}>}
 */
export function scanCodeFallbacks(source, manifestConfig) {
    const findings = [];
    // Host-owned keys are read the same way whether or not a manifest
    // (wrongly) declares them.
    const declared = manifestConfig && typeof manifestConfig === 'object' ? manifestConfig : {};
    const config = { ...declared, ...HOST_KEYS };
    const lines = source.split(/\r?\n/);

    const booleanKeys = Object.entries(config).filter(
        ([, spec]) => spec?.type === 'boolean' && typeof spec.default === 'boolean'
    );
    // Why `key` defaults to what it does, for the messages.
    const defaultIs = (key, spec) =>
        Object.hasOwn(HOST_KEYS, key)
            ? `\`${key}\` is the host's on/off switch, and older hosts leave it unset`
            : `the manifest default is ${fmt(spec.default)}`;

    lines.forEach((line, i) => {
        if (isCommentLine(line) || line.includes(IGNORE_MARKER)) return;
        const lineNo = i + 1;

        for (const m of line.matchAll(LITERAL_FALLBACK_RE)) {
            const key = m[1] ?? m[2];
            const op = m[3];
            const spec = config[key];
            if (!spec || typeof spec !== 'object' || !('default' in spec)) continue;
            const fallback = parseLiteral(m[4]);
            if (!Object.is(fallback, spec.default)) {
                findings.push({
                    line: lineNo,
                    message:
                        `config.${key} ${op} ${m[4]} falls back to ${fmt(fallback)}, but ` +
                        `${defaultIs(key, spec)}`,
                });
            }
        }

        for (const [key, spec] of booleanKeys) {
            if (spec.default === true) {
                if (truthinessPatterns(key).some((re) => re.test(line))) {
                    findings.push({
                        line: lineNo,
                        message:
                            `config.${key} is read by truthiness (or compared with true), so a ` +
                            `config without the key turns it off, but ${defaultIs(key, spec)}. ` +
                            `Test \`config.${key} !== false\` (or \`=== false\` to disable)` +
                            (Object.hasOwn(HOST_KEYS, key)
                                ? '.'
                                : `, or read \`config.${key} ?? DEFAULTS.${key}\`.`),
                    });
                }
            } else if (
                new RegExp(String.raw`\b_?config\??\.${key}\b\s*[!=]==\s*false\b`).test(line)
            ) {
                findings.push({
                    line: lineNo,
                    message:
                        `config.${key} is compared with false, so a config without the key ` +
                        `turns it on, but the manifest default is false. Test ` +
                        `\`config.${key} === true\` or plain truthiness.`,
                });
            }
        }
    });
    return findings;
}

/**
 * `DEFAULTS.x` reads of a key that defaults.js doesn't have. They're
 * undefined, so the fallback does nothing.
 *
 * @param {string} source
 * @param {object} defaults - the extension's DEFAULTS
 * @returns {Array<{line: number, message: string}>}
 */
export function scanDefaultsRefs(source, defaults) {
    const findings = [];
    source.split(/\r?\n/).forEach((line, i) => {
        if (isCommentLine(line) || line.includes(IGNORE_MARKER)) return;
        for (const m of line.matchAll(DEFAULTS_REF_RE)) {
            if (Object.hasOwn(defaults, m[1])) continue;
            findings.push({
                line: i + 1,
                message:
                    `DEFAULTS.${m[1]} isn't in ${DEFAULTS_MODULE}, so it's undefined. Add it ` +
                    `there with the manifest default, or fix the name.`,
            });
        }
    });
    return findings;
}

// --- Per-extension driver ---------------------------------------------------

async function readJsonIfExists(p) {
    try {
        return JSON.parse(await readFile(p, 'utf8'));
    } catch {
        return null;
    }
}

async function isFile(p) {
    try {
        return (await stat(p)).isFile();
    } catch {
        return false;
    }
}

async function listCodeFiles(dir) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && /\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name))
        .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
        .filter((rel) => !rel.split(path.sep).includes('node_modules'))
        .sort();
}

/**
 * Run every defaults check against one extension directory.
 *
 * @param {string} dir - absolute path to extensions/<id>
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<{file?: string, line?: number, message: string}>>}
 */
export async function checkExtension(dir, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? GET_SETTINGS_TIMEOUT_MS;
    const issues = [];
    const manifest = await readJsonIfExists(path.join(dir, 'manifest.json'));
    // Missing / unparseable manifests are validate-manifests.mjs's job.
    if (!manifest || typeof manifest !== 'object') return issues;

    const manifestConfig = manifest.config ?? {};
    for (const message of checkManifestConfig(manifest.config)) {
        issues.push({ file: 'manifest.json', message });
    }

    let defaults = null;
    const defaultsPath = path.join(dir, DEFAULTS_MODULE);
    if (await isFile(defaultsPath)) {
        try {
            const mod = await import(pathToFileURL(defaultsPath).href);
            for (const message of checkDefaultsModule(mod?.DEFAULTS, manifestConfig)) {
                issues.push({ file: DEFAULTS_MODULE, message });
            }
            if (mod?.DEFAULTS && typeof mod.DEFAULTS === 'object') defaults = mod.DEFAULTS;
        } catch (e) {
            issues.push({
                file: DEFAULTS_MODULE,
                message: `couldn't load it in Node to read DEFAULTS: ${e?.message || e}`,
            });
        }
    }

    const settingsRel = manifest.contributes?.settingsProvider;
    if (typeof settingsRel === 'string' && settingsRel) {
        const file = settingsRel.replace(/^\.\//, '');
        const catalog = (await readJsonIfExists(path.join(dir, '_locales', 'en', 'messages.json'))) || {};
        try {
            const mod = await import(pathToFileURL(path.join(dir, file)).href);
            const Cls = mod?.default;
            if (typeof Cls !== 'function') {
                issues.push({ file, message: 'settings provider has no default-exported class' });
            } else {
                const en = await runSettingsProvider(Cls, catalog, { timeoutMs });
                if (en.schema !== null) {
                    const pseudo = await runSettingsProvider(Cls, catalog, { pseudo: true, timeoutMs });
                    const current = await runSettingsProvider(Cls, catalog, {
                        current: { config: currentHostConfig(manifestConfig) },
                        timeoutMs,
                    });
                    const normalizeOf = ({ provider }) =>
                        typeof provider.normalize === 'function' ? provider.normalize.bind(provider) : undefined;
                    for (const message of compareSchemaToManifest(en.schema, manifestConfig, {
                        normalize: normalizeOf(en),
                        pseudoSchema: pseudo.schema,
                        currentSchema: current.schema,
                        currentNormalize: normalizeOf(current),
                    })) {
                        issues.push({ file, message });
                    }
                }
            }
        } catch (e) {
            issues.push({
                file,
                message:
                    `couldn't load the settings provider in Node to read its defaults: ` +
                    `${e?.message || e}. Settings providers must import and run getSettings() ` +
                    `without a DOM, given a context whose invoke() resolves null.`,
            });
        }
    }

    for (const rel of await listCodeFiles(dir)) {
        const source = await readFile(path.join(dir, rel), 'utf8');
        const file = rel.replace(/\\/g, '/');
        for (const f of scanCodeFallbacks(source, manifestConfig)) {
            issues.push({ file, line: f.line, message: f.message });
        }
        if (defaults) {
            for (const f of scanDefaultsRefs(source, defaults)) {
                issues.push({ file, line: f.line, message: f.message });
            }
        }
    }
    return issues;
}

async function main() {
    const root = path.join(repoRoot, 'extensions');
    const dirs = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

    const errors = [];
    let checked = 0;
    for (const d of dirs) {
        const dir = path.join(root, d);
        try {
            await stat(path.join(dir, 'manifest.json'));
        } catch {
            continue;
        }
        checked++;
        for (const issue of await checkExtension(dir)) {
            const loc = issue.file
                ? `extensions/${d}/${issue.file}${issue.line ? `:${issue.line}` : ''}`
                : `extensions/${d}`;
            errors.push(`${loc}: ${issue.message}`);
        }
    }

    if (errors.length > 0) {
        console.error(`[defaults] ${errors.length} issue(s):`);
        for (const e of errors) console.error(`  - ${e}`);
        return 1;
    }
    console.log(
        `[defaults] OK — manifest defaults, settings defaults, DEFAULTS constants and code ` +
            `fallbacks agree, and nothing claims \`enabled\`, across ${checked} extension(s).`
    );
    return 0;
}

function invokedDirectly() {
    if (!process.argv[1]) return false;
    try {
        // realpath: on macOS /tmp is a symlink, and import.meta.url is resolved.
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
    } catch {
        return false;
    }
}

if (invokedDirectly()) {
    // Explicit exit: a provider may leave a timer running after initialize().
    main().then(
        (code) => process.exit(code),
        (e) => {
            console.error(e);
            process.exit(1);
        }
    );
}
