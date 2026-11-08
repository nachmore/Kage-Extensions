import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import storageProbes from './fixtures/sensitive-review-storage.mjs';
import settingsProbes from './fixtures/sensitive-review-settings.mjs';
import { checkSensitiveDeclarations } from './lib/check-sensitive-data.mjs';
import { checkExtension } from './check-security.mjs';
import { packageDir } from './build-catalog.mjs';

const errors = (issues) => issues.filter((issue) => issue.severity === 'error');
const root = mkdtempSync(path.join(tmpdir(), 'kage-sensitive-review-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture(files, manifest = {}) {
    const dir = path.join(root, String(++sequence));
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), source);
    }
    return dir;
}

describe('sensitive gate: every original review probe', () => {
    it.each(Object.entries(storageProbes))('%s fails closed', (name, [manifest, sources]) => {
        const issues = checkSensitiveDeclarations(manifest, sources);
        expect(errors(issues).length, name).toBeGreaterThan(0);
        expect(issues.every((issue) => issue.file && issue.line > 0)).toBe(true);
        if (name.includes('annotation')) {
            expect(issues.some((issue) => issue.severity === 'warn' && issue.pattern === 'sensitive-data-annotation')).toBe(true);
        }
        if (name === 'annotation key substitutes for mixed resolved/unresolved') {
            expect(errors(issues).some((issue) => issue.message.includes("'token'"))).toBe(true);
        }
    });

    it.each(Object.entries(settingsProbes))('%s has the intended result', (name, [manifest, sources, options]) => {
        const issues = errors(checkSensitiveDeclarations(manifest, sources, options));
        // Storage key names keep the host's conservative heuristic, even for
        // an innocuous payload: focus_sessions still needs a declaration.
        if (name.startsWith('FP:') && name !== 'FP: storage key session_history') {
            expect(issues, name).toEqual([]);
        } else {
            expect(issues.length, name).toBeGreaterThan(0);
        }
    });
});

