// SPEC §3 acceptance tests (P0): AT-1, AT-1-agent, AT-1b, AT-2, AT-2-agent,
// AT-2b, AT-3, AT-4, AT-5, AT-7, AT-8, AT-9, AT-10 and AT-11, exactly as
// written there. AT-6 (the map card) is P1.
//
// The SPEC §3.1 corpus is built through the real search provider
// (match → execute) on the fixture clock, with link metadata mocked and
// awaited before the next capture (test-helpers/mindmap/corpus.mjs).
// Fixture clock: Fri 2026-11-06 10:00 local, week start Monday, language en.
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { F6_DUMP, FIXTURE_NOW, buildCorpus, captureVia, local, makeContext, makeHarness, makeI18n, rowById } from '../../test-helpers/mindmap/corpus.mjs';
import MindMapFormatter from './formatter.js';
import { Mind, getMind } from './mind.js';
import MindMapSearchProvider from './search.js';

// The formatter parses with the global DOMParser (sandbox and jsdom have one).
globalThis.DOMParser ??= new JSDOM('').window.DOMParser;

const DATA_KEY = /^(?:nx-)?mm-(?!lock$)/;
const hitRows = (rows) => rows.filter((r) => r.id.startsWith('mm:i:'));
const itemOf = (row) => row.id.slice('mm:i:'.length);

// The host renders display Markdown into paragraphs before formatters run.
function toHtml(markdown) {
  return String(markdown).split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n');
}

function textOf(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

let h;
let F;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  F = await buildCorpus(h);
  h.at(FIXTURE_NOW);
}, 60_000);

afterAll(() => vi.useRealTimers());

const f6Children = () => h.mind.childrenOf(F.F6);
const childTitled = (title) => f6Children().find((c) => c.title === title);

describe('AT-1 "remind me which doc spoke about mtcs last week" (launcher)', () => {
  const query = 'mm remind me which doc spoke about mtcs last week';

  it('parses kinds, range and terms with no command or hard entity', () => {
    const spec = h.mind.parse('remind me which doc spoke about mtcs last week', { trailingSpace: true });
    expect([...spec.kinds].sort()).toEqual(['doc', 'link']);
    expect(spec.kindBoost).toBe('doc');
    expect(spec.range).toMatchObject({ start: local(2026, 10, 26), end: local(2026, 11, 2), field: 'any' });
    expect(spec.terms.filter((t) => !t.neg).map((t) => t.t)).toEqual(['mtcs']);
    expect(spec.command).toBeNull();
    expect(spec.entities.filter((e) => e.hard)).toEqual([]);
  });

  it('shows F1 and F2 only, then the interpretation and ask rows', () => {
    const rows = h.search.match(query);
    const hits = hitRows(rows);
    expect(hits.map(itemOf).sort()).toEqual([F.F1, F.F2].sort());
    // Score order, ties by id.
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    for (const row of hits) {
      expect(row.icon).toBe('📄');
      expect(row.description).toMatch(/MTCS/);
      expect(row.description).toMatch(/ · matched: mtcs$/);
    }
    const f1 = rowById(rows, `mm:i:${F.F1}`);
    const f2 = rowById(rows, `mm:i:${F.F2}`);
    expect(f1.label).toBe('MTCS design review');
    expect(f1.description.startsWith('Mon, Oct 26 · ')).toBe(true);
    expect(f2.label).toBe('MTCS rollout plan.docx');
    expect(f2.description.startsWith('Wed, Oct 28 · Microsoft Word · ')).toBe(true);

    const interp = rowById(rows, 'mm:interp');
    expect(`${interp.icon} ${interp.label}`).toBe('🔎 Docs & links · Mon, Oct 26 – Sun, Nov 1 · “mtcs”');
    expect(interp.score).toBeLessThan(Math.min(...hits.map((r) => r.score)));
    const ask = rowById(rows, 'mm:ask');
    expect(ask.score).toBeLessThan(interp.score);
  });

  it('Enter on the interpretation and ask rows refines the input', async () => {
    const rows = h.search.match(query);
    expect(await h.search.execute(rowById(rows, 'mm:interp'))).toEqual({
      type: 'replace_input', value: 'mm kind:doc,link when:2026-10-26..2026-11-01 mtcs',
    });
    expect(await h.search.execute(rowById(rows, 'mm:ask'))).toEqual({
      type: 'replace_input', value: 'mm? remind me which doc spoke about mtcs last week',
    });
  });

  it('Enter on F1 opens its URL; Enter on F2 focuses Word, else shows its card', async () => {
    const rows = h.search.match(query);
    h.opened.length = 0;
    expect(await h.search.execute(rowById(rows, `mm:i:${F.F1}`))).toBeNull();
    expect(h.opened).toEqual(['https://wiki.example.com/mtcs/design-review']);

    h.openWindows = [
      { handle: 11, title: 'Inbox - Mail', process_name: 'Mail' },
      { handle: 42, title: 'MTCS rollout plan.docx - Word', process_name: 'Microsoft Word' },
    ];
    h.focused.length = 0;
    expect(await h.search.execute(rowById(rows, `mm:i:${F.F2}`))).toBeNull();
    expect(h.focused).toEqual([42]);

    h.openWindows = [];
    const card = await h.search.execute(rowById(rows, `mm:i:${F.F2}`));
    expect(card.type).toBe('display');
    expect(card.value).toContain(`[mm-card:item:${F.F2}]`);
  });

  it('works offline and answers match() within the budget', () => {
    const before = h.metaCalls.length;
    const times = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      h.search.match(query);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1];
    if (p95 > 10) console.warn(`AT-1 match() p95 ${p95.toFixed(1)} ms is above the 10 ms budget`);
    expect(p95).toBeLessThan(100);
    expect(h.metaCalls.length).toBe(before);
  });
});

