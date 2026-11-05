/**
 * Tests for scripts/check-defaults.mjs, the settings-default drift gate.
 *
 * Each case writes a throwaway extension (manifest.json + settings.js + code)
 * to a temp dir and runs the real checkExtension() over it, the same path CI
 * takes for every folder under extensions/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    checkExtension,
    scanCodeFallbacks,
    shownDefault,
    storedValue,
} from './check-defaults.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'kage-check-defaults-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** Write a fixture extension. `files` maps relative path → contents. */
function fixture({ config, settings, files = {}, catalog }) {
    const dir = path.join(root, `ext-${++seq}`);
    mkdirSync(dir, { recursive: true });
    const contributes = settings ? { settingsProvider: './settings.js' } : {};
    writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ id: `ext-${seq}`, version: '1.0.0', type: 'extension', config, contributes })
    );
    if (settings) writeFileSync(path.join(dir, 'settings.js'), settings);
    if (catalog) {
        mkdirSync(path.join(dir, '_locales', 'en'), { recursive: true });
        writeFileSync(path.join(dir, '_locales', 'en', 'messages.json'), JSON.stringify(catalog));
    }
    for (const [rel, src] of Object.entries(files)) writeFileSync(path.join(dir, rel), src);
    return dir;
}

/** A settings provider whose getSettings() returns `controls` in one section. */
const provider = (controls, extra = '') => `
export default class P {
    initialize(context) {
        this.config = context.config || {};
        this.invoke = context.invoke;
        this.t = context.i18n.t.bind(context.i18n);
    }
    getSettings() {
        const t = this.t;
        return { sections: [{ controls: ${controls} }] };
    }
    ${extra}
}
`;

const messages = async (dir) => (await checkExtension(dir)).map((i) => i.message);