describe('sensitive gate: real mutation probes and extra boundaries', () => {
    async function realSources(id) {
        const dir = path.resolve('extensions', id);
        const files = Object.fromEntries(readdirSync(dir).filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
            .map((file) => [file, readFileSync(path.join(dir, file), 'utf8')]));
        const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        return { manifest, sources: Object.entries(files).map(([file, source]) => ({ file, source })) };
    }

    it('catches the actual stocks saveAccountKey mutation with all its safe callers present', async () => {
        const { manifest, sources } = await realSources('stocks');
        const client = sources.find((entry) => entry.file === 'client.js');
        client.source = client.source.replace('  async key() {', `  async saveAccountKey(account, apiKey) {
    await this.write(account, { api_key: apiKey });
  }
  async key() {`);
        expect(errors(checkSensitiveDeclarations(manifest, sources)).some((issue) =>
            issue.message.includes('unresolved (computed key)'))).toBe(true);
    });

    it('keeps stocks credentials mandatory when its generic write has not-sensitive.', async () => {
        const { manifest, sources } = await realSources('stocks');
        manifest.sensitiveData = [];
        const client = sources.find((entry) => entry.file === 'client.js');
        client.source = client.source.replace("    await this.dataInvoke('save_extension_data'", "    // kage-sensitive-data: not-sensitive.\n    await this.dataInvoke('save_extension_data'");
        const issues = checkSensitiveDeclarations(manifest, sources);
        expect(errors(issues).some((issue) => issue.message.includes("'credentials'"))).toBe(true);
        expect(issues.filter((issue) => issue.pattern === 'sensitive-data-annotation')).toEqual([
            expect.objectContaining({ file: 'client.js', line: client.source.split('\n').findIndex((line) => line.includes('not-sensitive.')) + 1, severity: 'warn' }),
        ]);
    });

    it('accepts the real password select mutation', async () => {
        const { manifest, sources } = await realSources('password');
        const settings = sources.find((entry) => entry.file === 'settings.js');
        settings.source = settings.source.replace("type: 'number', id: 'default_length'", "type: 'select', id: 'default_length'");
        const messages = JSON.parse(readFileSync('extensions/password/_locales/en/messages.json', 'utf8'));
        expect(errors(checkSensitiveDeclarations(manifest, sources, { messages }))).toEqual([]);
    });

    it.each([
        `context.invoke(['save','extension','data'].join('_'), {});`,
        `context.invoke.call(context, command(), {});`,
        `context.invoke.apply(context, [command(), {}]);`,
        `Reflect.apply(context.invoke, context, [command(), {}]);`,
        `const dispatch = context.invoke; dispatch(command(), {});`,
        `const dispatch = context.invoke.bind(context); dispatch(command(), {});`,
        `const method = 'invoke'; context[method](command(), {});`,
    ])('rejects an unresolved invoke command: %s', (source) => {
        expect(errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]))).toEqual([
            expect.objectContaining({ message: expect.stringContaining('commands must be literals') }),
        ]);
    });

    it.each(['=', '+=', '-=', '*=', '||=', '&&=', '??='])('handles assignment operator %s', (operator) => {
        const source = `let k = 'tok'; k ${operator} 'en'; context.invoke('save_extension_data', { key: k, data: 1 });`;
        const issues = errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]));
        expect(issues.length).toBe(operator === '=' ? 0 : 1);
    });

    it.each(['hasApiKey', 'isPasswordRequired', 'maxTokens', 'minTokenLength', 'tokenCount', 'tokenLimit', 'has_api_key', 'token_count'])('ignores indirect payload name %s', (name) => {
        const source = `context.invoke('save_extension_data', { key: 'prefs', data: { ${name}: 1 } });`;
        expect(checkSensitiveDeclarations({}, [{ file: 'search.js', source }])).toEqual([]);
    });

    it.each(['lyrics_url', 'metrics_endpoint'])('keeps public URL field %s negative', (name) => {
        expect(checkSensitiveDeclarations({ config: { [name]: { type: 'string' } } }, [
            { file: 'search.js', source: `context.invoke('save_extension_data', { key: '${name}', data: { ${name}: input } });` },
        ])).toEqual([]);
    });

    it.each(['slack_webhook_url', 'calendar_ics_url', 'slackWebhookUrl'])('checks prefixed capability URL %s as config, key and direct value', (name) => {
        expect(errors(checkSensitiveDeclarations({ config: { [name]: { type: 'string' } } }, []))).toHaveLength(1);
        for (const [key, data] of [[name, 'input'], ['connection', name]]) {
            const source = `context.invoke('save_extension_data', { key: '${key}', data: ${data} });`;
            expect(errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]))[0].message).toContain(`'${key}'`);
        }
    });

    it('reports even unattached annotations and accepts trailing punctuation', () => {
        const issues = checkSensitiveDeclarations({}, [{
            file: 'search.js',
            source: `// kage-sensitive-data: not-sensitive.
context.invoke('save_extension_data', { key: makeKey(), data: input });
// kage-sensitive-data: not-sensitive; reviewed separately.
`,
        }]);
        expect(errors(issues)).toEqual([]);
        expect(issues.map(({ file, line, severity }) => ({ file, line, severity }))).toEqual([
            { file: 'search.js', line: 1, severity: 'warn' },
            { file: 'search.js', line: 3, severity: 'warn' },
        ]);
    });

    it('retains ordinary names AND secret-value checks under not-sensitive', () => {
        const source = `// kage-sensitive-data: not-sensitive
context.invoke('save_extension_data', { key: 'cache', data: { api_key: input } });`;
        expect(errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]))[0].message).toContain("'cache'");
    });

    it('checks every conditional options-object alternative', () => {
        const source = `context.invoke('save_extension_data', flag ? { key: 'cache', data: 1 } : getOptions());`;
        expect(errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]))[0].message).toContain('(computed key)');
    });

    it('resolves star-exported wrappers and leaves dynamic references unresolved', () => {
        const sources = [
            { file: 'storage.js', source: `export function save(key, data) { return context.invoke('save_extension_data', { key, data }); } save('cache', 1);` },
            { file: 'index.js', source: `export * from './storage.js';` },
            { file: 'search.js', source: `import { save } from './index.js'; save('token', 1);` },
        ];
        expect(errors(checkSensitiveDeclarations({}, sources)).some((issue) => issue.message.includes("'token'"))).toBe(true);
        expect(checkSensitiveDeclarations({ sensitiveData: ['token'] }, sources)).toEqual([]);
        sources[2].source = `const MODULE = './index.js'; const m = await import(MODULE); m.save('cache', 1);`;
        expect(errors(checkSensitiveDeclarations({}, sources)).some((issue) => issue.message.includes('escaped/indirect'))).toBe(true);
    });

    it('checks a relative constant dynamic import against the analyzed module inventory', () => {
        const source = `const MODULE = './store.spec.js'; const m = await import(MODULE);`;
        expect(errors(checkSensitiveDeclarations({}, [{ file: 'search.js', source }]))[0].message).toContain('not an analyzed module');
    });

    it.each([
        `export default class S { getSettings() { return externalFactory(); } }`,
        `export default class S { async getSettings() { return (await import(moduleName)).default; } }`,
        `export default class S { getSettings() { return { sections: [{ controls: externalFactory() }] }; } }`,
        `export default class S { async getSettings() { return { sections: [{ controls: await externalFactory() }] }; } }`,
    ])('fails closed on opaque settings output: %s', (source) => {
        const issues = checkSensitiveDeclarations({ contributes: { settingsProvider: './settings.js' } }, [{ file: 'settings.js', source }]);
        expect(errors(issues).some((issue) => issue.message.includes('cannot be analyzed') && issue.message.includes('annotate'))).toBe(true);
    });

    it('reports reviewed settings gaps while still checking resolved control names and labels', () => {
        const source = `export default class S { getSettings() {
return { sections: [{ controls: [
// kage-sensitive-data: not-sensitive
{ id: 'token', type: unknownType, label: 'API key' },
// kage-sensitive-data: not-sensitive
{ id: 'connection', type: 'text', label: 'API key' },
] }] }; } }`;
        const issues = checkSensitiveDeclarations({ contributes: { settingsProvider: './settings.js' } }, [{ file: 'settings.js', source }]);
        expect(errors(issues).some((issue) => issue.message.includes('config.token'))).toBe(true);
        expect(errors(issues).some((issue) => issue.message.includes('config.connection'))).toBe(true);
        expect(issues.filter((issue) => issue.severity === 'warn')).toHaveLength(2);
    });

    it.each(['_locales/payload.js', '.lib/payload.js'])('scans shipped module %s for storage, eval and remote imports', async (file) => {
        const dir = fixture({
            'search.js': `import './${file}';`,
            [file]: `context.invoke('save_extension_data', { key: 'token', data: input });\neval(input);\nimport('https://example.org/code.js');`,
        });
        expect((await checkExtension(dir)).map((issue) => issue.pattern)).toEqual(expect.arrayContaining([
            'undeclared-sensitive-data', 'eval', 'remote-import',
        ]));
    });

    it.each(['_locales/store.js', '.lib/store.js', 'store.test.js', 'store.spec.js'])('catches the original imported-store mutation at %s', async (file) => {
        const dir = fixture({
            'search.js': `import { bind, persist } from './${file}'; export default class Search {
initialize(context) { bind(context); this.persist = persist; }
}`,
            [file]: `let ctx;
export function bind(c) { ctx = c; }
export function persist(accessToken) { return ctx.invoke('save_extension_data', { key: 'token', data: JSON.stringify({ accessToken }) }); }`,
        });
        expect(errors(await checkExtension(dir)).length).toBeGreaterThan(0);
    });

    it.each(['test', 'spec'])('forbids relative imports and re-exports of excluded .%s.js files', async (suffix) => {
        for (const source of [`import './payload.${suffix}.js';`, `export * from './payload.${suffix}.js';`, `import('./payload.${suffix}.js');`]) {
            const dir = fixture({ 'search.js': source, [`payload.${suffix}.js`]: `export const value = 1;` });
            expect(errors(await checkExtension(dir))).toEqual([
                expect.objectContaining({ message: expect.stringContaining('not an analyzed module') }),
            ]);
        }
    });

    it('packages hidden/locales JS and excludes every test/spec module', async () => {
        const dir = fixture({
            'search.js': '',
            'search.test.js': '',
            'deep/payload.spec.js': '',
            '.lib/payload.test.mjs': '',
            '.lib/payload.js': '',
            '_locales/payload.js': '',
            '_locales/en/messages.json': '{}',
        });
        const zip = path.join(root, 'fixture.zip');
        await packageDir(dir, zip);
        const files = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
        expect(files.sort()).toEqual(['.lib/payload.js', '_locales/en/messages.json', '_locales/payload.js', 'manifest.json', 'search.js'].sort());
    });

    it('inventories every real relative import as an analyzed production module', () => {
        let count = 0;
        for (const extension of readdirSync('extensions', { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
            const dir = path.join('extensions', extension.name);
            // Recursive: mindmap keeps its leaf modules in lib/ (paths are posix-relative to the extension root).
            const files = readdirSync(dir, { recursive: true }).map((file) => String(file).split(path.sep).join('/'))
                .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js') && !file.startsWith('_locales/'));
            for (const file of files) {
                const ast = parse(readFileSync(path.join(dir, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
                for (const node of ast.body) {
                    if (!node.source?.value?.startsWith('.')) continue;
                    count++;
                    expect(files).toContain(path.posix.normalize(path.posix.join(path.posix.dirname(file), node.source.value)));
                }
            }
        }
        expect(count).toBe(101);
    });
});
