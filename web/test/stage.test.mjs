// web/stage.mjs: the extras it derives from the source tree, the pre-render,
// and what it may (and may not) write into a built catalog folder.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    REPO_ROOT,
    WEB_FILES,
    assertWritable,
    buildExtras,
    extrasBlock,
    fill,
    fillCss,
    isProtected,
    reachesWeb,
    renderIndex,
    renderStyle,
    sourceIndex,
    stage,
} from '../stage.mjs';

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
        expect(() => fillCss('a {}', 'theme-palettes', 'x')).toThrow(/theme-palettes/);
        expect(() => fillCss('/*@x*//*/@x*/', 'x', 'a {} /* */')).toThrow(/\*\//);
    });

    it('renders a page a strict CSP (script-src and style-src \'self\') allows', async () => {
        const template = await readFile(path.join(web, 'index.html'), 'utf8');
        const html = renderIndex(template, catalog, extras);
        // No inline script: every <script> loads a file, except the JSON data block.
        for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
            expect(/\ssrc="\.\/[a-z-]+\.js"/.test(tag) || tag === '<script type="application/json" id="store-extras">', tag).toBe(true);
        }
        expect(html.match(/<script type="application\/json"/g)).toHaveLength(1);
        // No inline handlers, no style attributes, no <style> element.
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/\sstyle\s*=/i);
        expect(html).not.toMatch(/<style\b/i);
        expect(html).toContain('<html lang="en" class="no-js">');
        expect(html).toMatch(/<script src="\.\/boot\.js"><\/script>/);
    });

    it('embeds the extras as inert JSON the page reads back', async () => {
        const template = await readFile(path.join(web, 'index.html'), 'utf8');
        const html = renderIndex(template, catalog, extras);
        const json = /<script type="application\/json" id="store-extras">([^<]*)<\/script>/.exec(html)[1];
        expect(JSON.parse(json).items).toEqual(JSON.parse(JSON.stringify(extras.items)));
        const tricky = extrasBlock({ items: { x: { trigger: '</script><script>alert(1)</script><!--' } } });
        const open = '<script type="application/json" id="store-extras">';
        expect(tricky.startsWith(open) && tricky.endsWith('</script>')).toBe(true);
        const body = tricky.slice(open.length, -'</script>'.length);
        expect(body).not.toContain('<');
        expect(JSON.parse(body).items.x.trigger).toBe('</script><script>alert(1)</script><!--');
    });

    it('writes each theme’s preview colors into the stylesheet', async () => {
        const css = await readFile(path.join(web, 'style.css'), 'utf8');
        const out = renderStyle(css, catalog, extras);
        expect(out).toMatch(/\.theme-card\[data-id="nord-theme"\] \{\n {4}--d-accent: #88C0D0;/);
        expect(out).toContain('--l-bg: #ECEFF4;');
        for (const t of catalog.items.filter((i) => i.type === 'theme')) expect(out, t.id).toContain(`[data-id="${t.id}"]`);
        expect(out.startsWith(css.slice(0, css.indexOf('/*@theme-palettes*/')))).toBe(true);
        expect(renderStyle(out, catalog, extras)).toBe(out);
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
        for (const f of WEB_FILES) {
            expect(await readFile(path.join(dist, f)), f).toEqual(await readFile(path.join(web, f)));
        }
        expect(await readFile(path.join(dist, 'style.css'), 'utf8')).toContain('.theme-card[data-id="nord-theme"]');
        expect(await tempFiles(dist)).toEqual([]);
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

// Every leftover temp file under `dir`.
async function tempFiles(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (/^\..*\.tmp$/.test(e.name)) out.push(path.join(e.parentPath, e.name));
    }
    return out;
}

const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

// Hashes of everything Kage downloads (and the checksums), by path.
async function clientFiles(dist) {
    const out = {};
    out['catalog.json'] = await sha(path.join(dist, 'catalog.json'));
    for (const dir of ['detail', 'packages']) {
        for (const f of await readdir(path.join(dist, dir))) out[`${dir}/${f}`] = await sha(path.join(dist, dir, f));
    }
    return out;
}

describe('safe output', () => {
    let tmp;
    let n = 0;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'kage-store-safe-'));
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    // A built catalog folder, and a scratch folder "outside" it.
    async function fixture() {
        const base = path.join(tmp, `case-${++n}`);
        const dist = path.join(base, 'dist');
        const outside = path.join(base, 'outside');
        await mkdir(path.join(dist, 'detail'), { recursive: true });
        await mkdir(path.join(dist, 'packages'), { recursive: true });
        await mkdir(outside);
        await writeFile(path.join(dist, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
        await writeFile(path.join(dist, 'detail', 'math.json'), '{"id":"math"}');
        await writeFile(path.join(dist, 'packages', 'math-1.1.0.zip'), 'zip bytes');
        await writeFile(path.join(dist, 'packages', 'math-1.1.0.zip.sha256'), 'abc  math-1.1.0.zip\n');
        await writeFile(path.join(outside, 'keep.txt'), 'outside');
        return { base, dist, outside, before: await clientFiles(dist) };
    }

    // A copy of the source tree's web/ to plant things in.
    async function sourceRoot(base) {
        const root = path.join(base, 'repo');
        await cp(web, path.join(root, 'web'), { recursive: true, filter: (src) => !src.includes(`${path.sep}test`) });
        return root;
    }

    async function refuses(dist, re, opts = {}) {
        await expect(stage(dist, { log: () => {}, ...opts })).rejects.toThrow(re);
    }

    it('won’t write store-extras.json through a symlink to catalog.json', async () => {
        const { dist, before } = await fixture();
        await symlink('catalog.json', path.join(dist, 'store-extras.json'));
        await refuses(dist, /store-extras\.json in the output is a symlink/);
        expect(await clientFiles(dist)).toEqual(before);
        expect(Array.isArray(JSON.parse(await readFile(path.join(dist, 'catalog.json'), 'utf8')).items)).toBe(true);
        // Checked before anything was written.
        expect(existsSync(path.join(dist, 'index.html'))).toBe(false);
    });

    it('won’t write index.html through a symlink out of the folder', async () => {
        const { dist, outside, before } = await fixture();
        await symlink(path.join(outside, 'keep.txt'), path.join(dist, 'index.html'));
        await refuses(dist, /index\.html in the output is a symlink/);
        expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside');
        expect(await clientFiles(dist)).toEqual(before);
    });

    it('won’t write into a symlinked folder, at the top or further down', async () => {
        const a = await fixture();
        await symlink(a.outside, path.join(a.dist, 'assets'));
        await refuses(a.dist, /assets in the output is a symlink/);
        expect(await readdir(a.outside)).toEqual(['keep.txt']);

        const b = await fixture();
        await mkdir(path.join(b.dist, 'assets'));
        await symlink(b.outside, path.join(b.dist, 'assets', 'mascot'));
        await refuses(b.dist, /assets\/mascot in the output is a symlink/);
        expect(await readdir(b.outside)).toEqual(['keep.txt']);
        expect(await clientFiles(b.dist)).toEqual(b.before);
    });

    it('won’t replace a folder or other non-file with a page file', async () => {
        const { dist } = await fixture();
        await mkdir(path.join(dist, 'index.html'));
        await refuses(dist, /index\.html in the output is not a regular file/);
    });

    it('replaces a hard link to catalog.json instead of writing through it', async () => {
        const { dist, before } = await fixture();
        await link(path.join(dist, 'catalog.json'), path.join(dist, 'store-extras.json'));
        await stage(dist, { log: () => {} });
        expect(await clientFiles(dist)).toEqual(before);
        expect(JSON.parse(await readFile(path.join(dist, 'store-extras.json'), 'utf8')).items.weather).toBeTruthy();
        expect((await lstat(path.join(dist, 'catalog.json'))).nlink).toBe(1);
        expect(await tempFiles(dist)).toEqual([]);
    });

    it('refuses symlinks among the page’s own files, before writing anything', async () => {
        for (const plant of [
            async (root, outside) => symlink(path.join(outside, 'keep.txt'), path.join(root, 'web', 'assets', 'evil.svg')),
            async (root, outside) => symlink(outside, path.join(root, 'web', 'assets', 'more')),
            async (root) => {
                await rm(path.join(root, 'web', 'app.js'));
                await symlink(path.join(web, 'app.js'), path.join(root, 'web', 'app.js'));
            },
            async (root) => {
                await rm(path.join(root, 'web', 'index.html'));
                await symlink(path.join(web, 'index.html'), path.join(root, 'web', 'index.html'));
            },
        ]) {
            const { base, dist, outside, before } = await fixture();
            const root = await sourceRoot(base);
            await plant(root, outside);
            await refuses(dist, /is a symlink; the page's files must be regular files/, { root });
            expect(await readdir(dist)).toEqual(['catalog.json', 'detail', 'packages']);
            expect(await clientFiles(dist)).toEqual(before);
        }
    });

    it('never writes catalog.json, detail/, packages/ or *.sha256', async () => {
        for (const rel of ['catalog.json', 'Catalog.JSON', 'detail/math.json', 'DETAIL/x', 'packages/a.zip', 'packages', 'assets/x.sha256', 'a.SHA256']) {
            expect(isProtected(rel), rel).toBe(true);
            expect(() => assertWritable(rel), rel).toThrow(/belong to the catalog build/);
        }
        for (const rel of ['../x', '/abs', 'a//b', '', './x', 'a/../b', 'a\\b']) {
            expect(() => assertWritable(rel), rel).toThrow(/not a plain relative path/);
        }
        for (const rel of ['index.html', 'store-extras.json', 'assets/mascot/kage-icon.svg', 'assets/catalog.json']) {
            expect(() => assertWritable(rel), rel).not.toThrow();
        }
        // A page file that would land on one is refused, before anything is written.
        const { base, dist, before } = await fixture();
        const root = await sourceRoot(base);
        await writeFile(path.join(root, 'web', 'assets', 'stars.svg.sha256'), 'x');
        await refuses(dist, /belong to the catalog build/, { root });
        expect(await readdir(dist)).toEqual(['catalog.json', 'detail', 'packages']);
        expect(await clientFiles(dist)).toEqual(before);
    });

    it('refuses an output folder that is a symlink, or a catalog folder', async () => {
        const { base, dist, before } = await fixture();
        const via = path.join(base, 'via');
        await symlink(dist, via);
        await refuses(via, /is a symlink; stage into the real build folder/);
        const toDetail = path.join(base, 'to-detail');
        await symlink(path.join(dist, 'detail'), toDetail);
        await refuses(toDetail, /is a symlink/);
        // Not via a link, but still one of the catalog's own folders.
        await writeFile(path.join(dist, 'detail', 'catalog.json'), `${JSON.stringify(catalog)}\n`);
        await refuses(path.join(dist, 'detail'), /inside a catalog folder/);
        await rm(path.join(dist, 'detail', 'catalog.json'));
        expect(existsSync(path.join(dist, 'index.html'))).toBe(false);
        expect(existsSync(path.join(dist, 'detail', 'store-extras.json'))).toBe(false);
        expect(await clientFiles(dist)).toEqual(before);
    });

    it('refuses an output folder reached through a symlink inside the checkout', async () => {
        const { base, dist, before } = await fixture();
        const root = await sourceRoot(base);
        await mkdir(path.join(root, 'build'));
        await cp(dist, path.join(root, 'build', 'dist'), { recursive: true });
        await symlink(path.join(root, 'build'), path.join(root, 'out'));
        await refuses(path.join(root, 'out', 'dist'), /out is a symlink/, { root });
        expect(existsSync(path.join(root, 'build', 'dist', 'index.html'))).toBe(false);
        expect(await clientFiles(dist)).toEqual(before);
    });

    it('stages again over its own output, changing nothing Kage downloads', async () => {
        const { dist, before } = await fixture();
        await stage(dist, { log: () => {} });
        const first = await readFile(path.join(dist, 'index.html'));
        await stage(dist, { log: () => {} });
        expect(await readFile(path.join(dist, 'index.html'))).toEqual(first);
        expect(await clientFiles(dist)).toEqual(before);
        expect(await tempFiles(dist)).toEqual([]);
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