describe('check-defaults — settings control vs manifest default', () => {
    it('passes when every control default equals the manifest default', async () => {
        const dir = fixture({
            config: {
                precision: { type: 'number', default: 2 },
                on: { type: 'boolean', default: true },
                mode: { type: 'string', default: 'b' },
            },
            settings: provider(`[
                { type: 'number', id: 'precision', label: 'P', default: 2 },
                { type: 'checkbox', id: 'on', label: 'On', default: true },
                { type: 'select', id: 'mode', label: 'M', default: 'b',
                  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
                { type: 'info', html: '<p>hi</p>' },
                { type: 'action', id: 'go', label: 'Go', action: 'go' },
            ]`),
        });
        expect(await checkExtension(dir)).toEqual([]);
    });

    it('fails on the Math bug: Settings shows 2, the manifest default is 0', async () => {
        const dir = fixture({
            config: { precision: { type: 'number', default: 0 } },
            settings: provider(`[{ type: 'number', id: 'precision', label: 'P', default: 2 }]`),
        });
        const issues = await checkExtension(dir);
        expect(issues).toHaveLength(1);
        expect(issues[0].file).toBe('settings.js');
        expect(issues[0].message).toMatch(/'precision'.*Settings shows 2.*manifest default 0/);
    });

    it('compares what Settings shows for a control with no explicit default', async () => {
        // checkbox → false, text → '', number → min ?? 0 (host renderer coercion).
        const dir = fixture({
            config: {
                flag: { type: 'boolean', default: true },
                name: { type: 'string', default: '' },
                n: { type: 'number', default: 1 },
            },
            settings: provider(`[
                { type: 'checkbox', id: 'flag', label: 'F' },
                { type: 'text', id: 'name', label: 'N' },
                { type: 'number', id: 'n', label: 'N', min: 1 },
            ]`),
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/'flag'.*Settings shows false.*manifest default true/),
        ]);
    });

    it('flags a control the manifest does not declare', async () => {
        const dir = fixture({
            config: {},
            settings: provider(`[{ type: 'checkbox', id: 'show_icons', label: 'S', default: true }]`),
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/'show_icons'.*no manifest config entry.*"type": "boolean", "default": true/),
        ]);
    });

    it('flags a type mismatch between the control and the manifest', async () => {
        const dir = fixture({
            config: { refresh: { type: 'string', default: '15' } },
            settings: provider(`[{ type: 'number', id: 'refresh', label: 'R', default: 15 }]`),
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/'refresh'.*number control stores a number.*declares type "string"/),
        ]);
    });

    it('flags a select default that is not one of its options', async () => {
        const dir = fixture({
            config: { units: { type: 'string', default: 'kelvin' } },
            settings: provider(`[{ type: 'select', id: 'units', label: 'U', default: 'kelvin',
                options: [{ value: 'metric', label: 'M' }, { value: 'imperial', label: 'I' }] }]`),
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/'units'.*"kelvin" isn't one of its options/),
        ]);
    });

    it('applies normalize() the way Save does (window-walker shows "w", stores "w ")', async () => {
        const normalize = `normalize(values) {
            return { values: { ...values, trigger: String(values.trigger || '').trim() + ' ' } };
        }`;
        const ok = fixture({
            config: { trigger: { type: 'string', default: 'w ' } },
            settings: provider(`[{ type: 'text', id: 'trigger', label: 'T', default: 'w' }]`, normalize),
        });
        expect(await checkExtension(ok)).toEqual([]);

        const drift = fixture({
            config: { trigger: { type: 'string', default: 'x ' } },
            settings: provider(`[{ type: 'text', id: 'trigger', label: 'T', default: 'w' }]`, normalize),
        });
        expect(await messages(drift)).toEqual([
            expect.stringMatching(/'trigger'.*Settings shows "w" \(stored as "w " after normalize\(\)\).*"x "/),
        ]);
    });

    it('skips controls that normalize() drops (action inputs, not config)', async () => {
        const dir = fixture({
            config: { trigger: { type: 'string', default: 'gh' } },
            settings: provider(
                `[
                    { type: 'text', id: 'trigger', label: 'T', default: 'gh' },
                    { type: 'text', id: '__token_input', label: 'Token', default: '' },
                ]`,
                `normalize(values) { const { __token_input, ...rest } = values; return { values: rest }; }`
            ),
        });
        expect(await checkExtension(dir)).toEqual([]);
    });

    it('flags a translated default even when the EN text matches the manifest', async () => {
        const dir = fixture({
            config: { greeting: { type: 'string', default: 'Hello World' } },
            catalog: { 'greeting.default': { message: 'Hello World' } },
            settings: provider(`[{ type: 'text', id: 'greeting', label: 'G', default: t('greeting.default') }]`),
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/'greeting'.*depends on the UI language/),
        ]);
    });

    it('accepts a fixed default with a translated placeholder', async () => {
        const dir = fixture({
            config: { greeting: { type: 'string', default: '' } },
            catalog: { 'greeting.default': { message: 'Hello World' } },
            settings: provider(
                `[{ type: 'text', id: 'greeting', label: t('greeting.label'), default: '',
                    placeholder: t('greeting.default') }]`
            ),
        });
        expect(await checkExtension(dir)).toEqual([]);
    });

    it('runs async getSettings() against a fresh-install host (invoke → null)', async () => {
        const dir = fixture({
            config: { trigger: { type: 'string', default: 'bm' } },
            settings: `
export default class P {
    initialize(context) { this.invoke = context.invoke; }
    async getSettings() {
        const raw = await this.invoke('load_extension_data', { key: 'bookmarks' });
        const count = Object.keys(raw ? JSON.parse(raw) : {}).length;
        return { sections: [{ controls: [
            { type: 'info', html: count + ' saved' },
            { type: 'text', id: 'trigger', label: 'T', default: 'bm' },
        ] }] };
    }
}`,
        });
        expect(await checkExtension(dir)).toEqual([]);
    });

    it('reports a provider that throws instead of crashing the run', async () => {
        const dir = fixture({
            config: {},
            settings: `export default class P { getSettings() { throw new Error('boom'); } }`,
        });
        expect(await messages(dir)).toEqual([
            expect.stringMatching(/couldn't load the settings provider in Node.*boom/),
        ]);
    });

    it('reports a getSettings() that never resolves', async () => {
        const dir = fixture({
            config: {},
            settings: `export default class P { getSettings() { return new Promise(() => {}); } }`,
        });
        const issues = await checkExtension(dir, { timeoutMs: 50 });
        expect(issues.map((i) => i.message)).toEqual([expect.stringMatching(/timed out after 50ms/)]);
    });
});

describe('check-defaults — manifest config sanity', () => {
    it('flags an unsupported type and a default of the wrong type', async () => {
        const dir = fixture({
            config: {
                a: { type: 'integer', default: 1 },
                b: { type: 'number', default: '5' },
                c: { type: 'boolean', default: false },
            },
        });
        const issues = await checkExtension(dir);
        expect(issues.map((i) => `${i.file}: ${i.message}`)).toEqual([
            expect.stringMatching(/^manifest\.json: config\.a\.type must be one of boolean, string, number/),
            expect.stringMatching(/^manifest\.json: config\.b\.default "5" is not a number/),
        ]);
    });
});

