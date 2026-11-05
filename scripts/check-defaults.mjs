#!/usr/bin/env node
// Settings-default drift gate.
//
// A setting can have three defaults, and they have to agree:
//
//   1. The settings control `default` from settings.js getSettings(). The
//      Settings page shows it for a value that was never saved, and Save
//      writes it for any control in the section the user didn't change.
//   2. The manifest `config` default. The host gives the running extension
//      these until the user saves (Kage: ExtensionManager._getExtensionConfig
//      returns the manifest defaults when config.extensions[id] is absent).
//   3. Code fallbacks (`config.x ?? 2`, `config.flag !== false`). These apply
//      when a saved config lacks the key: the host stores only the controls'
//      values and never merges manifest defaults back in.
//
// If 1 and 2 disagree, the UI is wrong. Math's Settings page showed
// precision 2 while 29/34 rendered "= 1" (manifest default 0) for every user
// who had never saved Math settings.
//
// How (1) is read: providers build their schema in code (translated strings,
// async lookups, values derived from config), so a regex over settings.js
// can't see the real defaults. This script imports each settings provider in
// Node and calls getSettings() with a stub context that looks like a fresh
// install: config {} (what the Settings window passes for an unsaved
// extension), invoke() resolving null for every command (no extension data),
// and i18n.t backed by the extension's EN catalog. Each value control's
// default is coerced the way the host renderer coerces it, then passed through
// the provider's normalize(), which the host runs before saving. (window-walker
// shows "w" but stores "w ".) The host saves every value control, not just
// the keys normalize() returns: it writes the returned keys back into their
// controls, then save() reads all controls (Kage RenderedSettings.validate /
// save). So a control normalize() leaves out is stored as shown, and is
// compared like any other. The one exemption is a helper field: an input for
// an action button (github's token box), whose id starts with `__` and which
// the manifest doesn't declare.
//
// Per control, the check requires that the manifest declares the id, the
// types agree, the defaults are equal, and a select's default is one of its
// options. It also runs getSettings() a second time under a pseudo-locale:
// a translated default can't equal one fixed manifest value in every language.
//
// (3) is a best-effort static scan of every non-test .js file. A literal
// fallback (`config.x ?? 5`, `config.x || 'gh'`) must equal the manifest
// default. A boolean that defaults to true must not be read by truthiness
// (`!config.x`, `config.x &&`, `if (config.x)`) because that turns a missing
// key off, and one that defaults to false must not be tested with
// `=== false` / `!== false`. The scan can't follow values through helpers or
// variables. To skip a line, put `check-defaults: ignore` in a comment on it.
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

/**
 * Id prefix for helper fields: inputs read by an action button (github's
 * `__token_input`, spotify's `__setup_client_id`), not config the extension
 * runs with. The repo's normalize() implementations strip them.
 */
const HELPER_PREFIX = '__';
const isHelperField = (id) => id.startsWith(HELPER_PREFIX);

// --- Host value semantics ---------------------------------------------------
// Mirrors Kage ui/js/shared/settings-renderer.js. Keep in sync.

/** The value Settings shows for a never-saved control: coerceValue(ctrl, ctrl.default). */
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

/** The value Save stores for `value`: _writeToControl then _readFromControl. */
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

// --- Settings provider harness ---------------------------------------------

function interpolate(template, vars) {
    if (typeof template !== 'string') return '';
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
        vars && name in vars ? String(vars[name]) : whole
    );
}

/**
 * A fresh-install host context. `pseudo` wraps every translated string so a
 * default built from t() comes out different from the EN run.
 */
function makeStubContext(catalog, { pseudo = false } = {}) {
    const noop = () => {};
    const t = (key, vars) => {
        const text = interpolate(catalog?.[key]?.message ?? key, vars);
        return pseudo ? `⟦${text}⟧` : text;
    };
    return {
        config: {},
        invoke: async () => null,
        log: { debug: noop, info: noop, warn: noop, error: noop },
        runSandboxed: async () => null,
        i18n: { t, language: () => (pseudo ? 'qps' : 'en'), isRtl: () => false },
        mascot: { setActivity: noop, clearActivity: noop },
        formatter: { requestReformat: noop },
    };
}

