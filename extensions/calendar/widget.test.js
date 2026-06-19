/**
 * Functional tests for the Calendar next-meeting widget.
 *
 * The widget's contract: render() computes the "next meeting" from a local
 * snapshot (this._events) that a fire-and-forget background refresh keeps
 * warm. The WARM path never awaits a fetch. The COLD path (snapshot still
 * empty, e.g. the first render after mount) briefly awaits the in-flight
 * fetch — capped at COLD_LOAD_WAIT_MS — so the first paint isn't empty;
 * on timeout it paints null and the next tick retries.
 * These tests exercise the pure picker (_recomputeNextEvent) directly plus
 * both render paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('CalendarNextMeetingWidget — mount warm-up', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does NOT query at mount — only after the warm-up delay', () => {
        const calls = { n: 0 };
        invalidate();
        const { context } = makeContext({
            invokes: { get_calendar_events: () => { calls.n++; return []; } },
        });
        const widget = new CalendarNextMeetingWidget();
        widget.initialize(context);
        // Nothing fired synchronously at mount — that's the whole point.
        expect(calls.n).toBe(0);
        // Fires once the warm-up delay elapses.
        vi.advanceTimersByTime(2_000);
        expect(calls.n).toBe(1);
    });

    it('destroy() before the delay cancels the query (reload-storm safety)', () => {
        const calls = { n: 0 };
        invalidate();
        const { context } = makeContext({
            invokes: { get_calendar_events: () => { calls.n++; return []; } },
        });
        const widget = new CalendarNextMeetingWidget();
        widget.initialize(context);
        // Torn down almost immediately, as in a mount→unmount reload storm.
        widget.destroy();
        vi.advanceTimersByTime(10_000);
        expect(calls.n).toBe(0); // never spawned
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

    it('cold render paints once the (fast) fetch resolves', async () => {
        // Empty snapshot + a fetch that resolves quickly: the cold path
        // awaits it briefly and paints the bar on the FIRST render, rather
        // than returning null and waiting for a later tick (which is paused
        // while the floating window is hidden — that gap is why the bar
        // appeared to never show).
        const { widget } = setup({
            events: [{ id: 'a', subject: 'Standup', start_time: minutesFromNow(-2), duration_minutes: 30 }],
        });
        const out = await widget.render();
        expect(out).not.toBeNull();
        expect(out.html).toContain('Standup');
    });

    it('cold render does not block past the cap when the fetch is slow', async () => {
        // Slow fetch + empty snapshot: the cold-load wait is bounded, so
        // render resolves at the cap (null, nothing yet) instead of hanging
        // until the 10s fetch — which would blow the host's renderWidget
        // RPC budget. Fake timers let us advance past COLD_LOAD_WAIT_MS
        // without a real wait. Kept last: the slow fetch leaks a pending
        // promise into the shared cache singleton.
        vi.useFakeTimers();
        try {
            const { widget } = setup({
                slowFetch: true,
                events: [{ id: 'a', subject: 'X', start_time: minutesFromNow(-5), duration_minutes: 60 }],
            });
            const p = widget.render();
            await vi.advanceTimersByTimeAsync(3_500);
            const out = await p;
            expect(out).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
