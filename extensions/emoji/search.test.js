/**
 * Functional tests for the Emoji provider — pure search over the embedded
 * dataset. Asserts the trigger forms and result shape; uses stable, common
 * shortcodes so the dataset can grow without breaking these.
 */

import { describe, it, expect } from 'vitest';
import EmojiSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new EmojiSearchProvider();
    provider.initialize(context);
    return provider;
}

const shortcodes = (rows) => rows.map((r) => r.data.shortcode);

describe('EmojiSearchProvider — trigger-word form', () => {
    it('returns a hint for the bare trigger', () => {
        const rows = setup().match('emoji');
        expect(rows).toHaveLength(1);
        expect(rows[0].data.hint).toBe(true);
    });

    it('searches with "emoji <q>"', () => {
        const rows = setup().match('emoji fire');
        expect(rows.length).toBeGreaterThan(0);
        expect(shortcodes(rows)).toContain('fire');
    });

    it('supports the short "e <q>" alias', () => {
        const rows = setup().match('e rocket');
        expect(shortcodes(rows)).toContain('rocket');
    });

    it('caps trigger-word results at 8', () => {
        const rows = setup().match('emoji a'); // broad query
        expect(rows.length).toBeLessThanOrEqual(8);
    });

    it('honours a custom trigger', () => {
        const rows = setup({ trigger: 'emo' }).match('emo fire');
        expect(shortcodes(rows)).toContain('fire');
    });
});

describe('EmojiSearchProvider — shortcode form', () => {
    it('matches ":fire" and ":fire:"', () => {
        expect(shortcodes(setup().match(':fire'))).toContain('fire');
        expect(shortcodes(setup().match(':fire:'))).toContain('fire');
    });

    it('matches multi-char names like ":heart:"', () => {
        expect(shortcodes(setup().match(':heart:'))).toContain('heart');
    });

    it('can be disabled via config', () => {
        expect(setup({ shortcode_trigger: false }).match(':fire:')).toEqual([]);
    });

    it('ignores too-short shortcode fragments', () => {
        expect(setup().match(':a')).toEqual([]);
    });
});

describe('EmojiSearchProvider — non-matches & execute', () => {
    it('returns nothing for unrelated input', () => {
        expect(setup().match('hello there')).toEqual([]);
    });

    it('copies the emoji glyph on execute', () => {
        const provider = setup();
        const row = provider.match(':fire:')[0];
        const out = provider.execute(row);
        expect(out.type).toBe('copy');
        expect(out.value).toBe(row.data.emoji);
        expect(out.value.length).toBeGreaterThan(0);
    });

    it('hint row executes as a custom action', () => {
        const provider = setup();
        const hint = provider.match('emoji')[0];
        expect(provider.execute(hint)).toEqual({ type: 'custom', data: { hint: true } });
    });
});