function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Instantiate the provider the way the sandbox runtime does and fetch its schema. */
async function runSettingsProvider(Cls, catalog, { pseudo, timeoutMs }) {
    const provider = new Cls();
    const init = provider.initialize?.(makeStubContext(catalog, { pseudo }));
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

function valueControls(schema) {
    const out = [];
    for (const section of schema?.sections || []) {
        for (const ctrl of section?.controls || []) {
            if (!ctrl || typeof ctrl.id !== 'string') continue;
            if (!(ctrl.type in CONTROL_VALUE_TYPE)) continue; // info, action, unknown
            out.push(ctrl);
        }
    }
    return out;
}

const fmt = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

/**
 * Compare a settings schema against the manifest config.
 *
 * @param {object} schema           - getSettings() result (EN run)
 * @param {object} manifestConfig   - manifest.config
 * @param {object} [opts]
 * @param {Function} [opts.normalize]   - provider.normalize, bound
 * @param {object}   [opts.pseudoSchema] - getSettings() result under a pseudo-locale
 * @returns {string[]} issues
 */
export function compareSchemaToManifest(schema, manifestConfig, opts = {}) {
    const issues = [];
    if (!schema || typeof schema !== 'object' || !Array.isArray(schema.sections)) {
        issues.push('getSettings() did not return a schema with a sections array');
        return issues;
    }
    const controls = valueControls(schema);

    // What the host's save() would hand normalize(): every control's value.
    const shown = {};
    for (const ctrl of controls) shown[ctrl.id] = storedValue(ctrl, shownDefault(ctrl));

    let normalized = null;
    if (typeof opts.normalize === 'function') {
        let out;
        try {
            out = opts.normalize({ ...shown });
        } catch (e) {
            issues.push(`normalize() threw on the default values: ${e?.message || e}`);
        }
        // The runtime calls normalize() synchronously and ignores anything
        // without a `values` object (including a Promise).
        if (out && typeof out === 'object' && out.values && typeof out.values === 'object') {
            normalized = out.values;
        }
    }

    const pseudoShown = {};
    for (const ctrl of valueControls(opts.pseudoSchema)) {
        pseudoShown[ctrl.id] = storedValue(ctrl, shownDefault(ctrl));
    }

    for (const ctrl of controls) {
        const id = ctrl.id;
        const spec = manifestConfig?.[id];
        // A helper field: input for an action button (e.g. a token box), not config.
        if (isHelperField(id) && !spec) continue;

        const shownValue = shown[id];
        // The host writes back only the keys normalize() returned; Save then
        // reads every control, so a key it left out is stored as shown.
        const normalizedIt = normalized !== null && Object.hasOwn(normalized, id);
        const stored = normalizedIt ? storedValue(ctrl, normalized[id]) : shownValue;
        const valueType = CONTROL_VALUE_TYPE[ctrl.type];

        if (Object.hasOwn(pseudoShown, id) && !Object.is(pseudoShown[id], shownValue)) {
            issues.push(
                `'${id}': the control default depends on the UI language (it's built ` +
                    `from t()), but the manifest default is one fixed value, so in other ` +
                    `languages Settings shows a different value from the one the extension ` +
                    `uses. Use a fixed default, show the translated text as a placeholder, ` +
                    `and fall back to it in code (see extensions/hello-world).`
            );
            continue;
        }

        if (ctrl.type === 'select' && Array.isArray(ctrl.options)) {
            if (!ctrl.options.some((o) => o && o.value === shownValue)) {
                issues.push(
                    `'${id}': select default ${fmt(shownValue)} isn't one of its options ` +
                        `(${ctrl.options.map((o) => fmt(o?.value)).join(', ')})`
                );
            }
        }

        if (!spec || typeof spec !== 'object') {
            issues.push(
                `'${id}': settings control has no manifest config entry, so a never-saved ` +
                    `extension gets undefined while Settings shows ${fmt(shownValue)}. Add ` +
                    `"${id}": { "type": "${valueType}", "default": ${fmt(stored)} } to the ` +
                    `manifest's config. (If it's an input for an action button rather than ` +
                    `config, give it an id starting with "${HELPER_PREFIX}".)`
            );
            continue;
        }

        if (!MANIFEST_TYPES.has(spec.type)) continue; // reported by checkManifestConfig
        if (spec.type !== valueType) {
            issues.push(
                `'${id}': ${ctrl.type} control stores a ${valueType} but the manifest ` +
                    `declares type ${fmt(spec.type)}`
            );
            continue;
        }

        if (!Object.is(stored, spec.default)) {
            const via = Object.is(stored, shownValue)
                ? ''
                : ` (stored as ${fmt(stored)} after normalize())`;
            issues.push(
                `'${id}': Settings shows ${fmt(shownValue)}${via} for a never-saved value, ` +
                    `but the extension runs with the manifest default ${fmt(spec.default)}. ` +
                    `Make the control default and manifest config.${id}.default the same.`
            );
        }
    }
    return issues;
}

/** Manifest-only sanity: each config entry has a supported type and a default of that type. */
export function checkManifestConfig(manifestConfig) {
    const issues = [];
    if (manifestConfig == null) return issues;
    if (typeof manifestConfig !== 'object' || Array.isArray(manifestConfig)) {
        return ['manifest "config" must be an object'];
    }
    for (const [key, spec] of Object.entries(manifestConfig)) {
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

/** Patterns that read a boolean key by truthiness (a missing key reads as false). */
function truthinessPatterns(key) {
    const ref = String.raw`${RECEIVER}\b_?config\??\.${key}\b`;
    return [
        new RegExp(String.raw`!\s*${ref}`), // !config.x
        new RegExp(String.raw`!\s*\(\s*${ref}\s*\)`), // !(config.x)
        new RegExp(String.raw`${ref}\s*(?:&&|\?(?![?.]))`), // config.x && … / config.x ? … : …
        new RegExp(String.raw`&&\s*${ref}\s*(?:\)|&&|\?(?![?.]))`), // … && config.x)
        new RegExp(String.raw`\bif\s*\(\s*${ref}\s*\)`), // if (config.x)
    ];
}

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
    if (!manifestConfig || typeof manifestConfig !== 'object') return findings;
    const lines = source.split(/\r?\n/);

    const booleanKeys = Object.entries(manifestConfig).filter(
        ([, spec]) => spec?.type === 'boolean' && typeof spec.default === 'boolean'
    );

    lines.forEach((line, i) => {
        if (isCommentLine(line) || line.includes(IGNORE_MARKER)) return;
        const lineNo = i + 1;

        for (const m of line.matchAll(LITERAL_FALLBACK_RE)) {
            const key = m[1] ?? m[2];
            const op = m[3];
            const spec = manifestConfig[key];
            if (!spec || typeof spec !== 'object' || !('default' in spec)) continue;
            const fallback = parseLiteral(m[4]);
            if (!Object.is(fallback, spec.default)) {
                findings.push({
                    line: lineNo,
                    message:
                        `config.${key} ${op} ${m[4]} falls back to ${fmt(fallback)}, but the ` +
                        `manifest default is ${fmt(spec.default)}`,
                });
            }
        }

        for (const [key, spec] of booleanKeys) {
            if (spec.default === true) {
                if (truthinessPatterns(key).some((re) => re.test(line))) {
                    findings.push({
                        line: lineNo,
                        message:
                            `config.${key} is read by truthiness, so a config without the key ` +
                            `turns it off, but the manifest default is true. Test ` +
                            `\`config.${key} !== false\` (or \`=== false\` to disable).`,
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

// --- Per-extension driver ---------------------------------------------------

async function readJsonIfExists(p) {
    try {
        return JSON.parse(await readFile(p, 'utf8'));
    } catch {
        return null;
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
                const en = await runSettingsProvider(Cls, catalog, { pseudo: false, timeoutMs });
                if (en.schema !== null) {
                    const pseudo = await runSettingsProvider(Cls, catalog, { pseudo: true, timeoutMs });
                    const normalize =
                        typeof en.provider.normalize === 'function'
                            ? en.provider.normalize.bind(en.provider)
                            : undefined;
                    for (const message of compareSchemaToManifest(en.schema, manifestConfig, {
                        normalize,
                        pseudoSchema: pseudo.schema,
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
        for (const f of scanCodeFallbacks(source, manifestConfig)) {
            issues.push({ file: rel.replace(/\\/g, '/'), line: f.line, message: f.message });
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
        `[defaults] OK — settings defaults, manifest defaults, and code fallbacks agree ` +
            `across ${checked} extension(s).`
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