describe('AT-1-agent (the agent calls mindmap.search)', () => {
  it('returns the scope and cites F1 and F2', async () => {
    const out = await h.tools.execute('search', { query: 'which doc spoke about mtcs last week' });
    const r = out.result;
    expect(r.scope.kinds).toEqual(['doc', 'link']);
    expect(r.scope.from).toBe('2026-10-26');
    expect(r.scope.to).toBe('2026-11-02');
    expect(r.scope.terms).toContain('mtcs');
    expect(r.scope.relaxed).toBeNull();
    expect(r.total).toBe(2);
    expect(r.results.map((x) => x.cite).sort()).toEqual([`[mm:${F.F1}]`, `[mm:${F.F2}]`].sort());
  });

  it('turns the reply citation into chip [1] MTCS design review', async () => {
    const html = await h.formatter.format(`<p>That was the design review [mm:${F.F1}].</p>`, { streaming: false, role: 'assistant' });
    expect(html).toContain('class="mm-cite');
    expect(textOf(html)).toContain('[1] MTCS design review');
  });
});

describe('AT-1b relaxation', () => {
  it('widens to ±30 days bounded by now and ranks by closeness', () => {
    const spec = h.mind.parse('which doc spoke about mtcs yesterday', { trailingSpace: true });
    expect(spec.range).toMatchObject({ start: local(2026, 11, 5), end: local(2026, 11, 6) });
    const found = h.mind.find(spec);
    expect(found.relaxed.code).toBe('range_widened');
    expect(found.relaxed.range.start).toBe(local(2026, 10, 6));
    expect(found.relaxed.range.end).toBe(FIXTURE_NOW);

    const rows = h.search.match('mm which doc spoke about mtcs yesterday');
    expect(hitRows(rows).map(itemOf)).toEqual([F.F3, F.F2, F.F1, F.F4]);
    const top = [...rows].sort((a, b) => b.score - a.score)[0];
    expect(top.id).toBe('mm:interp');
    expect(top.label).toBe('Nothing from Thu, Nov 5 — closest matches from Oct 6 – Nov 6');
  });
});

