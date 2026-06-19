/**
 * Functional tests for the Bookmarks provider — add/delete/fuzzy-open over a
 * mocked in-memory store.
 */

import { describe, it, expect } from 'vitest';
import BookmarksSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = {}, seed = {} } = {}) {
    const store = { bookmarks: JSON.stringify(seed) };
    const invokes = {
        load_extension_data: ({ key }) => store[key] ?? null,
        save_extension_data: ({ key, data }) => {
            store[key] = data;
        },
    };
    const { context } = makeContext({ config, invokes });
    const provider = new BookmarksSearchProvider();
    provider.initialize(context);
    return { provider, store };
}

const current = (store) => JSON.parse(store.bookmarks);

describe('BookmarksSearchProvider — add (bm+)', () => {
    it('proposes an add row for a valid url', () => {
        const { provider } = setup();
        const row = provider.match('bm+ gh https://github.com')[0];
        expect(row.data.add).toEqual({ name: 'gh', url: 'https://github.com' });
    });

    it('flags a non-http url as an error', () => {
        const { provider } = setup();
        expect(provider.match('bm+ bad notaurl')[0].data.error).toBe(true);
    });

    it('shows help when no url is given', () => {
        const { provider } = setup();
        expect(provider.match('bm+ lonely')[0].data.help).toBe(true);
    });

    it('execute persists the bookmark', async () => {
        const { provider, store } = setup();
        const row = provider.match('bm+ gh https://github.com')[0];
        const out = await provider.execute(row);
        expect(out).toEqual({ type: 'custom', data: { saved: 'gh' } });
        expect(current(store).gh.url).toBe('https://github.com');
    });
});

describe('BookmarksSearchProvider — delete (bm-)', () => {
    it('execute removes the bookmark', async () => {
        const { provider, store } = setup({ seed: { gh: { url: 'https://github.com' } } });
        const out = await provider.execute(provider.match('bm- gh')[0]);
        expect(out).toEqual({ type: 'custom', data: { deleted: 'gh' } });
        expect(current(store).gh).toBeUndefined();
    });
});

describe('BookmarksSearchProvider — open/list (matchAsync)', () => {
    it('lists bookmarks alphabetically when no query', async () => {
        const { provider } = setup({
            seed: { zed: { url: 'https://z.com' }, abc: { url: 'https://a.com' } },
        });
        const rows = await provider.matchAsync('bm');
        expect(rows.map((r) => r.label)).toEqual(['abc', 'zed']);
    });

    it('fuzzy-matches by name and carries the url to open', async () => {
        const { provider } = setup({
            seed: { github: { url: 'https://github.com' }, gitlab: { url: 'https://gitlab.com' } },
        });
        const rows = await provider.matchAsync('bm githu');
        expect(rows[0].label).toBe('github');
        expect(rows[0].data.open).toBe('https://github.com');
    });

    it('returns a "none" row when nothing matches a query', async () => {
        const { provider } = setup({ seed: { github: { url: 'https://github.com' } } });
        const rows = await provider.matchAsync('bm zzzzz');
        expect(rows[0].data.miss).toBe(true);
    });
});

describe('BookmarksSearchProvider — execute open', () => {
    it('returns an open_url action', async () => {
        const { provider } = setup({ seed: { gh: { url: 'https://github.com' } } });
        const row = (await provider.matchAsync('bm gh'))[0];
        expect(await provider.execute(row)).toEqual({
            type: 'open_url',
            value: 'https://github.com',
        });
    });
});

describe('BookmarksSearchProvider — getKeywords', () => {
    const kw = (cfg) => setup({ config: cfg }).provider.getKeywords();

    it('registers the trigger and its +/- sub-commands', () => {
        expect(kw().map((k) => k.keyword)).toEqual(['bm', 'bm+', 'bm-']);
    });

    it('tracks a custom trigger across all sub-commands', () => {
        expect(kw({ trigger: 'mark' }).map((k) => k.keyword)).toEqual(['mark', 'mark+', 'mark-']);
    });

    it('returns i18n KEYS for labels, never raw text', () => {
        for (const k of kw()) {
            expect(k.labelKey).toMatch(/^keyword\./);
            expect(k.label).toBeUndefined();
        }
    });
});
