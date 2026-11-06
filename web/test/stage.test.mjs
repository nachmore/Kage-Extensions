// web/stage.mjs: the extras it derives from the source tree, the pre-render,
// and what it may (and may not) write into a built catalog folder.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, WEB_FILES, buildExtras, reachesWeb, fill, renderIndex, sourceIndex, stage } from '../stage.mjs';

const web = path.join(REPO_ROOT, 'web');
const here = path.dirname(fileURLToPath(import.meta.url));

// A catalog shaped like build-catalog.mjs's, from the real manifests.
async function catalogFromSource() {
    const index = await sourceIndex();
    const items = [...index.values()]
        .filter((s) => s.manifest.type === 'extension' || s.manifest.type === 'theme')
        .map(({ manifest: m }) => ({
            id: m.id,
            type: m.type,
            name: m.id,
            version: m.version,
            author: m.author ?? null,
            description: 'x',
            icon: m.icon ?? '',
            tags: Array.isArray(m.tags) ? m.tags : [],
            permissions: Array.isArray(m.permissions) ? m.permissions : [],
            downloadUrl: `packages/${m.id}-${m.version}.zip`,
            detailUrl: `detail/${m.id}.json`,
            size: 1000,
        }));
    return { schemaVersion: 1, generatedAt: '2026-11-06T12:00:00.000Z', items };
}

let catalog;
let extras;
beforeAll(async () => {
    catalog = await catalogFromSource();
    extras = await buildExtras(catalog);
});

describe('buildExtras', () => {
    it('covers every catalog item it has source for', () => {
        for (const item of catalog.items) expect(extras.items[item.id], item.id).toBeTruthy();
        expect(extras.items.weather.path).toBe('extensions/weather');
        expect(extras.items['nord-theme'].path).toBe('themes/nord');
    });

    it('reads the trigger and contributions from the manifest', () => {
        expect(extras.items.weather.trigger).toBe('weather');
        expect(extras.items.math.trigger).toBeNull();
        expect(extras.items.calendar.contributes).toEqual(expect.arrayContaining(['toolProvider', 'widgets']));
        expect(extras.items.spotify.mascot).toEqual(['music']);
    });

    it('flags extensions whose code calls fetch() as online', () => {
        for (const id of ['currency', 'dictionary', 'github', 'spotify', 'weather']) {
            expect(extras.items[id].online, id).toBe(true);
        }
        for (const id of ['math', 'timer', 'emoji', 'hello-world']) expect(extras.items[id].online, id).toBe(false);
    });

    it('takes a theme’s dark and light colors from its files', () => {
        const p = extras.items['nord-theme'].palette;
        expect(p.dark).toMatchObject({ accent: '#88C0D0', bg: '#2E3440' });
        expect(p.light).toMatchObject({ accent: '#5E81AC', bg: '#ECEFF4' });
        expect(extras.items['kiro-ish-theme'].palette.dark.invert).toBe('1');
    });

    it('skips items it has no source for', async () => {
        const e = await buildExtras({ items: [{ id: 'not-here', type: 'extension' }] });
        expect(e.items).toEqual({});
    });
});

