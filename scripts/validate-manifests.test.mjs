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

// A fixture with bundle files next to its manifest (view modules, CSS, the
// EN catalog).
async function validateWithFiles(metadata, files = {}) {
    const id = `fixture-${++seq}`;
    const dir = path.join(root, id);
    mkdirSync(dir);
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
    const manifest = {
        id, name: 'Fixture', version: '1.0.0', type: 'extension',
        description: 'Test manifest.', author: 'Contributor', icon: '🔧',
        permissions: [], ...metadata,
    };
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    return validateManifest(file, 'extension', id);
}

const VIEW_FILES = {
    'explorer.js': 'export default {};\n',
    'explorer.css': '.x { color: red; }\n',
    '_locales/en/messages.json': JSON.stringify({
        'view.explorer.title': { message: 'Explorer' },
        'view.long.title': { message: 'x'.repeat(61) },
        'agent.reason': { message: 'Sorts your notes.' },
        'agent.long_reason': { message: 'x'.repeat(301) },
    }),
};
const explorer = (extra = {}) => ({
    id: 'explorer', title: '__MSG_view.explorer.title__', icon: '🗺️',
    module: './explorer.js', css: ['./explorer.css'],
    defaultSize: { width: 1200, height: 800 }, minSize: { width: 640, height: 420 },
    ...extra,
});
const withViews = (views, permissions = ['storage', 'views']) =>
    validateWithFiles({ permissions, contributes: { views } }, VIEW_FILES);

