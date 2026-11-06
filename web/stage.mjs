#!/usr/bin/env node
// Stage the store page into a built catalog folder (CI: `dist/`).
//
//   node web/stage.mjs [dist]
//
// Run it after `npm run build`. It reads <dist>/catalog.json and the source
// tree, then
//   1. writes <dist>/store-extras.json: per-item facts the catalog doesn't
//      carry (a keyword to try, what an extension adds, whether it goes
//      online, a theme's colors) for the page only;
//   2. writes <dist>/index.html with every card already rendered, so the
//      catalog is there before (and without) JavaScript, and the same facts
//      embedded as a JSON data block, so the cards and the filters always
//      agree;
//   3. writes <dist>/style.css with a rule per theme for its preview colors
//      (no style attributes, so the page works under a strict CSP);
//   4. copies the page's other files (WEB_FILES) and web/assets/ alongside.
//
// It writes only those paths, and only as regular files inside <dist>:
//   - a symlink among the page's sources, or at or above a destination, is
//     refused (the build fails) rather than followed;
//   - every destination folder must resolve inside <dist>;
//   - each file is written to a temporary file in its folder and renamed
//     over the old one, which replaces a directory entry and never writes
//     through a link;
//   - catalog.json, detail/, packages/ and *.sha256 (what Kage itself
//     downloads, and the build's checksums) are never written.
// Everything is read and checked before the first write.

import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    applyFilters,
    cardHtml,
    categoryChipsHtml,
    escapeHtml,
    extraFromManifest,
    formatDate,
    paletteCss,
    paletteFromColors,
    plural,
    summaryText,
} from './store-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// Copied as they are. index.html and style.css are rendered, not copied.
export const WEB_FILES = Object.freeze([
    'app.js',
    'store-core.js',
    'boot.js',
    'main.js',
    'demo.js',
    'spotify-callback.html',
]);

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Not on Windows; there, lstat() is the check.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function readJson(p) {
    return JSON.parse(await readFile(p, 'utf8'));
}

