/**
 * Functional tests for the Dictionary provider.
 *
 * We focus on the synchronous surface: word extraction from the trigger, the
 * lookup-candidate filter (which keeps the agent from being spammed with
 * dictionary lookups for math/urls/paths), and the cache-driven match() paths.
 * matchAsync() depends on a host-only dynamic import for language detection
 * plus live HTTP, so it's left to manual QA — match()/_isLookupCandidate is
 * where the regressions an author cares about actually live.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DictionarySearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new DictionarySearchProvider();
    provider.initialize(context);
    return provider;
}

describe('DictionarySearchProvider — word extraction', () => {
    it('extracts the word after the default "dict" trigger', () => {
        const p = setup();
        expect(p._extractWord('dict serendipity')).toBe('serendipity');
    });

    it('returns null when the trigger prefix is absent', () => {
        const p = setup();
        expect(p._extractWord('serendipity')).toBeNull();
    });

    it('treats the whole query as the word when trigger is blank', () => {
        const p = setup({ trigger: '' });
        expect(p._extractWord('serendipity')).toBe('serendipity');
    });

    it('honours a custom trigger', () => {
        const p = setup({ trigger: 'def' });
        expect(p._extractWord('def cat')).toBe('cat');
        expect(p._extractWord('dict cat')).toBeNull();
    });
});

describe('DictionarySearchProvider — lookup candidate filter', () => {
    let p;
    beforeEach(() => {
        p = setup({ trigger: '' }); // treat input as the bare word
    });

    it('accepts ordinary words', () => {
        expect(p._isLookupCandidate('cat')).toBe(true);
        expect(p._isLookupCandidate('two words')).toBe(true);
    });

    it('rejects too-short input', () => {
        expect(p._isLookupCandidate('a')).toBe(false);
    });

    it('rejects math-ish / symbol-laden input', () => {
        expect(p._isLookupCandidate('1+1')).toBe(false);
        expect(p._isLookupCandidate('a@b')).toBe(false);
    });

    it('rejects urls and file paths', () => {
        expect(p._isLookupCandidate('https://x.com')).toBe(false);
        expect(p._isLookupCandidate('readme.md')).toBe(false);
    });

    it('rejects pure numbers and >2-word phrases', () => {
        expect(p._isLookupCandidate('1234')).toBe(false);
        expect(p._isLookupCandidate('one two three')).toBe(false);
    });
});

describe('DictionarySearchProvider — match() cache paths', () => {
    it('returns [] for a non-trigger query', () => {
        expect(setup().match('hello')).toEqual([]);
    });

    it('returns [] for an uncached word (matchAsync will fetch)', () => {
        expect(setup().match('dict serendipity')).toEqual([]);
    });

    it('surfaces a cached not-found as a not-found row', () => {
        const p = setup({ language: 'en' });
        p._cache.set('en:zzzzz', 'not_found');
        const rows = p.match('dict zzzzz');
        expect(rows).toHaveLength(1);
        expect(rows[0].data.type).toBe('not_found');
    });

    it('formats a cached definition hit', () => {
        const p = setup({ language: 'en' });
        // Minimal shape _formatResults expects: entries[].
        p._cache.set('en:cat', {
            word: 'cat',
            entries: [
                {
                    partOfSpeech: 'noun',
                    senses: [{ definition: 'a small domesticated feline' }],
                },
            ],
        });
        const rows = p.match('dict cat');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].type).toBe('dictionary');
    });
});

describe('DictionarySearchProvider — execute', () => {
    it('suggestion rows replace the input to re-trigger a lookup', () => {
        const p = setup();
        const out = p.execute({ data: { type: 'suggestion', word: 'definitely' } });
        expect(out).toEqual({ type: 'replace_input', value: 'dict definitely' });
    });

    it('loading/error/not-found rows produce no action', () => {
        const p = setup();
        expect(p.execute({ data: { type: 'loading' } })).toBeNull();
        expect(p.execute({ data: { type: 'error' } })).toBeNull();
        expect(p.execute({ data: { type: 'not_found' } })).toBeNull();
    });
});

describe('DictionarySearchProvider — getKeywords', () => {
    it('registers the trigger keyword', () => {
        const kws = setup().getKeywords();
        expect(kws.map((k) => k.keyword)).toEqual(['dict']);
        expect(kws[0].labelKey).toMatch(/^keyword\./);
        expect(kws[0].label).toBeUndefined();
    });

    it('tracks a custom trigger', () => {
        expect(setup({ trigger: 'def' }).getKeywords().map((k) => k.keyword)).toEqual(['def']);
    });

    it('registers NO keywords when the trigger is cleared (content matcher)', () => {
        // Empty trigger → dictionary looks up any bare word, so it must receive
        // every keystroke; the host treats an empty keyword list as "always call".
        expect(setup({ trigger: '' }).getKeywords()).toEqual([]);
    });
});