describe('contributes.views', () => {
    it('accepts the documented example and the minimal entry', async () => {
        expect(await withViews([explorer()])).toEqual([]);
        expect(await withViews([{ id: 'board', title: 'Board', module: './explorer.js' }])).toEqual([]);
        expect(await withViews(['a', 'b', 'c', 'd'].map((id) => explorer({ id })))).toEqual([]);
    });

    it('needs the views capability, and the capability needs a view', async () => {
        expect(await withViews([explorer()], ['storage'])).toEqual([
            expect.stringContaining("'contributes.views' needs 'views' in 'permissions'"),
        ]);
        expect(await withViews([], ['views'])).toEqual([
            expect.stringContaining("'views' in 'permissions' needs at least one 'contributes.views' entry"),
        ]);
        expect(await validateWithFiles({ permissions: ['views'] })).toEqual([
            expect.stringContaining("needs at least one 'contributes.views' entry"),
        ]);
    });

    it('rejects a non-array, a non-object entry and more than 4 entries', async () => {
        expect(await withViews({ id: 'explorer' })).toEqual([
            expect.stringContaining("'contributes.views' must be an array"),
            expect.stringContaining("needs at least one 'contributes.views' entry"),
        ]);
        expect(await withViews(['explorer'])).toEqual([expect.stringContaining('entry 0 must be an object')]);
        expect(await withViews(['a', 'b', 'c', 'd', 'e'].map((id) => explorer({ id })))).toEqual([
            expect.stringContaining('has 5 entries; Kage uses the first 4'),
        ]);
    });

    it.each(['', 'Explorer', '1map', 'map_view', 'a'.repeat(33), null, 7])('rejects view id %j', async (id) => {
        expect(await withViews([explorer({ id })])).toEqual([expect.stringContaining("'id' must match")]);
    });

    it('rejects duplicate ids and unknown fields', async () => {
        expect(await withViews([explorer(), explorer()])).toEqual([
            expect.stringContaining("duplicate view id 'explorer'"),
        ]);
        expect(await withViews([explorer({ position: { x: 0, y: 0 }, alwaysOnTop: true })])).toEqual([
            expect.stringContaining("unknown field 'position'"),
            expect.stringContaining("unknown field 'alwaysOnTop'"),
        ]);
    });

    it('checks the title, resolving __MSG_ tokens through the EN catalog', async () => {
        expect(await withViews([explorer({ title: undefined })])).toEqual([
            expect.stringContaining("'title' is required"),
        ]);
        expect(await withViews([explorer({ title: '  ' })])).toEqual([
            expect.stringContaining("'title' is required"),
        ]);
        expect(await withViews([explorer({ title: 'x'.repeat(61) })])).toEqual([
            expect.stringContaining("'title' must be 1–60 characters"),
        ]);
        expect(await withViews([explorer({ title: '__MSG_view.long.title__' })])).toEqual([
            expect.stringContaining("'title' must be 1–60 characters"),
        ]);
        expect(await withViews([explorer({ title: 'x'.repeat(60) })])).toEqual([]);
        // A missing key is check:i18n's to report.
        expect(await withViews([explorer({ title: '__MSG_view.missing__' })])).toEqual([]);
    });

    it.each(['', '🗺️🗺️', 'map', 7])('rejects icon %j', async (icon) => {
        expect(await withViews([explorer({ icon })])).toEqual([expect.stringContaining("'icon' must be one emoji")]);
    });

    it('accepts a joined emoji as one icon', async () => {
        expect(await withViews([explorer({ icon: '👩‍💻' })])).toEqual([]);
    });

    it.each([undefined, 'explorer.js', './explorer.mjs', '/explorer.js', 7])('rejects module %j', async (module) => {
        expect(await withViews([explorer({ module })])).toEqual([
            expect.stringContaining("'module' is required: a './…/*.js' path"),
        ]);
    });

    it('rejects a module or CSS file that is not in the bundle', async () => {
        expect(await withViews([explorer({ module: './missing.js', css: ['./missing.css'] })])).toEqual([
            expect.stringContaining('referenced file not found: ./missing.js'),
            expect.stringContaining('referenced file not found: ./missing.css'),
        ]);
    });

    it('checks the CSS list: paths, count and sizes', async () => {
        expect(await withViews([explorer({ css: './explorer.css' })])).toEqual([
            expect.stringContaining("'css' must be an array"),
        ]);
        expect(await withViews([explorer({ css: ['explorer.css', './explorer.js'] })])).toEqual([
            expect.stringContaining("'css' entry 0 must be a './…/*.css' path"),
            expect.stringContaining("'css' entry 1 must be a './…/*.css' path"),
        ]);
        expect(await withViews([explorer({ css: Array(9).fill('./explorer.css') })])).toEqual([
            expect.stringContaining("'css' has 9 files; at most 8"),
        ]);
        const big = 'a'.repeat(256 * 1024 + 1);
        const files = { ...VIEW_FILES, 'a.css': big, 'b.css': big, 'c.css': big, 'd.css': big };
        const issues = await validateWithFiles({
            permissions: ['views'],
            contributes: { views: [explorer({ css: ['./a.css', './b.css', './c.css', './d.css'] })] },
        }, files);
        expect(issues.filter((i) => i.includes('per file'))).toHaveLength(4);
        expect(issues.filter((i) => i.includes('in total'))).toHaveLength(1);
    });

    it('checks defaultSize and minSize against the host clamps', async () => {
        expect(await withViews([explorer({ defaultSize: { width: 400, height: 2200 }, minSize: undefined })])).toEqual([
            expect.stringContaining("'defaultSize.width' must be 480–3840"),
            expect.stringContaining("'defaultSize.height' must be 360–2160"),
        ]);
        expect(await withViews([explorer({ defaultSize: [1200, 800] })])).toEqual([
            expect.stringContaining("'defaultSize' must be { \"width\""),
        ]);
        expect(await withViews([explorer({ minSize: { width: 300, height: 900 } })])).toEqual([
            expect.stringContaining("'minSize.width' must be 320–1200"),
            expect.stringContaining("'minSize.height' must be 240–800"),
        ]);
        // Without a defaultSize, minSize is capped by the host default (1100 × 760).
        expect(await withViews([explorer({ defaultSize: undefined, minSize: { width: 1101, height: 760 } })])).toEqual([
            expect.stringContaining("'minSize.width' must be 320–1100"),
        ]);
        // The cap is the clamped default size.
        expect((await withViews([explorer({ defaultSize: { width: 5000, height: 800 }, minSize: { width: 3841, height: 420 } })]))
            .some((i) => i.includes("'minSize.width' must be 320–3840"))).toBe(true);
    });

    it('reports the offending view field on its own line', async () => {
        const [issue] = await withViews([explorer({ minSize: { width: 100, height: 420 } })]);
        expect(issue).toMatch(/manifest\.json:\d+: /);
        expect(Number(issue.match(/manifest\.json:(\d+):/)[1])).toBeGreaterThan(1);
    });
});

