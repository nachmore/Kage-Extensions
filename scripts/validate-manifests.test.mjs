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

describe('settings-only backup declarations', () => {
    it('accepts typed primitive enums and harmless plain strings', async () => {
        expect(await validate({
            config: {
                mode: { type: 'string', enum: ['metric', 'imperial'] },
                count: { type: 'number', enum: [0, 1, 1.5] },
                badge: { type: 'boolean', enum: [true, false] },
                trigger: { type: 'string', default: 'go', backup: 'plain' },
                category: { type: 'string', sensitive: false, backup: 'plain' },
                pinned: { type: 'string', backup: 'plain' },
                compass: { type: 'string', backup: 'plain' },
            },
        })).toEqual([]);
    });

    it.each([null, 'metric', {}, [], Array.from({ length: 65 }, (_, i) => `${i}`)])(
        'rejects malformed or oversized enum %j', async (value) => {
            expect(await validate({ config: { units: { type: 'string', enum: value } } })).toEqual([
                expect.stringContaining('enum must be a nonempty array of at most 64 primitives'),
            ]);
        });

    it.each([
        ['string', ['metric', 1]],
        ['string', [null]],
        ['string', [{}]],
        ['string', [[]]],
        ['number', [true]],
        ['number', ['1']],
        ['boolean', [0]],
        ['boolean', ['true']],
    ])('rejects enum values that do not match %s: %j', async (type, values) => {
        expect(await validate({ config: { value: { type, enum: values } } })).toEqual([
            expect.stringContaining(`must be a ${type} primitive`),
        ]);
    });

    it('rejects numeric enum overflow parsed from otherwise valid JSON', async () => {
        const id = `fixture-${++seq}`;
        const dir = path.join(root, id);
        mkdirSync(dir);
        const manifest = {
            id, name: 'Fixture', version: '1.0.0', type: 'extension',
            description: 'Test', author: 'Contributor', icon: '🔧', permissions: [],
            config: { count: { type: 'number', enum: [1] } },
        };
        const file = path.join(dir, 'manifest.json');
        writeFileSync(file, JSON.stringify(manifest).replace('"enum":[1]', '"enum":[1e400]'));
        expect(await validateManifest(file, 'extension', id)).toEqual([
            expect.stringContaining('must be a number primitive'),
        ]);
    });

    it('requires an explicit supported type for an enum', async () => {
        expect(await validate({ config: { mode: { enum: ['fast'] } } })).toEqual([
            expect.stringContaining('enum requires a declared'),
        ]);
    });

    it.each(['bool', 'integer', 'String', '', null, {}, []])('rejects unsupported type %j', async (type) => {
        expect(await validate({ config: { mode: { type } } })).toEqual([
            expect.stringContaining('type must be one of: boolean, number, string'),
        ]);
    });

    it('accepts the host enum limits, including UTF-8 byte boundaries', async () => {
        expect(await validate({ config: {
            modes: { type: 'string', enum: Array.from({ length: 64 }, (_, i) => `${i}`) },
            ascii: { type: 'string', enum: ['a'.repeat(128)] },
            unicode: { type: 'string', enum: ['é'.repeat(64)] },
        } })).toEqual([]);
        expect(await validate({ config: {
            ascii: { type: 'string', enum: ['a'.repeat(129)] },
            unicode: { type: 'string', enum: ['é'.repeat(65)] },
        } })).toEqual([
            expect.stringContaining('exceeds 128 UTF-8 bytes'),
            expect.stringContaining('exceeds 128 UTF-8 bytes'),
        ]);
    });

    it.each([null, true, false, 1, {}, [], 'Plain', 'encrypted', ''])(
        'rejects unsupported backup value %j', async (backup) => {
            expect(await validate({ config: { trigger: { type: 'string', backup } } })).toEqual([
                expect.stringContaining('backup must be "plain"'),
            ]);
        });

    it.each(['boolean', 'number', undefined])('rejects plain backup on type %j', async (type) => {
        expect(await validate({ config: { value: { type, backup: 'plain' } } })).toEqual([
            expect.stringContaining('only allowed on string fields'),
        ]);
    });

    it.each([
        'personal_token', 'SECRET', 'credentials', 'creds', 'password', 'passwd',
        'passphrase', 'passcode', 'API Key', 'api-key', 'apikey',
        'licenseKey', 'account_key', 'private-key', 'access_key',
        'auth_method', 'oauth', 'keep_session', 'session_cookie', 'totp',
        'otp_seed', 'otp-secret', 'mnemonic', 'pin', 'account.pin', 'login-pass', 'my_pwd',
    ])('rejects plain backup for credential-named field %s, even with an enum', async (field) => {
        expect(await validate({ config: { [field]: {
            type: 'string', enum: ['none'], sensitive: false, backup: 'plain',
        } } })).toEqual([
            expect.stringContaining('forbidden on credential-named or declared sensitive fields'),
        ]);
    });

    it.each([
        { config: { private_url: { type: 'string', sensitive: true, backup: 'plain' } } },
        { sensitiveData: ['connection'], config: { connection: { type: 'string', backup: 'plain' } } },
        { sensitiveData: ['ACCOUNT'], config: { account: { type: 'string', backup: 'plain' } } },
        { sensitiveData: ['Private_*'], config: { private_url: { type: 'string', backup: 'plain' } } },
    ])('rejects plain backup conflicting with a sensitive declaration %j', async (metadata) => {
        expect(await validate(metadata)).toEqual([
            expect.stringContaining('forbidden on credential-named or declared sensitive fields'),
        ]);
    });

    it('allows unmarked personal strings and sensitive fields with types or enums', async () => {
        expect(await validate({ config: {
            home_location: { type: 'string', default: '' },
            personal_token: { type: 'string', sensitive: true },
            pin: { type: 'number', enum: [0, 1234] },
            keep_session: { type: 'boolean' },
        } })).toEqual([]);
    });

    it('reports exact enum-entry and backup lines for dotted field names', async () => {
        const id = `fixture-${++seq}`;
        const dir = path.join(root, id);
        mkdirSync(dir);
        const manifest = {
            id, name: 'Fixture', version: '1.0.0', type: 'extension',
            description: 'Test', author: 'Contributor', icon: '🔧', permissions: [],
            config: { 'private.url': { type: 'string', enum: ['safe', 123], sensitive: true, backup: 'plain' } },
        };
        const source = JSON.stringify(manifest, null, 2);
        const file = path.join(dir, 'manifest.json');
        writeFileSync(file, source);
        const issues = await validateManifest(file, 'extension', id);
        const enumLine = source.split('\n').findIndex((line) => line.includes('123')) + 1;
        const backupLine = source.split('\n').findIndex((line) => line.includes('"backup"')) + 1;
        expect(issues).toHaveLength(2);
        expect(issues[0]).toContain(`manifest.json:${enumLine}:`);
        expect(issues[1]).toContain(`manifest.json:${backupLine}:`);
    });
});
