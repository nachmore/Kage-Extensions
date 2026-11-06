// demo.js (the launcher in the hero) and boot.js, run as the page runs
// them: classic scripts evaluated in a jsdom window of the real index.html.
// demo.js gets a fake clock and a controllable IntersectionObserver, so the
// tests can stop it mid-word and check that nothing keeps running.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../stage.mjs';

let html;
let demoSrc;
let bootSrc;
beforeAll(async () => {
    html = await readFile(path.join(REPO_ROOT, 'web', 'index.html'), 'utf8');
    demoSrc = await readFile(path.join(REPO_ROOT, 'web', 'demo.js'), 'utf8');
    bootSrc = await readFile(path.join(REPO_ROOT, 'web', 'boot.js'), 'utf8');
});

const flush = () => new Promise((r) => setImmediate(r));

// setTimeout/clearTimeout on a virtual clock.
function fakeClock(win) {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    win.setTimeout = (fn, ms = 0) => {
        const id = ++seq;
        timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
        return id;
    };
    win.clearTimeout = (id) => {
        timers.delete(id);
    };
    return {
        pending: () => timers.size,
        async tick(ms) {
            const end = now + ms;
            for (;;) {
                await flush();
                let next = null;
                for (const [id, t] of timers) if (!next || t.at < next[1].at) next = [id, t];
                if (!next || next[1].at > end) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].fn();
            }
            now = end;
            await flush();
        },
    };
}

function load({ reduce = false } = {}) {
    const dom = new JSDOM(html, { url: 'https://store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const doc = win.document;
    const clock = fakeClock(win);
    win.matchMedia = (q) => ({ matches: reduce && /prefers-reduced-motion: reduce/.test(q) });
    const observers = [];
    win.IntersectionObserver = class {
        constructor(cb) {
            this.cb = cb;
            observers.push(this);
        }
        observe(el) {
            this.el = el;
        }
        disconnect() {}
    };
    let hidden = false;
    Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden });
    win.eval(demoSrc);
    const root = doc.querySelector('[data-lm]');
    const io = observers.find((o) => o.el === root);
    return {
        win,
        doc,
        clock,
        q: () => doc.querySelector('[data-lm-query]').textContent,
        rows: () => doc.querySelectorAll('[data-lm-rows] li').length,
        typing: () => root.classList.contains('is-typing'),
        toggle: doc.querySelector('[data-demo-toggle]'),
        setVisible: (v) => io.cb([{ isIntersecting: v, target: root }]),
        setHidden: (h) => {
            hidden = h;
            doc.dispatchEvent(new win.Event('visibilitychange'));
        },
    };
}

// Run until the second scene ("#38b2ac") is part-way typed.
async function midWord(d) {
    d.setVisible(true);
    await d.clock.tick(3600 + 260 + 10);
    for (let i = 0; i < 100 && d.q().length < 3; i++) await d.clock.tick(20);
    expect(d.typing()).toBe(true);
    expect(d.q().length).toBeGreaterThanOrEqual(3);
    expect(d.q().length).toBeLessThan('#38b2ac'.length);
    expect('#38b2ac'.startsWith(d.q())).toBe(true);
}