describe('agentBackground', () => {
    const agent = (block, permissions = ['storage', 'agent_background']) =>
        validateWithFiles({ permissions, agentBackground: block }, VIEW_FILES);
    const ok = { reason: '__MSG_agent.reason__', purposes: ['organize'] };

    it('accepts the documented example and a plain-text reason', async () => {
        expect(await agent({ ...ok, maxPromptChars: 16000, dailyCalls: 40 })).toEqual([]);
        expect(await agent({ reason: 'Sorts your notes.', purposes: ['organize', 'summarize_2'] })).toEqual([]);
    });

    it('needs the agent_background capability, and the capability needs the block', async () => {
        expect(await agent(ok, ['storage'])).toEqual([
            expect.stringContaining("'agentBackground' needs 'agent_background' in 'permissions'"),
        ]);
        expect(await validateWithFiles({ permissions: ['agent_background'] })).toEqual([
            expect.stringContaining("needs an 'agentBackground' block"),
        ]);
    });

    it.each([null, [], 'organize'])('rejects a non-object block %j', async (block) => {
        expect(await agent(block)).toEqual([expect.stringContaining("'agentBackground' must be an object")]);
    });

    it('rejects unknown fields', async () => {
        expect(await agent({ ...ok, model: 'fast' })).toEqual([expect.stringContaining("unknown field 'model'")]);
    });

    it.each([undefined, '', '   ', 7])('requires a reason: %j', async (reason) => {
        expect(await agent({ ...ok, reason })).toEqual([expect.stringContaining("'agentBackground.reason' is required")]);
    });

    it('limits the reason to 300 characters after token resolution', async () => {
        expect(await agent({ ...ok, reason: 'x'.repeat(300) })).toEqual([]);
        expect(await agent({ ...ok, reason: 'x'.repeat(301) })).toEqual([
            expect.stringContaining("'agentBackground.reason' must be 1–300 characters"),
        ]);
        expect(await agent({ ...ok, reason: '__MSG_agent.long_reason__' })).toEqual([
            expect.stringContaining("'agentBackground.reason' must be 1–300 characters"),
        ]);
    });

    it.each([undefined, [], 'organize', Array.from({ length: 9 }, (_, i) => `p${i}`)])(
        'rejects purposes %j', async (purposes) => {
            expect(await agent({ ...ok, purposes })).toEqual([
                expect.stringContaining("'agentBackground.purposes' must be an array of 1–8 purpose ids"),
            ]);
        });

    it.each(['Organize', '1st', 'sort-notes', '', 'a'.repeat(25), 7])('rejects purpose id %j', async (id) => {
        expect(await agent({ ...ok, purposes: [id] })).toEqual([
            expect.stringContaining("'agentBackground.purposes' entry 0 must match"),
        ]);
    });

    it('rejects duplicate purposes', async () => {
        expect(await agent({ ...ok, purposes: ['organize', 'organize'] })).toEqual([
            expect.stringContaining("duplicate purpose 'organize'"),
        ]);
    });

    it.each([0, -1, 1.5, '40', null, Number.MAX_SAFE_INTEGER + 1])('rejects maxPromptChars and dailyCalls %j', async (n) => {
        expect(await agent({ ...ok, maxPromptChars: n, dailyCalls: n })).toEqual([
            expect.stringContaining("'agentBackground.maxPromptChars' must be a positive integer"),
            expect.stringContaining("'agentBackground.dailyCalls' must be a positive integer"),
        ]);
    });
});

