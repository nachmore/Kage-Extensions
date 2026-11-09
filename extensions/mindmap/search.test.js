// @vitest-environment jsdom
// The launcher provider (search.js): keywords, rows and Enter behaviours.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { F2_WINDOW, FIXTURE_NOW, buildCorpus, captureVia, makeHarness, rowById } from '../../test-helpers/mindmap/corpus.mjs';
import { FILE_FEATURES, fileText, hostError, installFiles } from '../../test-helpers/mindmap/file-host.mjs';
import { AGENT_FEATURES, createAgentHost } from '../../test-helpers/mindmap/agent-host.mjs';
import { makeContext } from '../../test-helpers/mindmap/corpus.mjs';
import MindMapSearchProvider, { splitTrigger } from './search.js';

const hits = (rows) => rows.filter((r) => r.id.startsWith('mm:i:'));
const ROW_ID_RE = /^mm:(?:[a-z]+(?::[a-z]+)?|i:i[0-9a-z]{14}|e:(?:e[0-9a-z]{14}|me))$/;

let h;
let F;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  F = await buildCorpus(h);
}, 60_000);
afterAll(() => vi.useRealTimers());

describe('keywords and trigger parsing', () => {
  it('registers mm, mm+ and mm? with i18n keys, and renames all three', () => {
    const p = new MindMapSearchProvider();
    p.initialize({ ...h.context, config: {} });
    expect(p.getKeywords().map((k) => [k.keyword, k.labelKey, k.descriptionKey, k.acceptsArgs])).toEqual([
      ['mm', 'keyword.find.label', 'keyword.find.desc', true],
      ['mm+', 'keyword.capture.label', 'keyword.capture.desc', true],
      ['mm?', 'keyword.ask.label', 'keyword.ask.desc', true],
    ]);
    p.onConfigUpdate({ trigger: 'brain' });
    expect(p.getKeywords().map((k) => k.keyword)).toEqual(['brain', 'brain+', 'brain?']);
    p.onConfigUpdate({ trigger: 'Not Valid!' });
    expect(p.getKeywords().map((k) => k.keyword)).toEqual(['mm', 'mm+', 'mm?']);
    h.mind.setConfig(h.context.config);
  });

  it('splits the trigger, keeping brain-dump newlines', () => {
    expect(splitTrigger('mm', 'mm')).toEqual({ mode: 'find', rest: '', trailingSpace: false });
    expect(splitTrigger('mm mtc', 'mm')).toEqual({ mode: 'find', rest: 'mtc', trailingSpace: false });
    expect(splitTrigger('mm+ \nline one\nline two', 'mm')).toEqual({ mode: 'capture', rest: '\nline one\nline two', trailingSpace: false });
    expect(splitTrigger('mm? why ', 'mm')).toEqual({ mode: 'ask', rest: 'why ', trailingSpace: true });
    expect(splitTrigger('mmx foo', 'mm')).toBeNull();
    expect(splitTrigger('todo foo', 'mm')).toBeNull();
  });

  it('returns nothing when the extension is disabled', async () => {
    const p = new MindMapSearchProvider();
    p.initialize({ ...h.context, config: { enabled: false } });
    expect(p.match('mm')).toEqual([]);
    expect(await p.matchAsync('mm')).toEqual([]);
  });
});

