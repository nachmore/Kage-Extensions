/**
 * Functional tests for the Dev Tools provider.
 * Covers UUID, base64 encode/decode, epoch conversion, JSON formatting (sync
 * match) and hashing (async match — sha via Web Crypto, plus the bundled MD5).
 * All capabilities are gated by config flags, so each test enables what it needs.
 */

import { describe, it, expect } from 'vitest';
import DevToolsSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

// Enable every tool by default; individual tests can override.
const ALL = { uuid: true, base64: true, hash: true, epoch: true, json_format: true };

function setup(config = ALL) {
    const { context } = makeContext({ config });
    const provider = new DevToolsSearchProvider();
    provider.initialize(context);
    return provider;
}

function row(rows) {
    return rows.length ? rows[0] : null;
}

describe('DevTools — UUID', () => {
    it('generates a v4 UUID for "uuid"/"guid"/"uuid4"', () => {
        const p = setup();
        for (const q of ['uuid', 'guid', 'uuid4']) {
            const r = row(p.match(q));
            expect(r.data.value).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );
        }
    });

    it('is disabled when config.uuid is false', () => {
        expect(setup({ uuid: false }).match('uuid')).toEqual([]);
    });
});

describe('DevTools — base64', () => {
    it('encodes text', () => {
        expect(row(setup().match('base64 hello')).data.value).toBe('aGVsbG8=');
        expect(row(setup().match('b64 hello')).data.value).toBe('aGVsbG8=');
    });

    it('decodes base64', () => {
        expect(row(setup().match('base64d aGVsbG8=')).data.value).toBe('hello');
        expect(row(setup().match('decode aGVsbG8=')).data.value).toBe('hello');
    });

    it('round-trips UTF-8', () => {
        const enc = row(setup().match('base64 café ☕')).data.value;
        expect(row(setup().match('base64d ' + enc)).data.value).toBe('café ☕');
    });
});

describe('DevTools — epoch', () => {
    it('converts a 10-digit (seconds) timestamp', () => {
        const r = row(setup().match('1700000000'));
        expect(r).toBeTruthy();
        expect(r.data.value).toContain('2023'); // 2023-11-14T...
    });

    it('converts a 13-digit (millis) timestamp', () => {
        const r = row(setup().match('1700000000000'));
        expect(r).toBeTruthy();
        expect(r.data.value).toContain('2023');
    });

    it('"now"/"epoch"/"timestamp" yields a ~current unix seconds value', () => {
        const r = row(setup().match('now'));
        const secs = parseInt(r.data.value, 10);
        const nowSecs = Math.floor(Date.now() / 1000);
        expect(Math.abs(nowSecs - secs)).toBeLessThan(5);
    });
});

describe('DevTools — JSON formatting', () => {
    it('pretty-prints compact JSON', () => {
        const r = row(setup().match('{"a":1,"b":2}'));
        expect(r).toBeTruthy();
        expect(r.data.value).toBe('{\n  "a": 1,\n  "b": 2\n}');
    });

    it('ignores invalid JSON', () => {
        expect(setup().match('{not json}')).toEqual([]);
    });
});

describe('DevTools — hashing (async)', () => {
    it('computes SHA-256 (known answer for "abc")', async () => {
        const r = row(await setup().matchAsync('sha256 abc'));
        expect(r.data.value).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        );
    });

    it('computes SHA-1 (known answer for "abc")', async () => {
        const r = row(await setup().matchAsync('sha1 abc'));
        expect(r.data.value).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    });

    it('computes MD5 via the bundled implementation (known answer for "abc")', async () => {
        const r = row(await setup().matchAsync('md5 abc'));
        expect(r.data.value).toBe('900150983cd24fb0d6963f7d28e17f72');
    });

    it('match() defers hashing to matchAsync (returns nothing synchronously)', () => {
        expect(setup().match('sha256 abc')).toEqual([]);
    });
});

describe('DevTools — execute', () => {
    it('copies the computed value', () => {
        const p = setup();
        const r = row(p.match('uuid'));
        expect(p.execute(r)).toEqual({ type: 'copy', value: r.data.value });
    });
});