describe('demo.js', () => {
    it('cycles through the examples while it can be seen', async () => {
        const d = load();
        expect(d.q()).toBe('12 km to mi');
        await d.clock.tick(10000);
        expect(d.q()).toBe('12 km to mi'); // not on screen yet: nothing runs
        expect(d.clock.pending()).toBe(0);
        d.setVisible(true);
        await d.clock.tick(3600 + 3000);
        expect(d.q()).toBe('#38b2ac');
        expect(d.rows()).toBe(1);
        expect(d.typing()).toBe(false);
    });

    it('Pause mid-word stops the typing on the spot and shows that scene whole', async () => {
        const d = load();
        await midWord(d);
        d.toggle.click();
        expect(d.toggle.getAttribute('aria-pressed')).toBe('true');
        expect(d.q()).toBe('#38b2ac');
        expect(d.rows()).toBe(1);
        expect(d.typing()).toBe(false);
        expect(d.clock.pending()).toBe(0);
        await d.clock.tick(20000);
        expect(d.q()).toBe('#38b2ac');
        // Play goes on to the next one.
        d.toggle.click();
        expect(d.toggle.getAttribute('aria-pressed')).toBe('false');
        await d.clock.tick(3000);
        expect(d.q()).toBe(':fire');
    });

    it('scrolling it off screen mid-word stops it, and it carries on when back', async () => {
        const d = load();
        await midWord(d);
        d.setVisible(false);
        expect(d.q()).toBe('#38b2ac');
        expect(d.typing()).toBe(false);
        expect(d.clock.pending()).toBe(0);
        await d.clock.tick(20000);
        expect(d.q()).toBe('#38b2ac');
        d.setVisible(true);
        await d.clock.tick(1000);
        expect(d.q()).toBe('#38b2ac'); // a moment on the whole scene first
        await d.clock.tick(3600 + 2000);
        expect(d.q()).toBe(':fire');
    });

    it('a hidden tab stops it mid-word, with no timers left running', async () => {
        const d = load();
        await midWord(d);
        d.setHidden(true);
        expect(d.q()).toBe('#38b2ac');
        expect(d.typing()).toBe(false);
        expect(d.clock.pending()).toBe(0);
        await d.clock.tick(20000);
        expect(d.q()).toBe('#38b2ac');
        d.setHidden(false);
        await d.clock.tick(3600 + 2000);
        expect(d.q()).toBe(':fire');
    });

    it('an example chip shows that example and holds it', async () => {
        const d = load();
        d.setVisible(true);
        d.doc.querySelector('[data-scene="3"]').click();
        expect(d.toggle.getAttribute('aria-pressed')).toBe('true');
        await d.clock.tick(3000);
        expect(d.q()).toBe('weather lisbon');
        expect(d.rows()).toBe(2);
        await d.clock.tick(20000);
        expect(d.q()).toBe('weather lisbon');
        expect(d.clock.pending()).toBe(0);
        expect(d.doc.querySelector('[data-scene="3"]').getAttribute('aria-current')).toBe('true');
    });

    it('with reduced motion, starts paused and switches examples instantly', async () => {
        const d = load({ reduce: true });
        d.setVisible(true);
        expect(d.toggle.getAttribute('aria-pressed')).toBe('true');
        await d.clock.tick(20000);
        expect(d.q()).toBe('12 km to mi');
        d.doc.querySelector('[data-scene="1"]').click();
        expect(d.q()).toBe('#38b2ac');
        expect(d.clock.pending()).toBe(0);
    });
});

describe('boot.js', () => {
    function boot({ platform = '', modules = true } = {}) {
        const dom = new JSDOM(html, { url: 'https://store.test/', runScripts: 'outside-only' });
        const win = dom.window;
        Object.defineProperty(win.navigator, 'platform', { configurable: true, get: () => platform });
        Object.defineProperty(win.navigator, 'maxTouchPoints', { configurable: true, get: () => 0 });
        if (modules) Object.defineProperty(win.HTMLScriptElement.prototype, 'noModule', { configurable: true, value: false });
        win.eval(bootSrc);
        return { win, doc: win.document, cls: () => win.document.documentElement.className };
    }
    const fail = (win, el) => el.dispatchEvent(new win.Event('error')); // like a load error: doesn't bubble

    it('swaps no-js for js and notes the OS', () => {
        const a = boot({ platform: 'MacIntel' });
        expect(a.cls()).toBe('js');
        expect(a.doc.documentElement.dataset.os).toBe('mac');
        expect(boot({ platform: 'Win32' }).doc.documentElement.dataset.os).toBe('windows');
        expect(boot({ platform: 'Linux x86_64' }).doc.documentElement.dataset.os).toBe('other');
    });

    it('marks the page when one of its scripts fails to load', () => {
        const { win, doc, cls } = boot();
        fail(win, doc.querySelector('script[src="./demo.js"]'));
        expect(cls()).toBe('js demo-failed');
        fail(win, doc.querySelector('script[src="./app.js"]'));
        expect(cls()).toBe('js demo-failed store-failed');
        fail(win, doc.querySelector('script[src="./main.js"]'));
        expect(cls()).toContain('main-failed');
    });

    it('ignores other errors, and fail classes it doesn’t expect', () => {
        const { win, doc, cls } = boot();
        fail(win, doc.querySelector('img'));
        const s = doc.createElement('script');
        s.setAttribute('data-fail-class', 'x y');
        doc.head.append(s);
        fail(win, s);
        s.setAttribute('data-fail-class', 'Evil');
        fail(win, s);
        win.dispatchEvent(new win.ErrorEvent('error', { message: 'boom' }));
        expect(cls()).toBe('js');
    });

    it('treats a browser without modules as app.js failing', () => {
        expect(boot({ modules: false }).cls()).toBe('js store-failed');
    });
});
