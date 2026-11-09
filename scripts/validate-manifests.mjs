#!/usr/bin/env node
// Strict manifest schema validation.
//
// Runs against every manifest.json under extensions/ and themes/ on
// every CI run, regardless of which item changed — schema checks are
// cheap and a malformed manifest in extension A can break the catalog
// build for extension B (the build script reads the manifest list at
// once). Heavier per-extension checks (security, permissions, i18n,
// bundle) live in scripts/check-*.mjs and run only on changed items.
//
// What this enforces:
//   - Required fields present + correct type.
//   - `id` matches the canonical pattern AND the folder name.
//   - `version` is semver.
//   - `type` is one of extension/theme/commands; matches the parent dir.
//   - `permissions` (extensions only): array of strings, all known.
//   - `name` ≤ 50 chars, `description` ≤ 200 chars (catalog UX caps).
//   - `icon` is one or two grapheme clusters (an emoji, possibly a ZWJ
//     sequence) — keeps the launcher / settings rows from blowing
//     out their layout.
//   - `tags` is array of strings if present.
//   - `contributes.*` paths exist on disk and start with './'.
//   - `contributes.mascotActivities` (if present): array of strings, all
//     from the host's closed activity vocabulary, no duplicates.
//   - `contributes.views` (if present): Kage's EXTENSION_VIEWS §4 rules,
//     and `views` in `permissions` (both ways).
//   - `agentBackground` (if present): Kage's EXTENSION_AGENT_CALLS §3.2
//     rules, and `agent_background` in `permissions` (both ways).
//   - No unknown top-level fields (catches typos like `permission`).
//   - Required fields for the catalog: `author`.
//   - Config types, primitive enums (host limits), and string-only plain
//     backup opt-ins; credentials and sensitive declarations cannot opt in.
//
// Single-pass: collect all errors then exit non-zero so a contributor
// fixes everything in one round trip rather than discovering issues
// one-at-a-time.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_CAPABILITIES, MASCOT_ACTIVITIES } from './host-capabilities.mjs';
import { BACKUP_SENSITIVE_NAME, declaresSensitiveKey, sensitiveMetadataIssues } from './lib/sensitive-data.mjs';
import { invokedDirectly } from './lib/invoked-directly.mjs';
import { jsonLine } from './lib/json-lines.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Standard semver. Allows pre-release / build metadata so `1.0.0-rc.1`
// and `1.0.0+sha.abc1234` validate. Rejects `v1.0.0`, `1.0`, `1`.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VALID_TYPES = new Set(['extension', 'theme', 'commands']);
const CONFIG_TYPES = new Set(['boolean', 'number', 'string']);
// Kage src/extensions.rs::config_field_decls; Rust string lengths are bytes.
const MAX_CONFIG_ENUM_VALUES = 64;
const MAX_CONFIG_ENUM_BYTES = 128;

// Catalog UX caps. The store cards truncate longer values; keeping
// them tight at submission time is friendlier than relying on
// downstream truncation.
const NAME_MAX_LEN = 50;
const DESCRIPTION_MAX_LEN = 200;

// `__MSG_key__`, resolved against the extension's EN catalog for length
// checks. check:i18n reports a key that's missing.
const MSG_TOKEN_RE = /^__MSG_([\w.\-]+)__$/;

// Extension views: Kage docs/design/EXTENSION_VIEWS.md §4. The host drops
// a bad entry with a warning, so a mistake here means a window that never
// opens.
const VIEW_MAX = 4;
const VIEW_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const VIEW_TITLE_MAX = 60;
const VIEW_ICON_MAX_CHARS = 8;
const VIEW_CSS_MAX = 8;
const VIEW_CSS_FILE_MAX_BYTES = 256 * 1024;
const VIEW_CSS_TOTAL_MAX_BYTES = 1024 * 1024;
const VIEW_FIELDS = new Set(['id', 'title', 'icon', 'module', 'css', 'defaultSize', 'minSize']);
const VIEW_DEFAULT_SIZE = { width: [480, 3840], height: [360, 2160] };
const VIEW_DEFAULT_SIZE_FALLBACK = { width: 1100, height: 760 };
const VIEW_MIN_SIZE_FLOOR = { width: 320, height: 240 };