describe('check-defaults — code fallbacks', () => {
    const CONFIG = {
        precision: { type: 'number', default: 2 },
        trigger: { type: 'string', default: 'gh' },
        max: { type: 'number', default: 5 },
        on: { type: 'boolean', default: true },
        off: { type: 'boolean', default: false },
    };
    const scan = (src) => scanCodeFallbacks(src, CONFIG).map((f) => `${f.line}: ${f.message}`);

    it('flags a literal ?? / || fallback that disagrees with the manifest', () => {
        expect(scan('const p = this.config.precision ?? 0;')).toEqual([
            expect.stringMatching(/^1: config\.precision \?\? 0 falls back to 0.*manifest default is 2/),
        ]);
        expect(scan(`const t = (this.config.trigger || 'git').toLowerCase();`)).toEqual([
            expect.stringMatching(/config\.trigger \|\| 'git' falls back to "git"/),
        ]);
        expect(scan('const n = Number(this.config?.max) || 10;')).toEqual([
            expect.stringMatching(/config\.max \|\| 10 falls back to 10.*manifest default is 5/),
        ]);
    });

    it('accepts matching literals and non-literal fallbacks', () => {
        expect(
            scan(
                [
                    'const p = this.config.precision ?? 2;',
                    'const p2 = this.config.precision ?? DEFAULTS.precision;',
                    `const t = (this._config?.trigger || 'gh').trim();`,
                    'const h = params.hours ?? this.config?.max ?? 5;',
                    'const ms = this.config.max || 5 * 1000;', // `|| 5000`, not `|| 5`
                    'const u = this.config.unknown ?? 7;', // not a manifest key
                ].join('\n')
            )
        ).toEqual([]);
    });

    it('flags truthiness reads of a default-true boolean', () => {
        const lines = [
            'if (!this.config.on) return null;',
            'if (config.on && x) go();',
            'const label = this.config.on ? a : b;',
            'if (this.config?.on) go();',
            'if (ready && this.config.on) go();',
            'if (!ctx.config.on) return;',
        ];
        expect(scan(lines.join('\n')).map((s) => s.split(':')[0])).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('accepts explicit comparisons for a default-true boolean', () => {
        expect(
            scan(
                [
                    'if (this.config.on !== false) go();',
                    'if (this.config.on === false) return;',
                    'const on = this.config.on ?? true;',
                ].join('\n')
            )
        ).toEqual([]);
    });

    it('flags a default-false boolean compared with false', () => {
        expect(scan('if (this.config.off !== false) go();')).toEqual([
            expect.stringMatching(/config\.off is compared with false.*manifest default is false/),
        ]);
        expect(scan('if (this.config.off) go();')).toEqual([]);
        expect(scan('const off = this.config.off ?? true;')).toEqual([
            expect.stringMatching(/config\.off \?\? true falls back to true/),
        ]);
    });

    it('skips comments and lines marked check-defaults: ignore', () => {
        expect(
            scan(
                [
                    '// this.config.precision ?? 0',
                    ' * if (!this.config.on) …',
                    'const p = this.config.precision ?? 0; // check-defaults: ignore',
                ].join('\n')
            )
        ).toEqual([]);
    });

    it('reports file and line through checkExtension, and skips *.test.js', async () => {
        const dir = fixture({
            config: CONFIG,
            files: {
                'search.js': 'export const a = 1;\nexport const p = (c) => c.config.precision ?? 0;\n',
                'search.test.js': 'const p = this.config.precision ?? 0;\n',
            },
        });
        expect(await checkExtension(dir)).toEqual([
            expect.objectContaining({ file: 'search.js', line: 2 }),
        ]);
    });
});

describe('check-defaults — host value coercion', () => {
    it('mirrors the renderer for unset defaults', () => {
        expect(shownDefault({ type: 'checkbox' })).toBe(false);
        expect(shownDefault({ type: 'text' })).toBe('');
        expect(shownDefault({ type: 'number' })).toBe(0);
        expect(shownDefault({ type: 'range', min: 1, max: 10 })).toBe(1);
        expect(shownDefault({ type: 'number', default: 2 })).toBe(2);
    });

    it('round-trips stored values through the control', () => {
        expect(storedValue({ type: 'text' }, null)).toBe('');
        expect(storedValue({ type: 'number', default: 3 }, '')).toBe(3);
        expect(storedValue({ type: 'number' }, '7')).toBe(7);
        expect(storedValue({ type: 'checkbox' }, 1)).toBe(true);
    });
});
