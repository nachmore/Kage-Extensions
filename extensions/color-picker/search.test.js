/**
 * Functional tests for the Color Picker search provider.
 * Pure compute — no host I/O — so these directly exercise parseColor across
 * hex/rgb/hsl/named forms plus the copy-format config.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import ColorPickerSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new ColorPickerSearchProvider();
    provider.initialize(context);
    return provider;
}

function row(provider, query) {
    const rows = provider.match(query);
    return rows.length ? rows[0] : null;
}

describe('ColorPickerSearchProvider — parsing', () => {
    let provider;
    beforeEach(() => {
        provider = setup();
    });

    it('parses 6-digit hex', () => {
        const r = row(provider, '#ff8800');
        expect(r).toBeTruthy();
        expect(r.type).toBe('color');
        expect(r.label).toBe('#FF8800');
        expect(r.data).toMatchObject({ r: 255, g: 136, b: 0, source: 'hex' });
    });

    it('expands 3-digit hex shorthand', () => {
        expect(row(provider, '#f80').data).toMatchObject({ r: 255, g: 136, b: 0 });
    });

    it('parses rgb()', () => {
        const r = row(provider, 'rgb(255, 136, 0)');
        expect(r.data).toMatchObject({ r: 255, g: 136, b: 0, source: 'rgb' });
        expect(r.label).toBe('#FF8800');
    });

    it('rejects rgb() with an out-of-range channel', () => {
        expect(provider.match('rgb(300, 0, 0)')).toEqual([]);
    });

    it('parses hsl() and converts to rgb', () => {
        // hsl(0,100,50) is pure red.
        const r = row(provider, 'hsl(0, 100%, 50%)');
        expect(r.data).toMatchObject({ r: 255, g: 0, b: 0, source: 'hsl' });
    });

    it('parses named colors', () => {
        expect(row(provider, 'red').data).toMatchObject({ r: 255, g: 0, b: 0, source: 'name' });
        expect(row(provider, 'teal').data).toMatchObject({ r: 0, g: 128, b: 128 });
    });

    it('is case-insensitive and trims', () => {
        expect(row(provider, '  RED  ').data).toMatchObject({ r: 255, g: 0, b: 0 });
        expect(row(provider, '#FF8800').label).toBe('#FF8800');
    });

    it('returns no match for non-colors', () => {
        for (const q of ['', 'hello', '#gggggg', 'rgb()', 'notacolor']) {
            expect(provider.match(q)).toEqual([]);
        }
    });
});

describe('ColorPickerSearchProvider — execute (copy format)', () => {
    it('copies all three formats by default', () => {
        const provider = setup();
        const r = row(provider, '#ff0000');
        const out = provider.execute(r);
        expect(out.type).toBe('copy');
        expect(out.value).toContain('#FF0000');
        expect(out.value).toContain('rgb(255, 0, 0)');
        expect(out.value).toContain('hsl(0, 100%, 50%)');
    });

    it('copies only hex when configured', () => {
        const provider = setup({ copy_format: 'hex' });
        expect(provider.execute(row(provider, '#ff0000'))).toEqual({
            type: 'copy',
            value: '#FF0000',
        });
    });

    it('copies only rgb when configured', () => {
        const provider = setup({ copy_format: 'rgb' });
        expect(provider.execute(row(provider, '#ff0000'))).toEqual({
            type: 'copy',
            value: 'rgb(255, 0, 0)',
        });
    });

    it('copies only hsl when configured', () => {
        const provider = setup({ copy_format: 'hsl' });
        expect(provider.execute(row(provider, '#ff0000'))).toEqual({
            type: 'copy',
            value: 'hsl(0, 100%, 50%)',
        });
    });
});
