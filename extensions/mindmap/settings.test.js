// The settings page (settings.js, SPEC §13).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, makeContext, makeHarness } from '../../test-helpers/mindmap/corpus.mjs';
import { FILE_FEATURES, fileText, hostError, installFiles } from '../../test-helpers/mindmap/file-host.mjs';
import { createMemoryHost } from '../../test-helpers/mindmap/memory-host.mjs';
import { AGENT_FEATURES, createAgentHost } from '../../test-helpers/mindmap/agent-host.mjs';
import { LIMITS } from './defaults.js';
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
    expect(md.status).toBe('Exported 7 items as Markdown');
    expect(md.host).toMatchObject({ type: 'download', filename: 'mindmap-2026-11-06.md', mime: 'text/markdown' });
    expect(md.host.content).toContain('  - [ ] Send MTCS numbers to Dana');
    expect(md.host.content).toContain('· bingo salary thoughts · private');
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

// --- Documents (Kage EXTENSION_FILE_TEXT §11.1, C10) -----------------------------------

const LONG_DOC = ['# Q3 plan', 'Dana to send the MTCS numbers by Friday.', ...Array.from({ length: 200 }, (_, i) => `Paragraph ${i} covers the walrus roadmap and the budget.`)].join('\n');

function fileSettings({ hostFeatures = FILE_FEATURES, files = true, config = {} } = {}) {
  const host = createMemoryHost({ atomic: true });
  const ctx = makeContext(host, { config, hostFeatures });
  const fake = files ? installFiles(ctx) : null;
  const p = new MindMapSettingsProvider();
  p.initialize(ctx);
  return { host, ctx, p, ...fake };
}

const section = (schema, label) => schema.sections.find((x) => x.label === label);

describe('documents', () => {
  it('shows the Documents section, the disclosure and the limit only where Kage reads files', async () => {
    const { p } = fileSettings();
    const schema = await p.getSettings();
    const docs = section(schema, 'Documents');
    expect(docs.controls.map((c) => c.id || c.type)).toEqual(['add_file', 'doc_max_chars', 'info']);
    expect(byId(schema, 'add_file')).toMatchObject({ type: 'action', label: 'Add a file…', variant: 'primary' });
    expect(byId(schema, 'doc_max_chars')).toMatchObject({ type: 'select', default: '200000' });
    expect(byId(schema, 'doc_max_chars').options).toEqual([
      { value: '50000', label: '50,000' }, { value: '200000', label: '200,000' }, { value: '1000000', label: '1,000,000' },
    ]);
    expect(docs.controls[2].html).toBe('<p>Document storage: 0 of 64 MB</p>');
    const privacy = section(schema, 'Privacy').controls[0].html;
    expect(privacy).toContain('Mind Map keeps up to 200,000 characters of it with your notes. Kage never tells Mind Map where the file is.');
    // The old "never reads files" note is gone here.
    expect(controls(schema).some((c) => c.type === 'info' && c.html.includes('attach it in chat'))).toBe(false);
    // Documents sits before "Your data".
    expect(schema.sections.map((x) => x.label).slice(-2)).toEqual(['Documents', 'Your data']);
  });

  it('elsewhere: no file rows; older hosts keep a hidden copy of the limit, current ones need none', async () => {
    const old = await fileSettings({ hostFeatures: [], files: false }).p.getSettings();
    expect(section(old, 'Documents')).toBeUndefined();
    expect(byId(old, 'add_file')).toBeUndefined();
    expect(byId(old, 'doc_max_chars')).toMatchObject({ showWhen: { id: 'doc_max_chars', oneOf: [] }, default: '200000' });
    const current = await fileSettings({ hostFeatures: ['config.manifest_defaults'], files: false }).p.getSettings();
    expect(byId(current, 'doc_max_chars')).toBeUndefined();
    // Approved later (files.pick_text without context.files is still off).
    const half = await fileSettings({ files: false }).p.getSettings();
    expect(byId(half, 'add_file')).toBeUndefined();
  });

  it('Add a file… adds the doc and says what it held; cancelling says nothing; refusals say why', async () => {
    const { p, queue, calls } = fileSettings({ config: { doc_max_chars: '50000' } });
    queue(fileText(LONG_DOC, { pageCount: 2 }));
    const out = await p.runAction('add_file');
    expect(out.host).toEqual({ type: 'refresh' });
    expect(out.status).toMatch(/^Added Q3 plan\.pdf: 2 pages, [\d,]+ characters\. Found /);
    expect(calls[0].maxChars).toBe(50000);
    const schema = await p.getSettings();
    expect(section(schema, 'Documents').controls[2].html).toMatch(/Document storage: 0(\.\d)? of 64 MB/);
    expect(controls(schema).find((c) => c.type === 'info' && c.html.includes('1 doc'))).toBeTruthy();
    queue(null);
    expect(await p.runAction('add_file')).toEqual({});
    queue(hostError('errors.file_text.unsupported', 'Kage can’t read .key files here. It reads: .txt, .md, .pdf, .docx', 'invalid_input'));
    expect(await p.runAction('add_file')).toEqual({ status: 'Kage can’t read .key files here. It reads: .txt, .md, .pdf, .docx' });
    // The export carries the documents' full text.
    const data = JSON.parse((await p.runAction('export_json')).host.content);
    expect(Object.values(data.bodies || {})).toEqual([LONG_DOC]);
  });

  it('warns when document storage is nearly full', async () => {
    const { p, queue } = fileSettings();
    queue(fileText(LONG_DOC));
    const out = await p.mind.addFile();
    p.mind.item(out.itemId).body.bytes = Math.ceil(LIMITS.bodyBudget * 0.95);
    const html = section(await p.getSettings(), 'Documents').controls[2].html;
    expect(html).toContain('Document storage: 60.8 of 64 MB');
    expect(html).toContain('Document storage is almost full.');
  });

  it('validates and normalizes the character limit (a select stores a string)', () => {
    const { p } = fileSettings();
    expect(p.validate({ doc_max_chars: '1000000' })).toEqual({ valid: true });
    expect(p.validate({ doc_max_chars: 200000 })).toEqual({ valid: true });
    expect(p.validate({ doc_max_chars: '123' })).toEqual({ valid: false, error: 'Choose one of the listed limits.' });
    expect(p.normalize({ doc_max_chars: '1000000' }).values).toEqual({ doc_max_chars: '1000000' });
    expect(p.normalize({ doc_max_chars: 50000 }).values).toEqual({ doc_max_chars: '50000' });
    expect(p.normalize({ doc_max_chars: 'lots' }).values).toEqual({ doc_max_chars: '200000' });
  });
});

