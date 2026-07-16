#!/usr/bin/env node
// Per-extension i18n hygiene.
//
// The host's contract (docs/EXTENSIONS.md and docs/I18N.md in the Kage
// repo) requires:
//   - `_locales/en/messages.json` exists for every extension.
//   - Every `__MSG_KEY__` token in manifest.json resolves in the EN
//     catalog.
//   - Every `t('key')` / `i18n.t('key')` call site in extension JS
//     resolves in the EN catalog.
//   - Non-EN catalogs aren't required to have every key — the host's
//     translate.py seeds them from the EN catalog before release —
//     but if a key IS present, it must look like a real translation
//     (non-empty `message` string, no leftover `TODO` markers from a
//     half-finished hand-edit).
//
// Errors here block CI; warnings don't. The split:
//   error: missing _locales/en, manifest token unresolved, t() call
//          referencing a key that doesn't exist anywhere.
//   warn:  unused EN keys (might land in a future release), drift
//          between EN and non-EN.
//
// Affected-paths logic mirrors the other check-*.mjs scripts.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedItems, shouldRun } from './lib/affected.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const flagAll = args.has('--all');

// `t('key')`, `t("key")`, `i18n.t('key')`, `this.t('key')`,
// `context.i18n.t('key')`, etc. The leading-boundary class
// `(?:^|[^\w$])` allows `.` (so `this.t` matches) but rejects word
// chars (so `prevent.t` doesn't).
const T_CALL_RE = /(?:^|[^\w$])(?:[\w.$]*\.)?t\s*\(\s*['"]([\w.\-]+)['"]/g;

// Author-supplied hint for dynamic key lookups, e.g.
// `// i18n-keys: wmo.*` for `t(\`wmo.${code}\`)`. Each comma-separated
// entry can be an exact key OR a `prefix.*` glob that whitelists every
// EN-catalog key starting with that prefix.
const KEY_HINT_RE = /\/\/\s*i18n-keys:\s*([\w.\-, *]+)/gi;

// `__MSG_key__` token — only valid as a complete string value of a
// localizable manifest field.
const MSG_TOKEN_RE = /^__MSG_([\w.\-]+)__$/;

const errors = [];
const warnings = [];

async function listJsFiles(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.name === 'node_modules' || e.name === '_locales') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await listJsFiles(full)));
        } else if (/\.(?:js|mjs|cjs)$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

async function readJson(p) {
    try {
        return JSON.parse(await readFile(p, 'utf8'));
    } catch {
        return null;
    }
}

function catalogKeys(catalog) {
    if (!catalog || typeof catalog !== 'object') return new Set();
    return new Set(Object.keys(catalog).filter((k) => !k.startsWith('_')));
}

async function readEnCatalog(extDir) {
    const p = path.join(extDir, '_locales', 'en', 'messages.json');
    return readJson(p);
}

async function listLocaleDirs(localesDir) {
    let entries;
    try {
        entries = await readdir(localesDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function checkExtension(itemKey) {
    const extDir = path.join(repoRoot, itemKey);
    const manifestPath = path.join(extDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    if (!manifest) {
        // Schema validator will have caught this; nothing to do.
        return;
    }

    // Collect manifest tokens up front so we can decide whether the
    // extension uses i18n at all. An extension with no tokens and no
    // t() calls in code can legitimately omit _locales/.
    const manifestTokens = new Set();
    for (const field of ['name', 'description']) {
        const v = manifest[field];
        if (typeof v === 'string') {
            const m = v.match(MSG_TOKEN_RE);
            if (m) manifestTokens.add(m[1]);
        }
    }

    // Scan code for t() call sites and `// i18n-keys: ...` hints.
    const tCallSites = []; // [{ key, file, line }]
    const exactHintedKeys = new Set();
    const prefixHints = []; // each entry is the literal `<prefix>.` so a startsWith match works
    const files = await listJsFiles(extDir);
    for (const f of files) {
        const txt = await readFile(f, 'utf8').catch(() => '');
        if (!txt) continue;
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            T_CALL_RE.lastIndex = 0;
            for (const m of line.matchAll(T_CALL_RE)) {
                tCallSites.push({
                    key: m[1],
                    file: path.relative(repoRoot, f),
                    line: i + 1,
                });
            }
            KEY_HINT_RE.lastIndex = 0;
            for (const m of line.matchAll(KEY_HINT_RE)) {
                for (const raw of m[1].split(',')) {
                    const entry = raw.trim();
                    if (!entry) continue;
                    if (entry.endsWith('.*')) {
                        prefixHints.push(entry.slice(0, -1)); // keeps the trailing '.'
                    } else if (entry.endsWith('*')) {
                        prefixHints.push(entry.slice(0, -1));
                    } else {
                        exactHintedKeys.add(entry);
                    }
                }
            }
        }
    }

    const usesI18n = manifestTokens.size > 0 || tCallSites.length > 0;
    const enCatalog = await readEnCatalog(extDir);
    const enKeys = catalogKeys(enCatalog);

    if (usesI18n && enCatalog === null) {
        errors.push(
            `${itemKey}: missing _locales/en/messages.json (required: manifest tokens or t() calls present)`
        );
        return;
    }
    if (!usesI18n) {
        // Nothing more to do. If the extension ships an EN catalog
        // anyway (some authors prefer the structure), that's fine.
        return;
    }

    // 1. Manifest tokens must resolve.
    for (const tok of manifestTokens) {
        if (!enKeys.has(tok)) {
            errors.push(
                `${itemKey}/manifest.json: __MSG_${tok}__ not found in _locales/en/messages.json`
            );
        }
    }

    // 2. Every t() call site must resolve.
    for (const site of tCallSites) {
        if (!enKeys.has(site.key)) {
            errors.push(
                `${site.file}:${site.line}: t('${site.key}') not found in _locales/en/messages.json`
            );
        }
    }

    // 3. EN keys not referenced anywhere — warn (could be a future
    //    feature; could be cruft). Honour author-supplied
    //    `// i18n-keys:` hints for dynamic lookups.
    const referenced = new Set([
        ...manifestTokens,
        ...tCallSites.map((s) => s.key),
        ...exactHintedKeys,
    ]);
    const isHintedByPrefix = (key) => prefixHints.some((p) => key.startsWith(p));
    for (const key of enKeys) {
        if (!referenced.has(key) && !isHintedByPrefix(key)) {
            warnings.push(
                `${itemKey}/_locales/en/messages.json: '${key}' is not referenced from manifest or code`
            );
        }
    }

    // 4. Non-EN catalog drift. The host's translate.py auto-seeds
    //    these, so a missing key isn't necessarily a problem. But a
    //    non-EN catalog with a key whose `message` is empty/TODO IS
    //    a problem (pre-launch, we don't want shipped TODO strings).
    const localesDir = path.join(extDir, '_locales');
    const langs = (await listLocaleDirs(localesDir)).filter((l) => l !== 'en');
    for (const lang of langs) {
        const cat = await readJson(path.join(localesDir, lang, 'messages.json'));
        if (!cat || typeof cat !== 'object') continue;

        // Key-set drift: every EN key must be present in the non-EN catalog.
        // A missing key means the host renders no string (or the EN fallback)
        // for that locale — and the host's own check_i18n.py hard-fails on it,
        // blocking ingest. This was previously undetected here, which let the
        // spotify extension ship 3 keys missing from 31 catalogs and pass
        // `npm run check:i18n`. Ignore metadata keys (`_source_hash` etc.).
        const catKeys = new Set(Object.keys(cat).filter((k) => !k.startsWith('_')));
        for (const enKey of enKeys) {
            if (!catKeys.has(enKey)) {
                errors.push(
                    `${itemKey}/_locales/${lang}/messages.json: missing key '${enKey}' (present in EN). Run the host's translate.py to regenerate.`
                );
            }
        }

        for (const [k, v] of Object.entries(cat)) {
            if (k.startsWith('_')) continue;
            const msg = v?.message;
            if (typeof msg !== 'string' || msg.trim() === '') {
                errors.push(
                    `${itemKey}/_locales/${lang}/messages.json: key '${k}' has empty message`
                );
            } else if (/^TODO[:\s]|\{\{TODO\}\}/.test(msg)) {
                // Match an unfinished marker, not a trigger string that
                // happens to start with the word "todo". Common real-
                // world signals are leading `TODO:` (hand-edit
                // shorthand) and the `{{TODO}}` placeholder some
                // translation tools leave behind. Both are intentionally
                // case-sensitive — a real translation might legitimately
                // start with the lowercase word "todo", but a screaming
                // `TODO` marker is unambiguously unfinished.
                errors.push(
                    `${itemKey}/_locales/${lang}/messages.json: key '${k}' looks unfinished ('${msg.slice(0, 40)}...')`
                );
            }
            if (!enKeys.has(k)) {
                warnings.push(
                    `${itemKey}/_locales/${lang}/messages.json: key '${k}' has no EN counterpart (drop it or add to EN)`
                );
            }
        }
    }
}

async function main() {
    const affected = await affectedItems();
    const targets = affected.all.filter(
        (it) => it.startsWith('extensions/') && shouldRun(it, affected, { all: flagAll })
    );

    if (affected.mode === 'changed' && !flagAll) {
        const totalExt = affected.all.filter((it) => it.startsWith('extensions/')).length;
        const skipped = totalExt - targets.length;
        if (skipped > 0) {
            console.log(
                `[i18n] checking ${targets.length}/${totalExt} extension(s) — ${skipped} unchanged.`
            );
        }
    }

    for (const it of targets) {
        await checkExtension(it);
    }

    for (const w of warnings) console.warn(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);

    console.log(`[i18n] ${errors.length} error(s), ${warnings.length} warning(s).`);
    if (errors.length > 0) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
