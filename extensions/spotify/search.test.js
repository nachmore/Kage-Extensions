/**
 * Functional tests for the Spotify provider.
 *
 * The OAuth flow and Web API calls are genuinely network/IPC glue and stay in
 * manual QA. But match() is a pure verb-dispatch parser — the part a refactor
 * most easily breaks — so we test that directly with just config + i18n.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import SpotifySearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new SpotifySearchProvider();
    provider.initialize(context);
    return provider;
}

const ids = (rows) => rows.map((r) => r.data.id);

describe('SpotifySearchProvider — trigger gating', () => {
    it('ignores input without the trigger', () => {
        expect(setup().match('hello')).toEqual([]);
        expect(setup().match('')).toEqual([]);
    });

    it('ignores words that merely begin with the trigger', () => {
        // "spotify" starts with the default "sp" trigger but is not a
        // whole-word match — it must not strip to "otify" and surface a
        // bogus play row. See the word-boundary gate in match().
        expect(setup().match('spotify')).toEqual([]);
        expect(setup().match('special')).toEqual([]);
    });

    it('honours a custom trigger', () => {
        const p = setup({ trigger: 'spot' });
        expect(p.match('sp now')).toEqual([]);
        expect(ids(p.match('spot'))).toContain('now');
        // "spotify" begins with "spot" but is still not a whole word.
        expect(p.match('spotify')).toEqual([]);
    });
});

describe('SpotifySearchProvider — getKeywords', () => {
    it('registers the default trigger as a keyword', () => {
        const [kw] = setup().getKeywords();
        expect(kw.keyword).toBe('sp');
        expect(kw.acceptsArgs).toBe(true);
        expect(kw.labelKey).toMatch(/^keyword\./);
        // i18n keys only — no raw text the author could forget to localise.
        expect(kw.label).toBeUndefined();
    });

    it('reflects a user-configured trigger (config-aware)', () => {
        const [kw] = setup({ trigger: 'spot' }).getKeywords();
        expect(kw.keyword).toBe('spot');
    });
});

describe('SpotifySearchProvider — verb dispatch', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('bare trigger shows now-playing + help', () => {
        expect(ids(p.match('sp'))).toEqual(['now', 'help']);
    });

    it('play with a query vs. bare play (resume)', () => {
        expect(ids(p.match('sp play daft punk'))).toEqual(['play:daft punk']);
        expect(ids(p.match('sp play'))).toEqual(['play']);
    });

    it('pause / next / prev', () => {
        expect(ids(p.match('sp pause'))).toEqual(['pause']);
        expect(ids(p.match('sp next'))).toEqual(['next']);
        expect(ids(p.match('sp prev'))).toEqual(['prev']);
        expect(ids(p.match('sp previous'))).toEqual(['prev']);
    });

    it('queue requires an argument', () => {
        expect(ids(p.match('sp queue some song'))).toEqual(['queue:some song']);
        expect(p.match('sp queue')).toEqual([]);
    });

    it('like / unlike', () => {
        expect(ids(p.match('sp like'))).toEqual(['like']);
        expect(ids(p.match('sp unlike'))).toEqual(['unlike']);
    });

    it('volume accepts 0..100 and rejects out-of-range / non-numeric', () => {
        expect(ids(p.match('sp vol 50'))).toEqual(['vol:50']);
        expect(ids(p.match('sp volume 0'))).toEqual(['vol:0']);
        expect(ids(p.match('sp vol 100'))).toEqual(['vol:100']);
        expect(p.match('sp vol 150')).toEqual([]);
        expect(p.match('sp vol loud')).toEqual([]);
    });
});
