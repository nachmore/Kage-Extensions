/**
 * Functional tests for the Calendar search provider.
 *
 * match() is intentionally empty (all work is async). We test the pure
 * relative-date resolver and the matchAsync routing (trigger detection,
 * refresh row, date lookup, free-text filter) with calendar events served
 * through a mocked invoke. The shared cache.js reads its invoke from
 * initialize() → initCache().
 */

import { describe, it, expect, vi } from 'vitest';
import CalendarSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const EVENTS = [
    {
        id: 'a',
        subject: 'Standup',
        location: 'Zoom',
        organizer: 'alice',
        start_time: new Date(Date.now() + 3600000).toISOString(),
        online_url: 'https://zoom.us/j/1',
    },
    {
        id: 'b',
        subject: 'Lunch with Bob',
        location: 'Cafe',
        organizer: 'bob',
        start_time: new Date(Date.now() + 7200000).toISOString(),
    },
];

function setup({ config = {}, upcoming = EVENTS, forDate = EVENTS } = {}) {
    const invokes = {
        get_calendar_events: () => upcoming,
        get_calendar_events_for_date: () => forDate,
    };
    const { context, invoke } = makeContext({ config, invokes });
    const provider = new CalendarSearchProvider();
    provider.initialize(context);
    return { provider, invoke };
}

describe('CalendarSearchProvider — match (sync is empty)', () => {
    it('returns nothing synchronously', () => {
        expect(setup().provider.match('cal')).toEqual([]);
    });
});

describe('CalendarSearchProvider — _resolveDate', () => {
    let p;
    beforeEach(() => {
        ({ provider: p } = setup());
    });

    const ymd = (d) => d.toISOString().slice(0, 10);

    it('resolves today/tomorrow/yesterday', () => {
        const now = new Date();
        const tom = new Date(now);
        tom.setDate(tom.getDate() + 1);
        const yes = new Date(now);
        yes.setDate(yes.getDate() - 1);
        expect(p._resolveDate('today')).toBe(ymd(now));
        expect(p._resolveDate('tomorrow')).toBe(ymd(tom));
        expect(p._resolveDate('yesterday')).toBe(ymd(yes));
    });

    it('passes through an explicit ISO date', () => {
        expect(p._resolveDate('2026-12-25')).toBe('2026-12-25');
    });

    it('resolves a weekday name to the next occurrence (always future)', () => {
        const resolved = p._resolveDate('monday');
        expect(resolved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(resolved + 'T00:00:00').getTime()).toBeGreaterThan(
            Date.now() - 86400000
        );
        // "next monday" must be strictly in the future too.
        expect(new Date(p._resolveDate('next monday') + 'T00:00:00').getDay()).toBe(1);
    });

    it('returns null for unparseable input', () => {
        expect(p._resolveDate('someday')).toBeNull();
    });
});

describe('CalendarSearchProvider — matchAsync routing', () => {
    it('ignores non-calendar queries', async () => {
        expect(await setup().provider.matchAsync('hello')).toEqual([]);
    });

    it('lists upcoming events for the bare trigger', async () => {
        const rows = await setup().provider.matchAsync('cal');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => r.label?.includes('Standup'))).toBe(true);
    });

    it('emits a refresh row for "cal-refresh"', async () => {
        const rows = await setup().provider.matchAsync('cal-refresh');
        expect(rows[0].type).toBe('calendar_refresh');
    });

    it('free-text filters upcoming events', async () => {
        const rows = await setup().provider.matchAsync('cal bob');
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toContain('Lunch');
    });

    it('shows a no-match row when the filter matches nothing', async () => {
        const rows = await setup().provider.matchAsync('cal zzzzz');
        expect(rows[0].id).toBe('cal:no-match');
    });

    it('looks up events for a resolved date keyword', async () => {
        const { provider, invoke } = setup();
        await provider.matchAsync('cal tomorrow');
        expect(invoke).toHaveBeenCalledWith(
            'get_calendar_events_for_date',
            expect.objectContaining({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
        );
    });
});