describe('capture rows', () => {
  it('previews and saves a capture, returning an op card', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    const rows = g.search.match('mm+ todo: email the bingo team about the demo date');
    // The first keystroke starts loading and already previews the capture.
    const row = rowById(rows, 'mm:capture');
    expect(row).toMatchObject({ label: 'Save to Mind Map', score: 95, data: { a: 'capture', text: 'todo: email the bingo team about the demo date' } });
    expect(row.description).toBe('☐ action · Bingo');
    const out = await g.search.execute(row);
    expect(out.type).toBe('display');
    expect(out.value).toMatch(/^🧠 Saved “email the bingo team about the demo date”\n\n\[mm-card:op:o[0-9a-z]{14}\]$/);
    expect(g.mind.state.items.size).toBe(1);
  });

  it('marks private previews and escapes Markdown in the display line', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    await g.mind.ready();
    expect(rowById(g.search.match('mm+ ! salary *thoughts*'), 'mm:capture').description).toContain('🔒 private');
    const out = await g.search.execute({ id: 'mm:capture', data: { a: 'capture', text: '<b>bold</b> *stars* [link](x)' } });
    const line = out.value.split('\n\n')[0];
    expect(line).not.toMatch(/[<>]/);
    expect(line).toContain('\\*stars\\*');
  });

  it('mm+ alone offers the source window (when it has a title) and the hint', async () => {
    h.sourceWindow = F2_WINDOW;
    let rows = await h.search.matchAsync('mm+');
    expect(rows.map((r) => r.id)).toEqual(['mm:window', 'mm:hint']);
    expect(rows[0].label).toBe('Save the window you came from: “MTCS rollout plan.docx” — Microsoft Word');
    expect(rows[0].data).toEqual({ a: 'window', title: 'MTCS rollout plan.docx - Word', app: 'Microsoft Word' });

    h.sourceWindow = { title: '', processName: 'Microsoft Word' };
    rows = await h.search.matchAsync('mm+ ');
    expect(rows.map((r) => r.id)).toEqual(['mm:hint']);
    h.sourceWindow = { title: 'Microsoft Word', processName: 'Microsoft Word' };
    expect((await h.search.matchAsync('mm+')).map((r) => r.id)).toEqual(['mm:hint']);
    h.sourceWindow = null;
    expect(rowById(h.search.match('mm+'), 'mm:hint').label).toBe('Type or paste anything to save');
  });

  it('a slow get_source_window never blocks the rows', async () => {
    const g = await makeHarness();
    await g.mind.ready();
    g.host.calls.length = 0;
    const slow = new Promise(() => {});
    g.context.invoke = async (command, args) => (command === 'get_source_window' ? slow : g.host.invoke(command, args));
    const p = new MindMapSearchProvider();
    p.initialize(g.context);
    const start = performance.now();
    expect((await p.matchAsync('mm+')).map((r) => r.id)).toEqual(['mm:hint']);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('loading and matchAsync', () => {
  it('shows a loading row first, real rows from matchAsync, then [] while nothing changed', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    // A second window that hasn't loaded yet.
    const { default: Search } = await import('./search.js');
    const ctx = { ...g.context, invoke: g.host.connect().invoke };
    const p = new Search();
    p.initialize(ctx);
    expect(p.match('mm bingo')).toEqual([expect.objectContaining({ id: 'mm:loading', label: 'Loading your mind map…' })]);
    const rows = await p.matchAsync('mm bingo');
    expect(hits(rows)).toHaveLength(1);
    expect(p.match('mm bingo').map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(await p.matchAsync('mm bingo')).toEqual([]);
  });

  it('a load failure says so instead of hanging', async () => {
    const g = await makeHarness();
    const ctx = { ...g.context, invoke: async () => { throw new Error('host gone'); } };
    const p = new MindMapSearchProvider();
    p.initialize(ctx);
    const rows = await p.matchAsync('mm walrus');
    expect(rows.map((r) => r.id)).toEqual(['mm:loaderror']);
  });

  it('the home rows (bare mm) never serialize the store to size it', () => {
    // Sizing the store stringifies every part: ~100 ms per keystroke at
    // 10,000 items, against match()'s 10 ms budget (SPEC §17). Settings
    // still shows the size.
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const rows = h.search.match('mm');
      expect(rowById(rows, 'mm:home:actions').label).toMatch(/^\d+ open actions/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(h.mind.stats().bytes).toBeGreaterThan(1000);
    expect(h.mind.stats({ size: false })).toMatchObject({ items: h.mind.state.items.size, bytes: null });
  });
});

describe('row ids', () => {
  it('never carry user text (fuzz)', async () => {
    const words = ['mtcs', 'bingo', 'dana', 'zebra', 'salary', 'walrus', 'doc', 'last week', 'yesterday', 'actions', 'review', 'recent',
      'undo', 'help', 'map', '@bingo', '#mtcs', 'kind:doc', 'is:open', 'owner:anyone', '"exact phrase"', '-term', 'Q4', 'in october',
      'é', '中文', '<b>', '../', 'mm:i:x', '\n- [ ] dump line'];
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let n = 0; n < 150; n++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => words[Math.floor(rand() * words.length)]).join(' ');
      const mode = ['mm ', 'mm+ ', 'mm? '][n % 3];
      for (const row of h.search.match(mode + text)) {
        expect(row.id, `${mode}${text}`).toMatch(ROW_ID_RE);
        expect(row.type).toBe('mindmap');
      }
    }
  });
});

describe('Enter behaviours', () => {
  it('opens links, focuses or copies docs, and shows cards for the rest', async () => {
    h.opened.length = 0;
    expect(await h.search.execute({ id: `mm:i:${F.F4}`, data: { a: 'open', id: F.F4 } })).toBeNull();
    expect(h.opened).toEqual(['https://example.com/blog/mtcs-intro']);

    h.openWindows = [];
    expect(await h.search.execute({ id: `mm:i:${F.F3}`, data: { a: 'open', id: F.F3 } }))
      .toEqual({ type: 'copy', value: '~/Documents/MTCS capacity notes.pdf' });
    h.openWindows = [{ handle: 7, title: 'MTCS capacity notes.pdf - Preview', process_name: 'Preview' }];
    h.focused.length = 0;
    expect(await h.search.execute({ id: `mm:i:${F.F3}`, data: { a: 'open', id: F.F3 } })).toBeNull();
    expect(h.focused).toEqual([7]);
    h.openWindows = [];

    const note = await h.search.execute({ id: `mm:i:${F.F5}`, data: { a: 'open', id: F.F5 } });
    expect(note).toEqual({ type: 'display', value: `📝 Lunch with Dana, talked about MTCS hiring\n\n[mm-card:item:${F.F5}]` });
    // Ids that aren't item ids are ignored.
    expect(await h.search.execute({ id: 'mm:i:x', data: { a: 'open', id: '../etc' } })).toBeNull();
  });

  it('toggles actions and refreshes the same query', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    g.at(FIXTURE_NOW);
    const query = 'mm actions';
    const row = hits(g.search.match(query))[0];
    expect(row.data).toEqual({ a: 'toggle', id: F.F7 === undefined ? row.data.id : row.data.id, query });
    expect(await g.search.execute(row)).toEqual({ type: 'replace_input', value: query });
    expect(g.mind.item(row.data.id).status).toBe('done');
    expect(await g.search.execute(hits(g.search.match(query))[0])).toEqual({ type: 'replace_input', value: query });
    expect(g.mind.item(row.data.id).status).toBe('open');
  });

  it('mm review lists suggestions and Enter accepts one', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F6'] });
    g.at(FIXTURE_NOW);
    const rows = g.search.match('mm review');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Dana to share the roadmap deck');
    expect(rows[0].icon).toBe('❔');
    expect(rows[0].data.a).toBe('accept');
    await g.search.execute(rows[0]);
    expect(g.mind.item(rows[0].data.id).suggested).toBe(false);
    expect(g.search.match('mm review').map((r) => r.id)).toEqual(['mm:review:none']);
  });

  it('mm @entity shows the header, its items and related entities to walk to', async () => {
    const rows = h.search.match('mm @bingo');
    expect(rows[0].id).toMatch(/^mm:e:e[0-9a-z]{14}$/);
    expect(rows[0].label).toBe('Bingo (team)');
    expect(rows[0].description).toMatch(/^4 open actions · 1 suggested · /);
    const related = rows.filter((r) => r.id.startsWith('mm:e:') && r !== rows[0]);
    expect(related.map((r) => r.label)).toEqual(expect.arrayContaining(['Dana (person)']));
    const dana = related.find((r) => r.label === 'Dana (person)');
    expect(await h.search.execute(dana)).toEqual({ type: 'replace_input', value: 'mm @dana' });
    // The exact entity name works as well as the marker.
    expect(h.search.match('mm bingo')[0].id).toBe(rows[0].id);
  });

  it('mm recent, mm help and refine rows', async () => {
    const recent = h.search.match('mm recent');
    expect(hits(recent).length).toBe(10);
    expect(hits(recent)[0].id).toBe(`mm:i:${F.F10}`);
    const help = await h.search.execute(h.search.match('mm help')[0]);
    // The P2 commands the help card doesn't list follow it as one line.
    expect(help).toEqual({
      type: 'display',
      value: '🧠 Mind Map — quick reference\n\n[mm-card:help]\n\n'
        + 'More: `mm organize` · `mm archive …` · `mm archived` · `mm merge @a into @b` · `mm rename @a to …` · `mm forget @a`',
    });
    const prefix = h.search.match('mm mtc');
    expect(hits(prefix).length).toBeGreaterThanOrEqual(4);
  });

  it('undoing an op a later change superseded is refused with the reason', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    g.at(FIXTURE_NOW);
    const id = g.mind.recent(1)[0].id;
    const capture = g.mind.undoTarget().op.opId;
    await g.mind.setStatus(id, 'done');
    // The capture's card still offers Undo; the item changed since.
    const out = await g.search.execute({ id: 'mm:undo', data: { a: 'undo', opId: capture } });
    expect(out.value).toBe('↶ Can’t undo: a later change touched the same items');
    expect(g.mind.item(id).status).toBe('done');
    // mm undo targets the newest op, which still works.
    const rows = g.search.match('mm undo');
    expect(rows[0].label).toBe('Undo: Marked “email the bingo team about the demo date” done');
    expect(rows[0].data.a).toBe('undo');
  });
});