async function dirs(parent) {
    try {
        return (await readdir(parent, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

// Regular files and real folders only, like build-catalog's walker: a
// symlink (to a FIFO, /dev/zero or anything outside the checkout) is never
// followed.
async function jsFiles(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await jsFiles(p)));
        else if (e.isFile() && /\.(m?js)$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
    }
    return out;
}

const MAX_READ = 2 * 1024 * 1024;

// A regular file of sane size whose real path is inside `dir`, or null.
async function safeFile(dir, rel) {
    if (typeof rel !== 'string') return null;
    const p = path.resolve(dir, rel);
    if (!p.startsWith(dir + path.sep)) return null;
    try {
        const st = await lstat(p);
        if (!st.isFile() || st.size > MAX_READ) return null;
        const [real, realDir] = await Promise.all([realpath(p), realpath(dir)]);
        return real.startsWith(realDir + path.sep) ? real : null;
    } catch {
        return null;
    }
}

// Does any (non-test) source file make web requests? Extensions can reach
// the web from their sandbox without a capability, so this, not
// `permissions`, is what tells us an extension goes online.
const WEB_API = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/;

export async function reachesWeb(dir) {
    for (const f of await jsFiles(dir)) {
        const p = await safeFile(dir, path.relative(dir, f));
        if (!p) continue;
        try {
            if (WEB_API.test(await readFile(p, 'utf8'))) return true;
        } catch {
            // Unreadable: it can't call anything.
        }
    }
    return false;
}

async function themePalette(dir, manifest) {
    const files = manifest.contributes?.themes ?? {};
    const out = {};
    for (const mode of ['dark', 'light']) {
        const p = await safeFile(dir, files[mode]);
        if (!p) continue;
        try {
            const pal = paletteFromColors((await readJson(p)).colors);
            if (pal) out[mode] = pal;
        } catch {
            // A broken color file only costs the preview.
        }
    }
    return out.dark ? out : null;
}

// id → { path, manifest } for every extension and theme in the source tree.
export async function sourceIndex(root = REPO_ROOT) {
    const out = new Map();
    for (const kind of ['extensions', 'themes']) {
        for (const name of await dirs(path.join(root, kind))) {
            const mp = await safeFile(path.join(root, kind, name), 'manifest.json');
            if (!mp) continue;
            try {
                const manifest = await readJson(mp);
                if (typeof manifest.id === 'string' && ID_RE.test(manifest.id)) {
                    out.set(manifest.id, { path: `${kind}/${name}`, dir: path.join(root, kind, name), manifest });
                }
            } catch {
                // validate-manifests reports these; skip it here.
            }
        }
    }
    return out;
}

export async function buildExtras(catalog, root = REPO_ROOT) {
    const index = await sourceIndex(root);
    const items = {};
    for (const item of catalog.items ?? []) {
        const src = index.get(item?.id);
        if (!src) continue;
        const extra = { path: src.path, ...extraFromManifest(src.manifest) };
        if (item.type === 'theme') {
            const palette = await themePalette(src.dir, src.manifest);
            if (palette) extra.palette = palette;
        } else {
            extra.online = await reachesWeb(src.dir);
        }
        items[item.id] = extra;
    }
    return { schemaVersion: 1, items };
}

// ─── rendering ────────────────────────────────────────────────────────

function fillBetween(text, open, close, label, content) {
    const q = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`(${q(open)})[\\s\\S]*?(${q(close)})`);
    if (!re.test(text)) throw new Error(`${label} has no ${open} … ${close} block`);
    return text.replace(re, (_, a, b) => `${a}${content}${b}`);
}

// Replace what's between <!--@name--> and <!--/@name--> (markers kept, so
// staging the staged file again gives the same result).
export function fill(html, name, content) {
    return fillBetween(html, `<!--@${name}-->`, `<!--/@${name}-->`, 'index.html', content);
}

// The same for style.css: /*@name*/ … /*/@name*/.
export function fillCss(css, name, content) {
    if (content.includes('*/')) throw new Error(`${name}: generated CSS can't contain "*/"`);
    return fillBetween(css, `/*@${name}*/`, `/*/@${name}*/`, 'style.css', content);
}

// The extras as an inert JSON data block. `<` is escaped, so nothing in it
// can close the element or open a comment; a data block isn't script, so a
// CSP doesn't block it.
export function extrasBlock(extras) {
    const json = JSON.stringify({ schemaVersion: extras.schemaVersion ?? 1, items: extras.items ?? {} }).replace(
        /</g,
        '\\u003c'
    );
    return `<script type="application/json" id="store-extras">${json}</script>`;
}

export function renderIndex(template, catalog, extras) {
    const items = Array.isArray(catalog.items) ? catalog.items : [];
    const ex = extras.items ?? {};
    const r = applyFilters(items, {}, ex);
    let html = template;
    html = fill(html, 'ext-cards', r.extensions.map((i) => cardHtml(i, ex[i.id])).join('\n'));
    html = fill(html, 'theme-cards', r.themes.map((i) => cardHtml(i, ex[i.id])).join('\n'));
    html = fill(html, 'chips', categoryChipsHtml(r.counts));
    html = fill(html, 'summary', escapeHtml(summaryText(r)));
    html = fill(
        html,
        'counts',
        `${escapeHtml(plural(r.totals.extensions, 'extension'))} · ${escapeHtml(plural(r.totals.themes, 'theme'))}`
    );
    html = fill(html, 'extras', extrasBlock(extras));
    const built = formatDate(catalog.generatedAt);
    if (built) html = fill(html, 'built', `Catalog built ${escapeHtml(built)}`);
    return html;
}

export function renderStyle(css, catalog, extras) {
    const css2 = paletteCss(Array.isArray(catalog.items) ? catalog.items : [], extras.items ?? {});
    return fillCss(css, 'theme-palettes', css2 ? `\n${css2}\n` : '');
}

// ─── safe output ──────────────────────────────────────────────────────

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

// What Kage downloads, and the build's checksums. Compared case-blind:
// on a case-insensitive disk Catalog.JSON is catalog.json.
export function isProtected(rel) {
    const parts = String(rel).toLowerCase().split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return true;
    if (parts.length === 1 && parts[0] === 'catalog.json') return true;
    if (parts[0] === 'detail' || parts[0] === 'packages') return true;
    return parts[parts.length - 1].endsWith('.sha256');
}

// A plain relative path (a/b/c.ext, no "..", no leading "/") that staging
// may write.
export function assertWritable(rel) {
    const parts = typeof rel === 'string' ? rel.split('/') : [];
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
        throw new Error(`refusing to write "${rel}": not a plain relative path`);
    }
    if (isProtected(rel)) throw new Error(`refusing to write "${rel}": catalog.json, detail/, packages/ and *.sha256 belong to the catalog build`);
}

// Read one of the page's own files: a regular file (never a symlink) whose
// real path is inside web/.
async function readSource(webReal, rel) {
    const p = path.join(webReal, ...rel.split('/'));
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new Error(`web/${rel} is a symlink; the page's files must be regular files`);
    if (!st.isFile()) throw new Error(`web/${rel} is not a regular file`);
    if (!inside(webReal, await realpath(p))) throw new Error(`web/${rel} resolves outside web/`);
    const fh = await open(p, constants.O_RDONLY | NOFOLLOW);
    try {
        if (!(await fh.stat()).isFile()) throw new Error(`web/${rel} is not a regular file`);
        return await fh.readFile();
    } finally {
        await fh.close();
    }
}

