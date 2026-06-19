/**
 * Functional tests for the Hello World sample provider.
 * Doubles as the canonical "how to test an extension" reference.
 */

import { describe, it, expect } from 'vitest';
import HelloWorldSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup(config = {}) {
    const { context } = makeContext({
        config,
        catalog: {
            'settings.greeting.default': { message: 'Hello World' },
            'result.description': { message: 'Press Enter to copy' },
        },
    });
    const provider = new HelloWorldSearchProvider();
    provider.initialize(context);
    return provider;
}

describe('HelloWorldSearchProvider', () => {
    it('responds to "test" and "hello"', () => {
        expect(setup().match('test')).toHaveLength(1);
        expect(setup().match('hello')).toHaveLength(1);
    });

    it('ignores unrelated input', () => {
        expect(setup().match('goodbye')).toEqual([]);
    });

    it('falls back to the localised default greeting', () => {
        expect(setup().match('hello')[0].label).toBe('Hello World');
    });

    it('uses a configured greeting override', () => {
        expect(setup({ greeting: 'Hej' }).match('hello')[0].label).toBe('Hej');
    });

    it('appends a timestamp when show_timestamp is enabled', () => {
        const label = setup({ greeting: 'Hi', show_timestamp: true }).match('hello')[0].label;
        expect(label).toMatch(/^Hi \(.+\)$/);
    });

    it('copies the displayed value on execute', () => {
        const provider = setup({ greeting: 'Hi' });
        const row = provider.match('hello')[0];
        expect(provider.execute(row)).toEqual({ type: 'copy', value: 'Hi' });
    });
});

describe('HelloWorldSearchProvider — getKeywords', () => {
    it('registers both test and hello as keywords', () => {
        const kws = setup().getKeywords();
        expect(kws.map((k) => k.keyword)).toEqual(['test', 'hello']);
    });

    it('test accepts args; hello is exact', () => {
        const byKw = Object.fromEntries(setup().getKeywords().map((k) => [k.keyword, k]));
        expect(byKw['test'].acceptsArgs).toBe(true);
        expect(byKw['hello'].acceptsArgs).toBe(false);
    });

    it('returns i18n KEYS for labels', () => {
        for (const k of setup().getKeywords()) {
            expect(k.labelKey).toMatch(/^keyword\./);
            expect(k.label).toBeUndefined();
        }
    });
});
