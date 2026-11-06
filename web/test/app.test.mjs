// app.js against the real index.html in jsdom: the first render, search,
// categories, the detail dialog, deep links and the failure paths.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { start } from '../app.js';
import { REPO_ROOT, buildExtras, renderIndex } from '../stage.mjs';
import { ONLINE_NOTES } from '../store-core.js';

const BASE = 'https://store.test/Kage-Extensions/';
const item = (id, type, name, permissions = [], tags = []) => ({
    id,
    type,
    name,
    version: '1.0.0',
    author: 'kage',
    description: `${name} does things`,
    icon: '🧩',
    tags,
    permissions,
    downloadUrl: `packages/${id}-1.0.0.zip`,
    detailUrl: `detail/${id}.json`,
    size: 4096,
    updatedAt: '2026-11-01T00:00:00.000Z',
});
const CATALOG = {
    schemaVersion: 1,
    generatedAt: '2026-11-06T12:00:00.000Z',
    items: [
        item('weather', 'extension', 'Weather', ['storage'], ['weather', 'forecast']),
        item('calendar', 'extension', 'Calendar', ['calendar', 'urls', 'automation']),
        item('math', 'extension', 'Math Calculator'),
        item('timer', 'extension', 'Timer & Stopwatch', [], ['timer', 'productivity']),
        item('nord-theme', 'theme', 'Nord', [], ['dark', 'light', 'blue']),
    ],
};

let template;
let extras;
beforeAll(async () => {
    template = await readFile(path.join(REPO_ROOT, 'web', 'index.html'), 'utf8');
    extras = await buildExtras(CATALOG);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data) });

async function open({
    search = '',
    prerender = true,
    catalog = 'ok',
    withExtras = true,
    detail = null,
} = {}) {
    const html = prerender ? renderIndex(template, CATALOG, extras) : template;
    const dom = new JSDOM(html, { url: `${BASE}${search}`, pretendToBeVisual: true });
    const calls = [];
    const fetchImpl = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith('catalog.json')) {
            if (catalog === 'throw') throw new Error('<b>offline</b>');
            return catalog === 'ok' ? json(CATALOG) : { ok: false, status: 500 };
        }
        if (u.endsWith('store-extras.json')) {
            return withExtras ? json(extras) : { ok: false, status: 404 };
        }
        if (u.includes('/detail/') && detail) return json(detail);
        return { ok: false, status: 404 };
    };
    const doc = dom.window.document;
    const firstCard = doc.getElementById('ext-weather');
    const api = await start({ doc, win: dom.window, fetchImpl });
    const ids = (sel = '[data-results]') => [...doc.querySelector(sel).children].map((c) => c.dataset.id).filter(Boolean);
    return { dom, win: dom.window, doc, api, calls, ids, firstCard };
}