// Every file under web/<dir>, as relative paths. Dotfiles (.DS_Store) are
// left out; a symlink or anything that isn't a file or folder fails.
async function walkSource(webReal, dir) {
    const out = [];
    const abs = path.join(webReal, ...dir.split('/'));
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new Error(`web/${dir} is a symlink; the page's files must be regular files`);
    if (!st.isDirectory()) throw new Error(`web/${dir} is not a folder`);
    for (const e of await readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const rel = `${dir}/${e.name}`;
        if (e.isSymbolicLink()) throw new Error(`web/${rel} is a symlink; the page's files must be regular files`);
        if (e.isDirectory()) out.push(...(await walkSource(webReal, rel)));
        else if (e.isFile()) out.push(rel);
        else throw new Error(`web/${rel} is not a regular file`);
    }
    return out;
}

// Check (and with `create`, make) each folder from <dist> down to `relDir`:
// none may be a symlink or a non-folder, and the last must resolve inside
// <dist>. Returns its real path.
async function destDir(distReal, relDir, create) {
    let cur = distReal;
    for (const part of relDir ? relDir.split('/') : []) {
        cur = path.join(cur, part);
        let st = null;
        try {
            st = await lstat(cur);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        if (!st) {
            if (!create) return null; // nothing there yet: nothing to refuse
            try {
                await mkdir(cur);
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
            }
            st = await lstat(cur);
        }
        if (st.isSymbolicLink()) throw new Error(`${path.relative(distReal, cur)} in the output is a symlink; refusing to write through it`);
        if (!st.isDirectory()) throw new Error(`${path.relative(distReal, cur)} in the output is not a folder`);
    }
    const real = await realpath(cur);
    if (!inside(distReal, real)) throw new Error(`${relDir || '.'} resolves outside the output folder`);
    return real;
}

// The destination may be missing or a regular file; anything else
// (a symlink, a folder, a FIFO) is refused.
async function checkDest(file, rel) {
    let st;
    try {
        st = await lstat(file);
    } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`${rel} in the output is a symlink; refusing to write through it`);
    if (!st.isFile()) throw new Error(`${rel} in the output is not a regular file`);
}

const split = (rel) => {
    const i = rel.lastIndexOf('/');
    return i < 0 ? ['', rel] : [rel.slice(0, i), rel.slice(i + 1)];
};

async function checkOutput(distReal, rel) {
    assertWritable(rel);
    const [dir, base] = split(rel);
    const real = await destDir(distReal, dir, false);
    if (real) await checkDest(path.join(real, base), rel);
}

async function writeOutput(distReal, rel, data) {
    assertWritable(rel);
    const [dir, base] = split(rel);
    const real = await destDir(distReal, dir, true);
    if (isProtected(path.relative(distReal, path.join(real, base)))) throw new Error(`refusing to write "${rel}"`);
    const dest = path.join(real, base);
    await checkDest(dest, rel);
    // O_EXCL: the temp name is new, so this can't open (or follow) anything
    // that was already there.
    const tmp = path.join(real, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    try {
        try {
            await fh.writeFile(data);
        } finally {
            await fh.close();
        }
        // rename() swaps the directory entry: a link (or a hard link to
        // catalog.json) at `dest` is replaced, never written through.
        await rename(tmp, dest);
    } catch (e) {
        await rm(tmp, { force: true });
        throw e;
    }
}

// ─── staging ──────────────────────────────────────────────────────────

export async function stage(distDir, { root = REPO_ROOT, log = console.log } = {}) {
    let distReal;
    try {
        distReal = await realpath(path.resolve(distDir));
    } catch {
        distReal = null;
    }
    const catalogPath = distReal && path.join(distReal, 'catalog.json');
    let catalogStat = null;
    try {
        catalogStat = catalogPath ? await lstat(catalogPath) : null;
    } catch {
        catalogStat = null;
    }
    if (!catalogStat) {
        throw new Error(`${path.join(path.resolve(distDir), 'catalog.json')} not found. Run \`npm run build\` first.`);
    }
    const catalog = await readJson(catalogPath);
    const webReal = await realpath(path.join(root, 'web'));

    // Read and render everything first.
    const extras = await buildExtras(catalog, root);
    extras.generatedAt = catalog.generatedAt ?? null;
    const out = new Map();
    out.set('store-extras.json', Buffer.from(`${JSON.stringify(extras, null, 2)}\n`));
    out.set('index.html', Buffer.from(renderIndex((await readSource(webReal, 'index.html')).toString('utf8'), catalog, extras)));
    out.set('style.css', Buffer.from(renderStyle((await readSource(webReal, 'style.css')).toString('utf8'), catalog, extras)));
    for (const f of WEB_FILES) out.set(f, await readSource(webReal, f));
    for (const f of await walkSource(webReal, 'assets')) out.set(f, await readSource(webReal, f));

    // Check every destination, then write.
    for (const rel of out.keys()) await checkOutput(distReal, rel);
    for (const [rel, data] of out) await writeOutput(distReal, rel, data);

    log(
        `Staged the store page into ${distReal} (${out.size} files; ${Object.keys(extras.items).length} of ${(catalog.items ?? []).length} item(s) with extras).`
    );
    return { extras, files: [...out.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    stage(process.argv[2] || path.join(REPO_ROOT, 'dist')).catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
