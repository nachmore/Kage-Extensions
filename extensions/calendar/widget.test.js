/**
 * Functional tests for the Calendar next-meeting widget.
 *
 * The widget's contract after the stale-bar fix: render() never awaits a
 * calendar fetch — it computes the "next meeting" from a local snapshot
 * (this._events) that a fire-and-forget background refresh keeps warm.
 * These tests exercise the pure picker (_recomputeNextEvent) directly and
 * assert that render() resolves without waiting on a (deliberately slow)
 * invoke.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import CalendarNextMeetingWidget from './widget.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { invalidate } from './cache.js';

const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();

function setup({ config = {}, events = [], slowFetch = false } = {}) {
    // The shared cache memoises across tests; clear it so each test's
    // events are actually re-fetched.
    invalidate();
    const get_calendar_events = slowFetch
        ? () => new Promise((resolve) => setTimeout(() => resolve(events), 10_000))
        : () => events;
    const { context, invoke } = makeContext({ config, invokes: { get_calendar_events } });
    const widget = new CalendarNextMeetingWidget();
    widget.initialize(context);
    return { widget, invoke };
}

describe('CalendarNextMeetingWidget — _recomputeNextEvent', () => {
    let widget;
    beforeEach(() => {
        ({ widget } = setup());
    });

    it('picks an in-progress meeting as "now"', () => {
        widget._events = [
            { id: 'a', subject: 'Live now', start_time: minutesFromNow(-10), duration_minutes: 60 },
        ];
        widget._recomputeNextEvent();
        expect(widget._cachedEvent?.subject).toBe('Live now');
    });

    it('drops a meeting that has already ended', () => {
        widget._events = [
            { id: 'a', subject: 'Done', start_time: minutesFromNow(-120), duration_minutes: 30 },
        ];
        widget._recomputeNextEvent();
        expect(widget._cachedEvent).toBeNull();
    });

    it('prefers an imminent (≤10m) upcoming meeting over an in-progress one', () => {
        widget._events = [
            { id: 'a', subject: 'Running long', start_time: minutesFromNow(-50), duration_minutes: 120 },
            { id: 'b', subject: 'Starting soon', start_time: minutesFromNow(5), duration_minutes: 30 },
        ];
        widget._recomputeNextEvent();
        expect(widget._cachedEvent?.subject).toBe('Starting soon');
    });

    it('ignores all-day events', () => {
        widget._events = [
            { id: 'a', subject: 'OOO', start_time: minutesFromNow(-60), duration_minutes: 1440, all_day: true },
        ];
        widget._recomputeNextEvent();
        expect(widget._cachedEvent).toBeNull();
    });

    it('skips dismissed meetings', () => {
        widget._events = [
            { id: 'a', subject: 'Dismissed', start_time: minutesFromNow(-5), duration_minutes: 60 },
        ];
        widget._dismissedIds.add('a');
        widget._recomputeNextEvent();
        expect(widget._cachedEvent).toBeNull();
    });
});

describe('CalendarNextMeetingWidget — render', () => {
    it('renders the bar synchronously from the local snapshot', async () => {
        // Snapshot set directly — render() reads this._events, it does not
        // await a fetch. (The cache path is covered by cache.js's own
        // isolation; here we assert the render-from-snapshot contract.)
        const { widget } = setup();
        widget._events = [
            { id: 'a', subject: 'Standup', start_time: minutesFromNow(-2), duration_minutes: 30 },
        ];
        const out = await widget.render();
        expect(out).not.toBeNull();
        expect(out.html).toContain('Standup');
    });

    it('resolves render() promptly even when the calendar fetch is slow', async () => {
        // Slow fetch + empty snapshot: render must return immediately
        // (null, nothing to show yet) rather than awaiting the fetch. This
        // is the regression guard for the frozen-stale-bar bug, where a
        // render that awaited a 9s-killed Outlook query blew the host's
        // 10s renderWidget RPC budget. Kept last: the slow fetch leaks a
        // pending promise into the shared cache singleton.
        const { widget } = setup({
            slowFetch: true,
            events: [{ id: 'a', subject: 'X', start_time: minutesFromNow(-5), duration_minutes: 60 }],
        });
        const start = Date.now();
        const out = await widget.render();
        expect(Date.now() - start).toBeLessThan(1_000);
        expect(out).toBeNull();
    });
});