describe('the new capabilities', () => {
    it('knows file_text, which needs no manifest block', async () => {
        expect(await validateWithFiles({ permissions: ['storage', 'file_text'] })).toEqual([]);
    });
});

describe('sync', () => {
    const SYNC_FILES = {
        '_locales/en/messages.json': JSON.stringify({
            'sync.description': { message: 'Your notes, so they are on every computer.' },
            'sync.long': { message: 'x'.repeat(141) },
        }),
    };
    // Kage's SYNC §12.2 example.
    const example = {
        description: '__MSG_sync.description__',
        schema: 1,
        keys: ['prefs', 'view-*'],
        lists: { todos: { array: 'items', id: 'id', label: 'title' } },
        collections: {
            items: {
                label: 'title', private: 'private', maxBytes: 65536,
                together: [['status', 'doneAt', 'suggested', 'confidence'], ['title', 'titleSource'], ['summary', 'summarySource'], ['url', 'canonicalUrl']],
                sets: ['entityIds', 'terms'], maps: ['mentionOrigin'], local: ['rev', 'enrich', 'v', 'fileRefs'],
            },
            bodies: { whole: true, large: true, maxBytes: 4194304 },
        },
    };
    const sync = (block, extra = {}) =>
        validateWithFiles({ permissions: ['storage', 'sync'], sync: block, ...extra }, SYNC_FILES);
    const only = (collections) => sync({ collections });

    it('accepts the documented example', async () => {
        expect(await sync(example, {
            config: {
                my_names: { type: 'string', default: '', sync: 'shared' },
                background_organize: { type: 'boolean', default: false, sync: 'machine' },
                theme_size: { type: 'number', default: 1, sync: 'os' },
                cache_url: { type: 'string', default: '', sync: 'never' },
            },
        })).toEqual([]);
    });

    it('needs the sync capability, and the capability needs the block', async () => {
        expect(await validateWithFiles({ permissions: ['storage'], sync: { keys: ['prefs'] } })).toEqual([
            expect.stringContaining("'sync' needs 'sync' in 'permissions'"),
        ]);
        expect(await validateWithFiles({ permissions: ['storage', 'sync'] })).toEqual([
            expect.stringContaining("needs a 'sync' block"),
        ]);
    });

    it.each([null, [], 'items'])('rejects a non-object block %j', async (block) => {
        expect(await sync(block)).toEqual([expect.stringContaining("'sync' must be an object")]);
    });

    it('rejects unknown fields and a block that syncs nothing', async () => {
        expect(await sync({ keys: ['prefs'], extra: 1 })).toEqual([expect.stringContaining("unknown field 'extra'")]);
        expect(await sync({ schema: 1 })).toEqual([expect.stringContaining('declares nothing to sync')]);
    });

    it('limits the description to 140 characters after token resolution', async () => {
        expect(await sync({ keys: ['prefs'], description: 'x'.repeat(140) })).toEqual([]);
        expect(await sync({ keys: ['prefs'], description: '__MSG_sync.long__' })).toEqual([
            expect.stringContaining("'sync.description' must be at most 140 characters"),
        ]);
    });

    it.each([0, 1.5, '1', -2])('rejects schema %j', async (schema) => {
        expect(await sync({ keys: ['prefs'], schema })).toEqual([expect.stringContaining("'sync.schema' must be an integer")]);
    });

    it('checks keys: storage-key rules, a trailing wildcard, the limit and sensitive data', async () => {
        expect(await sync({ keys: ['a', 'b-*', 'c.d_e'] })).toEqual([]);
        expect(await sync({ keys: ['bad key'] })).toEqual([expect.stringContaining("'sync.keys' entry 0 must be a storage key")]);
        expect(await sync({ keys: ['*'] })).toEqual([expect.stringContaining("'sync.keys' entry 0 must be a storage key")]);
        expect(await sync({ keys: Array.from({ length: 33 }, (_, i) => `k${i}`) })).toEqual([
            expect.stringContaining("at most 32 storage keys"),
        ]);
        expect(await sync({ keys: ['oauth_token'] })).toEqual([expect.stringContaining('names sensitive data')]);
        expect(await sync({ keys: ['conn*'] }, { sensitiveData: ['conn*'] })).toEqual([expect.stringContaining('names sensitive data')]);
    });

    it('checks lists', async () => {
        expect(await sync({ lists: { todos: { array: '', id: 'id' } } })).toEqual([]);
        expect(await sync({ lists: { todos: { array: 'items' } } })).toEqual([expect.stringContaining("'sync.lists.todos.id'")]);
        expect(await sync({ lists: { todos: { array: 'a.b', id: 'id' } } })).toEqual([expect.stringContaining("'sync.lists.todos.array'")]);
        expect(await sync({ lists: { todos: { array: 'items', id: 'id', sort: 'x' } } })).toEqual([expect.stringContaining("unknown field 'sort'")]);
        const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`l${i}`, { array: 'items', id: 'id' }]));
        expect(await sync({ lists: many })).toEqual([expect.stringContaining('at most 16 storage keys')]);
    });

    it('checks collection names, fields and sizes', async () => {
        expect(await only({ Items: { whole: true } })).toEqual([expect.stringContaining('the name must match')]);
        expect(await only({ items: { whole: true, sort: 'x' } })).toEqual([expect.stringContaining("unknown field 'sort'")]);
        expect(await only({ items: { maxBytes: 1048577 } })).toEqual([expect.stringContaining('maxBytes must be 1–1048576')]);
        expect(await only({ items: { whole: true, large: true, maxBytes: 4194305 } })).toEqual([expect.stringContaining('maxBytes must be 1–4194304')]);
        expect(await only({ items: { label: 'a.b' } })).toEqual([expect.stringContaining('.label must name a top-level field')]);
        const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, { whole: true }]));
        expect(await only(many)).toEqual([expect.stringContaining('at most 16 collections')]);
    });

    it('rejects overlapping groups, sets, maps and local fields', async () => {
        expect(await only({ items: { together: [['a', 'b']], sets: ['b'] } })).toEqual([
            expect.stringContaining("'b' is in both 'together' and 'sets'"),
        ]);
        expect(await only({ items: { maps: ['m'], local: ['m'] } })).toEqual([expect.stringContaining("'m' is in both 'maps' and 'local'")]);
        expect(await only({ items: { together: [['a']] } })).toEqual([expect.stringContaining('groups of two or more')]);
    });

    it('rejects a whole collection that splits fields, and credential-named fields', async () => {
        expect(await only({ items: { whole: true, sets: ['tags'] } })).toEqual([expect.stringContaining("a 'whole' collection is one cell")]);
        expect(await only({ items: { sets: ['apiKey'] } })).toEqual([expect.stringContaining('looks like a credential field')]);
        expect(await only({ items: { local: ['session'] } })).toEqual([]);
    });

    it('checks config.<field>.sync', async () => {
        expect(await sync({ keys: ['prefs'] }, { config: { x: { type: 'boolean', default: true, sync: 'everywhere' } } })).toEqual([
            expect.stringContaining('config.x.sync must be one of: shared, os, machine, never'),
        ]);
        expect(await sync({ keys: ['prefs'] }, { config: { api_key: { type: 'string', default: '', sync: 'shared' } } })).toEqual([
            expect.stringContaining('config.api_key.sync: credentials never sync'),
        ]);
        expect(await sync({ keys: ['prefs'] }, { config: { url: { type: 'string', default: '', sensitive: true, sync: 'machine' } } })).toEqual([]);
    });
});
