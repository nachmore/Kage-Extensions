// Regression tests for the review findings on privacy, cross-window
// consistency and stored-data robustness: names learned from private notes
// never reach the agent, Delete everything holds in every window, agent
// captures never reveal private items, and odd stored records survive.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, captureVia, local, makeContext, makeHarness } from '../../test-helpers/mindmap/corpus.mjs';
import { Mind, getMind } from './mind.js';
import MindMapToolProvider from './tools.js';
import { resolveWeekStart } from './lib/dates.js';

afterAll(() => vi.useRealTimers());

function window2(h, extra = {}) {
  return new Mind(makeContext(h.host, { invoke: h.host.connect().invoke, ...extra }), { idleDelayMs: 1e9 });
}

describe('names known only from private notes never reach the agent', () => {
  it('entity tool: no relation, no existence, no suggestion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness();
    h.at(local(2026, 11, 2, 9, 0));
    await captureVia(h, 'mm+ todo: email the bingo team about the demo date');
    h.at(local(2026, 11, 4, 12, 0));
    await captureVia(h, 'mm+ ! #layoffs plan for the bingo team');
    h.at(FIXTURE_NOW);

    const bingo = (await h.tools.execute('entity', { name: 'bingo' })).result;
    expect(bingo.name).toBe('Bingo');
    expect(JSON.stringify(bingo)).not.toMatch(/layoffs/i);
    expect(bingo.related).toEqual([]);
    const hidden = (await h.tools.execute('entity', { name: 'layoffs' })).result;
    expect(hidden.error).toBe('not_found');
    expect(hidden.suggestions).toEqual([]);
    expect((await h.tools.execute('entity', { name: 'lay' })).result.suggestions).toEqual([]);
    // search/actions with the name: unresolved, never confirmed in scope.
    const s = (await h.tools.execute('search', { query: 'layoffs', entity: 'layoffs' })).result;
    expect(s.scope.entities).toEqual([]);
    expect(s.scope.unresolved).toContain('layoffs');
    expect(JSON.stringify(s.results)).not.toMatch(/layoffs/i);
    const a = (await h.tools.execute('actions', { entity: 'layoffs' })).result;
    expect(a.unresolved).toEqual(['layoffs']);
    expect(a.suggestions).toEqual([]);
    // The launcher still knows it.
    expect(h.mind.resolveEntity('layoffs')).toBeTruthy();
    // Once a public note names it, the agent may see it.
    h.at(FIXTURE_NOW + 60_000);
    await captureVia(h, 'mm+ #layoffs rumours in the news');
    expect((await h.tools.execute('entity', { name: 'layoffs' })).result.name).toBe('layoffs');
  }, 60_000);

  it('an alias learned from a private note is neither returned nor searchable by the agent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness();
    await buildCorpus(h);
    h.at(local(2026, 11, 5, 9, 0));
    await captureVia(h, 'mm+ ! the Mass Termination Cost Study (MTCS) numbers look grim');
    h.at(FIXTURE_NOW);
    const mtcs = [...h.mind.state.entities.values()].find((e) => e.key === 'mtcs');
    expect(mtcs.aliases).toContain('Mass Termination Cost Study');

    const entity = (await h.tools.execute('entity', { name: 'mtcs' })).result;
    expect(entity.aliases).toEqual([]);
    const s = (await h.tools.execute('search', { query: 'termination' })).result;
    expect(s.results).toEqual([]);
    expect(s.hiddenPrivate).toBe(1);
    const viaShort = (await h.tools.execute('search', { query: 'mtcs' })).result;
    expect(JSON.stringify(viaShort)).not.toMatch(/terminat/i);
    expect(h.mind.askPrompt('which doc spoke about mtcs')).not.toMatch(/terminat/i);
    // The launcher keeps the alias: "termination" finds the MTCS items.
    const rows = h.search.match('mm termination');
    expect(rows.filter((r) => r.id.startsWith('mm:i:')).length).toBeGreaterThan(1);

    // A public note that spells it out makes the alias visible to the agent.
    h.at(FIXTURE_NOW + 60_000);
    await captureVia(h, 'mm+ the Mass Termination Cost Study kickoff is next month');
    expect((await h.tools.execute('entity', { name: 'mtcs' })).result.aliases).toEqual(['Mass Termination Cost Study']);
  }, 60_000);
});

