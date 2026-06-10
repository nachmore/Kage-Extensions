/**
 * @vitest-environment jsdom
 *
 * Functional tests for the Link Preview formatter.
 *
 * format() parses message HTML with DOMParser and inserts preview cards, so
 * this file runs under jsdom (the rest of the suite stays on the faster node
 * env). Metadata fetches go through invoke('fetch_link_metadata'), which we
 * mock — no network. We assert the real behaviour: which links get cards, the
 * max-previews cap, the streaming/disabled short-circuits, and card shape
 * (hero vs compact vs fallback).
 */

import { describe, it, expect } from 'vitest';
import LinkPreviewFormatter from './formatter.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = { enabled: true }, meta = {} } = {}) {
    const invokes = {
        // meta is a map of url → metadata object (or null). Unlisted → null.
        fetch_link_metadata: ({ url }) => (url in meta ? meta[url] : null),
    };
    const { context } = makeContext({ config, invokes });
    const formatter = new LinkPreviewFormatter();
    formatter.initialize(context);
    return formatter;
}

/** Parse returned HTML back into a document for assertions. */
function parse(html) {
    return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

describe('LinkPreviewFormatter — short-circuits', () => {
    it('returns null when disabled', async () => {
        const f = setup({ config: { enabled: false } });
        expect(await f.format('<a href="https://example.com">x</a>', {})).toBeNull();
    });

    it('returns null during streaming', async () => {
        const f = setup();
        expect(await f.format('<a href="https://example.com">x</a>', { streaming: true })).toBeNull();
    });

    it('returns null when there are no http(s) links', async () => {
        const f = setup();
        expect(await f.format('<p>just text</p>', {})).toBeNull();
        expect(await f.format('<a href="mailto:x@y.com">mail</a>', {})).toBeNull();
    });
});

describe('LinkPreviewFormatter — card insertion', () => {
    it('inserts one card per unique link', async () => {
        const f = setup();
        const out = await f.format('<p><a href="https://example.com">e</a></p>', {});
        const doc = parse(out);
        const cards = doc.querySelectorAll('.link-preview-card');
        expect(cards).toHaveLength(1);
        expect(cards[0].getAttribute('href')).toBe('https://example.com');
    });

    it('dedupes repeated links', async () => {
        const f = setup();
        const html =
            '<a href="https://example.com">a</a><a href="https://example.com">b</a>';
        const out = await f.format(html, {});
        expect(parse(out).querySelectorAll('.link-preview-card')).toHaveLength(1);
    });

    it('caps cards at max_previews', async () => {
        const f = setup({ config: { enabled: true, max_previews: 2 } });
        const html = ['a', 'b', 'c', 'd']
            .map((s) => `<a href="https://example.com/${s}">${s}</a>`)
            .join('');
        const out = await f.format(html, {});
        expect(parse(out).querySelectorAll('.link-preview-card')).toHaveLength(2);
    });

    it('skips anchors inside code blocks / source chips', async () => {
        const f = setup();
        const html =
            '<div class="code-block-wrapper"><a href="https://skip.me">x</a></div>' +
            '<a href="https://keep.me">y</a>';
        const out = await f.format(html, {});
        const cards = parse(out).querySelectorAll('.link-preview-card');
        expect(cards).toHaveLength(1);
        expect(cards[0].getAttribute('href')).toBe('https://keep.me');
    });
});

describe('LinkPreviewFormatter — card shapes', () => {
    it('renders a hero card when metadata has an image', async () => {
        const f = setup({
            meta: {
                'https://example.com': {
                    title: 'Example',
                    description: 'A site',
                    image: 'https://example.com/og.png',
                },
            },
        });
        const out = await f.format('<a href="https://example.com">e</a>', {});
        const card = parse(out).querySelector('.link-preview-card');
        expect(card.classList.contains('link-preview-card-hero')).toBe(true);
        expect(card.querySelector('img.link-preview-hero-img').getAttribute('src')).toBe(
            'https://example.com/og.png'
        );
    });

    it('omits the hero image when show_images is false', async () => {
        const f = setup({
            config: { enabled: true, show_images: false },
            meta: { 'https://example.com': { title: 'E', image: 'https://example.com/og.png' } },
        });
        const out = await f.format('<a href="https://example.com">e</a>', {});
        const card = parse(out).querySelector('.link-preview-card');
        expect(card.classList.contains('link-preview-card-hero')).toBe(false);
        expect(card.querySelector('.link-preview-hero-img')).toBeNull();
    });

    it('renders a fallback card when metadata fetch yields nothing', async () => {
        const f = setup(); // no meta → null
        const out = await f.format('<a href="https://nometa.example">x</a>', {});
        const card = parse(out).querySelector('.link-preview-card');
        expect(card.classList.contains('link-preview-card-fallback')).toBe(true);
        // Fallback derives the domain + a coloured initial.
        expect(card.querySelector('.link-preview-domain').textContent).toBe('nometa.example');
    });

    it('truncates long descriptions', async () => {
        const long = 'x'.repeat(300);
        const f = setup({ meta: { 'https://example.com': { title: 'E', description: long } } });
        const out = await f.format('<a href="https://example.com">e</a>', {});
        const desc = parse(out).querySelector('.link-preview-desc').textContent;
        expect(desc.length).toBeLessThan(long.length);
        expect(desc.endsWith('…')).toBe(true);
    });
});

describe('LinkPreviewFormatter — _hashToHue', () => {
    it('is deterministic and within 0..359', () => {
        const f = setup();
        const a = f._hashToHue('example.com');
        const b = f._hashToHue('example.com');
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(360);
    });

    it('differs across distinct domains (usually)', () => {
        const f = setup();
        expect(f._hashToHue('github.com')).not.toBe(f._hashToHue('gitlab.com'));
    });
});