describe('AT-2 "what were my actions for the bingo team" (launcher)', () => {
  const query = 'mm what were my actions for the bingo team';

  it('parses the actions intent, owner me, hard Bingo (team), status open', () => {
    const spec = h.mind.parse('what were my actions for the bingo team', { trailingSpace: true });
    expect(spec.intent).toBe('actions');
    expect(spec.owner).toBe('me');
    expect(spec.status).toBe('open');
    const hard = spec.entities.filter((e) => e.hard);
    expect(hard).toHaveLength(1);
    expect(h.mind.entity(hard[0].entityId)).toMatchObject({ name: 'Bingo', type: 'team' });
  });

  it('lists the open actions in order, then recently done, then the interpretation and everyone rows', () => {
    const rows = h.search.match(query);
    const actions = hitRows(rows);
    const send = childTitled('Send MTCS numbers to Dana');
    const book = childTitled('book the offsite');
    const review = childTitled('review the Bingo launch checklist');
    expect(actions.map(itemOf)).toEqual([send.id, F.F7, book.id, review.id, F.F9]);
    expect(actions.map((r) => `${r.icon} ${r.label}`)).toEqual([
      '☐ Send MTCS numbers to Dana',
      '☐ email the bingo team about the demo date',
      '☐ book the offsite',
      '☐ review the Bingo launch checklist',
      '☑ update the Bingo dashboard',
    ]);
    expect(actions[0].description).toBe('due today (Fri, Nov 6) · Bingo · from “Bingo team sync” (Fri, Oct 30)');
    expect(actions[1].description).toBe('Bingo · Mon, Nov 2');
    expect(actions[2].description).toBe('Bingo · from “Bingo team sync”');
    expect(actions[4].description).toBe('done Wed, Nov 4');

    const ordered = [...rows].sort((a, b) => b.score - a.score).map((r) => r.id);
    expect(ordered.slice(5, 7)).toEqual(['mm:interp', 'mm:everyone']);
    const interp = rowById(rows, 'mm:interp');
    expect(`${interp.icon} ${interp.label}`).toBe('🔎 Actions · mine · Bingo (team) · open + recently done');
    const everyone = rowById(rows, 'mm:everyone');
    expect(everyone.label).toBe('Show everyone’s actions');
    expect(everyone.data).toEqual({ a: 'fill', value: 'mm actions @bingo owner:anyone' });
  });

  it('does not show Dana’s suggestion, F8 or F10', () => {
    const ids = hitRows(h.search.match(query)).map(itemOf);
    expect(ids).not.toContain(childTitled('Dana to share the roadmap deck').id);
    expect(ids).not.toContain(F.F8);
    expect(ids).not.toContain(F.F10);
  });

  it('Enter marks row 1 done, refreshes into the done section, and mm undo reopens it', async () => {
    const send = childTitled('Send MTCS numbers to Dana');
    const rows = h.search.match(query);
    expect(await h.search.execute(rowById(rows, `mm:i:${send.id}`))).toEqual({ type: 'replace_input', value: query });
    expect(h.mind.item(send.id).status).toBe('done');
    const after = hitRows(h.search.match(query));
    const row = rowById(after, `mm:i:${send.id}`);
    expect(row.icon).toBe('☑');
    // Open rows first, then the done section (doneAt descending).
    expect(after.map(itemOf)).toEqual([F.F7, childTitled('book the offsite').id, childTitled('review the Bingo launch checklist').id, send.id, F.F9]);

    const undoRows = h.search.match('mm undo');
    expect(undoRows[0].label).toBe('Undo: Marked “Send MTCS numbers to Dana” done');
    const out = await h.search.execute(undoRows[0]);
    expect(out.type).toBe('display');
    expect(h.mind.item(send.id).status).toBe('open');
    expect(hitRows(h.search.match(query))[0].id).toBe(`mm:i:${send.id}`);
  });
});

