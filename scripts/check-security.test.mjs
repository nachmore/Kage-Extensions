import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkExtension } from './check-security.mjs';
import { checkSensitiveDeclarations } from './lib/check-sensitive-data.mjs';
import { CURRENT_HOST_FEATURES } from './check-defaults.mjs';

const scan = (source, manifest = {}, file = 'search.js') =>
    checkSensitiveDeclarations(manifest, [{ file, source }]);
const write = (key, data = 'value') =>
    `await context.invoke('save_extension_data', { key: ${key}, data: JSON.stringify(${data}) });`;

describe('security: sensitive storage declarations', () => {
    it.each(['token', 'oauth', 'client_secret', 'credentials', 'creds', 'password',
        'passwd', 'api_key', 'api-key', 'auth', 'session', 'cookie'])('requires declaration of %s', (key) => {
        expect(scan(write(JSON.stringify(key)))).toEqual([
            expect.objectContaining({
                severity: 'error', line: 1, pattern: 'undeclared-sensitive-data',
                message: expect.stringContaining(`Storage key '${key}'`),
            }),
        ]);
        expect(scan(write(JSON.stringify(key)), { sensitiveData: [key] })).toEqual([]);
    });

    it('resolves constants, multiline writes, and imported storage-key constants', () => {
        const source = `const TOKEN_KEY = 'github-token';\n${write('TOKEN_KEY')}`;
        expect(scan(source)[0]).toMatchObject({ line: 2 });
        expect(scan(source, { sensitiveData: ['github-token'] })).toEqual([]);
        expect(checkSensitiveDeclarations({}, [
            { file: 'keys.js', source: `export const KEY = 'credentials';` },
            { file: 'search.js', source: `import { KEY } from './keys.js';\n${write('KEY')}` },
        ])[0].message).toContain("'credentials'");
    });

    it('requires a prefix declaration for dynamic template and concatenated keys', () => {
        for (const key of ['`token_${account}`', "'token_' + account"]) {
            expect(scan(write(key))[0].message).toContain("'token_*'");
            expect(scan(write(key), { sensitiveData: ['token_*'] })).toEqual([]);
            expect(scan(write(key), { sensitiveData: ['token_alice'] })).toHaveLength(1);
            expect(scan(write(key), { sensitiveData: ['ken_*'] })).toHaveLength(1);
        }
    });

    it('requires declarations for OAuth tokens and API keys under innocuous keys', () => {
        for (const data of ['{ access_token: response.access_token }', '{ refresh_token }',
            '{ client_secret }', '{ secret: values.input }', '{ api_key: values.input }', 'credentials', 'tokens', 'authToken', 'values.__token_input']) {
            expect(scan(write("'client'", data))[0].message).toContain('secret-bearing value');
            expect(scan(write("'client'", data), { sensitiveData: ['client'] })).toEqual([]);
        }
    });

    it('follows secret values through a local assignment', () => {
        const source = `const record = { refresh_token: response.refresh_token };\n${write("'connection'", 'record')}`;
        expect(scan(source)[0].message).toContain("'connection'");
    });

    it('checks generic storage wrappers at their write call sites', () => {
        const source = `
class Client {
    async write(key, value) { ${write('key', 'value')} }
    async saveKey(input) { await this.write('credentials', { api_key: input }); }
    async cache() { await this.write('rate_cache', { rate: 2 }); }
}`;
        expect(scan(source)).toHaveLength(1);
        expect(scan(source)[0].message).toContain("'credentials'");
        expect(scan(source, { sensitiveData: ['credentials'] })).toEqual([]);
    });

    it('follows OAuth arguments into fixed-key helpers, including literal/parameter name overlap', () => {
        const source = `async function writeCreds(creds) { ${write("'creds'", 'creds')} }
await writeCreds({ refresh_token: response.refresh_token });`;
        expect(scan(source).every((issue) => issue.message.includes("'creds'"))).toBe(true);
        expect(scan(source, { sensitiveData: ['creds'] })).toEqual([]);
        const opaque = `async function writeState(value) { ${write("'connection'", 'value')} }
await writeState(response.access_token);`;
        expect(scan(opaque)[0].message).toContain("'connection'");
    });

    it('fails for an unresolved secret-bearing key without guessing a declaration', () => {
        expect(scan(write('computeKey()', '{ access_token }'))[0].message).toContain('(computed key)');
        expect(scan(write('secretKey', 'input'))[0].message).toContain('(computed key)');
    });

    it('skips comments, test examples, ordinary caches, and authentication status flags', () => {
        expect(scan(`// ${write("'token'")}\n/* ${write("'password'")} */`)).toEqual([]);
        for (const [key, data] of [
            ['status', '{ auth_revoked: true, at: Date.now() }'],
            ['refresh_lock', '{ holder: instanceId, expires_at: 123 }'],
            ['geocode_cache', '{ location: home }'],
            ['bookmarks', '{ url: "https://example.org" }'],
            ['snippets', '{ text: input }'],
            ['kage-todos', 'todos'],
        ]) expect(scan(write(JSON.stringify(key), data))).toEqual([]);
    });
});