describe('formatter actions (onResultAction)', () => {
  it('routes data verbs to the mind and repaints', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F7'] });
    g.at(FIXTURE_NOW);
    const id = g.mind.recent(1)[0].id;
    // Data actions are bound to a card this window rendered (mm:b<blk>:a:…).
    const fmt = { streaming: false };
    const blkOf = (html) => / mm-b([0-9a-z]+) mm-r/.exec(html)[1];
    let html = await g.formatter.format(`<p>[mm-card:item:${id}]</p>`, fmt);
    const card = blkOf(html);
    const act = (verb, target = id, blk = card) => `mm:b${blk}:a:${verb}:${target}`;
    // Each click repaints the card (as the host's reformat pass does), so the
    // next button is the one now on screen.
    const press = async (action) => {
      html = (await g.formatter.format(html, fmt)) ?? html;
      return g.search.onResultAction(action, { resultId: null });
    };
    g.context.formatter.requestReformat.mockClear();
    expect(await press(act('done'))).toEqual({});
    expect(g.mind.item(id).status).toBe('done');
    expect(g.context.formatter.requestReformat).toHaveBeenCalled();
    // A button the card doesn't show (it says Reopen now, not Done) does nothing.
    await press(act('done'));
    await press(act('reopen'));
    expect(g.mind.item(id).status).toBe('open');
    await press(act('private'));
    expect(g.mind.item(id).private).toBe(true);
    await press(act('share'));
    expect(g.mind.item(id).private).toBeUndefined();
    await press(act('dismiss'));
    expect(g.mind.item(id).status).toBe('dismissed');
    const undoOp = g.mind.undoTarget().op.opId;
    const opCard = blkOf(await g.formatter.format(`<p>[mm-card:op:${undoOp}]</p>`, fmt));
    // Undo only from that op's own card.
    await press(act('undo', undoOp));
    expect(g.mind.item(id).status).toBe('dismissed');
    await press(act('undo', undoOp, opCard));
    expect(g.mind.item(id).status).toBe('open');
    await press(act('delete'));
    expect(g.mind.item(id)).toBeNull();
  });

  it('refuses data actions no rendered card offers (a button in the agent’s own reply)', async () => {
    const g = await makeHarness();
    const F = await buildCorpus(g, { only: ['F6', 'F7', 'F10'] });
    g.at(FIXTURE_NOW);
    expect(g.mind.item(F.F10).private).toBe(true);
    // The agent writes a fake chip next to a real citation; the formatter
    // turns the citation into a chip and the host wires the whole message.
    const agent = `<p>See [mm:${F.F7}] and <button type="button" class="mm-cite" data-ext-action="mm:a:share:${F.F10}">[2] Sources</button></p>`;
    await g.formatter.format(agent, { streaming: false });
    for (const forged of [`mm:a:share:${F.F10}`, `mm:a:delete:${F.F6}`, `mm:b1:a:share:${F.F10}`, `mm:bzz9:a:delete:${F.F6}`]) {
      expect(await g.search.onResultAction(forged)).toEqual({});
    }
    // A real card for F7 can't act on F10 either.
    const html = await g.formatter.format(`<p>[mm-card:item:${F.F7}]</p>`, { streaming: false });
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(html)[1];
    await g.search.onResultAction(`mm:b${blk}:a:share:${F.F10}`);
    await g.search.onResultAction(`mm:b${blk}:a:delete:${F.F6}`);
    expect(g.mind.item(F.F10).private).toBe(true);
    expect(g.mind.item(F.F6)).not.toBeNull();
    expect((await g.tools.execute('get', { id: F.F10 })).result.error).toBe('private');
  });

  it('ignores junk and routes card navigation to the UI state', async () => {
    const g = await makeHarness();
    await g.mind.ready();
    g.context.formatter.requestReformat.mockClear();
    for (const junk of [null, 42, '', 'mm:a:done:../x', 'MM:A:DONE:x', 'mm:a:explode:i0000000000000a', 'other:thing', `mm:${'a'.repeat(80)}`]) {
      expect(await g.search.onResultAction(junk)).toEqual({});
    }
    expect(g.context.formatter.requestReformat).not.toHaveBeenCalled();
    await g.search.onResultAction('mm:c1:x:1:i0000000000000a');
    expect(g.context.formatter.requestReformat).toHaveBeenCalledTimes(1);
  });
});