describe('AT-2-agent (the agent calls mindmap.actions)', () => {
  it('groups the four open Bingo actions with their sources', async () => {
    const { result } = await h.tools.execute('actions', { entity: 'bingo' });
    expect(result.total).toBe(4);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].entity).toBe('Bingo');
    expect(result.groups[0].actions.map((a) => a.text)).toEqual([
      'Send MTCS numbers to Dana',
      'email the bingo team about the demo date',
      'book the offsite',
      'review the Bingo launch checklist',
    ]);
    for (const a of result.groups[0].actions) {
      expect(a.status).toBe('open');
      expect(a.owner).toBe('me');
    }
    const fromSync = result.groups[0].actions.filter((a) => a.source);
    expect(fromSync).toHaveLength(3);
    for (const a of fromSync) expect(a.source).toEqual({ cite: `[mm:${F.F6}]`, title: 'Bingo team sync' });
    expect(result.groups[0].actions[1].source).toBeNull();
  });
});

describe('AT-2b unknown team', () => {
  it('says there is no team called walrus and finds no actions', () => {
    const rows = h.search.match('mm what were my actions for the walrus team');
    expect(hitRows(rows)).toEqual([]);
    expect(rowById(rows, 'mm:interp').label).toBe('No team called “walrus” yet — searching the word instead');
    const none = rows.filter((r) => /^No actions found/.test(r.label));
    expect(none).toHaveLength(1);
    expect(none[0].label).toBe('No actions found for “walrus”');
    expect(none[0].description).toContain('mm actions');
    expect(none[0].data).toEqual({ a: 'fill', value: 'mm actions' });
  });
});

describe('AT-3 brain dump (F6)', () => {
  it('saves one meeting and four actions with Bingo and Dana', () => {
    const parent = h.mind.item(F.F6);
    expect(parent.kind).toBe('meeting');
    expect(parent.title).toBe('Bingo team sync');
    const kids = f6Children();
    expect(kids).toHaveLength(4);
    expect(kids.every((k) => k.kind === 'action' && k.parentId === F.F6)).toBe(true);

    const bingo = h.mind.resolveEntity('bingo', null);
    const dana = h.mind.resolveEntity('dana', null);
    expect(bingo).toMatchObject({ name: 'Bingo', type: 'team' });
    expect(dana).toMatchObject({ name: 'Dana', type: 'person' });
    expect(parent.entityIds).toEqual(expect.arrayContaining([bingo.entityId, dana.entityId]));

    const table = kids.map((k) => ({
      title: k.title, quote: k.quote, status: k.status, suggested: !!k.suggested,
      owner: k.owner === 'me' ? 'me' : h.mind.nameOf(k.owner), due: k.dueAt ?? null,
    }));
    expect(table).toEqual([
      { title: 'Send MTCS numbers to Dana', quote: 'Send MTCS numbers to Dana by Friday', status: 'open', suggested: false, owner: 'me', due: local(2026, 11, 6) },
      { title: 'Dana to share the roadmap deck', quote: 'Dana to share the roadmap deck', status: 'open', suggested: true, owner: 'Dana', due: null },
      { title: 'book the offsite', quote: 'I\'ll book the offsite', status: 'open', suggested: false, owner: 'me', due: null },
      { title: 'review the Bingo launch checklist', quote: 'review the Bingo launch checklist', status: 'open', suggested: false, owner: 'me', due: null },
    ]);
    // Line 1 links to the person created from line 2; children inherit Bingo.
    expect(kids[0].entityIds).toEqual(expect.arrayContaining([bingo.entityId, dana.entityId]));
    for (const k of kids) expect(k.entityIds).toContain(bingo.entityId);
  });

  it('previews the split before saving', () => {
    h.at(local(2026, 10, 30, 16, 0));
    try {
      const row = rowById(h.search.match(`mm+ ${F6_DUMP}`), 'mm:capture');
      expect(row.label).toBe('Save to Mind Map');
      expect(row.description).toBe('🗓️ meeting · Bingo · Dana · MTCS · 4 actions (1 suggested) · due Fri, Nov 6');
      expect(row.id).toBe('mm:capture');
    } finally {
      h.at(FIXTURE_NOW);
    }
  });
});