describe('security: sensitive config declarations', () => {
    it('requires true, even when the host safety net would catch the name', () => {
        for (const sensitive of [undefined, false]) {
            expect(scan('', { config: { personal_token: { type: 'string', sensitive } } })[0].message)
                .toContain('config.personal_token.sensitive: true');
        }
        expect(scan('', { config: { personal_token: { type: 'string', sensitive: true } } })).toEqual([]);
    });

    it.each(['private_url', 'ics_url', 'subscription_url', 'webhook_url'])('recognizes capability URL field %s', (field) => {
        expect(scan('', { config: { [field]: { type: 'string' } } })).toHaveLength(1);
    });

    it.each([
        `type: 'password'`,
        `type: 'text', inputType: 'password'`,
        `type: 'text', secret: true`,
        `type: 'text', sensitive: true`,
        `type: 'text', label: 'Private calendar URL'`,
    ])('recognizes an otherwise innocuous secret settings input (%s)', (control) => {
        const source = `export default class Settings { getSettings() {
            return { sections: [{ controls: [{ ${control}, id: 'connection' }] }] };
        } }`;
        const manifest = { contributes: { settingsProvider: './settings.js' }, config: { connection: { type: 'string' } } };
        expect(scan(source, manifest, 'settings.js')[0].message).toContain('config.connection');
        manifest.config.connection.sensitive = true;
        expect(scan(source, manifest, 'settings.js')).toEqual([]);
    });

    it('checks secret controls imported by the settings provider', () => {
        const manifest = { contributes: { settingsProvider: './settings.js' } };
        expect(checkSensitiveDeclarations(manifest, [
            { file: 'settings.js', source: `import { controls } from './controls.js';` },
            { file: 'controls.js', source: `export const controls = [{ id: 'connection', type: 'password' }];` },
        ])[0].file).toBe('controls.js');
    });

    it('skips transient action inputs, buttons, and password-generator search results', () => {
        const source = `const controls = [
            { type: 'password', id: '__token_input' },
            { type: 'action', id: 'clear_token' },
            { type: 'info', id: 'auth_status' },
        ];`;
        expect(scan(source, { contributes: { settingsProvider: './settings.js' } }, 'settings.js')).toEqual([]);
        expect(scan(`return { type: 'password', id: 'generated' };`)).toEqual([]);
    });
});

describe('security check integration', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kage-security-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    let seq = 0;
    function fixture(manifest, files) {
        const dir = path.join(root, String(++seq));
        mkdirSync(dir);
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        for (const [file, source] of Object.entries(files)) writeFileSync(path.join(dir, file), source);
        return dir;
    }

    it('mirrors the backup feature in current-host fixtures', () => {
        expect(CURRENT_HOST_FEATURES).toContain('export.sensitive_data');
    });

    it('fails the real extension check when a secret declaration is removed', async () => {
        const dir = fixture({ id: 'fixture' }, {
            'search.js': `const TOKEN_KEY = 'token';\n${write('TOKEN_KEY', '{ token: input }')}`,
            'search.test.js': write("'test_password'"),
        });
        const issues = await checkExtension(dir);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ severity: 'error', line: 2 });
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'fixture', sensitiveData: ['token'] }));
        expect(await checkExtension(dir)).toEqual([]);
    });

    it('keeps existing dynamic-code protections', async () => {
        const dir = fixture({}, { 'search.js': 'eval(input);' });
        expect(await checkExtension(dir)).toEqual([expect.objectContaining({ pattern: 'eval', severity: 'error' })]);
    });

    it('passes Spotify and GitHub, and catches their actual declarations being removed', async () => {
        for (const id of ['spotify', 'github']) {
            const dir = path.resolve('extensions', id);
            const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
            expect((await checkExtension(dir)).filter((i) => i.severity === 'error')).toEqual([]);
            const file = id === 'spotify' ? 'auth.js' : 'search.js';
            const sources = [{ file, source: readFileSync(path.join(dir, file), 'utf8') }];
            expect(checkSensitiveDeclarations({ ...manifest, sensitiveData: [] }, sources)
                .some((i) => i.message.includes(id === 'spotify' ? "'creds'" : "'token'"))).toBe(true);
            if (id === 'github') {
                const config = { ...manifest.config, personal_token: { type: 'string' } };
                expect(checkSensitiveDeclarations({ ...manifest, config }, sources)[0].message)
                    .toContain('config.personal_token');
            }
        }
    });
});
