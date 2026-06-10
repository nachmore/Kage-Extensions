/**
 * Functional tests for the Snippets provider.
 * Storage is mocked via invoke(load/save_extension_data) backed by an
 * in-memory object, so add/delete/list/copy round-trips are exercised
 * end-to-end without touching disk.
 */

import { describe, it, expect } from 'vitest';
import SnippetsSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

/**
 * Build a provider over an in-memory store. Returns the provider plus the
 * live store object so tests can seed/inspect it.
 */
function setup({ config = {}, seed = {} } = {}) {
    const store = { snippets: JSON.stringify(seed) };
    const invokes = {
        load_extension_data: ({ key }) => store[key] ?? null,
        save_extension_data: ({ key, data }) => {
            store[key] = data;
        },
    };
    const { context } = makeContext({ config, invokes });
    const provider = new SnippetsSearchProvider();
    provider.initialize(context);
    return { provider, store };
}

const current = (store) => JSON.parse(store.snippets);

describe('SnippetsSearchProvider — trigger', () => {
    it('ignores input that does not start with the trigger', () => {
        const { provider } = setup();
        expect(provider.match('hello')).toEqual([]);
    });
});

describe('SnippetsSearchProvider — add (snip+)', () => {
    it('proposes an add row parsing name + body', () => {
        const { provider } = setup();
        const row = provider.match('snip+ sig Best regards, Alice')[0];
        expect(row.data.add).toEqual({ name: 'sig', body: 'Best regards, Alice' });
    });

    it('shows help when no body is given', () => {
        const { provider } = setup();
        expect(provider.match('snip+ onlyname')[0].data.help).toBe(true);
    });

    it('execute persists the snippet to storage', async () => {
        const { provider, store } = setup();
        const row = provider.match('snip+ greet hello there')[0];
        const out = await provider.execute(row);
        expect(out).toEqual({ type: 'custom', data: { saved: 'greet' } });
        expect(current(store).greet.body).toBe('hello there');
    });
});

describe('SnippetsSearchProvider — delete (snip-)', () => {
    it('proposes a delete row', () => {
        const { provider } = setup({ seed: { greet: { body: 'hi' } } });
        expect(provider.match('snip- greet')[0].data.del).toBe('greet');
    });

    it('execute removes the snippet', async () => {
        const { provider, store } = setup({ seed: { greet: { body: 'hi' } } });
        const row = provider.match('snip- greet')[0];
        const out = await provider.execute(row);
        expect(out).toEqual({ type: 'custom', data: { deleted: 'greet' } });
        expect(current(store).greet).toBeUndefined();
    });
});

describe('SnippetsSearchProvider — list/search (matchAsync)', () => {
    it('shows an empty-state row when there are no snippets', async () => {
        const { provider } = setup();
        const rows = await provider.matchAsync('snip');
        expect(rows[0].data.empty).toBe(true);
    });

    it('lists stored snippets', async () => {
        const { provider } = setup({ seed: { a: { body: 'alpha' }, b: { body: 'beta' } } });
        const rows = await provider.matchAsync('snip');
        const labels = rows.map((r) => r.label);
        expect(labels).toContain('a');
        expect(labels).toContain('b');
    });

    it('fuzzy-matches by name', async () => {
        const { provider } = setup({
            seed: { signature: { body: 'sig body' }, other: { body: 'x' } },
        });
        const rows = await provider.matchAsync('snip sig');
        expect(rows[0].label).toBe('signature');
        expect(rows[0].data.copy).toBe('sig body');
    });

    it('does not run a list when the query is an add/delete command', async () => {
        const { provider } = setup({ seed: { a: { body: 'x' } } });
        expect(await provider.matchAsync('snip+ a b')).toEqual([]);
        expect(await provider.matchAsync('snip- a')).toEqual([]);
    });
});

describe('SnippetsSearchProvider — execute copy', () => {
    it('copies a snippet body', async () => {
        const { provider } = setup({ seed: { greet: { body: 'hello there' } } });
        const row = (await provider.matchAsync('snip greet'))[0];
        expect(await provider.execute(row)).toEqual({ type: 'copy', value: 'hello there' });
    });
});
