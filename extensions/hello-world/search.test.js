/**
 * Functional tests for the Hello World sample provider.
 * Doubles as the canonical "how to test an extension" reference.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import HelloWorldSearchProvider from './search.js';
import HelloWorldSettingsProvider from './settings.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const MANIFEST = readJson('./manifest.json');
const JA_CATALOG = readJson('./_locales/ja/messages.json');

/** The config the host hands a never-saved extension: the manifest defaults. */
const manifestDefaults = () =>
    Object.fromEntries(Object.entries(MANIFEST.config).map(([k, v]) => [k, v.default]));

const EN_CATALOG = {
    'settings.greeting.default': { message: 'Hello World' },
    'result.description': { message: 'Press Enter to copy' },
};

function setup(config = {}, catalog = EN_CATALOG) {
    const { context } = makeContext({ config, catalog });
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

    // The manifest used to default the greeting to the literal "Hello World",
    // which the host hands to a never-saved extension, so a Japanese user got
    // English while Settings showed the Japanese default.
    it('never-saved settings (manifest defaults) use the localised greeting', () => {
        const ja = JA_CATALOG['settings.greeting.default'].message;
        expect(setup(manifestDefaults(), JA_CATALOG).match('hello')[0].label).toBe(ja);
        expect(setup(manifestDefaults()).match('hello')[0].label).toBe('Hello World');
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

describe('HelloWorldSettingsProvider — defaults', () => {
    function greetingControl(catalog) {
        const { context } = makeContext({ catalog });
        const settings = new HelloWorldSettingsProvider();
        settings.initialize(context);
        const controls = settings.getSettings().sections.flatMap((s) => s.controls);
        return controls.find((c) => c.id === 'greeting');
    }

    it('defaults the greeting to the manifest value and shows the localised one as a placeholder', () => {
        const ctrl = greetingControl(JA_CATALOG);
        expect(ctrl.default).toBe(MANIFEST.config.greeting.default);
        expect(ctrl.placeholder).toBe(JA_CATALOG['settings.greeting.default'].message);
    });
});