function type(win, input, value) {
    input.value = value;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function key(win, target, k) {
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

describe('first render', () => {
    it('keeps the pre-rendered cards instead of rebuilding them', async () => {
        const { doc, ids, firstCard } = await open();
        expect(firstCard).not.toBeNull();
        expect(doc.getElementById('ext-weather')).toBe(firstCard);
        expect(ids()).toEqual(['calendar', 'math', 'timer', 'weather']);
        expect(ids('[data-theme-results]')).toEqual(['nord-theme']);
        expect(doc.getElementById('generated-at').textContent).toBe('Catalog built 2026-11-06');
        expect(doc.querySelector('[data-counts]').textContent).toBe('4 extensions · 1 theme');
    });

    it('renders from the catalog when the page has no pre-render', async () => {
        const { doc, ids } = await open({ prerender: false });
        expect(ids()).toEqual(['calendar', 'math', 'timer', 'weather']);
        expect(doc.querySelectorAll('[data-chips] [data-cat]').length).toBeGreaterThan(1);
        expect(doc.getElementById('summary').textContent).toBe('4 extensions and 1 theme, all sandboxed.');
    });
});

describe('search', () => {
    it('filters as you type and keeps the query in the URL', async () => {
        const { win, doc, ids } = await open();
        const input = doc.getElementById('search');
        let event = null;
        doc.addEventListener('kage:search', (e) => {
            event = e.detail;
        });
        type(win, input, 'tim');
        expect(ids()).toEqual(['timer']);
        expect(doc.getElementById('summary').textContent).toBe('1 extension and 0 themes for “tim”.');
        expect(event).toEqual({ query: 'tim', count: 1 });
        await sleep(450);
        expect(win.location.search).toBe('?q=tim');
    });

    it('clears on Escape', async () => {
        const { win, doc, ids } = await open({ search: '?q=math' });
        const input = doc.getElementById('search');
        expect(input.value).toBe('math');
        expect(ids()).toEqual(['math']);
        key(win, input, 'Escape');
        expect(input.value).toBe('');
        expect(ids()).toHaveLength(4);
        expect(win.location.search).toBe('');
    });

    it('shows the empty state, pointing at matching themes', async () => {
        const { doc, ids } = await open({ search: '?q=dark' });
        expect(ids()).toEqual([]);
        expect(ids('[data-theme-results]')).toEqual(['nord-theme']);
        expect(doc.getElementById('empty').hidden).toBe(false);
        expect(doc.querySelector('[data-empty-detail]').textContent).toBe('But 1 theme does, below.');
        expect(doc.getElementById('theme-empty').hidden).toBe(true);
    });

    it('show-everything resets the search and the category', async () => {
        const { doc, ids, win } = await open({ search: '?q=zzz&cat=answers' });
        expect(ids()).toEqual([]);
        doc.querySelector('[data-clear]').click();
        expect(ids()).toHaveLength(4);
        expect(doc.getElementById('search').value).toBe('');
        expect(doc.querySelector('[data-cat="all"]').getAttribute('aria-pressed')).toBe('true');
        expect(win.location.search).toBe('');
    });
});

describe('while the catalog is loading', () => {
    async function slow() {
        const html = renderIndex(template, CATALOG, extras);
        const dom = new JSDOM(html, { url: BASE });
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        const fetchImpl = async (url) => {
            await gate;
            return String(url).endsWith('catalog.json') ? json(CATALOG) : json(extras);
        };
        const doc = dom.window.document;
        const ids = () => [...doc.querySelector('[data-results]').children].map((c) => c.dataset.id);
        return { dom, win: dom.window, doc, ids, release, started: start({ doc, win: dom.window, fetchImpl }) };
    }

    it('keeps text typed before the script ran instead of the URL’s', async () => {
        const html = renderIndex(template, CATALOG, extras);
        const dom = new JSDOM(html, { url: `${BASE}?q=math` });
        dom.window.document.getElementById('search').value = 'tim';
        await start({ doc: dom.window.document, win: dom.window, fetchImpl: async (u) => json(String(u).endsWith('catalog.json') ? CATALOG : extras) });
        const doc = dom.window.document;
        expect(doc.getElementById('search').value).toBe('tim');
        expect([...doc.querySelector('[data-results]').children].map((c) => c.dataset.id)).toEqual(['timer']);
        expect(dom.window.location.search).toBe('?q=tim');
    });

    it('applies a search, a category and a Details press made during the load', async () => {
        const { win, doc, ids, release, started } = await slow();
        type(win, doc.getElementById('search'), 'a');
        doc.querySelector('[data-cat="productivity"]').click();
        expect(doc.querySelector('[data-cat="productivity"]').getAttribute('aria-pressed')).toBe('true');
        doc.querySelector('[data-details="calendar"]').click();
        expect(doc.getElementById('details').hasAttribute('open')).toBe(false);
        expect(ids()).toHaveLength(4); // nothing filtered yet
        release();
        await started;
        expect(ids()).toEqual(['calendar', 'timer']); // "a" within Productivity
        expect(doc.getElementById('details').hasAttribute('open')).toBe(true);
        expect(doc.getElementById('dlg-title').textContent).toBe('Calendar');
        expect(win.location.search).toBe('?q=a&cat=productivity&ext=calendar');
    });
});

describe('reusing cards', () => {
    it('keeps the cards that stay, animates the ones that come back, drops the rest', async () => {
        const { win, doc, ids } = await open();
        const input = doc.getElementById('search');
        const timer = doc.getElementById('ext-timer');
        const weather = doc.getElementById('ext-weather');
        type(win, input, 'tim');
        expect(ids()).toEqual(['timer']);
        expect(doc.getElementById('ext-timer')).toBe(timer);
        expect(timer.classList.contains('is-new')).toBe(false);
        expect(doc.getElementById('ext-weather')).toBeNull();
        type(win, input, '');
        expect(ids()).toEqual(['calendar', 'math', 'timer', 'weather']);
        expect(doc.getElementById('ext-timer')).toBe(timer);
        const back = doc.getElementById('ext-weather');
        expect(back).not.toBe(weather);
        expect(back.classList.contains('is-new')).toBe(true);
    });

    it('rebuilds a pre-rendered card whose version changed since the page was built', async () => {
        const html = renderIndex(template, CATALOG, extras);
        const newer = structuredClone(CATALOG);
        newer.items.find((i) => i.id === 'math').version = '9.9.9';
        const dom = new JSDOM(html, { url: BASE });
        const doc = dom.window.document;
        const before = doc.getElementById('ext-math');
        const weather = doc.getElementById('ext-weather');
        await start({
            doc,
            win: dom.window,
            fetchImpl: async (u) => (String(u).endsWith('catalog.json') ? json(newer) : json(extras)),
        });
        expect(doc.getElementById('ext-math')).not.toBe(before);
        expect(doc.getElementById('ext-math').textContent).toContain('v9.9.9');
        expect(doc.getElementById('ext-math').classList.contains('is-new')).toBe(false);
        expect(doc.getElementById('ext-weather')).toBe(weather);
    });

    it('replaces the loading note when there is no pre-render', async () => {
        const { doc } = await open({ prerender: false });
        expect(doc.querySelector('[data-results] .loading')).toBeNull();
        expect(doc.querySelector('[data-theme-results] .loading')).toBeNull();
    });
});

describe('categories', () => {
    it('filters, updates the chips in place, and toggles back to All', async () => {
        const { win, doc, ids } = await open();
        const chip = doc.querySelector('[data-cat="productivity"]');
        chip.click();
        expect(doc.querySelector('[data-cat="productivity"]')).toBe(chip);
        expect(chip.getAttribute('aria-pressed')).toBe('true');
        expect(ids()).toEqual(['calendar', 'timer']);
        expect(win.location.search).toBe('?cat=productivity');
        chip.click();
        expect(chip.getAttribute('aria-pressed')).toBe('false');
        expect(ids()).toHaveLength(4);
        expect(win.location.search).toBe('');
    });

    it('moves focus to the pressed chip when clearing hides the focused one', async () => {
        const { doc } = await open({ search: '?q=weather&cat=developer' });
        const dev = doc.querySelector('[data-cat="developer"]');
        expect(dev.hidden).toBe(false); // shown while active, though it has 0
        dev.focus();
        dev.click();
        expect(dev.hidden).toBe(true);
        expect(doc.activeElement).toBe(doc.querySelector('[data-cat="all"]'));
    });

    it('counts within the search and hides empty categories', async () => {
        const { win, doc } = await open();
        type(win, doc.getElementById('search'), 'cal');
        const n = (id) => doc.querySelector(`[data-cat="${id}"] .chip__n`).textContent;
        expect(n('all')).toBe('2'); // Calendar, Math Calculator
        expect(n('productivity')).toBe('1');
        expect(doc.querySelector('[data-cat="online"]').hidden).toBe(true);
    });
});

describe('details', () => {
    it('opens with what it asks for, updates the URL, and returns focus on close', async () => {
        const { win, doc } = await open();
        const btn = doc.querySelector('[data-details="weather"]');
        btn.focus();
        btn.click();
        const dialog = doc.getElementById('details');
        expect(dialog.hasAttribute('open')).toBe(true);
        const body = doc.querySelector('[data-dlg-body]').textContent;
        expect(doc.getElementById('dlg-title').textContent).toBe('Weather');
        expect(body).toContain('Access it asks for');
        expect(body).toContain('Storage');
        expect(body).toContain(ONLINE_NOTES.weather);
        expect(body).toContain('It runs in a sandbox.');
        expect(win.location.search).toBe('?ext=weather');
        doc.querySelector('[data-close]').click();
        expect(dialog.hasAttribute('open')).toBe(false);
        expect(win.location.search).toBe('');
        expect(doc.activeElement).toBe(btn);
    });

    it('opens from a deep link, and drops an unknown one from the URL', async () => {
        const a = await open({ search: '?ext=calendar' });
        expect(a.doc.getElementById('details').hasAttribute('open')).toBe(true);
        expect(a.doc.querySelector('[data-dlg-body]').textContent).toContain('Agent tools');
        const b = await open({ search: '?ext=nope&q=time' });
        expect(b.doc.getElementById('details').hasAttribute('open')).toBe(false);
        expect(b.win.location.search).toBe('?q=time');
    });

    it('opens from in-page links to a card (the hero’s "Powered by")', async () => {
        const { doc } = await open();
        doc.querySelector('[data-lm-via]').click();
        expect(doc.getElementById('details').hasAttribute('open')).toBe(true);
        expect(doc.getElementById('dlg-title').textContent).toBe('Math Calculator');
    });

    it('reads the manifest from detail/<id>.json when store-extras.json is missing', async () => {
        const { doc, calls } = await open({
            withExtras: false,
            detail: { manifest: { contributes: { searchProvider: './s.js', toolProvider: './t.js' } } },
        });
        doc.querySelector('[data-details="calendar"]').click();
        await sleep(20);
        expect(calls).toContain('./detail/calendar.json');
        expect(doc.querySelector('[data-dlg-body]').textContent).toContain('Agent tools');
    });
});

describe('themes', () => {
    it('switches the previews between dark and light', async () => {
        const { doc } = await open();
        const light = doc.querySelector('[data-mode-pick="light"]');
        light.click();
        expect(doc.querySelector('[data-theme-results]').dataset.mode).toBe('light');
        expect(light.getAttribute('aria-pressed')).toBe('true');
        expect(doc.querySelector('[data-mode-pick="dark"]').getAttribute('aria-pressed')).toBe('false');
    });
});

describe('when catalog.json fails', () => {
    it('keeps the pre-rendered cards and hides what needs the catalog', async () => {
        const { doc, ids } = await open({ catalog: 'http500' });
        expect(ids()).toEqual(['calendar', 'math', 'timer', 'weather']);
        expect(doc.documentElement.classList.contains('no-catalog')).toBe(true);
        expect(doc.getElementById('summary').textContent).toMatch(/Couldn’t refresh the catalog/);
    });

    it('says so, escaped, when there is nothing to fall back on', async () => {
        const { doc } = await open({ catalog: 'throw', prerender: false });
        const html = doc.querySelector('[data-results]').innerHTML;
        expect(html).toContain('Couldn’t load the catalog: &lt;b&gt;offline&lt;/b&gt;');
        expect(doc.querySelector('[data-results] b')).toBeNull();
    });
});
