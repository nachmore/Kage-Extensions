#!/usr/bin/env node
// Validates every manifest.json under extensions/ and themes/.
// Exits non-zero on any violation; prints the full list of errors first
// (single-pass), so a contributor sees everything they need to fix in one CI run.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VALID_TYPES = new Set(['extension', 'theme', 'commands']);

// Mirrors ui/js/shared/extension-permissions.js KNOWN_CAPABILITIES.
// Keep in sync — the host enforces this list at install time too.
//
// `shell` was the previous catch-all for "open URLs, file paths, and
// launch other apps." Pre-launch we split it into `urls` (web links +
// safe deep links, scheme-allowlisted at the sandbox boundary) and
// `launch` (open arbitrary files / launch apps by name). No back-
// compat path — any manifest that still says `shell` will fail
// validation here, in the host loader, and at the install-time
// prompt. Replace with `urls` for browser handoff or `launch` for
// genuine app/file launching.
const KNOWN_CAPABILITIES = new Set([
    'storage',
    'clipboard',
    'urls',
    'launch',
    'network',
    'oauth',
    'filesystem',
    'window',
    'windows',
    'notifications',
    'calendar',
    'session',
    'agent',
    'activity',
    'automation',
    'tts',
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

async function validateManifest(manifestPath, expectedKind, dirName) {
    const loc = path.relative(repoRoot, manifestPath);
    let m;
    try {
        m = await readJson(manifestPath);
    } catch (e) {
        note(loc, `failed to parse JSON: ${e.message}`);
        return;
    }

    if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
        note(loc, `'id' must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
    }
    if (typeof m.name !== 'string' || m.name.trim() === '') {
        note(loc, `'name' is required`);
    }
    if (typeof m.version !== 'string' || !SEMVER_PATTERN.test(m.version)) {
        note(loc, `'version' must be a semver string`);
    }
    if (typeof m.type !== 'string' || !VALID_TYPES.has(m.type)) {
        note(loc, `'type' must be one of: ${[...VALID_TYPES].join(', ')}`);
    }

    if (expectedKind === 'extension' && m.type !== 'extension') {
        note(loc, `expected type "extension" under extensions/`);
    }
    if (expectedKind === 'theme' && m.type !== 'theme') {
        note(loc, `expected type "theme" under themes/`);
    }

    if (m.type === 'extension') {
        if (!Array.isArray(m.permissions)) {
            note(loc, `'permissions' is required (use [] for no capabilities)`);
        } else {
            for (const p of m.permissions) {
                if (typeof p !== 'string' || !KNOWN_CAPABILITIES.has(p)) {
                    note(loc, `unknown capability '${p}' in 'permissions'`);
                }
            }
        }
    }

    if (m.tags !== undefined) {
        if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
            note(loc, `'tags' must be an array of strings`);
        }
    }

    // Verify that contributed file paths exist.
    if (m.contributes && typeof m.contributes === 'object') {
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
        if (Array.isArray(m.contributes.css)) {
            for (const c of m.contributes.css) await checkRel(loc, manifestPath, c);
        }
        if (Array.isArray(m.contributes.widgets)) {
            for (const w of m.contributes.widgets) {
                if (typeof w?.module === 'string') await checkRel(loc, manifestPath, w.module);
            }
        }
        if (m.contributes.themes && typeof m.contributes.themes === 'object') {
            for (const v of Object.values(m.contributes.themes)) {
                if (typeof v === 'string') await checkRel(loc, manifestPath, v);
            }
        }
    }

    // Folder name must equal manifest id for extensions; themes are a touch
    // looser (the published id often has a "-theme" suffix while the folder
    // doesn't), but we still warn if they're wildly out of sync.
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