describe('map and ask rows (P1)', () => {
  it('mm map: overview, entity, item id, words (with kinds and highlights) and a miss', async () => {
    const overview = rowById(h.search.match('mm map'), 'mm:map');
    expect(overview).toMatchObject({ icon: '🗺️', label: 'Map overview', description: 'Shows the map — click a node to move there', score: 95, data: { a: 'map', ref: 'o' } });
    expect(await h.search.execute(overview)).toEqual({ type: 'display', value: '🗺️ Overview\n\n[mm-card:map:o]' });

    const dana = h.mind.resolveEntity('dana', null).entityId;
    expect(rowById(h.search.match('mm map @dana'), 'mm:map')).toMatchObject({ label: 'Map: Dana', data: { a: 'map', ref: dana } });
    expect(rowById(h.search.match(`mm map ${F.F6}`), 'mm:map')).toMatchObject({ label: 'Map: Bingo team sync', data: { a: 'map', ref: F.F6 } });

    const words = rowById(h.search.match('mm map kind:doc rollout plan'), 'mm:map');
    expect(words.data).toEqual({ a: 'map', ref: F.F2, kinds: ['doc'], highlight: ['rollout', 'plan'] });
    expect((await h.search.execute(words)).value).toBe(`🗺️ MTCS rollout plan.docx\n\n[mm-card:map:${F.F2}]`);

    const miss = rowById(h.search.match('mm map zeppelin hangar'), 'mm:map');
    expect(miss).toMatchObject({ label: 'Map overview', description: 'Nothing matched “zeppelin hangar” — showing the overview' });
  });

  it('the display line escapes Markdown in the name', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    const out = await g.mind.capture('Notes on *stars* and [links](x) <b>', { via: 'launcher' });
    const shown = await g.search.execute(rowById(g.search.match(`mm map ${out.itemId}`), 'mm:map'));
    expect(shown.value.split('\n\n')[0]).toBe('🗺️ Notes on \\*stars\\* and \\[links\\]\\(x\\) b');
  });

  it('mm?: a hint when empty; otherwise one row whose Enter sends the visible prompt', async () => {
    expect(h.search.match('mm?')).toEqual([expect.objectContaining({ id: 'mm:askhint', data: { a: 'noop' } })]);
    const long = `which doc spoke about mtcs last week ${'and more words '.repeat(10)}`.trim();
    const [row] = h.search.match(`mm? ${long}\nsecond line`);
    expect(row.id).toBe('mm:askgo');
    expect(row.label.length).toBeLessThan(110);
    expect(row.data).toEqual({ a: 'ask', question: `${long} second line` });
    const out = await h.search.execute(row);
    expect(out.type).toBe('prompt');
    expect(out.value).toContain(`Question: ${long} second line`);
    expect(out.value).toMatch(/\[mm:i[0-9a-z]{14}\]/);
    // A custom trigger renames the ask keyword too.
    const custom = new MindMapSearchProvider();
    custom.initialize({ ...h.context, config: { ...h.context.config, trigger: 'brain' } });
    expect(custom.match('brain? mtcs')[0].id).toBe('mm:askgo');
    expect(rowById(custom.match('brain mtcs design'), 'mm:ask').data).toEqual({ a: 'fill', value: 'brain? mtcs design' });
  });
});

