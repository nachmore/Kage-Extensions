// app.js against the real index.html in jsdom: the first render, search,
// categories, the detail dialog, deep links, Back and Forward, where the
// extras come from, and the failure paths.

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
async function until(cond, what = 'condition', ms = 1000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}
const json = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data) });

// prerender: the staged page (cards, and the extras embedded as JSON);
// embedded: false drops that JSON, as if the page didn't have it;
// withExtras: whether ./store-extras.json can be fetched.
async function open({
    search = '',
    prerender = true,
    pageExtras = extras,
    embedded = true,
    catalog = 'ok',
    withExtras = true,
    detail = null,
} = {}) {
    const html = prerender ? renderIndex(template, CATALOG, pageExtras) : template;
    const dom = new JSDOM(html, { url: `${BASE}${search}`, pretendToBeVisual: true });
    if (!embedded) dom.window.document.getElementById('store-extras')?.remove();
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
        expect(doc.activeElement).toBe(btn);
        // Closing goes back off the entry the dialog pushed.
        await until(() => win.location.search === '', 'Back to the entry before');
        expect(dialog.hasAttribute('open')).toBe(false);
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

    it('reads the manifest from detail/<id>.json when there are no store extras', async () => {
        const { doc, calls } = await open({
            embedded: false,
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

describe('history', () => {
    // Every history write app.js makes from here on.
    function spy(win) {
        const writes = [];
        for (const m of ['pushState', 'replaceState']) {
            const orig = win.history[m].bind(win.history);
            win.history[m] = (st, title, url) => {
                writes.push(`${m} ${url}`);
                return orig(st, title, url);
            };
        }
        return writes;
    }
    const isOpen = (doc) => doc.getElementById('details').hasAttribute('open');
    const title = (doc) => doc.getElementById('dlg-title')?.textContent;

    it('Themes → open Nord → Back closes it, and Forward opens it again, without rewriting either entry', async () => {
        const { win, doc } = await open();
        doc.querySelector('.nav__links a[href="#themes"]').click();
        await until(() => win.location.hash === '#themes', 'the #themes entry');
        const len = win.history.length;
        doc.querySelector('[data-details="nord-theme"]').click();
        expect(isOpen(doc)).toBe(true);
        expect(win.location.search).toBe('?ext=nord-theme');
        expect(win.location.hash).toBe('#themes');
        expect(win.history.length).toBe(len + 1); // pushed

        const writes = spy(win);
        win.history.back();
        await until(() => !isOpen(doc), 'the dialog to close');
        expect(win.location.search).toBe('');
        expect(win.location.hash).toBe('#themes');
        expect(doc.activeElement).toBe(doc.querySelector('[data-details="nord-theme"]'));

        win.history.forward();
        await until(() => isOpen(doc), 'the dialog to reopen');
        expect(title(doc)).toBe('Nord');
        expect(win.location.search).toBe('?ext=nord-theme');
        await sleep(400); // past any debounce
        expect(writes).toEqual([]);

        // Closing it yourself goes back to #themes, and Forward still reopens it.
        doc.querySelector('[data-close]').click();
        await until(() => win.location.search === '', 'Back off the dialog entry');
        expect(win.location.hash).toBe('#themes');
        expect(isOpen(doc)).toBe(false);
        expect(win.history.length).toBe(len + 1);
        win.history.forward();
        await until(() => isOpen(doc), 'the dialog to reopen again');
        expect(title(doc)).toBe('Nord');
    });

    it('typing and the chips replace the current entry instead of adding one', async () => {
        const { win, doc } = await open();
        const len = win.history.length;
        type(win, doc.getElementById('search'), 'tim');
        doc.querySelector('[data-cat="productivity"]').click();
        expect(win.location.search).toBe('?q=tim&cat=productivity');
        await sleep(400);
        key(win, doc.getElementById('search'), 'Escape');
        doc.querySelector('[data-cat="productivity"]').click();
        expect(win.location.search).toBe('');
        expect(win.history.length).toBe(len);
    });

    it('Back and Forward put the search and the category back', async () => {
        const { win, doc, ids } = await open();
        const input = doc.getElementById('search');
        type(win, input, 'tim');
        doc.querySelector('[data-cat="productivity"]').click();
        // An in-page link starts a new entry from this address.
        doc.querySelector('.nav__links a[href="#build"]').click();
        await until(() => win.location.hash === '#build', 'the #build entry');
        doc.querySelector('[data-cat="productivity"]').click(); // back to All
        type(win, input, 'weather');
        await sleep(400);
        expect(win.location.search).toBe('?q=weather');

        win.history.back();
        await until(() => win.location.hash === '', 'Back');
        expect(input.value).toBe('tim');
        expect(doc.querySelector('[data-cat="productivity"]').getAttribute('aria-pressed')).toBe('true');
        expect(ids()).toEqual(['timer']);
        expect(doc.getElementById('summary').textContent).toBe('1 extension in Productivity and 0 themes for “tim”.');

        win.history.forward();
        await until(() => win.location.hash === '#build', 'Forward');
        expect(input.value).toBe('weather');
        expect(doc.querySelector('[data-cat="all"]').getAttribute('aria-pressed')).toBe('true');
        expect(ids()).toEqual(['weather']);
    });

    it('a search typed just before a #link reaches the entry it was typed on', async () => {
        const { win, doc } = await open();
        type(win, doc.getElementById('search'), 'cal');
        doc.querySelector('.nav__links a[href="#themes"]').click(); // within the 350 ms debounce
        await until(() => win.location.hash === '#themes', 'the #themes entry');
        expect(win.location.search).toBe('?q=cal');
        win.history.back();
        await until(() => win.location.hash === '', 'Back');
        expect(win.location.search).toBe('?q=cal');
        expect(doc.getElementById('search').value).toBe('cal');
    });

    it('a search typed just before Details reaches the entry before the dialog', async () => {
        const { win, doc } = await open();
        type(win, doc.getElementById('search'), 'cal');
        doc.querySelector('[data-details="calendar"]').click();
        expect(win.location.search).toBe('?q=cal&ext=calendar');
        doc.querySelector('[data-close]').click();
        await until(() => !win.location.search.includes('ext='), 'Back');
        expect(win.location.search).toBe('?q=cal');
    });

    it('closing a dialog the page was opened on replaces the entry', async () => {
        const { win, doc } = await open({ search: '?q=cal&ext=calendar' });
        expect(isOpen(doc)).toBe(true);
        const len = win.history.length;
        doc.querySelector('[data-close]').click();
        expect(win.location.search).toBe('?q=cal');
        expect(win.history.length).toBe(len);
        await sleep(50);
        expect(win.location.search).toBe('?q=cal'); // no Back
    });

    it('Back to an entry naming an unknown extension closes the dialog and leaves the address alone', async () => {
        const { win, doc } = await open();
        win.history.pushState(null, '', '?ext=not-here');
        win.history.pushState(null, '', '?q=x');
        win.history.back();
        await sleep(30);
        doc.querySelector('[data-details="math"]').click();
        expect(isOpen(doc)).toBe(true);
        const writes = spy(win);
        win.history.back();
        await until(() => !isOpen(doc), 'the dialog to close');
        expect(win.location.search).toBe('?ext=not-here');
        expect(writes).toEqual([]);
    });

    it('a Details press while the last dialog is still going Back opens once it has', async () => {
        const { win, doc } = await open();
        doc.querySelector('[data-details="math"]').click();
        doc.querySelector('[data-close]').click(); // history.back() pending
        doc.querySelector('[data-details="timer"]').click();
        await until(() => isOpen(doc) && title(doc) === 'Timer & Stopwatch', 'the second dialog');
        expect(win.location.search).toBe('?ext=timer');
        doc.querySelector('[data-close]').click();
        await until(() => win.location.search === '', 'Back');
        expect(isOpen(doc)).toBe(false);
    });

    it('applies a Back press made during the load', async () => {
        const html = renderIndex(template, CATALOG, extras);
        const dom = new JSDOM(html, { url: `${BASE}?q=math` });
        const win = dom.window;
        win.history.pushState(null, '', '?q=tim');
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        const doc = win.document;
        const started = start({
            doc,
            win,
            fetchImpl: async (u) => {
                await gate;
                return json(String(u).endsWith('catalog.json') ? CATALOG : extras);
            },
        });
        expect(doc.getElementById('search').value).toBe('tim');
        win.history.back();
        await until(() => win.location.search === '?q=math', 'Back');
        expect(doc.getElementById('search').value).toBe('math');
        release();
        await started;
        expect([...doc.querySelector('[data-results]').children].map((c) => c.dataset.id)).toEqual(['math']);
    });
});

describe('store extras', () => {
    const onlineBadges = (doc) => doc.querySelectorAll('[data-results] .badge--online').length;
    const chip = (doc, id) => doc.querySelector(`[data-cat="${id}"]`);
    const count = (doc, id) => Number(chip(doc, id).querySelector('.chip__n').textContent);

    it('come from the page itself, so store-extras.json is never fetched', async () => {
        const { calls } = await open();
        expect(calls).toEqual(['./catalog.json']);
    });

    it('keep the badges and the filters in step when store-extras.json is blocked', async () => {
        // Math is Online only by what stage.mjs found in its code.
        const page = structuredClone(extras);
        page.items.math.online = true;
        const { doc, firstCard } = await open({ pageExtras: page, withExtras: false });
        expect(doc.getElementById('ext-weather')).toBe(firstCard); // pre-render kept
        expect(onlineBadges(doc)).toBe(2);
        expect(count(doc, 'online')).toBe(2);
        expect(chip(doc, 'agent').hidden).toBe(false);
        expect(count(doc, 'agent')).toBe(1); // Calendar's agent tools
        chip(doc, 'online').click();
        expect([...doc.querySelectorAll('[data-results] > [data-id]')].map((c) => c.dataset.id)).toEqual([
            'math',
            'weather',
        ]);
    });

    it('rebuild the pre-rendered cards when the page has none and the file is blocked', async () => {
        const page = structuredClone(extras);
        page.items.math.online = true;
        const { doc, firstCard } = await open({ pageExtras: page, embedded: false, withExtras: false });
        expect(doc.getElementById('ext-weather')).not.toBe(firstCard);
        // Without extras, Math isn't known to be Online, and nothing has agent tools: every count
        // matches what the cards say.
        expect(onlineBadges(doc)).toBe(1);
        expect(count(doc, 'online')).toBe(1);
        expect(chip(doc, 'agent').hidden).toBe(true);
        expect(doc.querySelectorAll('[data-results] .is-new').length).toBe(0); // no entrance animation
    });

    it('fall back to store-extras.json when the page has none', async () => {
        const { doc, calls } = await open({ embedded: false });
        expect(calls).toContain('./store-extras.json');
        expect(count(doc, 'agent')).toBe(1);
    });

    it('ignore an embedded block that is not valid', async () => {
        const html = renderIndex(template, CATALOG, extras).replace(
            /(<script type="application\/json" id="store-extras">)[^<]*/,
            '$1{"items": [1, 2]}'
        );
        const dom = new JSDOM(html, { url: BASE });
        const calls = [];
        await start({
            doc: dom.window.document,
            win: dom.window,
            fetchImpl: async (u) => {
                calls.push(String(u));
                return String(u).endsWith('catalog.json') ? json(CATALOG) : { ok: false, status: 404 };
            },
        });
        expect(calls).toContain('./store-extras.json');
        expect(dom.window.document.querySelector('[data-cat="agent"]').hidden).toBe(true);
    });
});
