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

function setup({ config = {}, upcoming = EVENTS, forDate = EVENTS, busyDays = [], hostFeatures, catalog } = {}) {
    const invokes = {
        get_calendar_events: () => upcoming,
        get_calendar_events_for_date: () => forDate,
        get_calendar_busy_days: typeof busyDays === 'function' ? busyDays : () => busyDays,
    };
    const { context, invoke } = makeContext({ config, invokes, hostFeatures, catalog });
    const provider = new CalendarSearchProvider();
    provider.initialize(context);
    return { provider, invoke };
}

describe('CalendarSearchProvider — match (sync is empty)', () => {
    it('returns nothing synchronously', () => {
        expect(setup().provider.match('cal')).toEqual([]);
    });
});

describe('CalendarSearchProvider — getKeywords', () => {
    const kws = () => setup().provider.getKeywords();

    it('registers cal, calendar, meetings, and cal-refresh as keywords', () => {
        // `cal` AND `calendar` are both registered: the host gates match() on
        // the complete set, so the bare `cal` trigger (which matchAsync also
        // answers) must be present or it'd be unreachable.
        expect(kws().map((k) => k.keyword)).toEqual(['cal', 'calendar', 'meetings', 'cal-refresh']);
    });

    it('covers every trigger matchAsync answers (no unreachable triggers)', () => {
        // Guard against drift: the host only invokes the extension on a
        // registered keyword, so each live trigger must appear here.
        const registered = new Set(kws().map((k) => k.keyword));
        for (const trigger of ['cal', 'calendar', 'meetings', 'cal-refresh']) {
            expect(registered.has(trigger)).toBe(true);
        }
    });

    it('returns i18n KEYS for labels, never raw text', () => {
        for (const k of kws()) {
            expect(k.labelKey).toMatch(/^keyword\./);
            expect(k.descriptionKey).toMatch(/^keyword\./);
            // No raw label/description fields — host resolves keys.
            expect(k.label).toBeUndefined();
            expect(k.description).toBeUndefined();
        }
    });

    it('marks cal-refresh as taking no args; calendar/meetings take args', () => {
        const byKw = Object.fromEntries(kws().map((k) => [k.keyword, k]));
        expect(byKw['cal-refresh'].acceptsArgs).toBe(false);
        expect(byKw['calendar'].acceptsArgs).toBe(true);
        expect(byKw['meetings'].acceptsArgs).toBe(true);
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

    it('lists upcoming events for the bare "calendar" trigger (not a bogus filter)', async () => {
        // Regression: the strip regex was alternation-ordered 'cal' first,
        // so 'calendar' stripped to 'endar' and fell into the free-text
        // filter, surfacing a "No meetings matching" row. The full word
        // must behave exactly like the bare 'cal' trigger.
        const rows = await setup().provider.matchAsync('calendar');
        expect(rows.some((r) => r.label?.includes('Standup'))).toBe(true);
        expect(rows.some((r) => r.id === 'cal:no-match')).toBe(false);
    });

    it('free-text filters after the full "calendar" keyword', async () => {
        const rows = await setup().provider.matchAsync('calendar bob');
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toContain('Lunch');
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

describe('CalendarSearchProvider — renderCustom', () => {
    // The mock i18n echoes message keys (no catalog seeded), so assert on
    // the row's own label/icon — which renderCustom must surface verbatim —
    // and on the ABSENCE of the event-template breakage.

    it('renders the refresh row from its label/icon, not as an event', async () => {
        // Regression: the refresh row carries a truthy `data: { action }`,
        // so a `!data` guard let it fall through to the event template and
        // render "undefined" / "[Invalid Date] Invalid Date". It must use
        // the label branch instead.
        const { provider } = setup();
        const [refresh] = await provider.matchAsync('cal-refresh');
        const { html } = provider.renderCustom(refresh);
        expect(html).toContain(refresh.icon); // 🔄
        expect(html).toContain(refresh.label); // not the event subject
        expect(html).not.toContain('undefined');
        expect(html).not.toMatch(/Invalid Date/i);
    });

    it('renders a no-match row from its label, not as an event', async () => {
        const { provider } = setup();
        const [row] = await provider.matchAsync('cal zzzzz');
        const { html } = provider.renderCustom(row);
        expect(html).toContain(row.label);
        expect(html).not.toContain('undefined');
        expect(html).not.toMatch(/Invalid Date/i);
    });

    it('renders an actual event row with its subject', async () => {
        const { provider } = setup();
        const rows = await provider.matchAsync('cal');
        const event = rows.find((r) => r.type === 'calendar_event' && r.data);
        const { html } = provider.renderCustom(event);
        expect(html).toContain('Standup');
        expect(html).not.toContain('undefined');
    });
});

/**
 * Host date picker. Newer hosts pass `context.hostFeatures: ['date-picker']`;
 * the provider then answers busy-day lookups, routes picked days to its own
 * `cal <date>` listing, and marks dates in its rows as picker openers. On an
 * older host (no hostFeatures) the rows must render exactly as plain text.
 */
describe('CalendarSearchProvider — date picker', () => {
    const PICKER = ['date-picker'];
    // A fake event 20 days out, so its row shows a full date label.
    const far = new Date();
    far.setDate(far.getDate() + 20);
    far.setHours(10, 0, 0, 0);
    const farIso = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}`;
    const FAR_EVENT = { id: 'f', subject: 'Fake planning', start_time: far.toISOString(), duration_minutes: 30 };

    it('routes a picked day to its own cal <date> listing', () => {
        const { provider } = setup({ hostFeatures: PICKER });
        expect(provider.onDateSelected('2026-11-26')).toEqual({ query: 'cal 2026-11-26' });
        expect(provider.onDateSelected('2026-02-30')).toBeNull();
        expect(provider.onDateSelected('not a date')).toBeNull();
    });

    it('the routed query lands back on the day listing', async () => {
        const { provider, invoke } = setup({ hostFeatures: PICKER });
        const { query } = provider.onDateSelected('2026-11-26');
        await provider.matchAsync(query);
        expect(invoke).toHaveBeenCalledWith('get_calendar_events_for_date', { date: '2026-11-26' });
    });

    it('answers busy-day lookups with one range call, passing counts through', async () => {
        const busyDays = vi.fn(() => [{ date: '2026-11-05', count: 2 }]);
        const { provider, invoke } = setup({ hostFeatures: PICKER, busyDays });
        const out = await provider.getDateMarkers('2026-10-26', '2026-12-07');
        expect(out).toEqual({ status: 'ok', days: [{ date: '2026-11-05', count: 2 }] });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('get_calendar_busy_days', { start: '2026-10-26', end: '2026-12-07' });
    });

    it('turns a denied OS permission into the permission status (by error key)', async () => {
        const busyDays = () => {
            const e = new Error('Calendar access denied');
            e.key = 'errors.calendar.access_denied';
            throw e;
        };
        const { provider } = setup({ hostFeatures: PICKER, busyDays });
        expect(await provider.getDateMarkers('2026-10-26', '2026-12-07')).toEqual({
            status: 'permission_denied',
            days: [],
        });
    });

    it('degrades any other failure (or a bad range) to no dots', async () => {
        const busyDays = () => {
            throw new Error('Outlook not running');
        };
        const { provider } = setup({ hostFeatures: PICKER, busyDays });
        expect(await provider.getDateMarkers('2026-10-26', '2026-12-07')).toEqual({ status: 'error', days: [] });
        expect(await provider.getDateMarkers('2026-10-26"', '2026-12-07')).toEqual({ status: 'error', days: [] });
    });

    it('day listings pin the date on every row and mark it as a picker opener', async () => {
        const { provider } = setup({ hostFeatures: PICKER, forDate: [FAR_EVENT] });
        const [row] = await provider.matchAsync(`cal ${farIso}`);
        expect(row.pinDate).toBe(true);
        const { html } = provider.renderCustom(row);
        expect(html).toContain(`data-kage-date="${farIso}"`);
        expect(html).toContain('Fake planning');
    });

    it("a day listing's today rows still carry a date opener", async () => {
        const soon = new Date();
        soon.setHours(23, 59, 0, 0);
        const todayEvent = { id: 't', subject: 'Fake sync', start_time: soon.toISOString(), duration_minutes: 1 };
        const { provider } = setup({ hostFeatures: PICKER, forDate: [todayEvent] });
        const [row] = await provider.matchAsync('cal today');
        const { html } = provider.renderCustom(row);
        expect(html).toMatch(/\[<button type="button" data-kage-date="\d{4}-\d{2}-\d{2}">day\.today<\/button>\]/);
    });

    it('the empty state for a picked day makes the day itself the opener', async () => {
        const catalog = { 'result.no_date.label': 'No meetings on {label}' };
        const { provider } = setup({ hostFeatures: PICKER, forDate: [], catalog });
        const [row] = await provider.matchAsync('cal 2026-11-26');
        expect(row.id).toBe('cal:no-date:2026-11-26');
        expect(row.dateView).toBe('2026-11-26');
        const { html } = provider.renderCustom(row);
        expect(html).toMatch(/No meetings on <button type="button" data-kage-date="2026-11-26">[^<]+<\/button>/);
    });

    it('older hosts get plain text: no data-kage-date anywhere', async () => {
        const { provider } = setup({ forDate: [FAR_EVENT] });
        const [row] = await provider.matchAsync(`cal ${farIso}`);
        expect(provider.renderCustom(row).html).not.toContain('data-kage-date');
        const { provider: p2 } = setup({ forDate: [] });
        const [empty] = await p2.matchAsync('cal 2026-11-26');
        expect(p2.renderCustom(empty).html).not.toContain('data-kage-date');
    });

    it('escapes a hostile subject but keeps the opener intact', async () => {
        const evil = { ...FAR_EVENT, subject: '<img src=x onerror=alert(1)>' };
        const { provider } = setup({ hostFeatures: PICKER, forDate: [evil] });
        const [row] = await provider.matchAsync(`cal ${farIso}`);
        const { html } = provider.renderCustom(row);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).toContain(`data-kage-date="${farIso}"`);
    });
});