// --- documents from a file (Kage EXTENSION_FILE_TEXT §11.2 C9, C12) ------------------

const DOC_TEXT = [
  '# Q3 plan',
  'Dana to send the MTCS numbers by Friday.',
  ...Array.from({ length: 200 }, (_, i) => `Paragraph ${i} covers the walrus roadmap and the budget.`),
  'The Zanzibar pilot starts in spring.',
].join('\n');

async function fileHarness() {
  const g = await makeHarness({ atomic: true, hostFeatures: FILE_FEATURES });
  const fake = installFiles(g.context);
  g.at(FIXTURE_NOW);
  await g.mind.ready();
  return { g, ...fake };
}

describe('documents from a file', () => {
  it('offers Add a file… only where Kage reads files', async () => {
    const plain = await makeHarness();
    await plain.mind.ready();
    expect((await plain.search.matchAsync('mm+')).map((r) => r.id)).not.toContain('mm:file');
    expect(plain.search.match('mm+ file').map((r) => r.id)).toEqual(['mm:capture']);
    expect(plain.search.match('mm add file').map((r) => r.id)).not.toContain('mm:file');
    const { g } = await fileHarness();
    const empty = await g.search.matchAsync('mm+');
    expect(rowById(empty, 'mm:file')).toMatchObject({ icon: '📄', label: 'Add a file…', description: 'Text, Markdown, PDF or Word. Kage reads it on this computer.', data: { a: 'file' } });
    expect(g.search.match('mm+ file').map((r) => r.id)).toEqual(['mm:file', 'mm:capture']);
    expect(g.search.match('mm+ a file').map((r) => r.id)).toEqual(['mm:file', 'mm:capture']);
    expect(g.search.match('mm add file').map((r) => r.id)).toEqual(['mm:file']);
    expect(g.search.match('mm+ file the expense report').map((r) => r.id)).toEqual(['mm:capture']);
  });

  it('Enter adds the file and shows its card; cancelling shows and saves nothing; refusals say why', async () => {
    const { g, queue } = await fileHarness();
    const row = rowById(await g.search.matchAsync('mm+'), 'mm:file');
    queue(fileText(DOC_TEXT, { pageCount: 3 }));
    const out = await g.search.execute(row);
    expect(out.type).toBe('display');
    expect(out.value).toMatch(/^🧠 Added “Q3 plan”\n\n\[mm-card:op:o[0-9a-z]{14}\]$/);
    const html = await g.formatter.format(`<p>${out.value.split('\n\n')[1]}</p>`, { streaming: false });
    expect(html).toContain('✓ Added Q3 plan.pdf: 3 pages, ');
    expect(html).toContain('Found ');
    const before = g.mind.stats().items;
    queue(null);
    expect(await g.search.execute(row)).toBeNull();
    expect(g.mind.stats().items).toBe(before);
    queue(hostError('errors.file_text.too_large', 'Big.pdf is 48.2 MB. Kage reads files up to 32 MB.'));
    expect((await g.search.execute(row)).value).toBe('⚠️ Big.pdf is 48.2 MB. Kage reads files up to 32 MB. Try a smaller copy, or save part of it as a PDF.');
    // The same file again: the card it already is.
    queue(fileText(DOC_TEXT, { pageCount: 3 }));
    const again = await g.search.execute(row);
    expect(again.value).toMatch(/^🧠 Already in your mind map \\\(added .+\\\)\n\n\[mm-card:item:i[0-9a-z]{14}\]$/);
    // mm undo names it.
    expect(rowById(g.search.match('mm undo'), 'mm:undo').label).toBe('Undo: Added “Q3 plan”');
  });

  it('a doc row shows its file, pages and day, and a passage when only the body matched', async () => {
    const { g, queue } = await fileHarness();
    queue(fileText(DOC_TEXT, { pageCount: 4 }));
    const { value } = await g.search.execute(rowById(await g.search.matchAsync('mm+'), 'mm:file'));
    expect(value).toContain('[mm-card:op:');
    const id = g.mind.recent(1)[0].id;
    const walrus = rowById(await g.search.matchAsync('mm walrus'), `mm:i:${id}`);
    expect(walrus.description).toMatch(/^Q3 plan\.pdf · 4 pages · added Fri, Nov 6/);
    // "zanzibar" is only past the item's first 8,000 characters. Another
    // window hasn't read the body yet: match() can't show the passage, and
    // matchAsync reads it and does.
    const other = new MindMapSearchProvider();
    other.initialize(makeContext(g.host, { invoke: g.host.connect().invoke, hostFeatures: FILE_FEATURES }));
    await other.mind.ready();
    expect(rowById(other.match('mm zanzibar'), `mm:i:${id}`).description).not.toContain('Zanzibar pilot');
    const rows = await other.matchAsync('mm zanzibar');
    expect(rowById(rows, `mm:i:${id}`).description).toMatch(/p\. 4: …[^·]*Zanzibar pilot/);
    expect(rowById(other.match('mm zanzibar'), `mm:i:${id}`).description).toContain('Zanzibar pilot');
    // The window that added it already has it.
    expect(rowById(g.search.match('mm zanzibar'), `mm:i:${id}`).description).toContain('Zanzibar pilot');
  });

  it('Update from file… on a doc card re-reads it, and the card says how it went', async () => {
    const { g, queue, calls } = await fileHarness();
    queue(fileText(DOC_TEXT));
    await g.search.execute(rowById(await g.search.matchAsync('mm+'), 'mm:file'));
    const id = g.mind.recent(1)[0].id;
    const fmt = { streaming: false };
    let html = await g.formatter.format(`<p>[mm-card:item:${id}]</p>`, fmt);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(html)[1];
    expect(html).toContain(`mm:b${blk}:a:update:${id}`);
    queue(fileText('A short replacement about the budget.', { ref: 'B', name: 'Q3 plan v2.pdf' }));
    expect(await g.search.onResultAction(`mm:b${blk}:a:update:${id}`)).toEqual({});
    expect(g.mind.item(id).text).toBe('A short replacement about the budget.');
    html = (await g.formatter.format(html, fmt)) ?? html;
    expect(html).toContain('Updated Q3 plan v2.pdf: ');
    // A refusal shows on the card; a cancel changes nothing.
    queue(hostError('errors.file_text.encrypted', 'Q3 plan v2.pdf is password-protected. Remove the password and try again.'));
    await g.search.onResultAction(`mm:b${blk}:a:update:${id}`);
    html = (await g.formatter.format(html, fmt)) ?? html;
    expect(html).toContain('is password-protected');
    queue(null);
    await g.search.onResultAction(`mm:b${blk}:a:update:${id}`);
    expect(g.mind.item(id).text).toBe('A short replacement about the budget.');
    // A forged update for an item the card doesn't show opens no dialog.
    const other = await g.mind.capture('a plain note about lunch');
    const n = calls.length;
    await g.search.onResultAction(`mm:b${blk}:a:update:${other.itemId}`);
    expect(calls).toHaveLength(n);
  });
});