// Background agent calls: Kage docs/design/EXTENSION_AGENT_CALLS.md §3.2.
const AGENT_BACKGROUND_FIELDS = new Set(['reason', 'purposes', 'maxPromptChars', 'dailyCalls']);
const AGENT_REASON_MAX = 300;
const AGENT_PURPOSES_MAX = 8;
const AGENT_PURPOSE_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

// Manifest fields we know about. Anything outside this set is a typo
// (e.g. `permission` instead of `permissions`) — fail closed.
const KNOWN_TOP_LEVEL_FIELDS = new Set([
    'id',
    'name',
    'version',
    'type',
    'description',
    'icon',
    'author',
    'tags',
    'permissions',
    'contributes',
    'config',
    'sensitiveData',
    'agentBackground',
    'sandboxVendor',
    'homepage',
    'repository',
    'license',
]);

const errors = [];
const note = (loc, msg) => errors.push(`${loc}: ${msg}`);

async function listDirs(parent) {
    try {
        const entries = await readdir(parent, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

async function readJson(p) {
    const txt = await readFile(p, 'utf8');
    return JSON.parse(txt);
}

/**
 * Count grapheme clusters in a string. We use Intl.Segmenter (Node
 * 16+) so a ZWJ-joined emoji like 👨‍👩‍👧‍👦 counts as 1, not 7. An
 * "icon" of 2 graphemes is OK (some authors prefer pairs); 3+ is
 * almost certainly a typo.
 */
function graphemeCount(str) {
    if (typeof str !== 'string') return 0;
    if (typeof Intl?.Segmenter === 'function') {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        let n = 0;
        // eslint-disable-next-line no-unused-vars
        for (const _ of seg.segment(str)) n++;
        return n;
    }
    // Conservative fallback for ancient Node — at least counts code
    // points, which is closer than `.length` on UTF-16.
    return Array.from(str).length;
}

export async function validateManifest(manifestPath, expectedKind, dirName) {
    const issues = [];
    let source = '';
    const note = (loc, msg, parts) => {
        const inferred = msg.match(/(?:config\.|contributes\.)([\w.-]+)/)?.[0]?.split('.') ||
            msg.match(/(?:field )?'([^']+)'/)?.[1]?.split('.');
        const at = jsonLine(source, parts || inferred || []);
        issues.push(`${loc}:${at}: ${msg}`);
    };
    const loc = path.relative(repoRoot, manifestPath);
    let m;
    try {
        source = await readFile(manifestPath, 'utf8');
        m = JSON.parse(source);
    } catch (e) {
        note(loc, `failed to parse JSON: ${e.message}`);
        return issues;
    }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        note(loc, 'manifest must be a JSON object at the root');
        return issues;
    }

    // Unknown-field detection — catches typos in field names. A typo
    // like `"permission"` (missing the `s`) silently grants nothing
    // at runtime; failing CI here gives the author an immediate hint.
    for (const k of Object.keys(m)) {
        if (!KNOWN_TOP_LEVEL_FIELDS.has(k)) {
            note(loc, `unknown top-level field '${k}' (typo? known fields: ${[...KNOWN_TOP_LEVEL_FIELDS].sort().join(', ')})`, [k]);
        }
    }
    for (const issue of sensitiveMetadataIssues(m, { locations: true })) note(loc, issue.message, issue.path);

    // The host reads exact `type`, `enum`, and `backup` keys on each
    // config entry. An enum takes precedence over the type's plain rule.
    if (m.config && typeof m.config === 'object' && !Array.isArray(m.config)) {
        for (const [field, definition] of Object.entries(m.config)) {
            // Malformed entries are already reported by sensitiveMetadataIssues.
            if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
            const at = ['config', field];
            if (definition.type !== undefined && !CONFIG_TYPES.has(definition.type)) {
                note(loc, `config.${field}.type must be one of: boolean, number, string`, [...at, 'type']);
            }
            if (definition.enum !== undefined) {
                const choices = definition.enum;
                if (!Array.isArray(choices) || choices.length === 0 || choices.length > MAX_CONFIG_ENUM_VALUES) {
                    note(loc, `config.${field}.enum must be a nonempty array of at most ${MAX_CONFIG_ENUM_VALUES} primitives matching the field's type`, [...at, 'enum']);
                } else if (!CONFIG_TYPES.has(definition.type)) {
                    note(loc, `config.${field}.enum requires a declared boolean, number, or string type`, [...at, 'enum']);
                } else {
                    for (const [i, value] of choices.entries()) {
                        if (typeof value !== definition.type ||
                            (definition.type === 'number' && !Number.isFinite(value))) {
                            note(loc, `config.${field}.enum entry ${i} must be a ${definition.type} primitive`, [...at, 'enum', i]);
                        } else if (definition.type === 'string' && Buffer.byteLength(value, 'utf8') > MAX_CONFIG_ENUM_BYTES) {
                            note(loc, `config.${field}.enum entry ${i} exceeds ${MAX_CONFIG_ENUM_BYTES} UTF-8 bytes`, [...at, 'enum', i]);
                        }
                    }
                }
            }
            if (definition.backup !== undefined) {
                if (definition.backup !== 'plain') {
                    note(loc, `config.${field}.backup must be "plain"`, [...at, 'backup']);
                } else {
                    if (definition.type !== 'string') {
                        note(loc, `config.${field}.backup: "plain" is only allowed on string fields`, [...at, 'backup']);
                    }
                    if (BACKUP_SENSITIVE_NAME.test(field) || definition.sensitive === true ||
                        declaresSensitiveKey(m, field, { ignoreCase: true })) {
                        note(loc, `config.${field}.backup: "plain" is forbidden on credential-named or declared sensitive fields`, [...at, 'backup']);
                    }
                }
            }
        }
    }

    // --- Required field presence + type ---------------------------------
    if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
        note(loc, `'id' must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
    }
    if (typeof m.name !== 'string' || m.name.trim() === '') {
        note(loc, `'name' is required (non-empty string)`);
    } else if (m.name.length > NAME_MAX_LEN) {
        note(loc, `'name' is ${m.name.length} chars; max ${NAME_MAX_LEN}`);
    }
    if (typeof m.version !== 'string' || !SEMVER_PATTERN.test(m.version)) {
        note(loc, `'version' must be a semver string (MAJOR.MINOR.PATCH[-pre][+build])`);
    }
    if (typeof m.type !== 'string' || !VALID_TYPES.has(m.type)) {
        note(loc, `'type' must be one of: ${[...VALID_TYPES].join(', ')}`);
    }
    if (typeof m.description !== 'string' || m.description.trim() === '') {
        note(loc, `'description' is required (non-empty string)`);
    } else if (m.description.length > DESCRIPTION_MAX_LEN) {
        note(loc, `'description' is ${m.description.length} chars; max ${DESCRIPTION_MAX_LEN}`);
    }
    if (typeof m.author !== 'string' || m.author.trim() === '') {
        note(loc, `'author' is required (free-form string)`);
    }
    if (typeof m.icon !== 'string') {
        note(loc, `'icon' is required (string, typically a single emoji)`);
    } else {
        const g = graphemeCount(m.icon);
        if (g === 0) {
            note(loc, `'icon' is empty`);
        } else if (g > 2) {
            note(loc, `'icon' should be 1 grapheme (an emoji); got ${g}`);
        }
    }

    if (expectedKind === 'extension' && m.type !== 'extension') {
        note(loc, `expected type "extension" under extensions/`);
    }
    if (expectedKind === 'theme' && m.type !== 'theme') {
        note(loc, `expected type "theme" under themes/`);
    }

    // --- Permissions ----------------------------------------------------
    if (m.type === 'extension') {
        if (!Array.isArray(m.permissions)) {
            note(loc, `'permissions' is required (use [] for no capabilities)`);
        } else {
            const seen = new Set();
            for (const [i, p] of m.permissions.entries()) {
                if (typeof p !== 'string') {
                    note(loc, `permissions entry ${JSON.stringify(p)} must be a string; got ${typeof p}`, ['permissions', i]);
                    continue;
                }
                if (!KNOWN_CAPABILITIES.includes(p)) {
                    note(loc, `unknown capability '${p}' in 'permissions' (see scripts/host-capabilities.mjs)`, ['permissions', i]);
                }
                if (seen.has(p)) {
                    note(loc, `duplicate capability '${p}' in 'permissions'`, ['permissions', i]);
                }
                seen.add(p);
            }
        }
    }

    // --- tags -----------------------------------------------------------
    if (m.tags !== undefined) {
        if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
            note(loc, `'tags' must be an array of strings`);
        }
    }

    // --- contributes file paths ----------------------------------------
    if (m.contributes !== undefined) {
        if (typeof m.contributes !== 'object' || m.contributes === null) {
            note(loc, `'contributes' must be an object`);
        } else {
            const fileFields = [
                'searchProvider',
                'settingsProvider',
                'toolProvider',
                'triggerProvider',
                'toolbarButtons',
                'messageFormatters',
            ];
            for (const f of fileFields) {
                const v = m.contributes[f];
                if (typeof v === 'string') {
                    await checkRel(loc, manifestPath, v, note, ['contributes', f]);
                }
            }
            if (m.contributes.css !== undefined) {
                if (!Array.isArray(m.contributes.css)) {
                    note(loc, `'contributes.css' must be an array of paths`);
                } else {
                    for (const [i, c] of m.contributes.css.entries()) {
                        if (typeof c !== 'string') {
                            note(loc, `'contributes.css' entry ${JSON.stringify(c)} must be a string`, ['contributes', 'css', i]);
                        } else {
                            await checkRel(loc, manifestPath, c, note, ['contributes', 'css', i]);
                        }
                    }
                }
            }
            if (m.contributes.widgets !== undefined) {
                if (!Array.isArray(m.contributes.widgets)) {
                    note(loc, `'contributes.widgets' must be an array`);
                } else {
                    const seenIds = new Set();
                    for (const [i, w] of m.contributes.widgets.entries()) {
                        if (typeof w?.id !== 'string') {
                            note(loc, `widget entry ${i} needs an 'id' string`, ['contributes', 'widgets', i]);
                        } else if (seenIds.has(w.id)) {
                            note(loc, `duplicate widget id '${w.id}'`, ['contributes', 'widgets', i, 'id']);
                        }
                        if (w?.id) seenIds.add(w.id);
                        if (typeof w?.module === 'string') {
                            await checkRel(loc, manifestPath, w.module, note, ['contributes', 'widgets', i, 'module']);
                        }
                    }
                }
            }
            // Mascot activity hints. The host only honours a name the
            // manifest declares here AND that's in its closed vocabulary, so
            // a typo means the hint is silently dropped at runtime — exactly
            // the class of mistake worth failing CI over.
            if (m.contributes.mascotActivities !== undefined) {
                if (!Array.isArray(m.contributes.mascotActivities)) {
                    note(loc, `'contributes.mascotActivities' must be an array of activity names`);
                } else {
                    const seenActivities = new Set();
                    for (const [i, a] of m.contributes.mascotActivities.entries()) {
                        if (typeof a !== 'string') {
                            note(loc, `'contributes.mascotActivities' entry ${JSON.stringify(a)} must be a string; got ${typeof a}`, ['contributes', 'mascotActivities', i]);
                            continue;
                        }
                        if (!MASCOT_ACTIVITIES.includes(a)) {
                            note(
                                loc,
                                `unknown mascot activity '${a}' — the vocabulary is closed and generic ` +
                                    `(${MASCOT_ACTIVITIES.join(', ')}); see scripts/host-capabilities.mjs`,
                                ['contributes', 'mascotActivities', i]
                            );
                        }
                        if (seenActivities.has(a)) {
                            note(loc, `duplicate mascot activity '${a}'`, ['contributes', 'mascotActivities', i]);
                        }
                        seenActivities.add(a);
                    }
                }
            }
            if (m.contributes.themes && typeof m.contributes.themes === 'object') {
                for (const [key, v] of Object.entries(m.contributes.themes)) {
                    if (typeof v === 'string') await checkRel(loc, manifestPath, v, note, ['contributes', 'themes', key]);
                }
            }
            if (m.contributes.views !== undefined) {
                await checkViews(loc, manifestPath, m.contributes.views, note);
            }
        }
    }

    // --- views and agentBackground need their capability ----------------
    // Each declaration only works with its capability, and each capability
    // only does something with its declaration.
    if (m.type === 'extension') {
        const perms = Array.isArray(m.permissions) ? m.permissions : [];
        const views = m.contributes && typeof m.contributes === 'object' ? m.contributes.views : undefined;
        const hasViews = Array.isArray(views) && views.length > 0;
        if (hasViews && !perms.includes('views')) {
            note(loc, `'contributes.views' needs 'views' in 'permissions'; without it Kage never opens these windows`, ['contributes', 'views']);
        }
        if (perms.includes('views') && !hasViews) {
            note(loc, `'views' in 'permissions' needs at least one 'contributes.views' entry`, ['permissions', perms.indexOf('views')]);
        }
        if (m.agentBackground !== undefined && !perms.includes('agent_background')) {
            note(loc, `'agentBackground' needs 'agent_background' in 'permissions'`, ['agentBackground']);
        }
        if (perms.includes('agent_background') && m.agentBackground === undefined) {
            note(loc, `'agent_background' in 'permissions' needs an 'agentBackground' block (reason and purposes)`, ['permissions', perms.indexOf('agent_background')]);
        }
    }
    if (m.agentBackground !== undefined) {
        await checkAgentBackground(loc, manifestPath, m.agentBackground, note);
    }

    // --- Folder ↔ id parity --------------------------------------------
    if (expectedKind === 'extension' && m.id && dirName && m.id !== dirName) {
        note(loc, `extension folder name '${dirName}' must match manifest id '${m.id}'`, ['id']);
    }
    return issues;
}

// Returns the file's stats, or null when the path is bad or missing.
async function checkRel(loc, manifestPath, relPath, note, parts) {
    if (typeof relPath !== 'string') return null;
    if (!relPath.startsWith('./') && !relPath.startsWith('/')) {
        note(loc, `path '${relPath}' should start with './'`, parts);
        return null;
    }
    const abs = path.resolve(path.dirname(manifestPath), relPath);
    try {
        return await stat(abs);
    } catch {
        note(loc, `referenced file not found: ${relPath}`, parts);
        return null;
    }
}

// The EN catalog next to a manifest, or null.
async function readEnCatalog(manifestPath) {
    try {
        return JSON.parse(await readFile(path.join(path.dirname(manifestPath), '_locales', 'en', 'messages.json'), 'utf8'));
    } catch {
        return null;
    }
}

// A manifest string as English text: a `__MSG_key__` token resolves through
// the EN catalog. null when it can't be resolved here.
function resolveText(value, catalog) {
    const m = MSG_TOKEN_RE.exec(value);
    if (!m) return value;
    const message = catalog?.[m[1]]?.message;
    return typeof message === 'string' ? message : null;
}

const charCount = (s) => Array.from(s).length;

async function checkViews(loc, manifestPath, views, note) {
    const at = ['contributes', 'views'];
    if (!Array.isArray(views)) {
        note(loc, `'contributes.views' must be an array`, at);
        return;
    }
    if (views.length > VIEW_MAX) {
        note(loc, `'contributes.views' has ${views.length} entries; Kage uses the first ${VIEW_MAX} and ignores the rest`, at);
    }
    let catalog;
    const seen = new Set();
    for (const [i, v] of views.entries()) {
        const vat = [...at, i];
        const where = `'contributes.views' entry ${i}`;
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            note(loc, `${where} must be an object`, vat);
            continue;
        }
        for (const k of Object.keys(v)) {
            if (!VIEW_FIELDS.has(k)) {
                note(loc, `${where}: unknown field '${k}' (known fields: ${[...VIEW_FIELDS].join(', ')})`, [...vat, k]);
            }
        }
        if (typeof v.id !== 'string' || !VIEW_ID_PATTERN.test(v.id)) {
            note(loc, `${where}: 'id' must match ${VIEW_ID_PATTERN}`, [...vat, 'id']);
        } else if (seen.has(v.id)) {
            note(loc, `duplicate view id '${v.id}'`, [...vat, 'id']);
        }
        if (typeof v.id === 'string') seen.add(v.id);

        if (typeof v.title !== 'string' || v.title.trim() === '') {
            note(loc, `${where}: 'title' is required (a string or a __MSG_key__ token)`, [...vat, 'title']);
        } else {
            if (catalog === undefined) catalog = await readEnCatalog(manifestPath);
            const text = resolveText(v.title, catalog);
            if (text !== null && (text.trim() === '' || charCount(text.trim()) > VIEW_TITLE_MAX)) {
                note(loc, `${where}: 'title' must be 1–${VIEW_TITLE_MAX} characters`, [...vat, 'title']);
            }
        }

        if (v.icon !== undefined &&
            (typeof v.icon !== 'string' || graphemeCount(v.icon) !== 1 || charCount(v.icon) > VIEW_ICON_MAX_CHARS)) {
            note(loc, `${where}: 'icon' must be one emoji (at most ${VIEW_ICON_MAX_CHARS} characters)`, [...vat, 'icon']);
        }

        if (typeof v.module !== 'string' || !v.module.startsWith('./') || !v.module.endsWith('.js')) {
            note(loc, `${where}: 'module' is required: a './…/*.js' path in the bundle`, [...vat, 'module']);
        } else {
            await checkRel(loc, manifestPath, v.module, note, [...vat, 'module']);
        }

        if (v.css !== undefined) {
            if (!Array.isArray(v.css)) {
                note(loc, `${where}: 'css' must be an array of paths`, [...vat, 'css']);
            } else {
                if (v.css.length > VIEW_CSS_MAX) {
                    note(loc, `${where}: 'css' has ${v.css.length} files; at most ${VIEW_CSS_MAX}`, [...vat, 'css']);
                }
                let total = 0;
                for (const [j, c] of v.css.entries()) {
                    const cat = [...vat, 'css', j];
                    if (typeof c !== 'string' || !c.startsWith('./') || !c.endsWith('.css')) {
                        note(loc, `${where}: 'css' entry ${j} must be a './…/*.css' path in the bundle`, cat);
                        continue;
                    }
                    const st = await checkRel(loc, manifestPath, c, note, cat);
                    if (!st) continue;
                    total += st.size;
                    if (st.size > VIEW_CSS_FILE_MAX_BYTES) {
                        note(loc, `${where}: ${c} is ${st.size} bytes; at most ${VIEW_CSS_FILE_MAX_BYTES} per file`, cat);
                    }
                }
                if (total > VIEW_CSS_TOTAL_MAX_BYTES) {
                    note(loc, `${where}: its CSS is ${total} bytes; at most ${VIEW_CSS_TOTAL_MAX_BYTES} in total`, [...vat, 'css']);
                }
            }
        }

        const size = (value, name) => {
            if (value === undefined) return null;
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
                note(loc, `${where}: '${name}' must be { "width": <number>, "height": <number> }`, [...vat, name]);
                return null;
            }
            return value;
        };
        const def = size(v.defaultSize, 'defaultSize');
        if (def) {
            for (const dim of ['width', 'height']) {
                const [lo, hi] = VIEW_DEFAULT_SIZE[dim];
                if (def[dim] < lo || def[dim] > hi) {
                    note(loc, `${where}: 'defaultSize.${dim}' must be ${lo}–${hi} (Kage clamps it)`, [...vat, 'defaultSize', dim]);
                }
            }
        }
        const min = size(v.minSize, 'minSize');
        if (min) {
            for (const dim of ['width', 'height']) {
                const lo = VIEW_MIN_SIZE_FLOOR[dim];
                // The default size Kage uses: the declared one, clamped.
                const [dlo, dhi] = VIEW_DEFAULT_SIZE[dim];
                const hi = def ? Math.min(Math.max(def[dim], dlo), dhi) : VIEW_DEFAULT_SIZE_FALLBACK[dim];
                if (min[dim] < lo || min[dim] > hi) {
                    note(loc, `${where}: 'minSize.${dim}' must be ${lo}–${hi}, at most the default size (Kage clamps it)`, [...vat, 'minSize', dim]);
                }
            }
        }
    }
}

async function checkAgentBackground(loc, manifestPath, block, note) {
    const at = ['agentBackground'];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
        note(loc, `'agentBackground' must be an object`, at);
        return;
    }
    for (const k of Object.keys(block)) {
        if (!AGENT_BACKGROUND_FIELDS.has(k)) {
            note(loc, `'agentBackground': unknown field '${k}' (known fields: ${[...AGENT_BACKGROUND_FIELDS].join(', ')})`, [...at, k]);
        }
    }
    if (typeof block.reason !== 'string' || block.reason.trim() === '') {
        note(loc, `'agentBackground.reason' is required (a string or a __MSG_key__ token)`, [...at, 'reason']);
    } else {
        const text = resolveText(block.reason, await readEnCatalog(manifestPath));
        if (text !== null && (text.trim() === '' || charCount(text.trim()) > AGENT_REASON_MAX)) {
            note(loc, `'agentBackground.reason' must be 1–${AGENT_REASON_MAX} characters`, [...at, 'reason']);
        }
    }
    const purposes = block.purposes;
    if (!Array.isArray(purposes) || purposes.length === 0 || purposes.length > AGENT_PURPOSES_MAX) {
        note(loc, `'agentBackground.purposes' must be an array of 1–${AGENT_PURPOSES_MAX} purpose ids`, [...at, 'purposes']);
    } else {
        const seen = new Set();
        for (const [i, id] of purposes.entries()) {
            if (typeof id !== 'string' || !AGENT_PURPOSE_PATTERN.test(id)) {
                note(loc, `'agentBackground.purposes' entry ${i} must match ${AGENT_PURPOSE_PATTERN}`, [...at, 'purposes', i]);
            } else if (seen.has(id)) {
                note(loc, `duplicate purpose '${id}' in 'agentBackground.purposes'`, [...at, 'purposes', i]);
            }
            seen.add(id);
        }
    }
    for (const k of ['maxPromptChars', 'dailyCalls']) {
        const n = block[k];
        if (n !== undefined && !(Number.isSafeInteger(n) && n > 0)) {
            note(loc, `'agentBackground.${k}' must be a positive integer`, [...at, k]);
        }
    }
}

async function main() {
    // Cross-extension sanity: id collisions across the catalog. The
    // catalog build dedupes the dir name, but two manifests with the
    // SAME id in different folders would produce identical zip names
    // and silently clobber each other in dist/. Catch it here.
    const idsSeen = new Map(); // id → first location

    for (const kind of ['extension', 'theme']) {
        const root = path.join(repoRoot, kind === 'extension' ? 'extensions' : 'themes');
        const dirs = await listDirs(root);
        for (const d of dirs) {
            const manifestPath = path.join(root, d, 'manifest.json');
            try {
                await stat(manifestPath);
            } catch {
                note(path.relative(repoRoot, path.join(root, d)), 'missing manifest.json');
                continue;
            }
            errors.push(...await validateManifest(manifestPath, kind, d));
            // Capture the id for collision detection (best-effort —
            // if the manifest didn't parse, skip).
            try {
                const m = await readJson(manifestPath);
                if (typeof m?.id === 'string') {
                    const prior = idsSeen.get(m.id);
                    if (prior) {
                        note(
                            path.relative(repoRoot, manifestPath),
                            `id '${m.id}' collides with ${prior}`
                        );
                    } else {
                        idsSeen.set(m.id, path.relative(repoRoot, manifestPath));
                    }
                }
            } catch {
                /* parse error already reported */
            }
        }
    }

    if (errors.length > 0) {
        console.error(`Found ${errors.length} validation error(s):`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log('All manifests valid.');
}

if (invokedDirectly(import.meta.url)) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
