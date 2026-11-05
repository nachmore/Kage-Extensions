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
import { readFileSync } from 'node:fs';
import * as mathjs from 'mathjs';
import MathSearchProvider from './search.js';
import MathSettingsProvider from './settings.js';
import { DEFAULTS } from './defaults.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const MANIFEST = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

/**
 * The config the host hands a never-saved extension: every manifest `config`
 * default, as built by Kage's ExtensionManager._getExtensionConfig.
 */
function manifestDefaults() {
    const out = {};
    for (const [key, spec] of Object.entries(MANIFEST.config)) out[key] = spec.default;
    return out;
}

const CATALOG = {
    'result.copy_hint': { message: 'Press Enter to copy result' },
    'result.insert_hint': { message: 'Press Enter to put the result in the input bar' },
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
        // Default precision is at most 2 decimal places (see defaults.js);
        // trailing zeros are dropped.
        const row = await evalQuery(provider, '1+1');
        expect(row).toBeTruthy();
        expect(row.type).toBe('math');
        expect(row.label).toBe('= 2');
        expect(row.data.value).toBe('2');
    });

    it('evaluates division to the default 2dp precision', async () => {
        const row = await evalQuery(provider, '3/4');
        expect(row).toBeTruthy();
        expect(row.data.value).toBe('0.75');
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
    // Regression: Settings showed precision 2 for a never-saved Math extension
    // while the runtime used the manifest default of 0, so 29/34 showed "= 1".
    it('an unset precision shows 2 decimal places (29/34 → 0.85)', async () => {
        const { provider } = setup({ config: {} });
        const row = await evalQuery(provider, '29/34');
        expect(row.label).toBe('= 0.85');
        expect(row.data.value).toBe('0.85');
    });

    it('never-saved settings (manifest defaults, as the host passes them) → 0.85', async () => {
        const { provider } = setup({ config: manifestDefaults() });
        expect((await evalQuery(provider, '29/34')).data.value).toBe('0.85');
    });

    it('honours an explicit decimal precision', async () => {
        const { provider } = setup({ config: { precision: 3 } });
        expect((await evalQuery(provider, '29/34')).data.value).toBe('0.853');
    });

    it('precision 0 rounds to an integer', async () => {
        const { provider } = setup({ config: { precision: 0 } });
        expect((await evalQuery(provider, '29/34')).data.value).toBe('1');
        expect((await evalQuery(provider, '7/2')).data.value).toBe('4');
    });

    it('a negative result that rounds to zero shows no minus sign', async () => {
        const { provider } = setup();
        const row = await evalQuery(provider, '-1/1000');
        expect(row.label).toBe('= 0');
        expect(row.data.value).toBe('0');
        expect(provider.execute(row)).toEqual({ type: 'copy', value: '0' });
        // Still signed when it doesn't round to zero.
        expect((await evalQuery(provider, '-1/100')).data.value).toBe('-0.01');
        expect((await evalQuery(provider, '-1/3')).data.value).toBe('-0.33');
    });

    it('precision 0: a negative fraction that rounds to zero shows "0"', async () => {
        const { provider } = setup({ config: { precision: 0 } });
        expect((await evalQuery(provider, '-1/3')).data.value).toBe('0');
        expect((await evalQuery(provider, '-2/3')).data.value).toBe('-1');
    });

    it('precision -1 (auto) uses full significant-figure output', async () => {
        const { provider } = setup({ config: { precision: -1 } });
        expect((await evalQuery(provider, '29/34')).data.value).toBe('0.852941176470588');
        expect((await evalQuery(provider, '3/4')).data.value).toBe('0.75');
    });
});

