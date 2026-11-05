/**
 * Functional tests for the Todos provider.
 * The headline logic is _parseDueDate — natural-language due dates ("tomorrow",
 * "next friday", "in 3 days", "Dec 25", "12/25") — plus the summary match()
 * path over a seeded in-memory store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Local-time YYYY-MM-DD, matching _formatDate. Using toISOString() (UTC)
// here would disagree by a day for anyone behind UTC late in the day —
// the very bug the production fix addresses.
const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

describe('TodosSearchProvider — _parseDueDate across midnight boundaries', () => {
    // Deterministic timezone-bug guard, mirroring the calendar suite.
    // _parseDueDate does local-time arithmetic and _parseDueDateLocal reads
    // dates back as local midnight; if _formatDate emits via toISOString()
    // (UTC) instead of local, "today" lands on the wrong calendar day
    // whenever the local date != the UTC date. We pin the clock to two
    // instants straddling midnight in opposite directions and assert the
    // round-trip invariant. The early-UTC instant trips behind-UTC zones
    // (America/Los_Angeles); the late-UTC instant trips ahead-of-UTC zones
    // (Asia/Tokyo); UTC trips neither, which is why CI also runs off-UTC.
    const localYmd = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const INSTANTS = ['2026-06-15T06:30:00Z', '2026-06-15T20:30:00Z'];

    afterEach(() => {
        vi.useRealTimers();
    });

    for (const iso of INSTANTS) {
        it(`'today' returns the local date when now is ${iso}`, () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(iso));
            const { provider } = setup();
            expect(provider._parseDueDate('today')).toBe(localYmd(new Date()));
        });

        it(`'tomorrow' is local-today + 1 when now is ${iso}`, () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(iso));
            const { provider } = setup();
            const tom = new Date();
            tom.setDate(tom.getDate() + 1);
            expect(provider._parseDueDate('tomorrow')).toBe(localYmd(tom));
        });
    }
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

describe('TodosSearchProvider — getKeywords', () => {
    const kw = () => setup().provider.getKeywords();

    it('registers todo/todos + add/delete sub-commands', () => {
        expect(kw().map((k) => k.keyword)).toEqual(['todo', 'todos', 'todo+', 'todo-']);
    });

    it('returns i18n KEYS for labels', () => {
        for (const k of kw()) {
            expect(k.labelKey).toMatch(/^keyword\./);
            expect(k.label).toBeUndefined();
        }
    });
});

describe('TodosSearchProvider — confirm_delete', () => {
    const SEED = [
        { id: 'a', text: 'buy milk', status: 'pending', createdAt: 3 },
        { id: 'b', text: 'call mum', status: 'pending', createdAt: 2 },
        { id: 'c', text: 'file taxes', status: 'complete', createdAt: 1 },
        { id: 'd', text: 'water plants', status: 'complete', createdAt: 0 },
    ];

    async function ready(config = {}) {
        const store = { 'kage-todos': JSON.stringify(SEED) };
        const invokes = {
            load_extension_data: ({ key }) => store[key] ?? null,
            save_extension_data: ({ key, data }) => {
                store[key] = data;
            },
        };
        const { context } = makeContext({ config, invokes });
        const provider = new TodosSearchProvider();
        provider.initialize(context);
        await provider._ready;
        const saved = () => JSON.parse(store['kage-todos']).map((t) => t.id);
        return { provider, saved };
    }

    const deleteRow = (provider, query, id) =>
        provider.match(query).find((r) => r.data?.action === 'delete' && r.data.todoId === id);
    const clearRow = (provider, query) =>
        provider.match(query).find((r) => r.data?.action === 'clear_completed');
    const top = (rows) => [...rows].sort((x, y) => y.score - x.score)[0];

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('on (the default)', () => {
        it('the first Enter asks instead of deleting', async () => {
            const { provider, saved } = await ready();
            const action = provider.execute(deleteRow(provider, 'todo-', 'a'));
            // Re-runs the same query, which now shows the question.
            expect(action).toEqual({ type: 'replace_input', value: 'todo-' });
            expect(provider.todos.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
            expect(saved()).toEqual(['a', 'b', 'c', 'd']);
        });

        it('never-saved config (no confirm_delete key) asks too', async () => {
            const { provider } = await ready({});
            expect(provider.execute(deleteRow(provider, 'todo-', 'a')).type).toBe('replace_input');
        });

        it('the re-run query shows "Delete …?" on top and a way out, not the list', async () => {
            const { provider } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            const rows = provider.match('todo-');
            expect(rows.map((r) => r.data.action)).toEqual(['confirm_delete', 'cancel_delete']);
            expect(rows[0].label).toBe('result.confirm_delete.label');
            expect(top(rows).data).toEqual({ action: 'confirm_delete', todoId: 'a' });
        });

        it('a second Enter, on the question, deletes', async () => {
            const { provider, saved } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            const action = provider.execute(top(provider.match('todo-')));
            expect(action.type).toBe('display');
            expect(provider.todos.map((t) => t.id)).toEqual(['b', 'c', 'd']);
            expect(saved()).toEqual(['b', 'c', 'd']);
            // Answered: the query lists again.
            expect(provider.match('todo-').some((r) => r.data?.action === 'delete')).toBe(true);
        });

        it('"No, keep it" brings the list back and deletes nothing', async () => {
            const { provider, saved } = await ready();
            provider.execute(deleteRow(provider, 'todo- mi', 'a'));
            const cancel = provider.match('todo- mi').find((r) => r.data.action === 'cancel_delete');
            expect(provider.execute(cancel)).toEqual({ type: 'replace_input', value: 'todo- mi' });
            expect(saved()).toEqual(['a', 'b', 'c', 'd']);
            const rows = provider.match('todo- mi');
            expect(rows.map((r) => r.data.todoId)).toEqual(['a']);
            expect(rows[0].data.action).toBe('delete');
        });

        it('keeps the filtered query it was asked from', async () => {
            const { provider } = await ready();
            const action = provider.execute(deleteRow(provider, 'todo- milk', 'a'));
            expect(action).toEqual({ type: 'replace_input', value: 'todo- milk' });
            expect(provider.match('todo- milk')[0].data.action).toBe('confirm_delete');
        });

        it('typing something else drops the question', async () => {
            const { provider } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            expect(provider.match('todo- c')[0].data.action).toBe('delete');
            expect(provider.match('todo-').some((r) => r.data?.action === 'confirm_delete')).toBe(false);
        });

        it('an abandoned question expires', async () => {
            vi.useFakeTimers();
            const { provider } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            vi.advanceTimersByTime(3 * 60_000);
            expect(provider.match('todo-').some((r) => r.data?.action === 'confirm_delete')).toBe(false);
        });

        it('a todo removed meanwhile drops the question', async () => {
            const { provider } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            provider.deleteTodo('a');
            expect(provider.match('todo-').some((r) => r.data?.action === 'confirm_delete')).toBe(false);
        });

        it('"Clear N completed" asks too, then clears on the second Enter', async () => {
            const { provider, saved } = await ready();
            expect(provider.execute(clearRow(provider, 'todo /done'))).toEqual({
                type: 'replace_input',
                value: 'todo /done',
            });
            expect(saved()).toEqual(['a', 'b', 'c', 'd']);
            const rows = provider.match('todo /done');
            expect(rows.map((r) => r.data.action)).toEqual(['confirm_clear_completed', 'cancel_delete']);
            provider.execute(top(rows));
            expect(saved()).toEqual(['a', 'b']);
        });
    });

    describe('off', () => {
        it('Enter on a todo deletes it at once', async () => {
            const { provider, saved } = await ready({ confirm_delete: false });
            const action = provider.execute(deleteRow(provider, 'todo-', 'a'));
            expect(action.type).toBe('display');
            expect(saved()).toEqual(['b', 'c', 'd']);
            expect(provider.match('todo-').some((r) => r.data?.action === 'confirm_delete')).toBe(false);
        });

        it('"Clear N completed" clears at once', async () => {
            const { provider, saved } = await ready({ confirm_delete: false });
            provider.execute(clearRow(provider, 'todo /done'));
            expect(saved()).toEqual(['a', 'b']);
        });

        it('turning it off while asked still lets the question be answered', async () => {
            const { provider, saved } = await ready();
            provider.execute(deleteRow(provider, 'todo-', 'a'));
            const yes = top(provider.match('todo-'));
            provider.onConfigUpdate({ confirm_delete: false });
            provider.execute(yes);
            expect(saved()).toEqual(['b', 'c', 'd']);
        });
    });
});
