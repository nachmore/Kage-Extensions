import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkExtension, securityTargets } from './check-security.mjs';
import { checkSensitiveDeclarations } from './lib/check-sensitive-data.mjs';
import { checkExtension as checkDefaults } from './check-defaults.mjs';

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
        for (const key of ['`token_${account}`', "'token_' + account", "'token_' + account + '_suffix'", '`token_${`user_${account}`}_suffix`']) {
            const prefix = key.includes('user_') ? 'token_user_*' : 'token_*';
            expect(scan(write(key))[0].message).toContain(`'${prefix}'`);
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
        expect(scan(source)).toHaveLength(2);
        for (const issue of scan(source)) expect(issue.message).toContain("'creds'");
        expect(scan(source, { sensitiveData: ['creds'] })).toEqual([]);
        const opaque = `async function writeState(value) { ${write("'connection'", 'value')} }
await writeState(response.access_token);`;
        expect(scan(opaque)[0].message).toContain("'connection'");
    });

    it('fails for an unresolved secret-bearing key without guessing a declaration', () => {
        expect(scan(write('computeKey()', '{ access_token }'))[0].message).toContain('(computed key)');
        expect(scan(write('secretKey', 'input'))[0].message).toContain('(computed key)');
        expect(scan(write('computeKey()'))[0].message).toContain('kage-sensitive-data: <key|not-sensitive>');
    });

    it('checks literal writes in zero-parameter functions and methods', () => {
        expect(scan(`async function save() { ${write("'token'", 't')} }`)[0].message).toContain("'token'");
        expect(scan(`class Client { async _save() { ${write("'state'", '{access_token}')} } }`)[0].message).toContain("'state'");
    });

    it.each([
        `const persist = async (k, v) => { ${write('k', 'v')} }; persist('token', t);`,
        `const persist = async (k, v) => context.invoke('save_extension_data', {key:k,data:v}); persist('token', t);`,
        `const persist = k => context.invoke('save_extension_data', {key:k,data:t}); persist('token');`,
        `const persist = async k => context.invoke('save_extension_data', {key:k,data:t}); persist('token');`,
        `class Client { persist = async (k,v) => context.invoke('save_extension_data', {key:k,data:v}); save() {this.persist('token',t);} }`,
        `const persist = async (k,v) => context.invoke('save_extension_data', {key:k,data:v});
         const save = (key,data) => persist(key,data); save('token',t);`,
        `const persist = options => context.invoke('save_extension_data', options); persist({key:'token',data:t});`,
        `const persist = options => context.invoke('save_extension_data', {key:options.key,data:options.data}); persist({key:'token',data:t});`,
    ])('follows modern wrapper syntax: %s', (source) => {
        const issues = scan(source);
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toContain("'token'");
        expect(scan(source, { sensitiveData: ['token'] })).toEqual([]);
    });

    it('resolves aliased imported wrappers and member constants through relative modules', () => {
        const sources = [
            { file: 'lib/keys.js', source: `export const KEYS = { TOKEN: 'token' };` },
            { file: 'lib/storage.js', source: `export const persist = async (key,data) => context.invoke('save_extension_data',{key,data});` },
            { file: 'search.js', source: `import {KEYS as K} from './lib/keys.js'; import {persist as save} from './lib/storage.js'; save(K.TOKEN, t);` },
        ];
        expect(checkSensitiveDeclarations({}, sources)).toEqual([
            expect.objectContaining({ file: 'search.js', message: expect.stringContaining("'token'") }),
        ]);
        expect(checkSensitiveDeclarations({ sensitiveData: ['token'] }, sources)).toEqual([]);
    });

    it('resolves namespace imports, default wrappers, and re-exports', () => {
        const sources = [
            { file: 'keys.js', source: `export const KEYS={TOKEN:'token'};` },
            { file: 'storage.js', source: `export default async (key,data) => context.invoke('save_extension_data',{key,data});` },
            { file: 'index.js', source: `export {default as persist} from './storage.js';` },
            { file: 'search.js', source: `import * as keys from './keys.js'; import {persist} from './index.js'; persist(keys.KEYS.TOKEN,t);` },
        ];
        expect(checkSensitiveDeclarations({}, sources)).toEqual([
            expect.objectContaining({ file: 'search.js', message: expect.stringContaining("'token'") }),
        ]);
        expect(checkSensitiveDeclarations({ sensitiveData: ['token'] }, sources)).toEqual([]);
    });

    it('does not crash on cyclic re-exports or unresolved command constants', () => {
        const sources = [
            { file: 'a.js', source: `export {COMMAND} from './b.js';` },
            { file: 'b.js', source: `export {COMMAND} from './a.js';` },
            { file: 'search.js', source: `import {COMMAND} from './a.js'; context.invoke(COMMAND,{key:'token',data:t}); const orphan='save_extension_data';` },
        ];
        expect(checkSensitiveDeclarations({}, sources)[0].message).toContain('could not be resolved as storage calls');
    });

    it('resolves object members and all ternary alternatives', () => {
        const source = `const KEYS = {TOKEN:'token', OTHER:'credentials'}; ${write('flag ? KEYS.TOKEN : KEYS.OTHER')}`;
        expect(scan(source)).toHaveLength(2);
        expect(scan(source, { sensitiveData: ['token', 'credentials'] })).toEqual([]);
        expect(scan(source, { sensitiveData: ['token'] })[0].message).toContain("'credentials'");
    });

    it('honours object-member overrides and fails closed on unknown spreads', () => {
        expect(scan(`const KEYS={TOKEN:'token', ...{TOKEN:'cache'}}; ${write('KEYS.TOKEN')}`)).toEqual([]);
        expect(scan(`const TOKEN='key'; const options = {[TOKEN]:'token',data:t}; context.invoke('save_extension_data',options);`)[0].message)
            .toContain("'token'");
        expect(scan(`context.invoke('save_extension_data',{key:'cache',...options});`)[0].message)
            .toContain('(computed key)');
        expect(scan(`context.invoke('save_extension_data',{...options,key:'cache',data:rates});`)).toEqual([]);
    });

    it('keeps exact declarations distinct from prefix globs and matches case strictly', () => {
        expect(scan(write("'token_more'"), { sensitiveData: ['token'] })).toHaveLength(1);
        expect(scan(write("'token_more'"), { sensitiveData: ['token*'] })).toEqual([]);
        expect(scan(write("'Token'"), { sensitiveData: ['token'] })).toHaveLength(1);
    });

    it('parses regex quotes and nested templates without hiding later writes', () => {
        const source = `const escape = s => s.replace(/[&<>"']/g, '');
const rendered = \`outer \${\`inner \${value}\`}\`;
${write("'token'")}`;
        expect(scan(source)[0]).toMatchObject({ line: 3, message: expect.stringContaining("'token'") });
    });

    it('fails closed on parsing errors and unassociated storage-command occurrences', () => {
        expect(scan(`const broken = ; ${write("'token'")}`)[0].pattern).toBe('sensitive-data-analysis');
        expect(scan(`const command = 'save_extension_data'; dispatch(input);`)[0].message)
            .toContain('could not be resolved as storage calls');
        expect(scan(`const command = 'save_extension_data'; context.invoke(command, {key:'token',data:t});`,
            { sensitiveData: ['token'] })).toEqual([]);
    });

    it('honours reviewed annotations on computed calls and checks the annotated declaration', () => {
        const source = `${write('computeKey()', 'input')} // kage-sensitive-data: connection`;
        expect(scan(source)[0].message).toContain("'connection'");
        expect(scan(source, { sensitiveData: ['connection'] })).toEqual([]);
        expect(scan(`${write('computeKey()', 'input')} // kage-sensitive-data: not-sensitive`)).toEqual([]);
        expect(scan(`// kage-sensitive-data: token\n${write('computeKey()', 'input')}`,
            { sensitiveData: ['token'] })).toEqual([]);
        expect(scan(`async function save() {
// kage-sensitive-data: token
const saved = await context.invoke('save_extension_data',{key:computeKey(),data:input});
}`, { sensitiveData: ['token'] })).toEqual([]);
        expect(scan(`${write("'credentials'")} // kage-sensitive-data: token`,
            { sensitiveData: ['token'] })[0].message).toContain("'credentials'");
        expect(scan(`${write('computeKey()')} // kage-sensitive-data: bad/key`)[0].message).toContain('Invalid');
    });

    it.each(['private_url', 'secret_uri', 'ics_address', 'subscription_endpoint', 'webhook_url'])('detects capability URL payload %s', (name) => {
        expect(scan(write("'connection'", `{${name}: input}`))[0].message).toContain("'connection'");
    });

    it('does not classify suffix URLs or single-word string values as secrets', () => {
        expect(scan(write("'cache'", `{lyrics_url:'url', topics_url:'url',metrics_endpoint:'url', word:'token'}`))).toEqual([]);
    });

    it('uses lexical bindings and explicit imports despite conflicting shared names', () => {
        const sources = [
            { file: 'keys.js', source: `export const KEY = 'token';` },
            { file: 'other.js', source: `const KEY = 'cache'; const save = x => x; save('token');` },
            { file: 'storage.js', source: `export const save = key => context.invoke('save_extension_data',{key,data:t}); save('cache');` },
            { file: 'search.js', source: `import {KEY} from './keys.js'; ${write('KEY')}` },
        ];
        expect(checkSensitiveDeclarations({}, sources)).toEqual([
            expect.objectContaining({ file: 'search.js', message: expect.stringContaining("'token'") }),
        ]);
        expect(scan(`const KEY='token'; async function save() { const KEY='cache'; ${write('KEY')} }`)).toEqual([]);
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
        `type: 'text', label: 'Private calendar URL'`,
        `type: 'text', label: 'PAT'`,
        `type: 'text', label: 'Access credential'`,
        `type: 'text', label: 'Bearer'`,
        `type: 'text', label: 'API key'`,
        `type: 'text', label: 'Token'`,
        `type: 'text', label: 'Secret'`,
        `type: 'text', label: 'Password'`,
        `type: 'text', label: 'Client secret'`,
        `type: 'text', label: 'Webhook URL'`,
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
            { file: 'controls.js', source: `export const controls = [{ id: 'connection', type: 'text', label: 'API key' }];` },
        ])[0].file).toBe('controls.js');
    });

    it('skips transient action inputs, buttons, and password-generator search results', () => {
        const source = `const controls = [
            { type: 'text', id: '__token_input', label: 'PAT' },
            { type: 'action', id: 'clear_token' },
            { type: 'info', id: 'auth_status' },
        ];`;
        expect(scan(source, { contributes: { settingsProvider: './settings.js' } }, 'settings.js')).toEqual([]);
        expect(scan(`function result() { return { type: 'password', id: 'generated' }; }`)).toEqual([]);
        expect(scan(`const control = {type:'number', id:'length', label:'Password length'};`,
            { contributes: { settingsProvider: './settings.js' } }, 'settings.js')).toEqual([]);
    });

    it('resolves English t() labels rather than matching translation-key names', () => {
        const sources = [{ file: 'settings.js', source: `const control = {type:'text',id:'connection',label:t('settings.connection.label')};` }];
        const manifest = { contributes: { settingsProvider: './settings.js' } };
        expect(checkSensitiveDeclarations(manifest, sources, {
            messages: { 'settings.connection.label': { message: 'Personal access token' } },
        })[0].message).toContain('config.connection');
        expect(checkSensitiveDeclarations(manifest, sources, {
            messages: { 'settings.connection.label': { message: 'Server address' } },
        })).toEqual([]);
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

    it('lets a real settings provider observe the backup feature in the current-host defaults check', async () => {
        const dir = fixture({ contributes: { settingsProvider: './settings.js' } }, {
            'settings.js': `export default class Settings {
                initialize(context) {
                    if (context.hostFeatures && !context.hostFeatures.includes('export.sensitive_data')) {
                        throw new Error('current host must advertise the sensitive backup contract');
                    }
                    this.canLabelBackups = context.hostFeatures?.includes('export.sensitive_data') || false;
                }
                getSettings() {
                    return {sections:[{controls:[{type:'info',html:this.canLabelBackups ? 'Sensitive backups supported' : 'Upgrade host'}]}]};
                }
            }`,
        });
        expect(await checkDefaults(dir)).toEqual([]);
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

    it.each([
        ['search.test.js', 'eval(input);', 'eval'],
        ['provider.spec.js', 'new Function(input);', 'new-function'],
        ['search.test.js', `import('https://example.org/payload.js');`, 'remote-import'],
    ])('checks shipped test file %s for %s', async (file, source, pattern) => {
        expect(await checkExtension(fixture({}, { [file]: source }))).toEqual([
            expect.objectContaining({ pattern, severity: 'error' }),
        ]);
    });

    it('reports a missing manifest gracefully', async () => {
        const dir = path.join(root, String(++seq));
        mkdirSync(dir);
        expect(await checkExtension(dir)).toEqual([
            expect.objectContaining({ pattern: 'invalid-manifest', message: expect.stringContaining('missing manifest.json') }),
        ]);
    });

    it('reports secret config issues at the real manifest line', async () => {
        const dir = fixture({ config: { personal_token: { type: 'string' } } }, {});
        writeFileSync(path.join(dir, 'manifest.json'), '{\n  "config": {\n    "personal_token": {"type":"string"}\n  }\n}');
        expect((await checkExtension(dir))[0]).toMatchObject({ line: 3 });
    });

    it('rescans every extension when the checker or a shared library changes', () => {
        const affected = { mode: 'changed', changed: [], all: ['extensions/github', 'extensions/password'], nonItemChanged: [] };
        expect(securityTargets(affected)).toEqual([]);
        for (const file of ['scripts/check-security.mjs', 'scripts/lib/check-sensitive-data.mjs', 'scripts/lib/sensitive-data.mjs']) {
            expect(securityTargets({ ...affected, nonItemChanged: [file] })).toEqual(affected.all);
        }
        expect(securityTargets({ ...affected, nonItemChanged: ['CONTRIBUTING.md'] })).toEqual([]);
        expect(securityTargets(affected, true)).toEqual(affected.all);
    });

    it('passes Spotify and GitHub, and catches their actual declarations being removed', async () => {
        for (const id of ['spotify', 'github']) {
            const dir = path.resolve('extensions', id);
            const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
            const issues = (await checkExtension(dir)).filter((i) => i.severity === 'error');
            expect(issues).toEqual([]);
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

    it('runs the checker over EVERY real extension and requires Spotify client and stocks credentials', async () => {
        const dirs = readdirSync('extensions', { withFileTypes: true }).filter((entry) => entry.isDirectory());
        expect(dirs.length).toBeGreaterThan(0);
        for (const entry of dirs) {
            expect((await checkExtension(path.resolve('extensions', entry.name))).filter((i) => i.severity === 'error'),
                entry.name).toEqual([]);
        }
        for (const [id, removed, file] of [['spotify', 'client', 'auth.js'], ['stocks', 'credentials', 'client.js']]) {
            const manifest = JSON.parse(readFileSync(`extensions/${id}/manifest.json`, 'utf8'));
            manifest.sensitiveData = manifest.sensitiveData.filter((key) => key !== removed);
            const issues = checkSensitiveDeclarations(manifest, [
                { file, source: readFileSync(`extensions/${id}/${file}`, 'utf8') },
            ]);
            expect(issues.some((issue) => issue.message.includes(`'${removed}'`)), `${id}:${removed}`).toBe(true);
        }
    });
});
