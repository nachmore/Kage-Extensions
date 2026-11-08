// The settings page (settings.js, SPEC §13).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, makeContext, makeHarness } from '../../test-helpers/mindmap/corpus.mjs';
import { DEFAULTS } from './defaults.js';
import MindMapSettingsProvider from './settings.js';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const HOST_TYPES = new Set(['checkbox', 'text', 'number', 'select', 'range', 'action', 'info']);
const VALUE_TYPES = new Set(['checkbox', 'text', 'number', 'select', 'range']);

const controls = (schema) => schema.sections.flatMap((s) => s.controls);
const byId = (schema, id) => controls(schema).find((c) => c.id === id);

function settingsFor(host, config = {}) {
  const ctx = makeContext(host, { invoke: host.connect().invoke, config });
  const p = new MindMapSettingsProvider();
  p.initialize(ctx);
  return p;
}

let h;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  await buildCorpus(h, { only: ['F1', 'F6', 'F10'] });
  h.at(FIXTURE_NOW);
}, 60_000);
afterAll(() => vi.useRealTimers());

describe('schema', () => {
  it('uses only host control types, and its value controls are exactly the manifest config', async () => {
    const schema = await settingsFor(h.host).getSettings();
    for (const c of controls(schema)) expect(HOST_TYPES.has(c.type), c.type).toBe(true);
    const values = controls(schema).filter((c) => VALUE_TYPES.has(c.type));
    expect(values.map((c) => c.id).sort()).toEqual(Object.keys(manifest.config).sort());
    expect(Object.keys(DEFAULTS).sort()).toEqual(Object.keys(manifest.config).sort());
    for (const c of values) {
      expect(c.default, c.id).toEqual(manifest.config[c.id].default);
      expect(DEFAULTS[c.id], c.id).toEqual(manifest.config[c.id].default);
      expect(c.label, c.id).toBeTruthy();
    }
    expect(controls(schema).some((c) => c.id === 'enabled')).toBe(false);
    expect(manifest.config.enabled).toBeUndefined();
    expect(byId(schema, 'week_start').options.map((o) => o.value)).toEqual(['auto', 'mon', 'sun', 'sat']);
    expect(byId(schema, 'agent_snippet_chars')).toMatchObject({ type: 'number', min: 80, max: 600 });
  });

  it('shows the privacy disclosure, the documents note and the statistics', async () => {
    const schema = await settingsFor(h.host).getSettings();
    const html = controls(schema).filter((c) => c.type === 'info').map((c) => c.html).join('\n');
    expect(html).toContain('Your mind map is stored only on this computer');
    expect(html).toContain('Private items are never sent.');
    expect(html).toContain('export first if you want to keep it');
    expect(html).toContain('Mind Map stores no passwords, keys or other credentials.');
    expect(html).toContain('attach it in chat');
    expect(html).toContain('Screen Recording');
    expect(html).toContain('understood in English today');
    expect(html).toContain('1 meeting');
    expect(html).toContain('4 actions');
    expect(html).toContain('3 open actions');
    expect(html).toContain('1 suggestion to review');
    expect(html).toMatch(/About \d+ KB on disk/);
    expect(html).not.toContain('Repair');
    const actions = controls(schema).filter((c) => c.type === 'action').map((c) => c.id);
    expect(actions).toEqual(['export_json', 'export_md', 'import_json', 'delete_all']);
    expect(byId(schema, 'delete_all')).toMatchObject({ variant: 'danger', confirm: expect.stringContaining('can’t be undone') });
  });

  it('escapes the HTML it builds', async () => {
    const p = settingsFor(h.host);
    p.t = (key) => (key === 'settings.disclosure' ? '<img src=x onerror=alert(1)>' : key);
    const schema = await p.getSettings();
    const html = controls(schema).filter((c) => c.type === 'info').map((c) => c.html).join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('validate and normalize', () => {
  it('validates the trigger, snippet bounds and week start', () => {
    const p = settingsFor(h.host);
    expect(p.validate({ trigger: 'mm', agent_snippet_chars: 280, week_start: 'auto' })).toEqual({ valid: true });
    expect(p.validate({ trigger: 'Brain' })).toEqual({ valid: true });
    for (const trigger of ['', '9mm', 'mind map', 'abcdefghijk', 'mm+']) expect(p.validate({ trigger }).valid, trigger).toBe(false);
    for (const n of [79, 601, 'lots']) expect(p.validate({ agent_snippet_chars: n }).valid, String(n)).toBe(false);
    expect(p.validate({ agent_snippet_chars: '80' }).valid).toBe(true);
    expect(p.validate({ week_start: 'tue' }).valid).toBe(false);
    expect(p.validate({ trigger: '' }).error).toBe('The trigger must be 1 to 10 lowercase letters or digits, starting with a letter.');
  });

  it('normalizes: trims names, lowercases the trigger, keeps only known keys', () => {
    const p = settingsFor(h.host);
    const { values } = p.normalize({ my_names: '  Sam, SJ  ', trigger: ' Brain ', agent_snippet_chars: '300', enabled: false, __tmp: 'x', fetch_link_titles: false });
    expect(values).toEqual({ my_names: 'Sam, SJ', trigger: 'brain', agent_snippet_chars: 300, fetch_link_titles: false });
    // Leaves a current host's manifest defaults as they are.
    expect(p.normalize({ ...DEFAULTS }).values).toEqual({ ...DEFAULTS });
  });
});

describe('actions', () => {
  it('export_json and export_md download files', async () => {
    const p = settingsFor(h.host);
    const json = await p.runAction('export_json');
    expect(json.status).toBe('Exported 7 items');
    expect(json.host).toMatchObject({ type: 'download', filename: 'mindmap-2026-11-06.json', mime: 'application/json' });
    const data = JSON.parse(json.host.content);
    expect(data).toMatchObject({ format: 'kage-mindmap', schema: 1, note: 'This export includes private items. Keep it somewhere safe.' });
    expect(data.items.some((i) => i.private)).toBe(true);
    const md = await p.runAction('export_md');
    expect(md.host).toMatchObject({ type: 'download', filename: 'mindmap-2026-11-06.md', mime: 'text/markdown' });
    expect(md.host.content).toContain('- [ ] Send MTCS numbers to Dana');
    expect(await p.runAction('import_json')).toEqual({ host: { type: 'pick_file', accept: '.json', action: 'import_json' } });
    expect(await p.runAction('nonsense')).toEqual({});
  });

  it('delete_all removes the data and refreshes the page', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    const p = settingsFor(g.host);
    const out = await p.runAction('delete_all');
    expect(out.host).toEqual({ type: 'refresh' });
    expect(out.status).toBe('Deleted your mind map');
    expect([...g.host.files.keys()]).toEqual([]);
    const schema = await p.getSettings();
    expect(controls(schema).find((c) => c.type === 'info' && c.html.includes('0 notes'))).toBeTruthy();
  });

  it('read-only mode shows Export raw copies and Repair, and repair works', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    g.host.corrupt('mm-journal');
    g.host.corrupt('nx-mm-journal');
    const p = settingsFor(g.host);
    const schema = await p.getSettings();
    const ids = controls(schema).map((c) => c.id).filter(Boolean);
    expect(ids).toEqual(expect.arrayContaining(['export_raw', 'repair']));
    expect(byId(schema, 'import_json').disabled).toBe(true);
    expect(byId(schema, 'repair').confirm).toBeTruthy();
    const raw = await p.runAction('export_raw');
    expect(raw.host).toMatchObject({ type: 'download', filename: 'mindmap-raw-2026-11-06.json' });
    expect(JSON.parse(raw.host.content)['nx-mm-journal']).toBeTypeOf('string');
    expect(await p.runAction('repair')).toEqual({ status: 'Repaired', host: { type: 'refresh' } });
    const after = await p.getSettings();
    expect(controls(after).some((c) => c.id === 'repair')).toBe(false);
    expect(await p.runAction('repair')).toEqual({ status: 'Nothing needs repairing', host: { type: 'refresh' } });
  });

  it('imports an export through onFileSelected', async () => {
    const source = settingsFor(h.host);
    const file = (await source.runAction('export_json')).host.content;
    const g = await makeHarness();
    const p = settingsFor(g.host);
    const out = await p.onFileSelected({ action: 'import_json', content: file });
    expect(out.host).toEqual({ type: 'refresh' });
    expect(out.status).toBe('Imported 7 new and 0 updated items. Undo with mm undo.');
    expect(p.mind.state.items.size).toBe(7);
    expect(await p.onFileSelected({ action: 'import_json', content: '{not json' })).toEqual({ status: 'That file isn’t a Mind Map export' });
    expect(await p.onFileSelected({ action: 'other', content: file })).toEqual({});
  });
});
