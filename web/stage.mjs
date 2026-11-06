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
//      catalog is there before (and without) JavaScript;
//   3. copies the page's other files and web/assets/ alongside.
//
// It only ever adds or overwrites the files in WEB_FILES, assets/,
// index.html and store-extras.json. catalog.json, detail/ and packages/
// (which Kage itself downloads) are read, never written.

import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    applyFilters,
    cardHtml,
    categoryChipsHtml,
    escapeHtml,
    extraFromManifest,
    formatDate,
    paletteFromColors,
    plural,
    summaryText,
} from './store-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

// Copied as they are. index.html is rendered, not copied.
export const WEB_FILES = Object.freeze([
    'style.css',
    'app.js',
    'store-core.js',
    'main.js',
    'demo.js',
    'spotify-callback.html',
]);

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

// Replace what's between <!--@name--> and <!--/@name--> (markers kept, so
// staging the staged file again gives the same result).
export function fill(html, name, content) {
    const re = new RegExp(`(<!--@${name}-->)[\\s\\S]*?(<!--/@${name}-->)`);
    if (!re.test(html)) throw new Error(`index.html has no <!--@${name}--> … <!--/@${name}--> block`);
    return html.replace(re, (_, a, b) => `${a}${content}${b}`);
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
    const built = formatDate(catalog.generatedAt);
    if (built) html = fill(html, 'built', `Catalog built ${escapeHtml(built)}`);
    return html;
}

export async function stage(distDir, { root = REPO_ROOT, log = console.log } = {}) {
    const dist = path.resolve(distDir);
    const catalogPath = path.join(dist, 'catalog.json');
    if (!existsSync(catalogPath)) {
        throw new Error(`${catalogPath} not found. Run \`npm run build\` first.`);
    }
    const catalog = await readJson(catalogPath);
    const web = path.join(root, 'web');

    const extras = await buildExtras(catalog, root);
    extras.generatedAt = catalog.generatedAt ?? null;
    await writeFile(path.join(dist, 'store-extras.json'), `${JSON.stringify(extras, null, 2)}\n`);

    const template = await readFile(path.join(web, 'index.html'), 'utf8');
    await writeFile(path.join(dist, 'index.html'), renderIndex(template, catalog, extras));

    for (const f of WEB_FILES) await cp(path.join(web, f), path.join(dist, f));
    const assets = path.join(web, 'assets');
    if ((await stat(assets)).isDirectory()) {
        await mkdir(path.join(dist, 'assets'), { recursive: true });
        await cp(assets, path.join(dist, 'assets'), { recursive: true });
    }
    log(
        `Staged the store page into ${dist} (${Object.keys(extras.items).length} of ${(catalog.items ?? []).length} item(s) with extras).`
    );
    return { extras };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    stage(process.argv[2] || path.join(REPO_ROOT, 'dist')).catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