describe('reachesWeb', () => {
    it('ignores tests and other files', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'kage-store-fetch-'));
        try {
            await writeFile(path.join(dir, 'search.test.js'), 'fetch("x")');
            await writeFile(path.join(dir, 'README.md'), 'fetch("x")');
            await writeFile(path.join(dir, 'search.js'), 'export const a = 1;');
            expect(await reachesWeb(dir)).toBe(false);
            await mkdir(path.join(dir, 'lib'));
            await writeFile(path.join(dir, 'lib', 'api.js'), 'navigator.sendBeacon(url, body)');
            expect(await reachesWeb(dir)).toBe(true);
            await writeFile(path.join(dir, 'lib', 'api.js'), 'const ws = new WebSocket(url)');
            expect(await reachesWeb(dir)).toBe(true);
            await writeFile(path.join(dir, 'lib', 'api.js'), 'await fetch (url)');
            expect(await reachesWeb(dir)).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('symlinks', () => {
    it('never follows a symlink out of an item folder', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'kage-store-links-'));
        try {
            const outside = path.join(root, 'outside');
            await mkdir(outside);
            await writeFile(path.join(outside, 'colors.json'), JSON.stringify({ colors: { 'kage-accent': '#111111', 'kage-bg': '#222222' } }));
            await writeFile(path.join(outside, 'net.js'), 'fetch("https://example.com")');
            const t = path.join(root, 'themes', 'linked');
            await mkdir(t, { recursive: true });
            await writeFile(
                path.join(t, 'manifest.json'),
                JSON.stringify({ id: 'linked-theme', type: 'theme', contributes: { themes: { dark: './dark.json', light: './sub/light.json' } } })
            );
            await symlink(path.join(outside, 'colors.json'), path.join(t, 'dark.json'));
            await symlink(outside, path.join(t, 'sub'));
            await writeFile(path.join(outside, 'light.json'), '{}');
            const x = path.join(root, 'extensions', 'linked');
            await mkdir(x, { recursive: true });
            await writeFile(path.join(x, 'manifest.json'), JSON.stringify({ id: 'linked', type: 'extension' }));
            await symlink(path.join(outside, 'net.js'), path.join(x, 'search.js'));
            const e = await buildExtras(
                { items: [{ id: 'linked-theme', type: 'theme' }, { id: 'linked', type: 'extension' }] },
                root
            );
            expect(e.items['linked-theme'].palette).toBeUndefined();
            expect(e.items.linked.online).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('renderIndex', () => {
    it('pre-renders every card, the chips, the counts and the build date', async () => {
        const template = await readFile(path.join(web, 'index.html'), 'utf8');
        const html = renderIndex(template, catalog, extras);
        for (const item of catalog.items) expect(html, item.id).toContain(`id="ext-${item.id}"`);
        const exts = catalog.items.filter((i) => i.type === 'extension').length;
        const themes = catalog.items.filter((i) => i.type === 'theme').length;
        expect(html).toContain(`<!--@counts-->${exts} extensions · ${themes} themes<!--/@counts-->`);
        expect(html).toContain('<!--@built-->Catalog built 2026-11-06<!--/@built-->');
        expect(html).toMatch(/<!--@chips--><button type="button" class="chip" data-cat="all" aria-pressed="true">/);
        expect(html).not.toContain('Loading the catalog');
        // Rendering the rendered page again changes nothing.
        expect(renderIndex(html, catalog, extras)).toBe(html);
    });

    it('fails loudly when a marker is missing', () => {
        expect(() => fill('<p>no markers</p>', 'ext-cards', 'x')).toThrow(/ext-cards/);
        expect(fill('a<!--@x-->old<!--/@x-->b', 'x', '$&$1')).toBe('a<!--@x-->$&$1<!--/@x-->b');
    });
});

describe('stage', () => {
    let dist;
    beforeAll(async () => {
        dist = await mkdtemp(path.join(tmpdir(), 'kage-store-dist-'));
    });
    afterAll(async () => {
        await rm(dist, { recursive: true, force: true });
    });

    it('refuses to run before the catalog is built', async () => {
        await expect(stage(path.join(dist, 'nothing-here'), { log: () => {} })).rejects.toThrow(/npm run build/);
    });

    it('adds the page and leaves the catalog, details and packages alone', async () => {
        const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
        await writeFile(path.join(dist, 'catalog.json'), catalogText);
        await mkdir(path.join(dist, 'packages'));
        await mkdir(path.join(dist, 'detail'));
        await writeFile(path.join(dist, 'packages', 'math-1.1.0.zip'), 'zip bytes');
        await writeFile(path.join(dist, 'detail', 'math.json'), '{"id":"math"}');

        await stage(dist, { log: () => {} });

        expect(await readFile(path.join(dist, 'catalog.json'), 'utf8')).toBe(catalogText);
        expect(await readFile(path.join(dist, 'packages', 'math-1.1.0.zip'), 'utf8')).toBe('zip bytes');
        expect(await readFile(path.join(dist, 'detail', 'math.json'), 'utf8')).toBe('{"id":"math"}');
        for (const f of WEB_FILES) expect(existsSync(path.join(dist, f)), f).toBe(true);
        expect(existsSync(path.join(dist, 'assets', 'mascot', 'kage-icon.svg'))).toBe(true);
        const staged = JSON.parse(await readFile(path.join(dist, 'store-extras.json'), 'utf8'));
        expect(staged.items.weather.trigger).toBe('weather');
        expect(staged.generatedAt).toBe(catalog.generatedAt);
        expect(await readFile(path.join(dist, 'index.html'), 'utf8')).toContain('id="ext-weather"');
        expect(await readFile(path.join(dist, 'spotify-callback.html'), 'utf8')).toBe(
            await readFile(path.join(web, 'spotify-callback.html'), 'utf8')
        );
    });

    it('leaves no broken local references in the staged pages', async () => {
        const local = (ref) =>
            ref &&
            !/^(https?:|kage:|mailto:|#|data:)/.test(ref) &&
            !ref.startsWith('//');
        const missing = [];
        for (const page of ['index.html', 'spotify-callback.html']) {
            const html = await readFile(path.join(dist, page), 'utf8');
            for (const [, ref] of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
                // The zips are build-catalog's; this fixture catalog has none.
                if (!local(ref) || ref === './' || ref.startsWith('packages/')) continue;
                const file = ref.replace(/^\.\//, '').split(/[?#]/)[0];
                if (!existsSync(path.join(dist, file))) missing.push(`${page}: ${ref}`);
            }
        }
        const css = await readFile(path.join(dist, 'style.css'), 'utf8');
        for (const [, ref] of css.matchAll(/url\("?([^")]+)"?\)/g)) {
            if (local(ref) && !existsSync(path.join(dist, ref))) missing.push(`style.css: ${ref}`);
        }
        // Script imports.
        for (const js of ['app.js']) {
            const src = await readFile(path.join(dist, js), 'utf8');
            for (const [, ref] of src.matchAll(/from '(\.\/[^']+)'/g)) {
                if (!existsSync(path.join(dist, ref))) missing.push(`${js}: ${ref}`);
            }
        }
        expect(missing).toEqual([]);
    });
});

describe('CI', () => {
    it('stages the page after building the catalog', async () => {
        const yml = await readFile(path.join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8');
        const build = yml.indexOf('- run: npm run build');
        const staging = yml.indexOf('node web/stage.mjs dist');
        expect(build).toBeGreaterThan(-1);
        expect(staging).toBeGreaterThan(build);
        expect(yml.indexOf('upload-pages-artifact')).toBeGreaterThan(staging);
    });

    it('keeps the test folder out of the published files', () => {
        expect(WEB_FILES.some((f) => f.includes('test'))).toBe(false);
        expect(path.relative(web, here)).toBe('test');
    });
});
