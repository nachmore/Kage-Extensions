/**
 * Functional tests for the Focus Tracker provider.
 * Focus on the pure query-parsing and period logic; the report formatting and
 * activity-tracker IPC are covered lightly via the cached match() path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import FocusTrackerSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    // Enabled = tracking: initialize() starts the activity tracker
    // unconditionally (there is no auto_start toggle). Stub the tracker
    // invokes so the mock doesn't log a "no handler" warning during setup.
    const invokes = {
        is_activity_tracker_running: true,
        start_activity_tracker: undefined,
        stop_activity_tracker: undefined,
    };
    const { context } = makeContext({ config, invokes });
    const provider = new FocusTrackerSearchProvider();
    provider.initialize(context);
    return provider;
}

// Like setup(), but returns the mock invoke too so tests can assert
// tracker lifecycle calls (start/stop).
function setupWithInvoke(config = {}) {
    const invokes = {
        is_activity_tracker_running: false,
        start_activity_tracker: undefined,
        stop_activity_tracker: undefined,
    };
    const { context } = makeContext({ config, invokes });
    const provider = new FocusTrackerSearchProvider();
    provider.initialize(context);
    return { provider, invoke: context.invoke };
}

describe('FocusTracker — query parsing', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('defaults the bare trigger to "today" (implicit — hint row eligible)', () => {
        expect(p._parseQuery('focus')).toEqual({ period: 'today', explicit: false });
    });

    it('trailing space shows the period menu', () => {
        expect(p._parseQuery('focus ')).toEqual({ menu: true, filter: '' });
    });

    it('partial period prefix shows filtered menu', () => {
        expect(p._parseQuery('focus w')).toEqual({ menu: true, filter: 'w' });
        expect(p._parseQuery('focus mo')).toEqual({ menu: true, filter: 'mo' });
    });

    it('parses each period keyword', () => {
        expect(p._parseQuery('focus week')).toEqual({ period: 'week', explicit: true });
        expect(p._parseQuery('focus month')).toEqual({ period: 'month', explicit: true });
        expect(p._parseQuery('focus year')).toEqual({ period: 'year', explicit: true });
        expect(p._parseQuery('focus all')).toEqual({ period: 'all', explicit: true });
    });

    it('returns null for a non-trigger query', () => {
        expect(p._parseQuery('hello')).toBeNull();
    });

    it('honours a custom trigger', () => {
        const c = setup({ trigger: 'time' });
        expect(c._parseQuery('time week')).toEqual({ period: 'week', explicit: true });
        expect(c._parseQuery('focus week')).toBeNull();
    });
});

describe('FocusTracker — comparison period ladder', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('steps today→week→month→year→all', () => {
        expect(p._getComparisonPeriod('today')).toBe('week');
        expect(p._getComparisonPeriod('week')).toBe('month');
        expect(p._getComparisonPeriod('month')).toBe('year');
        expect(p._getComparisonPeriod('year')).toBe('all');
    });

    it('returns null past the end of the ladder', () => {
        expect(p._getComparisonPeriod('all')).toBeNull();
    });
});

describe('FocusTracker — match()', () => {
    it('returns a loading placeholder for a valid trigger with no cache', () => {
        const rows = setup().match('focus');
        expect(rows).toHaveLength(1);
        expect(rows[0].data).toEqual({ type: 'loading', period: 'today' });
    });

    it('returns [] for unrelated input', () => {
        expect(setup().match('hello')).toEqual([]);
    });

    it('serves a fresh cached report instead of a placeholder', () => {
        const p = setup();
        p._cache.set('today', {
            time: Date.now(),
            data: {
                period: 'Today',
                total_seconds: 3600,
                longest_streak_seconds: 1200,
                longest_streak_app: 'Code.exe',
                apps: [
                    { process_name: 'Code.exe', seconds: 3600, percentage: 100 },
                ],
            },
        });
        const rows = p.match('focus');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.data?.type !== 'loading')).toBe(true);
    });
});

describe('FocusTracker — period menu (trailing space / partial prefix)', () => {
    it('"focus " shows all periods as selectable rows', () => {
        const rows = setup().match('focus ');
        expect(rows.length).toBe(5); // today, week, month, year, all
        expect(rows.every((r) => r.data?.type === 'period-menu')).toBe(true);
        expect(rows[0].label).toBe('focus today');
        expect(rows[4].label).toBe('focus all');
    });

    it('partial prefix filters to matching periods', () => {
        const rows = setup().match('focus w');
        expect(rows.length).toBe(1);
        expect(rows[0].label).toBe('focus week');
    });

    it('Enter on a menu row replaces input with that query', () => {
        const p = setup();
        const row = p.match('focus ')[1]; // 'focus week'
        expect(p.execute(row)).toEqual({ type: 'replace_input', value: 'focus week' });
    });

    it('custom trigger flows through to menu labels', () => {
        const rows = setup({ trigger: 'time' }).match('time ');
        expect(rows[0].label).toBe('time today');
    });
});

describe('FocusTracker — period-hint row (discoverability)', () => {
    const CACHED_REPORT = {
        period: 'Today',
        total_seconds: 3600,
        context_switches: 3,
        longest_streak_seconds: 1200,
        longest_streak_app: 'Code.exe',
        apps: [{ process_name: 'Code.exe', display_name: 'Code', seconds: 3600, percentage: 100, switches_to: 3 }],
    };

    function withCache(p, period = 'today') {
        p._cache.set(period, { time: Date.now(), data: { ...CACHED_REPORT } });
        return p;
    }

    it('bare trigger appends the hint row listing the other periods', () => {
        const rows = withCache(setup()).match('focus');
        const hint = rows.find((r) => r.data?.type === 'period-hint');
        expect(hint).toBeDefined();
        // All non-today periods, spelled as typeable queries.
        expect(hint.description).toBe('focus week · focus month · focus year · focus all');
        // Renders below every report row.
        expect(Math.max(...rows.filter((r) => r !== hint).map((r) => r.score))).toBeGreaterThan(hint.score);
    });

    it('explicit period query does NOT get the hint row', () => {
        const p = setup();
        p._cache.set('week', { time: Date.now(), data: { ...CACHED_REPORT, period: 'This Week' } });
        const rows = p.match('focus week');
        expect(rows.find((r) => r.data?.type === 'period-hint')).toBeUndefined();
    });

    it('hint row respects a custom trigger', () => {
        const rows = withCache(setup({ trigger: 'time' })).match('time');
        const hint = rows.find((r) => r.data?.type === 'period-hint');
        expect(hint.description).toBe('time week · time month · time year · time all');
    });

    it('Enter on the hint row swaps the input to a period query', () => {
        const p = withCache(setup());
        const hint = p.match('focus').find((r) => r.data?.type === 'period-hint');
        expect(p.execute(hint)).toEqual({ type: 'replace_input', value: 'focus week' });
    });
});

describe('FocusTrackerSearchProvider — getKeywords', () => {
    it('registers the trigger keyword (accepts period args)', () => {
        const kws = setup().getKeywords();
        expect(kws.map((k) => k.keyword)).toEqual(['focus']);
        expect(kws[0].acceptsArgs).toBe(true);
        expect(kws[0].labelKey).toMatch(/^keyword\./);
        expect(kws[0].label).toBeUndefined();
    });

    it('tracks a custom trigger', () => {
        expect(setup({ trigger: 'time' }).getKeywords().map((k) => k.keyword)).toEqual(['time']);
    });
});

describe('FocusTrackerSearchProvider — tracker lifecycle (enabled = tracking)', () => {
    it('starts the tracker on initialize', async () => {
        const { invoke } = setupWithInvoke();
        // initialize()'s start is fire-and-forget; let it settle.
        await new Promise((r) => setTimeout(r, 0));
        expect(invoke).toHaveBeenCalledWith('start_activity_tracker', expect.anything());
    });

    it('does not start when the extension is disabled', async () => {
        const { invoke } = setupWithInvoke({ enabled: false });
        await new Promise((r) => setTimeout(r, 0));
        expect(invoke).not.toHaveBeenCalledWith('start_activity_tracker', expect.anything());
    });

    it('stops the tracker when the extension is disabled via config', async () => {
        const { provider, invoke } = setupWithInvoke();
        await new Promise((r) => setTimeout(r, 0));
        provider.onConfigUpdate({ enabled: false });
        await new Promise((r) => setTimeout(r, 0));
        expect(invoke).toHaveBeenCalledWith('stop_activity_tracker');
    });

    it('restarts the tracker when the extension is re-enabled', async () => {
        const { provider, invoke } = setupWithInvoke();
        await new Promise((r) => setTimeout(r, 0));
        provider.onConfigUpdate({ enabled: false });
        await new Promise((r) => setTimeout(r, 0));
        invoke.mockClear();
        provider.onConfigUpdate({ enabled: true });
        await new Promise((r) => setTimeout(r, 0));
        expect(invoke).toHaveBeenCalledWith('start_activity_tracker', expect.anything());
    });
});
