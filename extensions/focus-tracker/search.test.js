/**
 * Functional tests for the Focus Tracker provider.
 * Focus on the pure query-parsing and period logic; the report formatting and
 * activity-tracker IPC are covered lightly via the cached match() path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import FocusTrackerSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const EN = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url), 'utf8'));

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

describe('FocusTracker — track_switches / track_streaks', () => {
    // A busy day: enough switches for the AI insight row.
    const REPORT = Object.freeze({
        period: 'Today',
        total_seconds: 7200,
        context_switches: 42,
        longest_streak_seconds: 1500,
        longest_streak_app: 'Code',
        apps: [
            { process_name: 'Code.exe', display_name: 'Code', seconds: 3600, percentage: 50, switches_to: 12 },
            { process_name: 'Slack.exe', display_name: 'Slack', seconds: 2400, percentage: 33.3, switches_to: 20 },
            { process_name: 'Outlook.exe', display_name: 'Outlook', seconds: 1200, percentage: 16.7, switches_to: 10 },
        ],
    });

    function make(config = {}) {
        const invokes = {
            is_activity_tracker_running: true,
            start_activity_tracker: undefined,
            stop_activity_tracker: undefined,
            get_activity_report: () => structuredClone(REPORT),
            get_app_icon: null,
        };
        const { context, invoke } = makeContext({ config, invokes, catalog: EN });
        const provider = new FocusTrackerSearchProvider();
        provider.initialize(context);
        return { provider, invoke };
    }

    /** Rows for "focus week" through the real fetch path (no hint row). */
    const rowsFor = (provider) => provider.matchAsync('focus week');
    const byType = (rows, type) => rows.filter((r) => r.data?.type === type);
    const summaryOf = (rows) => byType(rows, 'summary')[0];
    const promptOf = (provider, rows) => provider.execute(summaryOf(rows)).value;

    describe('both on (the default)', () => {
        it('shows switches and the best streak, and copies both', async () => {
            const { provider } = make();
            const s = summaryOf(await rowsFor(provider));
            expect(s.description).toBe('42 switches · 25m best streak (Code) · Enter for AI summary');
            expect(s.data.copyText).toBe('Today: 2.0h tracked, 42 switches, 25m best streak (Code)');
        });

        it('never-saved config (neither key) tracks both', async () => {
            const { provider } = make({});
            const rows = await rowsFor(provider);
            expect(summaryOf(rows).description).toMatch(/42 switches · 25m best streak/);
            expect(byType(rows, 'app-row')[0].description).toBe('12 sessions');
        });

        it('per-app sessions, the insight row and the AI prompt carry them', async () => {
            const { provider } = make();
            const rows = await rowsFor(provider);
            expect(byType(rows, 'app-row').map((r) => r.description)).toEqual(['12 sessions', '20 sessions', '10 sessions']);
            const insight = byType(rows, 'insight')[0];
            expect(insight.data.prompt).toContain('Context switches: 42');
            expect(insight.data.prompt).toContain('Longest focus streak: 25 minutes (Code)');
            const prompt = promptOf(provider, rows);
            expect(prompt).toContain('42 context switches');
            expect(prompt).toContain('25m longest streak (Code)');
            expect(prompt).toContain('12 sessions');
        });
    });

    describe('track_switches off', () => {
        it('the summary shows only the streak, and copies no switches', async () => {
            const { provider } = make({ track_switches: false });
            const s = summaryOf(await rowsFor(provider));
            expect(s.description).toBe('25m best streak (Code) · Enter for AI summary');
            expect(s.data.copyText).toBe('Today: 2.0h tracked, 25m best streak (Code)');
            expect(s.data).not.toHaveProperty('switches');
        });

        it('app rows drop their session counts', async () => {
            const { provider } = make({ track_switches: false });
            const apps = byType(await rowsFor(provider), 'app-row');
            expect(apps).toHaveLength(3);
            for (const r of apps) {
                expect(r.description).toBe('');
                expect(r.tooltip).not.toMatch(/sessions/);
                expect(r.data.copyText).not.toMatch(/sessions/);
                expect(r.data).not.toHaveProperty('sessions');
            }
        });

        it('no switch-driven insight row, and the AI prompt has no switches', async () => {
            const { provider } = make({ track_switches: false });
            const rows = await rowsFor(provider);
            expect(byType(rows, 'insight')).toEqual([]);
            const prompt = promptOf(provider, rows);
            expect(prompt).not.toMatch(/switch|sessions/i);
            expect(prompt).toContain('25m longest streak (Code)');
        });

        it('the cached report (and the row payload) keep no switch counts', async () => {
            const { provider } = make({ track_switches: false });
            const s = summaryOf(await rowsFor(provider));
            for (const report of [provider._cache.get('week').data, s.data.report]) {
                expect(report).not.toHaveProperty('context_switches');
                expect(report.apps.every((a) => !('switches_to' in a))).toBe(true);
                expect(report.longest_streak_seconds).toBe(1500);
            }
        });

        it('the comparison report used for the AI summary is trimmed too', async () => {
            const { provider } = make({ track_switches: false });
            await rowsFor(provider);
            await new Promise((r) => setTimeout(r, 0)); // the month pre-fetch
            expect(provider._cache.get('month').data).not.toHaveProperty('context_switches');
        });
    });

    describe('track_streaks off', () => {
        it('the summary shows only switches, and copies no streak', async () => {
            const { provider } = make({ track_streaks: false });
            const s = summaryOf(await rowsFor(provider));
            expect(s.description).toBe('42 switches · Enter for AI summary');
            expect(s.data.copyText).toBe('Today: 2.0h tracked, 42 switches');
            expect(s.data).not.toHaveProperty('streakMin');
            expect(s.data).not.toHaveProperty('streakApp');
        });

        it('the insight row and the AI prompt have no streak', async () => {
            const { provider } = make({ track_streaks: false });
            const rows = await rowsFor(provider);
            const insight = byType(rows, 'insight')[0];
            expect(insight.data.prompt).toContain('Context switches: 42');
            expect(insight.data.prompt).not.toMatch(/streak/i);
            const prompt = promptOf(provider, rows);
            expect(prompt).not.toMatch(/streak/i);
            expect(prompt).toContain('42 context switches');
        });

        it('the cached report keeps no streak', async () => {
            const { provider } = make({ track_streaks: false });
            await rowsFor(provider);
            const report = provider._cache.get('week').data;
            expect(report).not.toHaveProperty('longest_streak_seconds');
            expect(report).not.toHaveProperty('longest_streak_app');
            expect(report.context_switches).toBe(42);
        });
    });

    describe('both off', () => {
        it('the summary is just time tracked', async () => {
            const { provider } = make({ track_switches: false, track_streaks: false });
            const rows = await rowsFor(provider);
            const s = summaryOf(rows);
            expect(s.description).toBe('Enter for AI summary');
            expect(s.data.copyText).toBe('Today: 2.0h tracked');
            expect(promptOf(provider, rows)).toContain('Total: 2.0h tracked\n');
        });

        it('screen time still lists the apps', async () => {
            const { provider } = make({ track_switches: false, track_streaks: false });
            expect(byType(await rowsFor(provider), 'app-row').map((r) => r.label))
                .toEqual(['Code: 1.0h (50%)', 'Slack: 40m (33%)', 'Outlook: 20m (17%)']);
        });
    });

    describe('toggling', () => {
        it('turning switches back on shows them again from the host, with nothing re-stored', async () => {
            const { provider, invoke } = make({ track_switches: false });
            expect(summaryOf(await rowsFor(provider)).description).not.toMatch(/switches/);
            provider.onConfigUpdate({ track_switches: true });
            expect(provider._cache.size).toBe(0);
            expect(summaryOf(await rowsFor(provider)).description).toMatch(/^42 switches/);
            // Only reads: the host's activity data is never written or cleared.
            const calls = invoke.mock.calls.map((c) => c[0]);
            expect(calls.filter((c) => !['is_activity_tracker_running', 'get_activity_report', 'get_app_icon'].includes(c)))
                .toEqual([]);
        });

        it('a cached report is re-rendered under the new setting', () => {
            const { provider } = make();
            provider._cache.set('today', { time: Date.now(), data: structuredClone(REPORT) });
            expect(summaryOf(provider.match('focus')).description).toMatch(/42 switches/);
            provider.onConfigUpdate({ track_streaks: false });
            provider._cache.set('today', { time: Date.now(), data: structuredClone(REPORT) });
            expect(summaryOf(provider.match('focus')).description).toBe('42 switches · Enter for AI summary');
        });
    });
});