// --- Background organizing (Kage EXTENSION_AGENT_CALLS §11.1) ---------------------------

const BG_NOTE = 'Lunch with Dana about the MTCS hiring plan; someone should send the offsite budget around.';

function bgSettings({ hostFeatures = AGENT_FEATURES, access = 'on', agent = true, config = {} } = {}) {
  const host = createMemoryHost({ atomic: true });
  const ctx = makeContext(host, { config: { background_organize: true, ...config }, hostFeatures });
  const fake = agent ? createAgentHost({ access }) : null;
  fake?.install(ctx);
  const p = new MindMapSettingsProvider();
  p.initialize(ctx);
  return { host, ctx, p, agent: fake };
}

const bgSection = (schema) => section(schema, 'Background organizing');
const bgHtml = (schema) => bgSection(schema).controls.filter((c) => c.type === 'info').map((c) => c.html).join('');
const ON = { id: 'background_organize', equals: true };

describe('background organizing', () => {
  it('is off by default: the switch, after Agent, with what it does', async () => {
    expect(DEFAULTS.background_organize).toBe(false);
    // On each computer on its own (Kage sync §12.9 item 6): consent is per computer.
    expect(manifest.config.background_organize).toEqual({ type: 'boolean', default: false, sync: 'machine' });
    const { p } = bgSettings({ config: { background_organize: undefined } });
    const schema = await p.getSettings();
    const labels = schema.sections.map((x) => x.label);
    expect(labels[labels.indexOf('Agent') + 1]).toBe('Background organizing');
    expect(byId(schema, 'background_organize')).toMatchObject({ type: 'checkbox', default: false, label: 'Organize new notes in the background' });
    expect(bgHtml(schema)).toContain('Notes you marked private are never sent.');
  });

  it('on a Kage without it: the switch stays and the status says why; nothing else shows', async () => {
    for (const setup of [{ hostFeatures: [], agent: false }, { hostFeatures: AGENT_FEATURES, agent: false }, { hostFeatures: [] }]) {
      const { p, agent } = bgSettings(setup);
      const schema = await p.getSettings();
      expect(bgSection(schema).controls.map((c) => c.id || c.type)).toEqual(['background_organize', 'info', 'info']);
      expect(bgHtml(schema)).toContain('Update Kage, or approve Mind Map’s Background AI permission in the Store.');
      expect(section(schema, 'Privacy').controls[0].html).not.toContain('background organizing');
      expect(await p.runAction('organize_allow')).toEqual({});
      expect(agent?.calls || []).toEqual([]);
    }
  });

  it('asks Kage for access: Allow on this computer… opens Kage’s dialog', async () => {
    const { p, agent } = bgSettings({ access: 'off' });
    const schema = await p.getSettings();
    expect(bgHtml(schema)).toContain('Kage needs your OK on this computer before Mind Map sends anything to your agent.');
    expect(bgSection(schema).controls.find((c) => c.type === 'info' && c.html.includes('needs your OK')).showWhen).toEqual(ON);
    expect(byId(schema, 'organize_allow')).toMatchObject({ type: 'action', label: 'Allow on this computer…', variant: 'primary', showWhen: ON });
    expect(byId(schema, 'organize_now')).toBeUndefined();
    expect(await p.runAction('organize_allow')).toEqual({ host: { type: 'agent_access' } });
    expect(section(schema, 'Privacy').controls[0].html).toContain('new notes you haven’t marked private are sent to your agent in small batches');
    expect(agent.calls).toEqual([]);
    agent.access = 'consent_stale';
    const stale = await p.getSettings();
    expect(bgHtml(stale)).toContain('Your agent changed. Allow Mind Map again on this computer.');
    expect(byId(stale, 'organize_allow')).toBeTruthy();
  });

  it('with access on: the status, Organize now, and Organize older notes too when there are older notes', async () => {
    const { p, agent } = bgSettings();
    const schema = await p.getSettings();
    expect(bgHtml(schema)).toContain('0 organized · 0 waiting · last run never');
    expect(byId(schema, 'organize_allow')).toBeUndefined();
    expect(byId(schema, 'organize_now')).toMatchObject({ type: 'action', label: 'Organize now', showWhen: ON });
    expect(byId(schema, 'organize_backlog')).toBeUndefined();
    expect(await p.runAction('organize_now')).toEqual({ status: 'Nothing is waiting to be organized.', host: { type: 'refresh' } });
    // A note from a month ago is out of scope until the user asks for it.
    await p.mind.whenOrganized();
    vi.setSystemTime(FIXTURE_NOW - 30 * 86_400_000);
    await p.mind.capture(BG_NOTE);
    vi.setSystemTime(FIXTURE_NOW);
    const older = await p.getSettings();
    expect(byId(older, 'organize_backlog')).toMatchObject({ label: 'Organize older notes too', description: expect.stringMatching(/^1 note is from before you turned this on\./) });
    expect(await p.runAction('organize_backlog')).toEqual({ status: 'Older notes will be organized too, a batch at a time.', host: { type: 'refresh' } });
    await p.mind.whenOrganized();
    expect(agent.requests).toHaveLength(1);
    expect(bgHtml(await p.getSettings())).toContain("<p>1 organized · 0 waiting · last run Nov 6, 2026");
  });

  it('Organize now sends a batch with when: now and says how it went', async () => {
    const { p, agent } = bgSettings();
    await p.getSettings();
    await p.mind.whenOrganized();
    vi.setSystemTime(FIXTURE_NOW - 3_600_000);
    await p.mind.capture(BG_NOTE);
    vi.setSystemTime(FIXTURE_NOW);
    expect(await p.runAction('organize_now')).toEqual({ status: 'Your agent looked at 1 note.', host: { type: 'refresh' } });
    expect(agent.calls.at(-1)).toMatchObject({ when: 'now', outcome: 'ok' });
    // A refusal is Kage's own words; the saved switch off says to save first.
    vi.setSystemTime(FIXTURE_NOW - 3_600_000);
    await p.mind.capture(`${BG_NOTE} Again.`);
    vi.setSystemTime(FIXTURE_NOW);
    agent.refuse = ['paused'];
    expect((await p.runAction('organize_now')).status).toBe('Background AI refused the request (paused).');
    p.onConfigUpdate({ background_organize: false });
    expect(await p.runAction('organize_now')).toEqual({ status: 'Turn on “Organize new notes in the background” and save first.', host: { type: 'refresh' } });
  });

  it('says when it is paused, and warns after a tool attempt', async () => {
    const { p, agent } = bgSettings();
    agent.pausedUntil = new Date(FIXTURE_NOW + 3_600_000).toISOString();
    await p.mind.ready();
    await p.mind._noteToolAttempt();
    const html = bgHtml(await p.getSettings());
    expect(html).toMatch(/Paused until .+\./);
    expect(html).toContain('⚠️ Your agent tried to use a tool while organizing, so Kage stopped the request.');
  });

  it('escapes what it shows', async () => {
    const { p } = bgSettings();
    p.t = (key) => (key === 'settings.organize.about' ? '<img src=x onerror=alert(1)>' : key);
    const html = section(await p.getSettings(), 'settings.section_background').controls.filter((c) => c.type === 'info').map((c) => c.html).join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
