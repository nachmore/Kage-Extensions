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

    it('defaults the bare trigger to "today"', () => {
        expect(p._parseQuery('focus')).toEqual({ period: 'today' });
    });

    it('parses each period keyword', () => {
        expect(p._parseQuery('focus week')).toEqual({ period: 'week' });
        expect(p._parseQuery('focus month')).toEqual({ period: 'month' });
        expect(p._parseQuery('focus all')).toEqual({ period: 'all' });
    });

    it('returns null for a non-trigger query', () => {
        expect(p._parseQuery('hello')).toBeNull();
    });

    it('honours a custom trigger', () => {
        const c = setup({ trigger: 'time' });
        expect(c._parseQuery('time week')).toEqual({ period: 'week' });
        expect(c._parseQuery('focus week')).toBeNull();
    });
});

describe('FocusTracker — comparison period ladder', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('steps today→week→month→all', () => {
        expect(p._getComparisonPeriod('today')).toBe('week');
        expect(p._getComparisonPeriod('week')).toBe('month');
        expect(p._getComparisonPeriod('month')).toBe('all');
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
