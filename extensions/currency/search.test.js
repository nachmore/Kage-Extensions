/**
 * Functional tests for the Currency converter.
 * match() is pure parsing (returns a "looking up" placeholder); matchAsync()
 * does the conversion against a rate it fetches. We stub global.fetch and the
 * disk-cache invoke so no network is hit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import CurrencySearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = {}, invokes = {} } = {}) {
    // Default disk cache is empty; tests can override via invokes.
    const baseInvokes = {
        load_extension_data: null,
        save_extension_data: undefined,
        ...invokes,
    };
    const { context, log } = makeContext({ config, invokes: baseInvokes });
    const provider = new CurrencySearchProvider();
    provider.initialize(context);
    return { provider, log };
}

/** Stub fetch to return a fixed rates table for the requested base. */
function stubRates(table) {
    global.fetch = vi.fn(async (url) => {
        const base = new URL(url).searchParams.get('base');
        return {
            ok: true,
            json: async () => ({ base, rates: table }),
        };
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
});

describe('CurrencySearchProvider — match (parse + placeholder)', () => {
    it('parses "<amount> <ccy> to <ccy>" and returns a placeholder row', () => {
        const { provider } = setup();
        const rows = provider.match('100 USD to EUR');
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('currency');
        expect(rows[0].data).toMatchObject({ from: 'USD', to: 'EUR', amount: 100 });
    });

    it('defaults the target to config.default_target when omitted', () => {
        const { provider } = setup({ config: { default_target: 'GBP' } });
        expect(provider.match('50 USD')[0].data.to).toBe('GBP');
    });

    it('uses EUR as the target when nothing is configured', () => {
        const { provider } = setup();
        expect(provider.match('50 USD')[0].data.to).toBe('EUR');
    });

    it('handles thousands separators in the amount', () => {
        const { provider } = setup();
        expect(provider.match('1,000 USD to EUR')[0].data.amount).toBe(1000);
    });

    it('returns a same-currency row without a lookup', () => {
        const { provider } = setup();
        const row = provider.match('100 USD to USD')[0];
        expect(row.data.value).toBe(100);
    });

    it('rejects unknown currency codes', () => {
        const { provider } = setup();
        expect(provider.match('100 XYZ to EUR')).toEqual([]);
        expect(provider.match('100 USD to ZZZ')).toEqual([]);
    });

    it('rejects non-currency input', () => {
        const { provider } = setup();
        expect(provider.match('hello world')).toEqual([]);
        expect(provider.match('100')).toEqual([]);
    });
});

describe('CurrencySearchProvider — matchAsync (conversion)', () => {
    it('converts using the fetched rate', async () => {
        stubRates({ EUR: 0.9 });
        const { provider } = setup();
        const rows = await provider.matchAsync('100 USD to EUR');
        expect(rows).toHaveLength(1);
        // 100 * 0.9 = 90
        expect(rows[0].data.value).toBeCloseTo(90, 5);
        expect(rows[0].label).toContain('EUR');
    });

    it('returns [] for same-currency (nothing to convert)', async () => {
        const { provider } = setup();
        expect(await provider.matchAsync('100 USD to USD')).toEqual([]);
    });

    it('logs and returns [] when the rate lookup fails', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
        const { provider, log } = setup();
        const rows = await provider.matchAsync('100 USD to EUR');
        expect(rows).toEqual([]);
        expect(log.warn).toHaveBeenCalled();
    });

    it('reuses a fresh disk-cached rate without fetching', async () => {
        const cached = JSON.stringify({
            ts: Date.now(),
            from: 'USD',
            rates: { EUR: 0.8 },
        });
        global.fetch = vi.fn(); // should NOT be called
        const { provider } = setup({ invokes: { load_extension_data: cached } });
        const rows = await provider.matchAsync('10 USD to EUR');
        expect(rows[0].data.value).toBeCloseTo(8, 5);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('CurrencySearchProvider — execute', () => {
    it('copies the displayed label', () => {
        const { provider } = setup();
        const row = provider.match('100 USD to EUR')[0];
        expect(provider.execute(row)).toEqual({ type: 'copy', value: row.data.label });
    });
});
