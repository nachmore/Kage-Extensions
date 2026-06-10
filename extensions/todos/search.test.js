/**
 * Functional tests for the Todos provider.
 * The headline logic is _parseDueDate — natural-language due dates ("tomorrow",
 * "next friday", "in 3 days", "Dec 25", "12/25") — plus the summary match()
 * path over a seeded in-memory store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import TodosSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = {}, seed = [] } = {}) {
    const store = { todos: JSON.stringify(seed) };
    const invokes = {
        load_extension_data: ({ key }) => store[key] ?? null,
        save_extension_data: ({ key, data }) => {
            store[key] = data;
        },
    };
    const { context } = makeContext({ config, invokes });
    const provider = new TodosSearchProvider();
    provider.initialize(context);
    return { provider, store };
}

const ymd = (d) => d.toISOString().split('T')[0];

describe('TodosSearchProvider — _parseDueDate', () => {
    let p;
    beforeEach(() => {
        ({ provider: p } = setup());
    });

    it('parses today/tomorrow', () => {
        const now = new Date();
        const tom = new Date(now);
        tom.setDate(tom.getDate() + 1);
        expect(p._parseDueDate('today')).toBe(ymd(now));
        expect(p._parseDueDate('tomorrow')).toBe(ymd(tom));
    });

    it('parses a weekday name to the next future occurrence', () => {
        const out = p._parseDueDate('monday');
        expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const d = new Date(out + 'T00:00:00');
        expect(d.getDay()).toBe(1);
        expect(d.getTime()).toBeGreaterThan(Date.now() - 86400000);
    });

    it('parses "next <weekday>"', () => {
        const d = new Date(p._parseDueDate('next friday') + 'T00:00:00');
        expect(d.getDay()).toBe(5);
    });

    it('parses "next week" / "next month"', () => {
        const now = new Date();
        const wk = new Date(now);
        wk.setDate(wk.getDate() + 7);
        expect(p._parseDueDate('next week')).toBe(ymd(wk));
        const mo = new Date(now);
        mo.setMonth(mo.getMonth() + 1);
        expect(p._parseDueDate('next month')).toBe(ymd(mo));
    });

    it('parses "in N days/weeks"', () => {
        const now = new Date();
        const d3 = new Date(now);
        d3.setDate(d3.getDate() + 3);
        expect(p._parseDueDate('in 3 days')).toBe(ymd(d3));
        const w2 = new Date(now);
        w2.setDate(w2.getDate() + 14);
        expect(p._parseDueDate('in 2 weeks')).toBe(ymd(w2));
    });

    it('passes through ISO dates', () => {
        expect(p._parseDueDate('2026-12-25')).toBe('2026-12-25');
    });

    it('parses MM/DD and MM/DD/YYYY', () => {
        const thisYear = new Date().getFullYear();
        expect(p._parseDueDate('12/25')).toBe(`${thisYear}-12-25`);
        expect(p._parseDueDate('12/25/2030')).toBe('2030-12-25');
    });

    it('parses named months like "Dec 25 2030"', () => {
        expect(p._parseDueDate('Dec 25 2030')).toBe('2030-12-25');
    });

    it('returns null for unparseable text', () => {
        expect(p._parseDueDate('whenever')).toBeNull();
    });
});

describe('TodosSearchProvider — match() summary', () => {
    it('shows a summary for "todo"/"todos"', async () => {
        const { provider } = setup({
            seed: [
                { id: '1', text: 'a', status: 'active' },
                { id: '2', text: 'b', status: 'complete' },
            ],
        });
        await provider._ready;
        const rows = provider.match('todos');
        expect(rows[0].data.action).toBe('summary');
    });

    it('returns [] for unrelated input', async () => {
        const { provider } = setup();
        await provider._ready;
        expect(provider.match('hello')).toEqual([]);
    });
});
