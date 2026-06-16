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

    // Local-time YYYY-MM-DD, matching _resolveDate's formatter. Using
    // toISOString() (UTC) here would disagree by a day for anyone behind
    // UTC late in the day — the very bug the production fix addresses.
    const ymd = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

describe('CalendarSearchProvider — _resolveDate across midnight boundaries', () => {
    // Deterministic timezone-bug guard. _resolveDate does its arithmetic
    // in local time; if it formats via toISOString() (UTC) instead of
    // local, "today" returns the wrong calendar day whenever the local
    // date != the UTC date. We pin the clock to two instants that straddle
    // midnight in opposite directions, then assert the round-trip
    // invariant: _resolveDate('today') === the LOCAL date of `now`.
    //
    // Which instant trips the bug depends on the process timezone (set by
    // the CI matrix): the early-UTC instant is "yesterday" in behind-UTC
    // zones (America/Los_Angeles), the late-UTC instant is "tomorrow" in
    // ahead-of-UTC zones (Asia/Tokyo). In UTC neither trips it — that's the
    // case where this class of bug is invisible, which is exactly why the
    // matrix runs off-UTC zones too. Freezing the clock makes the failure
    // deterministic within each zone, independent of when CI runs.
    const localYmd = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const INSTANTS = [
        '2026-06-15T06:30:00Z', // behind-UTC: previous local day
        '2026-06-15T20:30:00Z', // ahead-of-UTC: next local day
    ];

    afterEach(() => {
        vi.useRealTimers();
    });

    for (const iso of INSTANTS) {
        it(`'today' returns the local date when now is ${iso}`, () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(iso));
            const { provider } = setup();
            expect(provider._resolveDate('today')).toBe(localYmd(new Date()));
        });

        it(`'tomorrow' is local-today + 1 when now is ${iso}`, () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(iso));
            const { provider } = setup();
            const tom = new Date();
            tom.setDate(tom.getDate() + 1);
            expect(provider._resolveDate('tomorrow')).toBe(localYmd(tom));
        });
    }
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
