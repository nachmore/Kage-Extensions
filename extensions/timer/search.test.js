/**
 * Functional tests for the Timer provider — pure duration parsing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import TimerSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new TimerSearchProvider();
    provider.initialize(context);
    return provider;
}

function data(provider, query) {
    const rows = provider.match(query);
    return rows.length ? rows[0].data : null;
}

describe('TimerSearchProvider', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('shows a hint for the bare trigger word', () => {
        expect(data(p, 'timer')).toEqual({ type: 'hint' });
        expect(data(p, 'countdown')).toEqual({ type: 'hint' });
    });

    it('parses a plain number as seconds', () => {
        expect(data(p, 'timer 30')).toMatchObject({ type: 'timer', durationMs: 30000 });
    });

    it('parses unit suffixes', () => {
        expect(data(p, 'timer 90s').durationMs).toBe(90000);
        expect(data(p, 'timer 5m').durationMs).toBe(300000);
        expect(data(p, 'timer 1h').durationMs).toBe(3600000);
    });

    it('parses compound durations', () => {
        expect(data(p, 'timer 1h30m').durationMs).toBe(5400000);
        expect(data(p, 'timer 2m30s').durationMs).toBe(150000);
    });

    it('does not confuse minutes with the trailing s in "ms"-like input', () => {
        // The minute matcher uses (?!s) so "30s" is seconds, not 30 "m"+s.
        expect(data(p, 'timer 30s').durationMs).toBe(30000);
    });

    it('recognises stopwatch aliases', () => {
        expect(data(p, 'stopwatch')).toEqual({ type: 'stopwatch' });
        expect(data(p, 'sw')).toEqual({ type: 'stopwatch' });
    });

    it('returns no match for unrelated input or zero/invalid durations', () => {
        expect(p.match('hello')).toEqual([]);
        expect(p.match('timer abc')).toEqual([]);
        expect(p.match('timer 0')).toEqual([]);
    });

    it('execute returns a custom action carrying the parsed data', () => {
        const row = p.match('timer 5m')[0];
        expect(p.execute(row)).toEqual({ type: 'custom', data: row.data });
    });
});
