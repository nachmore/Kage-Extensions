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
//   - No unknown top-level fields (catches typos like `permission`).
//   - Required fields for the catalog: `author`.
//
// Single-pass: collect all errors then exit non-zero so a contributor
// fixes everything in one round trip rather than discovering issues
// one-at-a-time.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_CAPABILITIES } from './host-capabilities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Standard semver. Allows pre-release / build metadata so `1.0.0-rc.1`
// and `1.0.0+sha.abc1234` validate. Rejects `v1.0.0`, `1.0`, `1`.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VALID_TYPES = new Set(['extension', 'theme', 'commands']);

// Catalog UX caps. The store cards truncate longer values; keeping
// them tight at submission time is friendlier than relying on
// downstream truncation.
const NAME_MAX_LEN = 50;
const DESCRIPTION_MAX_LEN = 200;

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

async function validateManifest(manifestPath, expectedKind, dirName) {
    const loc = path.relative(repoRoot, manifestPath);
    let m;
    try {
        m = await readJson(manifestPath);
    } catch (e) {
        note(loc, `failed to parse JSON: ${e.message}`);
        return;
    }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        note(loc, 'manifest must be a JSON object at the root');
        return;
    }

    // Unknown-field detection — catches typos in field names. A typo
    // like `"permission"` (missing the `s`) silently grants nothing
    // at runtime; failing CI here gives the author an immediate hint.
    for (const k of Object.keys(m)) {
        if (!KNOWN_TOP_LEVEL_FIELDS.has(k)) {
            note(loc, `unknown top-level field '${k}' (typo? known fields: ${[...KNOWN_TOP_LEVEL_FIELDS].sort().join(', ')})`);
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
            for (const p of m.permissions) {
                if (typeof p !== 'string') {
                    note(loc, `permissions entries must be strings; got ${typeof p}`);
                    continue;
                }
                if (!KNOWN_CAPABILITIES.includes(p)) {
                    note(loc, `unknown capability '${p}' in 'permissions' (see scripts/host-capabilities.mjs)`);
                }
                if (seen.has(p)) {
                    note(loc, `duplicate capability '${p}' in 'permissions'`);
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
                    await checkRel(loc, manifestPath, v);
                }
            }
            if (m.contributes.css !== undefined) {
                if (!Array.isArray(m.contributes.css)) {
                    note(loc, `'contributes.css' must be an array of paths`);
                } else {
                    for (const c of m.contributes.css) {
                        if (typeof c !== 'string') {
                            note(loc, `'contributes.css' entries must be strings`);
                        } else {
                            await checkRel(loc, manifestPath, c);
                        }
                    }
                }
            }
            if (m.contributes.widgets !== undefined) {
                if (!Array.isArray(m.contributes.widgets)) {
                    note(loc, `'contributes.widgets' must be an array`);
                } else {
                    const seenIds = new Set();
                    for (const w of m.contributes.widgets) {
                        if (typeof w?.id !== 'string') {
                            note(loc, `widget entries need an 'id' string`);
                        } else if (seenIds.has(w.id)) {
                            note(loc, `duplicate widget id '${w.id}'`);
                        }
                        if (w?.id) seenIds.add(w.id);
                        if (typeof w?.module === 'string') {
                            await checkRel(loc, manifestPath, w.module);
                        }
                    }
                }
            }
            if (m.contributes.themes && typeof m.contributes.themes === 'object') {
                for (const v of Object.values(m.contributes.themes)) {
                    if (typeof v === 'string') await checkRel(loc, manifestPath, v);
                }
            }
        }
    }

    // --- Folder ↔ id parity --------------------------------------------
    if (expectedKind === 'extension' && m.id && dirName && m.id !== dirName) {
        note(loc, `extension folder name '${dirName}' must match manifest id '${m.id}'`);
    }
}

async function checkRel(loc, manifestPath, relPath) {
    if (typeof relPath !== 'string') return;
    if (!relPath.startsWith('./') && !relPath.startsWith('/')) {
        note(loc, `path '${relPath}' should start with './'`);
        return;
    }
    const abs = path.resolve(path.dirname(manifestPath), relPath);
    try {
        await stat(abs);
    } catch {
        note(loc, `referenced file not found: ${relPath}`);
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
            await validateManifest(manifestPath, kind, d);
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

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