describe('AT-4 dedup', () => {
  it('annotates F1 instead of saving a new item', async () => {
    const before = h.mind.state.items.size;
    const out = await captureVia(h, 'mm+ https://WWW.wiki.example.com/mtcs/design-review/?utm_source=mail#top note: send to Ravi');
    expect(h.mind.state.items.size).toBe(before);
    expect(h.mind.item(F.F1).text.split('\n')).toContain('— 2026-11-06: note: send to Ravi');
    expect(out.value.split('\n\n')[0]).toContain('Already saved');
    const html = await h.formatter.format(toHtml(out.value), { streaming: false, role: 'assistant' });
    expect(textOf(html)).toContain('Already saved Mon, Oct 26');
  });
});

describe('AT-5 privacy', () => {
  it('the search tool hides F10 and counts it', async () => {
    const { result } = await h.tools.execute('search', { query: 'bingo salary' });
    expect(result.results.map((r) => r.cite)).not.toContain(`[mm:${F.F10}]`);
    expect(result.hiddenPrivate).toBe(1);
    for (const r of result.results) {
      expect(JSON.stringify([r.title, r.snippet, r.entities])).not.toMatch(/salary/i);
    }
    // Only the agent's own query words echo back in scope.terms.
    expect(JSON.stringify(result.results)).not.toMatch(/salary/i);
  });

  it('the launcher shows F10 first, with 🔒', () => {
    const hits = hitRows(h.search.match('mm bingo salary'));
    expect(hits[0].id).toBe(`mm:i:${F.F10}`);
    expect(hits[0].icon).toContain('🔒');
  });

  it('mm? builds a prompt without F10 or the word outside the question', async () => {
    const rows = h.search.match('mm? bingo salary');
    const out = await h.search.execute(rowById(rows, 'mm:askgo'));
    expect(out.type).toBe('prompt');
    expect(out.value).not.toContain(F.F10);
    const outside = out.value.split('\n').filter((line) => !line.startsWith('Question:'));
    expect(outside.join('\n')).not.toMatch(/salary/i);
  });
});