describe('Math defaults — Settings, manifest, and runtime agree', () => {
    function controlDefaults() {
        const { context } = makeContext();
        const settings = new MathSettingsProvider();
        settings.initialize(context);
        const out = {};
        for (const section of settings.getSettings().sections) {
            for (const ctrl of section.controls) out[ctrl.id] = ctrl.default;
        }
        return out;
    }

    it('every settings control default equals defaults.js', () => {
        expect(controlDefaults()).toEqual({ ...DEFAULTS });
    });

    it('every settings control default equals the manifest config default', () => {
        const manifest = manifestDefaults();
        for (const [id, value] of Object.entries(controlDefaults())) {
            expect(manifest[id], id).toBe(value);
        }
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

    it('is off by default', async () => {
        const { provider } = setup({ config: {} });
        expect((await evalQuery(provider, '1000*1000')).data.value).toBe('1000000');
    });

    it('groups only the integer part at the default precision', async () => {
        const { provider } = setup({ config: { thousands_separator: true } });
        expect((await evalQuery(provider, '1000*1000')).data.value).toBe('1,000,000');
        expect((await evalQuery(provider, '1234567/8')).data.value).toBe('154,320.88');
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

describe('MathSearchProvider — auto_copy', () => {
    it('is on by default: Enter copies, and the row says so', async () => {
        const { provider } = setup({ config: {} });
        const row = await evalQuery(provider, '2+2');
        expect(row.description).toBe('Press Enter to copy result');
        expect(provider.execute(row)).toEqual({ type: 'copy', value: '4' });
    });

    it('never-saved settings (manifest defaults) copy on Enter', async () => {
        const { provider } = setup({ config: manifestDefaults() });
        const row = await evalQuery(provider, '29/34');
        expect(provider.execute(row)).toEqual({ type: 'copy', value: '0.85' });
    });

    it('on: copies the answer as shown, thousands separators included', async () => {
        const { provider } = setup({ config: { auto_copy: true, thousands_separator: true } });
        const row = await evalQuery(provider, '1000*1000');
        expect(provider.execute(row)).toEqual({ type: 'copy', value: '1,000,000' });
    });

    it('off: Enter puts the answer in the input instead of copying it', async () => {
        const { provider } = setup({ config: { auto_copy: false } });
        const row = await evalQuery(provider, '29/34');
        expect(row.description).toBe('Press Enter to put the result in the input bar');
        expect(provider.execute(row)).toEqual({ type: 'replace_input', value: '0.85' });
    });

    it('off: the answer goes back without thousands separators, so it still evaluates', async () => {
        const { provider } = setup({ config: { auto_copy: false, thousands_separator: true, precision: 0 } });
        const row = await evalQuery(provider, '1000*1000');
        expect(row.label).toBe('= 1,000,000');
        const action = provider.execute(row);
        expect(action).toEqual({ type: 'replace_input', value: '1000000' });
        // Typing on from the answer keeps calculating.
        expect((await evalQuery(provider, action.value + '*2')).data.value).toBe('2,000,000');
    });

    it('off: a unit result goes back with its unit', async () => {
        const { provider } = setup({ config: { auto_copy: false } });
        const row = await evalQuery(provider, '5 km to miles');
        const action = provider.execute(row);
        expect(action.type).toBe('replace_input');
        expect(action.value).toBe(row.data.value);
        expect(action.value).toMatch(/^3\.1\d* mile/i);
    });

    it('follows a settings change without re-initializing', async () => {
        const { provider } = setup({ config: {} });
        const row = await evalQuery(provider, '2+2');
        provider.onConfigUpdate({ auto_copy: false });
        expect(provider.execute(row)).toEqual({ type: 'replace_input', value: '4' });
        provider.onConfigUpdate({ auto_copy: true });
        expect(provider.execute(row)).toEqual({ type: 'copy', value: '4' });
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

describe('MathSearchProvider — trailing zeros', () => {
    it('shows at most `precision` decimals without padding zeros', async () => {
        const { provider } = setup({ config: {} });
        expect((await evalQuery(provider, '1/2')).label).toBe('= 0.5');
        expect((await evalQuery(provider, '29/34')).label).toBe('= 0.85');
        expect((await evalQuery(provider, '1+1')).label).toBe('= 2');
        expect((await evalQuery(provider, '10/4')).label).toBe('= 2.5');
    });
});
