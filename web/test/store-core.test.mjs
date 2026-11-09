// Pure store logic: filtering, categories, URL state, and the markup the page
// and the deploy-time pre-render share (escaping included).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES as HOST_CAPS } from '../../scripts/host-capabilities.mjs';
import {
    CAPS,
    CATEGORIES,
    EXAMPLES,
    ONLINE_NOTES,
    SETUP_PICKS,
    applyFilters,
    buildQuery,
    cardHtml,
    categoriesFor,
    categoryChipsHtml,
    detailHtml,
    escapeHtml,
    exampleFor,
    extensionCardHtml,
    extraFromManifest,
    formatDate,
    formatSize,
    installUrl,
    isOnline,
    paletteCss,
    paletteFromColors,
    paletteVars,
    parseQuery,
    safeColor,
    safeDownloadUrl,
    safeGradient,
    summaryText,
    themeCardHtml,
    tokenize,
} from '../store-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function ext(id, more = {}) {
    return {
        id,
        type: 'extension',
        name: id.replace(/(^|-)(\w)/g, (_, s, c) => `${s ? ' ' : ''}${c.toUpperCase()}`),
        version: '1.0.0',
        author: 'kage',
        description: `The ${id} extension`,
        icon: '🧩',
        tags: [],
        permissions: [],
        downloadUrl: `packages/${id}-1.0.0.zip`,
        detailUrl: `detail/${id}.json`,
        size: 2048,
        ...more,
    };
}

const theme = (id, more = {}) => ext(id, { type: 'theme', name: id.replace('-theme', ''), ...more });

const ITEMS = [
    ext('timer', { name: 'Timer & Stopwatch', tags: ['timer', 'productivity'] }),
    ext('calendar', { name: 'Calendar', tags: [], permissions: ['calendar', 'urls'] }),
    ext('math', { name: 'Math Calculator', tags: [] }),
    ext('github', { name: 'GitHub Search', tags: ['github', 'developer'], permissions: ['urls', 'storage'] }),
    ext('link-preview', { name: 'Link Preview', tags: ['links'], permissions: ['network'] }),
    theme('nord-theme', { name: 'Nord', tags: ['dark', 'light', 'blue'] }),
    theme('sunset-theme', { name: 'Sunset', tags: ['dark', 'warm'] }),
];
const EXTRAS = {
    calendar: { contributes: ['searchProvider', 'toolProvider', 'widgets', 'mascotActivities'], mascot: ['meeting'] },
    github: { online: true, contributes: ['searchProvider'] },
};

describe('text helpers', () => {
    it('escapes the five HTML specials', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
        expect(escapeHtml(null)).toBe('');
    });

    it('tokenizes on whitespace, lowercased', () => {
        expect(tokenize('  Dark   THEME ')).toEqual(['dark', 'theme']);
        expect(tokenize('')).toEqual([]);
    });

    it('formats sizes and dates', () => {
        expect(formatSize(900)).toBe('900 B');
        expect(formatSize(46954)).toBe('46 KB');
        expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
        expect(formatSize(undefined)).toBe('');
        expect(formatDate('2026-11-06T15:54:43.933Z')).toBe('2026-11-06');
        expect(formatDate('not a date')).toBe('');
    });
});

describe('links', () => {
    it('builds kage://install/<id> links', () => {
        expect(installUrl('weather')).toBe('kage://install/weather');
        expect(installUrl('a b/c')).toBe('kage://install/a%20b%2Fc');
    });

    it('only links the relative packages/<file>.zip the build writes', () => {
        expect(safeDownloadUrl('packages/weather-1.0.1.zip')).toBe('packages/weather-1.0.1.zip');
        expect(safeDownloadUrl('packages/x-1.0.0-beta+1.zip')).toBe('packages/x-1.0.0-beta+1.zip');
        for (const bad of [
            'javascript:alert(1)',
            'https://evil.example/x.zip',
            '//evil.example/x.zip',
            'packages/../index.html',
            'packages/x.zip?y',
            'packages/.zip',
            undefined,
        ]) {
            expect(safeDownloadUrl(bad)).toBeNull();
        }
    });
});