describe('background organizing on a card (EXTENSION_AGENT_CALLS §11.6)', () => {
  it('Undo organizing on an item card takes the batch back; mm undo still targets the capture', async () => {
    const g = await makeHarness({ atomic: true, hostFeatures: AGENT_FEATURES, config: { background_organize: true } });
    const agent = createAgentHost();
    agent.install(g.context);
    g.at(FIXTURE_NOW - 3_600_000);
    await g.mind.ready();
    await g.mind.whenOrganized();
    const id = (await g.mind.capture('Lunch with Dana about the hiring plan and the offsite budget for spring.')).itemId;
    g.at(FIXTURE_NOW);
    agent.reply((request) => ({ json: { items: request.input.notes.map((n) => ({ ref: n.ref, summary: 'Hiring plan lunch with Dana.' })) } }));
    expect(await g.mind.organizeTick()).toMatchObject({ ok: true, organized: 1 });
    const fmt = { streaming: false };
    let html = await g.formatter.format(`<p>[mm-card:item:${id}]</p>`, fmt);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(html)[1];
    const opId = g.mind.itemVM(id).organized.opId;
    expect(html).toContain('✦ Organized by your agent');
    expect(html).toContain(`mm:b${blk}:a:undo:${opId}`);
    expect(g.mind.undoTarget().op.created.items).toContain(id);
    expect(await g.search.onResultAction(`mm:b${blk}:a:undo:${opId}`)).toEqual({});
    expect(g.mind.item(id).summary).toBeUndefined();
    expect(g.mind.item(id).org.state).toBe('done');
    html = (await g.formatter.format(html, fmt)) ?? html;
    expect(html).not.toContain('Organized by your agent');
  });
});
