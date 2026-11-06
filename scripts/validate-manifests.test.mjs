import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateManifest } from './validate-manifests.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'kage-sensitive-manifests-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
async function validate(metadata, type = 'extension') {
    const id = `fixture-${++seq}`;
    const dir = path.join(root, id);
    mkdirSync(dir);
    const manifest = {
        id, name: 'Fixture', version: '1.0.0', type,
        description: 'Test manifest.', author: 'Contributor', icon: '🔧',
        permissions: [], ...metadata,
    };
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest));
    return validateManifest(file, type, id);
}

describe('sensitive manifest metadata', () => {
    it('accepts optional fields, exact keys, prefix globs, and boolean config flags', async () => {
        expect(await validate({})).toEqual([]);
        expect(await validate({
            sensitiveData: ['creds', 'Token_1', 'private-url.*', `${'a'.repeat(128)}*`],
            config: {
                calendar_url: { type: 'string', default: '', sensitive: true },
                location: { type: 'string', default: '', sensitive: false },
            },
        })).toEqual([]);
        expect(await validate({ sensitiveData: [] }, 'theme')).toEqual([]);
    });

    it.each([null, false, 'token', {}, 1])('rejects a non-array sensitiveData: %j', async (value) => {
        expect(await validate({ sensitiveData: value })).toEqual([
            expect.stringContaining("'sensitiveData' must be an array"),
        ]);
    });

    it.each([
        '', '*', '**', 'token**', '*token', 'to*ken', 'token_*_suffix',
        '../token', 'a..b', 'a/b', 'a\\b', 'my token', 'clé', 'a'.repeat(129),
        `${'a'.repeat(129)}*`, null, 123, {},
        'token.json', 'token.JSON', 'token.json*',
    ])('rejects invalid storage pattern %j', async (value) => {
        expect(await validate({ sensitiveData: [value] })).toEqual([
            expect.stringContaining("entries must be exact keys or nonempty prefixes"),
        ]);
    });

    it('accepts 32 declarations and rejects 33', async () => {
        const entries = Array.from({ length: 33 }, (_, i) => `token_${i}`);
        expect(await validate({ sensitiveData: entries.slice(0, 32) })).toEqual([]);
        expect(await validate({ sensitiveData: entries })).toEqual([
            expect.stringContaining('at most 32 entries'),
        ]);
    });

    it.each(['true', 1, null, {}, []])('rejects a non-boolean config sensitive flag %j', async (value) => {
        expect(await validate({ config: { api_key: { type: 'string', sensitive: value } } })).toEqual([
            expect.stringContaining('config.api_key.sensitive must be a boolean'),
        ]);
    });

    it.each([null, [], 'config'])('rejects malformed config %j', async (config) => {
        expect(await validate({ config })).toEqual([
            expect.stringContaining("'config' must be an object"),
        ]);
    });

    it.each([null, [], true, 'password'])('rejects malformed config field %j', async (definition) => {
        expect(await validate({ config: { value: definition } })).toEqual([
            expect.stringContaining('config.value must be an object'),
        ]);
    });

    it('rejects sensitive at top level rather than on a config field', async () => {
        expect(await validate({ sensitive: true })).toEqual([
            expect.stringContaining("unknown top-level field 'sensitive'"),
        ]);
    });

    it.each([
        ['token', 'token'],
        ['token*', 'token_one'],
        ['token*', 'token_*'],
        ['token_one', 'token*'],
    ])('rejects duplicate/overlapping entries %j and %j', async (a, b) => {
        const issues = await validate({ sensitiveData: [a, b] });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain(a);
        expect(issues[0]).toContain(b);
    });

    it.each([
        { contributes: { sensitive: true } },
        { config: { api_key: { sensitve: true } } },
        { config: { api_key: { sensative: true } } },
        { config: { sensitive: true } },
        { contributes: { sensitiveData: ['token'] } },
    ])('rejects misplaced/misspelled metadata %j', async (metadata) => {
        expect((await validate(metadata)).some((issue) => /misplaced or misspelled/.test(issue))).toBe(true);
    });

    it('names the offending entry and reports its real line', async () => {
        const dir = path.join(root, `fixture-${++seq}`);
        mkdirSync(dir);
        const manifest = {
            id: path.basename(dir), name: 'Fixture', version: '1.0.0', type: 'extension',
            description: 'Test', author: 'Contributor', icon: '🔧', permissions: [],
            sensitiveData: ['token', 'bad/key'],
            config: { api_key: { type: 'string', sensitive: 'true' } },
        };
        const source = JSON.stringify(manifest, null, 2);
        const file = path.join(dir, 'manifest.json');
        writeFileSync(file, source);
        const issues = await validateManifest(file, 'extension', manifest.id);
        const badLine = source.split('\n').findIndex((line) => line.includes('bad/key')) + 1;
        const sensitiveLine = source.split('\n').findIndex((line) => line.includes('"sensitive"')) + 1;
        expect(issues).toHaveLength(2);
        expect(issues[0]).toContain(`manifest.json:${badLine}:`);
        expect(issues[0]).toContain('"bad/key"');
        expect(issues[1]).toContain(`manifest.json:${sensitiveLine}:`);
    });
});