describe('colors', () => {
    it('accepts hex and rgb(a) only', () => {
        expect(safeColor('#88C0D0')).toBe('#88C0D0');
        expect(safeColor(' #fff ')).toBe('#fff');
        expect(safeColor('rgba(136, 192, 208, 0.25)')).toBe('rgba(136, 192, 208, 0.25)');
        for (const bad of ['red', '#12345', 'url(x)', '#fff; background: url(x)', 'expression(alert(1))', '', null]) {
            expect(safeColor(bad)).toBeNull();
        }
    });

    it('accepts plain linear gradients and rebuilds them', () => {
        expect(safeGradient('linear-gradient(135deg, #88C0D0 0%, #5E81AC 100%)')).toBe(
            'linear-gradient(135deg, #88C0D0 0%, #5E81AC 100%)'
        );
        expect(safeGradient('linear-gradient(90deg,#fff,rgba(0, 0, 0, 0.5) 50%)')).toBe(
            'linear-gradient(90deg, #fff, rgba(0, 0, 0, 0.5) 50%)'
        );
        expect(safeGradient('linear-gradient(135deg, #fff 0%, url(x) 100%)')).toBeNull();
        expect(safeGradient('radial-gradient(#fff, #000)')).toBeNull();
        expect(safeGradient('linear-gradient(135deg, #fff)')).toBeNull();
    });

    it('reads a real theme color file', async () => {
        const nord = JSON.parse(await readFile(path.join(root, 'themes/nord/dark.json'), 'utf8'));
        const p = paletteFromColors(nord.colors);
        expect(p).toMatchObject({ accent: '#88C0D0', bg: '#2E3440', elevated: '#3B4252', invert: '0' });
        expect(p.gradient).toMatch(/^linear-gradient\(135deg, /);
        expect(paletteFromColors({ 'kage-accent': 'red' })).toBeNull();
    });
});

describe('classification', () => {
    it('reads contributions, mascot activities and the trigger from a manifest', () => {
        expect(
            extraFromManifest({
                contributes: { searchProvider: './s.js', css: ['x.css'], mascotActivities: ['music', 3] },
                config: { trigger: { default: ' sp ' } },
            })
        ).toEqual({ contributes: ['searchProvider', 'mascotActivities'], mascot: ['music'], trigger: 'sp' });
        expect(extraFromManifest(null)).toEqual({});
    });

    it('is Online for network/oauth, a known service, or detected fetch()', () => {
        expect(isOnline(ext('a', { permissions: ['network'] }))).toBe(true);
        expect(isOnline(ext('a', { permissions: ['oauth'] }))).toBe(true);
        expect(isOnline(ext('weather'))).toBe(true);
        expect(isOnline(ext('a'), { online: true })).toBe(true);
        expect(isOnline(ext('a', { permissions: ['storage'] }), { online: false })).toBe(false);
    });

    it('sorts extensions into categories by tags, id and name', () => {
        const by = Object.fromEntries(ITEMS.map((i) => [i.id, categoriesFor(i, EXTRAS[i.id])]));
        expect(by.timer).toEqual(['productivity']);
        // No tags at all: the id and name still place them.
        expect(by.calendar).toEqual(['productivity', 'agent']);
        expect(by.math).toEqual(['answers']);
        expect(by.github).toEqual(['developer', 'online']);
        expect(by['link-preview']).toEqual(['online']);
        expect(by['nord-theme']).toEqual([]);
    });

    it('prefers a curated example, then the manifest trigger', () => {
        expect(exampleFor(ext('math'))).toEqual({ query: '12 km to mi' });
        expect(exampleFor(ext('link-preview'))).toEqual({ auto: true });
        expect(exampleFor(ext('new-one'), { trigger: 'nw' })).toEqual({ query: 'nw' });
        expect(exampleFor(ext('new-one'))).toBeNull();
    });
});

describe('applyFilters', () => {
    it('splits extensions and themes, sorted by name, with totals', () => {
        const r = applyFilters(ITEMS, {}, EXTRAS);
        expect(r.extensions.map((i) => i.id)).toEqual(['calendar', 'github', 'link-preview', 'math', 'timer']);
        expect(r.themes.map((i) => i.id)).toEqual(['nord-theme', 'sunset-theme']);
        expect(r.totals).toEqual({ extensions: 5, themes: 2 });
        expect(r.counts).toMatchObject({ all: 5, productivity: 2, answers: 1, developer: 1, agent: 1, online: 2 });
    });

    it('matches every word against name, tags, capabilities and the example', () => {
        const ids = (q) => applyFilters(ITEMS, { q }, EXTRAS);
        expect(ids('calc').extensions.map((i) => i.id)).toEqual(['math']);
        expect(ids('open links').extensions.map((i) => i.id)).toEqual(['calendar', 'github']); // capability label
        expect(ids('km to mi').extensions.map((i) => i.id)).toEqual(['math']); // the example query
        expect(ids('dark').extensions).toEqual([]);
        expect(ids('dark').themes.map((i) => i.id)).toEqual(['nord-theme', 'sunset-theme']);
        expect(ids('dark warm').themes.map((i) => i.id)).toEqual(['sunset-theme']);
        expect(ids('ONLINE').extensions.map((i) => i.id)).toEqual(['github', 'link-preview']); // category label
    });

    it('filters by category, counts within the query, and ignores unknown categories', () => {
        expect(applyFilters(ITEMS, { cat: 'productivity' }, EXTRAS).extensions.map((i) => i.id)).toEqual([
            'calendar',
            'timer',
        ]);
        const r = applyFilters(ITEMS, { q: 'cal', cat: 'online' }, EXTRAS);
        expect(r.extensions).toEqual([]);
        expect(r.counts.all).toBe(2); // calendar + math ("Math Calculator")
        const bad = applyFilters(ITEMS, { cat: 'nope' }, EXTRAS);
        expect(bad.cat).toBe('all');
        expect(bad.extensions).toHaveLength(5);
    });

    it('drops junk entries', () => {
        expect(applyFilters([null, {}, { id: 3 }, ...ITEMS]).totals).toEqual({ extensions: 5, themes: 2 });
        expect(applyFilters(undefined).totals).toEqual({ extensions: 0, themes: 0 });
    });

    it('summarizes for the live region', () => {
        expect(summaryText(applyFilters(ITEMS, {}, EXTRAS))).toBe('5 extensions and 2 themes, all sandboxed.');
        expect(summaryText(applyFilters(ITEMS, { q: 'calc' }, EXTRAS), 'calc')).toBe(
            '1 extension and 0 themes for “calc”.'
        );
        expect(summaryText(applyFilters(ITEMS, { cat: 'online' }, EXTRAS))).toBe('2 extensions in Online.');
        expect(summaryText(applyFilters(ITEMS, { q: 'dark', cat: 'online' }, EXTRAS), 'dark')).toBe(
            '0 extensions in Online and 2 themes for “dark”.'
        );
        expect(summaryText(applyFilters(ITEMS, { q: 'zzz' }, EXTRAS), 'zzz')).toBe('Nothing found for “zzz”.');
        expect(summaryText(applyFilters(ITEMS, { q: 'zzz', cat: 'agent' }, EXTRAS), 'zzz')).toBe(
            'Nothing in Agent tools for “zzz”.'
        );
    });
});

describe('URL state', () => {
    it('parses and rebuilds ?q=&cat=&ext=', () => {
        const s = parseQuery('?q=dark%20theme&cat=online&ext=nord-theme');
        expect(s).toEqual({ q: 'dark theme', cat: 'online', ext: 'nord-theme', type: null });
        expect(buildQuery(s)).toBe('?q=dark+theme&cat=online&ext=nord-theme');
        expect(buildQuery({})).toBe('');
        expect(buildQuery({ q: '  ', cat: 'all' })).toBe('');
    });

    it('rejects ids and categories it does not know', () => {
        expect(parseQuery('?ext=../../etc&cat=<b>')).toMatchObject({ ext: null, cat: 'all' });
        expect(parseQuery('?ext=A').ext).toBeNull();
        expect(parseQuery(`?q=${'x'.repeat(500)}`).q).toHaveLength(200);
        expect(parseQuery('?type=theme').type).toBe('theme');
        expect(parseQuery('').q).toBe('');
    });
});

describe('markup', () => {
    const evil = ext('evil', {
        name: '<img src=x onerror=alert(1)>',
        description: '"><script>alert(1)</script>',
        author: '<b>me</b>',
        icon: '<svg onload=alert(1)>',
        version: '1.0.0"><i>',
        tags: ['<u>t</u>'],
        permissions: ['storage', '"><b>x</b>'],
        downloadUrl: 'javascript:alert(1)',
    });

    it('escapes everything it interpolates', () => {
        // None of the injected markup survives unescaped.
        const INJECTED = /<img src=x|<script|<svg onload|<b>me|<b>x|<i>t|"><i>/;
        const html = extensionCardHtml(evil, { trigger: '<i>t</i>' });
        expect(html).not.toMatch(INJECTED);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('href="kage://install/evil"');
        expect(detailHtml(evil, { contributes: ['searchProvider'], trigger: '<i>t</i>' })).not.toMatch(INJECTED);
        expect(themeCardHtml({ ...evil, type: 'theme' })).not.toMatch(INJECTED);
    });

    it('renders an extension card with its access, example, badges and actions', () => {
        const html = extensionCardHtml(ITEMS[3], EXTRAS.github);
        expect(html).toContain('id="ext-github"');
        expect(html).toContain('data-id="github"');
        expect(html).toContain('<code>gh tauri</code>');
        expect(html).toContain('🔗</span> Open links');
        expect(html).toContain('💾</span> Storage');
        expect(html).toContain('badge--online');
        expect(html).toContain('href="packages/github-1.0.0.zip" download');
        expect(html).toContain('data-details="github"');
        expect(html).toContain('Install in Kage</span><span class="sr-only">: GitHub Search</span>');
    });

    it('says when an extension asks for nothing, and marks setup picks', () => {
        const html = extensionCardHtml(ITEMS[2]);
        expect(html).toContain('No extra access');
        expect(html).not.toContain('class="perms"');
        expect(html).toContain('badge--setup');
        expect(extensionCardHtml(ext('x', { permissions: ['mystery'] }))).toContain('❓</span> mystery');
    });

    it('gives theme cards no style attribute (their colors come from the stylesheet)', () => {
        const palette = { dark: paletteFromColors({ 'kage-accent': '#88C0D0', 'kage-bg': '#2E3440' }) };
        const html = themeCardHtml(ITEMS[5], { palette });
        expect(html).not.toMatch(/\sstyle=/);
        expect(html).toContain('data-id="nord-theme"');
        expect(html).toContain('class="swatches"');
        // No palette at all: Kage's own colors (the CSS fallbacks), no swatches.
        const plain = themeCardHtml(ITEMS[5]);
        expect(plain).toContain('theme-card--plain');
        expect(plain).not.toMatch(/\sstyle=/);
        expect(plain).not.toContain('class="swatches"');
        for (const item of ITEMS) expect(cardHtml(item, {}), item.id).not.toMatch(/\sstyle=/);
        expect(detailHtml(ITEMS[0], {})).not.toMatch(/\sstyle=/);
    });

    it('turns a palette into validated custom properties only', () => {
        const palette = {
            dark: { ...paletteFromColors({ 'kage-accent': '#88C0D0', 'kage-bg': '#2E3440' }), text: 'red;}</style>' },
        };
        const vars = Object.fromEntries(paletteVars(palette));
        expect(vars['--d-accent']).toBe('#88C0D0');
        expect(vars['--d-bg']).toBe('#2E3440');
        expect(vars).not.toHaveProperty('--d-text');
        // No light palette: the dark one previews in both modes.
        expect(vars['--l-accent']).toBe('#88C0D0');
        expect(vars['--d-invert']).toBe('0');
        for (const v of Object.values(vars)) expect(v).not.toMatch(/[<>;{}]/);
        expect(paletteVars(null)).toEqual([]);
        expect(paletteVars({ light: palette.dark })).toEqual([]);
    });

    it('writes one stylesheet rule per theme with a palette, keyed on data-id', () => {
        const nord = { dark: paletteFromColors({ 'kage-accent': '#88C0D0', 'kage-bg': '#2E3440' }) };
        const css = paletteCss(
            [...ITEMS, theme('bad"id'), { id: 'x', type: 'extension' }],
            { 'nord-theme': { palette: nord }, x: { palette: nord }, 'bad"id': { palette: nord } }
        );
        expect(css).toMatch(/^\.theme-card\[data-id="nord-theme"\] \{\n {4}--d-accent: #88C0D0;/);
        expect(css.match(/\{/g)).toHaveLength(1); // not sunset (no palette), not the extension, not the bad id
        expect(css).not.toMatch(/[<>]|\*\//);
        expect(paletteCss(ITEMS, {})).toBe('');
    });

    it('renders category chips with counts, hiding empty ones', () => {
        const html = categoryChipsHtml({ all: 5, productivity: 2, answers: 0 }, 'productivity');
        expect(html).toContain('data-cat="all" aria-pressed="false"');
        expect(html).toContain('data-cat="productivity" aria-pressed="true"');
        expect(html).toMatch(/data-cat="answers" aria-pressed="false" hidden/);
        expect((html.match(/data-cat=/g) || []).length).toBe(CATEGORIES.length + 1);
    });

    it('lists what an extension adds and asks for in the detail view', () => {
        const html = detailHtml(ITEMS[1], { ...EXTRAS.calendar, path: 'extensions/calendar' });
        expect(html).toContain('<h2 id="dlg-title">Calendar</h2>');
        expect(html).not.toContain('<header'); // not a second banner landmark
        expect(html).toContain('Agent tools');
        expect(html).toContain('Cat reactions</b><span>Lets the cat react to what’s going on (meeting).');
        expect(html).toContain(escapeHtml(CAPS.calendar.description));
        expect(html).toContain(escapeHtml(CAPS.urls.description));
        expect(html).toContain('It runs in a sandbox.');
        expect(html).toContain('href="https://github.com/nachmore/Kage-Extensions/tree/main/extensions/calendar"');
        expect(html).toContain('<code class="dlg__try-q">cal</code>');
        expect(html).not.toContain('data-details=');
    });

    it('describes the views, file_text, agent_background and sync capabilities', () => {
        const item = ext('x', { permissions: ['views', 'file_text', 'agent_background', 'sync'] });
        const extra = extraFromManifest({ contributes: { views: [{ id: 'explorer' }] } });
        expect(extra.contributes).toEqual(['views']);
        const html = detailHtml(item, extra);
        expect(html).toContain('Windows</b><span>Full windows it draws itself, such as a map.');
        for (const cap of ['views', 'file_text', 'agent_background', 'sync']) {
            expect(html, cap).toContain(`<b>${escapeHtml(CAPS[cap].label)}</b>`);
            expect(html, cap).toContain(escapeHtml(CAPS[cap].description));
        }
        expect(html).not.toContain('doesn’t know about yet');
    });

    it('says a theme asks for nothing and an online extension talks to a service', () => {
        expect(detailHtml(ITEMS[5])).toContain('A theme is colors only; it runs no code.');
        expect(detailHtml(ext('math'))).toContain('None. It doesn’t ask for any capabilities.');
        expect(detailHtml(ext('weather'))).toContain(ONLINE_NOTES.weather);
        expect(detailHtml(ext('x', { permissions: ['network'] }))).toContain('Talks to a web service.');
        expect(detailHtml(ext('x'), { path: '../../etc' })).not.toContain('View source');
    });
});

describe('kept in step with the repo', () => {
    it('labels capabilities the way scripts/host-capabilities.mjs does', () => {
        expect(Object.keys(CAPS)).toEqual(Object.keys(HOST_CAPS));
        for (const [k, v] of Object.entries(HOST_CAPS)) {
            expect(CAPS[k].icon, k).toBe(v.icon);
            expect(CAPS[k].label, k).toBe(v.label);
            expect(CAPS[k].description, k).toBeTruthy();
        }
    });

    it('only names extensions and themes that exist', async () => {
        const ids = new Set();
        for (const kind of ['extensions', 'themes']) {
            for (const d of await readdir(path.join(root, kind), { withFileTypes: true })) {
                if (!d.isDirectory()) continue;
                try {
                    ids.add(JSON.parse(await readFile(path.join(root, kind, d.name, 'manifest.json'), 'utf8')).id);
                } catch {
                    // a folder without a manifest yet
                }
            }
        }
        for (const id of [...Object.keys(EXAMPLES), ...Object.keys(ONLINE_NOTES), ...SETUP_PICKS]) {
            expect(ids.has(id), id).toBe(true);
        }
    });
});
