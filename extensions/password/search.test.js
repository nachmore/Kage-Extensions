/**
 * Functional tests for the Password generator provider.
 * Pure compute (Web Crypto is available in Node). We assert structural
 * properties — length, charset, passphrase shape — rather than exact output,
 * since results are random by design.
 */

import { describe, it, expect } from 'vitest';
import PasswordSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new PasswordSearchProvider();
    provider.initialize(context);
    return provider;
}

/** First row is the generated password; second (if present) is the regen row. */
function gen(provider, query) {
    return provider.match(query);
}

describe('PasswordSearchProvider — trigger', () => {
    it('ignores input that is not the trigger', () => {
        const provider = setup();
        expect(provider.match('hello')).toEqual([]);
        expect(provider.match('password')).toEqual([]); // not the "pw" trigger
    });

    it('honours a custom trigger', () => {
        const provider = setup({ trigger: 'pass' });
        expect(provider.match('pw')).toEqual([]);
        expect(gen(provider, 'pass').length).toBeGreaterThan(0);
    });
});

describe('PasswordSearchProvider — numeric passwords', () => {
    it('generates a default-length password and a regen row', () => {
        const provider = setup({ default_length: 20 });
        const rows = gen(provider, 'pw');
        expect(rows).toHaveLength(2);
        expect(rows[0].type).toBe('password');
        expect(rows[0].data.value).toHaveLength(20);
        expect(rows[1].data.regen).toBe(true);
    });

    it('respects an explicit length', () => {
        const provider = setup();
        expect(gen(provider, 'pw 32')[0].data.value).toHaveLength(32);
    });

    it('clamps length to the 4..128 range', () => {
        const provider = setup();
        expect(gen(provider, 'pw 1')[0].data.value).toHaveLength(4);
        expect(gen(provider, 'pw 9999')[0].data.value).toHaveLength(128);
    });

    it('only uses digits when other charsets are disabled', () => {
        const provider = setup({
            include_lowercase: false,
            include_uppercase: false,
            include_symbols: false,
            include_numbers: true,
        });
        const pw = gen(provider, 'pw 40')[0].data.value;
        expect(pw).toMatch(/^\d+$/);
    });

    it('excludes ambiguous characters by default', () => {
        const provider = setup();
        const pw = gen(provider, 'pw 128')[0].data.value;
        // Default excludes Il1O0|`'" — none should appear.
        expect(pw).not.toMatch(/[Il1O0|`'"]/);
    });
});

describe('PasswordSearchProvider — passphrases', () => {
    it('generates a 4-word passphrase by default', () => {
        const provider = setup();
        const row = gen(provider, 'pw word')[0];
        expect(row.label.split('-')).toHaveLength(4);
    });

    it('respects an explicit word count, clamped to 2..12', () => {
        const provider = setup();
        expect(gen(provider, 'pw word 6')[0].label.split('-')).toHaveLength(6);
        expect(gen(provider, 'pw word 1')[0].label.split('-')).toHaveLength(2);
        expect(gen(provider, 'pw word 99')[0].label.split('-')).toHaveLength(12);
    });
});

describe('PasswordSearchProvider — execute', () => {
    it('copies the password value', () => {
        const provider = setup();
        const row = gen(provider, 'pw 16')[0];
        expect(provider.execute(row)).toEqual({ type: 'copy', value: row.data.value });
    });

    it('regen row replaces the input to re-trigger a fresh roll', () => {
        const provider = setup();
        const regen = gen(provider, 'pw 24')[1];
        const out = provider.execute(regen);
        expect(out.type).toBe('replace_input');
        expect(out.value).toContain('pw');
    });
});