describe('Delete everything holds in every window', () => {
  it('a window that missed the delete drops the old data on its next sync', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness();
    h.at(local(2026, 9, 15, 9, 0));
    await captureVia(h, 'mm+ todo: send the zebra contract');
    h.at(local(2026, 10, 10, 9, 0));
    await captureVia(h, 'mm+ notes about the walrus offsite');
    h.at(FIXTURE_NOW);

    const chatContext = makeContext(h.host, { invoke: h.host.connect().invoke });
    const chat = getMind(chatContext);
    await chat.ready();
    const old = [...chat.state.items.values()].find((i) => /zebra/.test(i.title));
    expect(chat.state.items.size).toBe(2);

    const settings = window2(h);
    await settings.ready();
    await settings.deleteAll();
    await captureVia(h, 'mm+ fresh start note');

    await chat.syncIfStale(0);
    expect([...chat.state.items.values()].map((i) => i.title)).toEqual(['fresh start note']);
    const tools = new MindMapToolProvider();
    tools.initialize(chatContext);
    expect((await tools.execute('search', { query: 'zebra contract' })).result.results).toEqual([]);
    expect((await chat.toggle(old.id)).ok).toBe(false);
    expect(h.host.files.has('mm-items-2026-09')).toBe(false);

    const fresh = window2(h);
    await fresh.ready();
    expect([...fresh.state.items.values()].map((i) => i.title)).toEqual(['fresh start note']);
  }, 60_000);
});

describe('agent capture of a URL saved privately', () => {
  it('creates its own item and never returns the private one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness();
    h.at(local(2026, 11, 2, 9, 0));
    await captureVia(h, 'mm+ ! https://jobs.example.com/apply/123');
    h.at(FIXTURE_NOW);
    const priv = [...h.mind.state.items.values()][0];
    const out = (await h.tools.execute('capture', { text: 'https://jobs.example.com/apply/123' })).result;
    expect(JSON.stringify(out)).not.toContain(priv.id);
    expect(out.deduped).toBeNull();
    expect(out.private).toBeUndefined();
    expect(h.mind.item(priv.id).text).toBe('https://jobs.example.com/apply/123');
    expect(h.mind.state.items.size).toBe(2);
    // A private agent capture says only that it saved.
    const quiet = (await h.tools.execute('capture', { text: 'a private thought', private: true })).result;
    expect(Object.keys(quiet).sort()).toEqual(['note', 'private', 'rejected', 'saved', 'undo']);
  }, 60_000);
});

describe('the shipped default week start', () => {
  it('AT-1 with week_start auto follows the OS region, and the label shows the dates it used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness({ config: { week_start: 'auto' } });
    const F = await buildCorpus(h);
    h.at(FIXTURE_NOW);
    // Kage passes the bare UI language "en"; the region comes from the OS
    // (navigator / Intl), as in the webview.
    const region = Intl.DateTimeFormat().resolvedOptions().locale;
    const sunday = h.mind.weekStart === 0;
    expect(h.mind.weekStart).toBe(resolveWeekStart('auto', region));
    const rows = h.search.match('mm remind me which doc spoke about mtcs last week');
    const hits = rows.filter((r) => r.id.startsWith('mm:i:')).map((r) => r.id.slice(5));
    expect(hits.sort()).toEqual([F.F1, F.F2].sort());
    const interp = rows.find((r) => r.id === 'mm:interp');
    expect(interp.label).toContain(sunday ? 'Sun, Oct 25 – Sat, Oct 31' : 'Mon, Oct 26 – Sun, Nov 1');
    const tool = (await h.tools.execute('search', { query: 'which doc spoke about mtcs last week' })).result;
    expect(tool.scope.from).toBe(sunday ? '2026-10-25' : '2026-10-26');
    expect(tool.results.map((r) => r.cite).sort()).toEqual([`[mm:${F.F1}]`, `[mm:${F.F2}]`].sort());
  }, 60_000);
});

describe('an unreadable mm-meta', () => {
  it('still finds every month shard for read-only use, Export raw copies, Repair and Delete everything', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await makeHarness();
    for (const m of [6, 7, 8, 9, 10, 11]) {
      h.at(local(2026, m, 3, 12));
      await h.mind.capture(`note from month ${m} about the zebra budget`, { via: 'launcher' });
    }
    h.at(FIXTURE_NOW);
    h.host.corrupt('mm-meta');
    h.host.corrupt('nx-mm-meta');
    const w = window2(h);
    await w.ready();
    expect(w.readOnly).toMatchObject({ code: 'unreadable' });
    expect(w.state.items.size).toBe(6);
    const raw = Object.keys(await w.exportRaw()).filter((k) => /^mm-items-/.test(k)).sort();
    expect(raw).toEqual(['06', '07', '08', '09', '10', '11'].map((m) => `mm-items-2026-${m}`));
    expect((await w.repair()).ok).toBe(true);
    const after = window2(h);
    await after.ready();
    expect(after.readOnly).toBeNull();
    expect(after.state.items.size).toBe(6);
    await after.deleteAll();
    expect([...h.host.files.keys()].filter((k) => /mm-items/.test(k))).toEqual([]);
  }, 60_000);
});