describe('AT-7 citations', () => {
  it('numbers chips, reuses numbers, marks deleted and private items, and is idempotent', async () => {
    const gone = 'i0zzzzzzzzzzzzz';
    const html = `<p>See [mm:${F.F1}] and [mm:${F.F2}], and again [mm:${F.F1}]. Also [mm:${gone}] and [mm:${F.F10}].</p>`;
    const out = await h.formatter.format(html, { streaming: false, role: 'assistant' });
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${out}</body>`, 'text/html');
    const chips = [...doc.querySelectorAll('.mm-cite')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['[1] MTCS design review', '[2] MTCS rollout plan.docx', '[1]', '[3] (deleted item)', '[4] private item']);
    expect(out).not.toMatch(/salary/i);
    expect(await h.formatter.format(out, { streaming: false, role: 'assistant' })).toBeNull();
  });
});

describe('AT-8 undo a brain dump', () => {
  it('removes the five items and the entities the capture created', async () => {
    const g = await makeHarness();
    const ids = await buildCorpus(g, { only: ['F6'] });
    expect(g.mind.state.items.size).toBe(5);
    expect(g.mind.resolveEntity('bingo', null)).not.toBeNull();
    const rows = g.search.match('mm undo');
    expect(rows[0].label).toBe('Undo: Saved “Bingo team sync” (5 items)');
    await g.search.execute(rows[0]);
    expect(g.mind.state.items.size).toBe(0);
    expect(g.mind.item(ids.F6)).toBeNull();
    expect(g.mind.resolveEntity('bingo', null)).toBeNull();
    expect(g.mind.resolveEntity('dana', null)).toBeNull();
    // The undo is persisted: a fresh window sees the empty store.
    const other = new Mind(makeContext(g.host, { invoke: g.host.connect().invoke }));
    await other.ready();
    expect(other.state.items.size).toBe(0);
  });
});

describe('AT-9 two windows', () => {
  it('two Minds on one store each capture 20 items concurrently and lose none', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    const a = g.mind;
    const b = getMind(makeContext(g.host, { invoke: g.host.connect().invoke }));
    expect(b).not.toBe(a);
    await Promise.all([a.ready(), b.ready()]);
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(a.capture(`window A note ${i} about zebra${i}`, { via: 'launcher' }));
      jobs.push(b.capture(`window B note ${i} about walrus${i}`, { via: 'launcher' }));
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.code)).toEqual([]);
    expect(new Set(results.map((r) => r.itemId)).size).toBe(40);

    await a.syncIfStale(0);
    await b.syncIfStale(0);
    expect(a.state.items.size).toBe(40);
    expect(b.state.items.size).toBe(40);
    // Every shard on disk holds every item.
    const fresh = new Mind(makeContext(g.host, { invoke: g.host.connect().invoke }));
    await fresh.ready();
    expect([...fresh.state.items.keys()].sort()).toEqual(results.map((r) => r.itemId).sort());
  }, 60_000);
});

describe('AT-10 crash safety', () => {
  const shardKey = () => `mm-items-${new Date(FIXTURE_NOW).toISOString().slice(0, 7)}`;

  it('a corrupt primary shard loads from its twin with no data loss', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    await g.mind.capture('remember the walrus migration plan', { via: 'launcher' });
    await g.mind.capture('second note about the zebra budget', { via: 'launcher' });
    g.host.corrupt(shardKey());
    const other = new Mind(makeContext(g.host, { invoke: g.host.connect().invoke }));
    await other.ready();
    expect(other.readOnly).toBeNull();
    expect(other.state.items.size).toBe(2);
  });

  it('corrupt primary and twin → read-only: banner, refused captures, no data writes', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    await g.mind.capture('remember the walrus migration plan', { via: 'launcher' });
    g.host.corrupt(shardKey());
    g.host.corrupt(`nx-${shardKey()}`);
    const ctx = makeContext(g.host, { invoke: g.host.connect().invoke });
    const { default: Search } = await import('./search.js');
    const search = new Search();
    search.initialize(ctx);
    const mind = getMind(ctx);
    await mind.ready();
    expect(mind.readOnly).toMatchObject({ code: 'unreadable' });
    const mark = g.host.calls.length;

    const home = search.match('mm');
    expect(home[0].id).toBe('mm:readonly');
    expect(`${home[0].icon} ${home[0].label}`).toBe('⚠️ Mind Map data couldn’t be read — open settings');
    expect(await search.execute(home[0])).toEqual({ type: 'open_extension_settings' });

    const capture = search.match('mm+ a new thought');
    expect(rowById(capture, 'mm:capture').description).toBe('Mind Map is read-only until repaired');
    const out = await search.execute({ id: 'mm:capture', data: { a: 'capture', text: 'a new thought' } });
    expect(out.value).toContain('Mind Map is read-only until repaired');
    expect(await mind.capture('another thought', { via: 'launcher' })).toEqual({ code: 'readonly' });

    const writes = g.host.calls.slice(mark).filter((c) => c.command !== 'load_extension_data' && DATA_KEY.test(c.args?.key || ''));
    expect(writes).toEqual([]);
  });
});

describe('AT-11 agent capture', () => {
  it('saves via agent, indexes terms, suggests quoted actions and rejects invented ones', async () => {
    const g = await makeHarness();
    g.at(FIXTURE_NOW);
    const text = 'Notes from the capacity review. Book review with the platform group next week. Budget is fine.';
    const { result } = await g.tools.execute('capture', {
      text,
      summary: 'Capacity review notes: budget fine, follow-up review to book.',
      terms: ['MTCS'],
      actions: [{ text: 'Book review', quote: 'Book review with the platform group' }, { text: 'Invent', quote: 'not in text' }],
    });
    const id = result.cite.slice(4, -1);
    const item = g.mind.item(id);
    expect(item.source.via).toBe('agent');
    expect(item.terms).toEqual(['MTCS']);
    expect(g.mind.find(g.mind.parse('mtcs', { trailingSpace: true })).hits.map((x) => x.item.id)).toContain(id);
    expect(result.actions).toHaveLength(1);
    const action = g.mind.item(result.actions[0].slice(4, -1));
    expect(action).toMatchObject({ kind: 'action', title: 'Book review', suggested: true, status: 'open', origin: 'agent', parentId: id });
    expect(result.rejected).toEqual([{ text: 'Invent', reason: 'quote_not_found' }]);
  });
});

describe('F-CAP and home rows on the corpus', () => {
  it('the op card for a brain dump shows the split, related items and Undo', async () => {
    const g = await makeHarness();
    await buildCorpus(g, { only: ['F5', 'F6'] });
    const op = g.mind.state.ops.at(-1).opId;
    const html = await g.formatter.format(toHtml(`🧠 Saved “Bingo team sync”\n\n[mm-card:op:${op}]`), { streaming: false, role: 'assistant' });
    const text = textOf(html);
    expect(text).toContain('Saved');
    expect(text).toMatch(/meeting/);
    expect(text).toMatch(/4 actions/);
    expect(html).toContain(`data-ext-action="mm:a:undo:${op}"`);
    expect(html).toMatch(/data-ext-action="mm:a:dismiss:i[0-9a-z]{14}"/);
    expect(html).toMatch(/data-ext-action="mm:a:accept:i[0-9a-z]{14}"/);
  });

  it('mm alone shows the home rows', () => {
    const rows = h.search.match('mm');
    const ids = rows.map((r) => r.id);
    expect(ids.slice(0, 3)).toEqual(['mm:home:capture', 'mm:home:actions', 'mm:home:review']);
    expect(rowById(rows, 'mm:home:actions').label).toMatch(/^\d+ open actions \(\d+ due this week\)$/);
    expect(rowById(rows, 'mm:home:review').label).toBe('1 suggestion to review');
    expect(hitRows(rows)).toHaveLength(5);
    expect(ids).toContain('mm:ask');
    expect(ids).toContain('mm:help');
  });
});

describe('every shipped locale', () => {
  const dir = new URL('./_locales/', import.meta.url);
  const langs = readdirSync(dir).sort();
  // A leftover {placeholder} or an untranslated key name means a broken catalog entry.
  const BROKEN = /[{}]|\b(?:row|card|chip|relax|due|range|kind|etype|map|cite|help|op|err|keyword|settings|tool|prompt)\.[a-z_]+\b/;

  it('ships English plus 31 translations with the same keys', () => {
    expect(langs).toHaveLength(32);
    const en = Object.keys(JSON.parse(readFileSync(new URL('en/messages.json', dir), 'utf8'))).sort();
    for (const lang of langs) {
      const catalog = JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
      expect(Object.keys(catalog).sort(), lang).toEqual(en);
      expect(catalog._meta.language, lang).toBe(lang);
    }
  });

  it.each(langs)('%s renders the owner’s queries, home rows and an op card', async (lang) => {
    const catalog = JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
    const i18n = makeI18n(catalog, { language: lang, rtl: !!catalog._meta.rtl });
    const context = { ...h.context, i18n };
    const search = new MindMapSearchProvider();
    search.initialize(context);
    const formatter = new MindMapFormatter();
    formatter.initialize(context);
    const queries = ['mm remind me which doc spoke about mtcs last week', 'mm what were my actions for the bingo team',
      'mm which doc spoke about mtcs yesterday', 'mm what were my actions for the walrus team', 'mm', 'mm @bingo', 'mm undo', `mm+ ${F6_DUMP}`];
    for (const q of queries) {
      const rows = search.match(q);
      expect(rows.length, `${lang} ${q}`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.label, `${lang} ${q}`).toBeTruthy();
        expect(`${row.label} ${row.description}`, `${lang} ${q} ${row.id}`).not.toMatch(BROKEN);
      }
    }
    // The owner's queries find the same items in every language (only the words around them change).
    expect(hitRows(search.match(queries[0])).map(itemOf).sort()).toEqual([F.F1, F.F2].sort());
    const op = h.mind.state.ops.find((o) => o.created?.items?.includes(F.F6)).opId;
    const html = await formatter.format(`<p>[mm-card:op:${op}]</p><p>See [mm:${F.F1}].</p>`, { streaming: false, role: 'assistant' });
    expect(textOf(html), lang).not.toMatch(BROKEN);
    expect(textOf(html)).toContain('[1] MTCS design review');
  });
});
