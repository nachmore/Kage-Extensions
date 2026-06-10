/**
 * Functional tests for the Math Calculator search provider.
 *
 * These drive the real provider (search.js) through a mocked host context
 * (test-helpers/mock-context.mjs), with the real `mathjs` package standing in
 * for the `math` vendor global the host injects into runSandboxed. The aim is
 * to let an extension author refactor search.js and immediately see whether
 * detection, evaluation, formatting, or the copy action regressed.
 *
 * What this CAN'T catch: host-side plumbing (e.g. the manifest `sandboxVendor`
 * field being dropped before mathjs ever reaches the worker — that's covered
 * by a round-trip test in the Kage repo). Here we assume the host delivers the
 * vendor lib correctly and test the extension's own logic. The "missing vendor"
 * case below documents the failure shape so a future author recognises it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';
import MathSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const CATALOG = {
    'result.copy_hint': { message: 'Press Enter to copy result' },
};

/** Spin up a provider with a fresh mocked context. */
function setup({ config = {}, lib = { math: mathjs } } = {}) {
    const { context, log, runSandboxed } = makeContext({
        config,
        lib,
        catalog: CATALOG,
    });
    const provider = new MathSearchProvider();
    provider.initialize(context);
    return { provider, log, runSandboxed: context.runSandboxed };
}

/** Convenience: run match() and return the single row (or null). */
async function evalQuery(provider, query) {
    const rows = await provider.match(query);
    return rows.length ? rows[0] : null;
}

describe('MathSearchProvider — detection & evaluation', () => {
    let provider;
    beforeEach(() => {
        ({ provider } = setup());
    });

    it('evaluates basic arithmetic', async () => {
        const row = await evalQuery(provider, '1+1');
        expect(row).toBeTruthy();
        expect(row.type).toBe('math');
        expect(row.label).toBe('= 2');
        expect(row.data.value).toBe('2');
    });

    it('evaluates division to default integer precision', async () => {
        // Default precision is 0 (manifest default); 3/4 → "1" at 0 dp.
        const row = await evalQuery(provider, '3/4');
        expect(row).toBeTruthy();
        expect(row.data.value).toBe('1');
    });

    it('evaluates multiplication and subtraction', async () => {
        expect((await evalQuery(provider, '6*7')).data.value).toBe('42');
        expect((await evalQuery(provider, '10-4')).data.value).toBe('6');
    });

    it('evaluates function calls like sqrt()', async () => {
        expect((await evalQuery(provider, 'sqrt(16)')).data.value).toBe('4');
    });

    it('exposes the raw numeric result in data.raw', async () => {
        const row = await evalQuery(provider, '2+2');
        expect(row.data.raw).toBe(4);
    });

    it('returns the copy hint as the row description', async () => {
        const row = await evalQuery(provider, '1+1');
        expect(row.description).toBe('Press Enter to copy result');
    });
});

describe('MathSearchProvider — non-math input is rejected', () => {
    let provider;
    beforeEach(() => {
        ({ provider } = setup());
    });

    it.each([
        ['', 'empty'],
        ['hello world', 'prose with no digits'],
        ['the quick brown', 'words only'],
        ['notanumber', 'single word'],
    ])('returns no match for %j (%s)', async (query) => {
        expect(await provider.match(query)).toEqual([]);
    });

    it('returns no match for a bare number (nothing to compute)', async () => {
        // "42" evaluates to 42 but equals its own input — not a useful result.
        expect(await provider.match('42')).toEqual([]);
    });
});

describe('MathSearchProvider — precision config', () => {
    it('honours an explicit decimal precision', async () => {
        const { provider } = setup({ config: { precision: 2 } });
        const row = await evalQuery(provider, '3/4');
        expect(row.data.value).toBe('0.75');
    });

    it('precision 0 rounds to an integer', async () => {
        const { provider } = setup({ config: { precision: 0 } });
        expect((await evalQuery(provider, '7/2')).data.value).toBe('4');
    });

    it('negative precision uses full significant-figure output', async () => {
        const { provider } = setup({ config: { precision: -1 } });
        const row = await evalQuery(provider, '3/4');
        expect(row.data.value).toBe('0.75');
    });
});

describe('MathSearchProvider — thousands separator', () => {
    it('inserts commas when enabled', async () => {
        const { provider } = setup({ config: { precision: 0, thousands_separator: true } });
        const row = await evalQuery(provider, '1000*1000');
        expect(row.data.value).toBe('1,000,000');
    });

    it('leaves the number plain when disabled', async () => {
        const { provider } = setup({ config: { precision: 0, thousands_separator: false } });
        const row = await evalQuery(provider, '1000*1000');
        expect(row.data.value).toBe('1000000');
    });
});

describe('MathSearchProvider — unit conversion', () => {
    let provider;
    beforeEach(() => {
        ({ provider } = setup());
    });

    it('converts between units', async () => {
        const row = await evalQuery(provider, '5 km to miles');
        expect(row).toBeTruthy();
        // ~3.11 miles; provider formats unit results to 2dp + unit name.
        expect(row.data.value).toMatch(/mile/i);
        expect(row.data.value).toMatch(/^3\.1/);
    });
});

describe('MathSearchProvider — execute (copy action)', () => {
    it('returns a copy action carrying the displayed value', async () => {
        const { provider } = setup();
        const row = await evalQuery(provider, '2+2');
        const action = provider.execute(row);
        expect(action).toEqual({ type: 'copy', value: '4' });
    });
});

describe('MathSearchProvider — missing vendor lib (regression shape)', () => {
    it('returns no match (does not throw) when the math global is absent', async () => {
        // Reproduces the failure mode where the host never delivered mathjs:
        // lib.math is undefined, the in-worker run fn throws, evaluateMath
        // swallows it, and match() yields []. The extension must degrade to
        // "not math" rather than blowing up the search.
        const { provider } = setup({ lib: {} });
        await expect(provider.match('1+1')).resolves.toEqual([]);
    });
});
