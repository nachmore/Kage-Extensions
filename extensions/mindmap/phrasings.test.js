// @vitest-environment jsdom
// A golden set of everyday phrasings, on the SPEC §3.1 corpus plus a second
// layer of realistic captures (the owner review): how people actually ask
// for things and write todos. Each one failed before the review fixes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, captureVia, local, makeHarness } from '../../test-helpers/mindmap/corpus.mjs';

const EXTRA = [
  { name: 'X04', at: local(2026, 10, 15, 13, 0), input: 'mm+ MTCS latency regression in eu-west, ping Raj' },
  { name: 'X05', at: local(2026, 10, 20, 15, 0), input: 'mm+ Bingo retro\n- deploys are too slow\n- need better alerts\nAction: set up paging for bingo' },
  { name: 'X15', at: local(2026, 11, 4, 17, 0), input: 'mm+ 1:1 with Sarah\n- she wants the hiring plan by next Friday\n- I need to draft the job description\n- Sarah to intro me to Raj\n- ask Raj about MTCS latency' },
  { name: 'X16', at: local(2026, 11, 5, 9, 0), input: 'mm+ https://docs.example.com/document/d/1AbC/edit', meta: { title: 'Launch plan — Q4', description: 'Timeline, owners and risks for the Q4 launch.' } },
  { name: 'X17', at: local(2026, 11, 5, 11, 30), input: 'mm+ Pricing discussion with Sarah: she prefers the tiered model. Need to update the pricing page by EOW' },
  { name: 'X18', at: local(2026, 11, 5, 16, 20), input: 'mm+ Sarah said the launch moves to Dec 3 because of the security review' },
  { name: 'X19', at: local(2026, 11, 6, 8, 45), input: 'mm+ thinking about how we onboard new hires — the first week is chaotic, maybe a buddy system would help' },
  { name: 'X20', at: local(2026, 11, 6, 9, 30), input: 'mm+ the OKR doc for H1 is at https://wiki.example.com/okrs/h1-2027', meta: { title: 'H1 2027 OKRs', description: 'Company and team OKRs for the first half.' } },
  { name: 'X21', at: local(2026, 11, 6, 9, 40), input: 'mm+ Weekly planning\nfinish the budget\nemail Dana the numbers\nbook flights to Berlin' },
  { name: 'X22', at: local(2026, 11, 6, 9, 50), input: 'mm+ gotta renew the domain' },
  { name: 'X23', at: local(2026, 11, 6, 9, 55), input: 'mm+ todo: pay the invoice tomorrow' },
  { name: 'X24', at: local(2026, 11, 6, 9, 58), input: 'mm+ great talk on caching https://example.com/v/123' },
];

let h;
let F;
const X = {};
const titles = (rows) => rows.filter((r) => r.id.startsWith('mm:i:')).map((r) => r.label);
const rowIds = (rows) => rows.map((r) => r.id);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  h.meta.set('https://docs.example.com/document/d/1AbC/edit', EXTRA.find((x) => x.name === 'X16').meta);
  h.meta.set('https://wiki.example.com/okrs/h1-2027', EXTRA.find((x) => x.name === 'X20').meta);
  F = await buildCorpus(h);
  for (const x of [...EXTRA].sort((a, b) => a.at - b.at)) {
    h.at(x.at);
    const out = await captureVia(h, x.input);
    const op = /\[mm-card:op:(o[0-9a-z]{14})\]/.exec(out?.value || '')?.[1];
    X[x.name] = h.mind.state.ops.find((o) => o.opId === op)?.label?.params?.itemId;
    await h.mind.whenIdle();
  }
  h.at(FIXTURE_NOW);
}, 120_000);
afterAll(() => vi.useRealTimers());

const child = (parent, title) => h.mind.childrenOf(parent).find((c) => c.title === title);

describe('asking for actions', () => {
  it('"my actions for Dana": mine that involve Dana, and a row for Dana’s own', () => {
    const rows = h.search.match('mm my actions for dana');
    expect(titles(rows)).toEqual(expect.arrayContaining(['Send MTCS numbers to Dana', 'email Dana the numbers']));
    expect(titles(rows)).not.toContain('Dana to share the roadmap deck');
    const theirs = rows.find((r) => r.id === 'mm:theirs');
    expect(theirs.label).toBe('Show Dana’s own actions');
    expect(theirs.data).toEqual({ a: 'fill', value: 'mm actions owner:dana' });
  });

  it('"actions for Sarah" with nothing open shows her suggestions', () => {
    for (const q of ['mm actions for sarah', "mm sarah's actions"]) {
      expect(titles(h.search.match(q)), q).toContain('Sarah to intro me to Raj');
    }
  });

  it('due phrases: tomorrow, a weekday asked on that weekday', () => {
    expect(titles(h.search.match("mm what's due tomorrow"))).toEqual(['pay the invoice']);
    expect(titles(h.search.match('mm todos due friday'))).toContain('Send MTCS numbers to Dana');
  });

  it('actions from a named note, what is on my plate, and suggestions', () => {
    expect(titles(h.search.match('mm what were my actions from the bingo retro'))).toContain('set up paging for bingo');
    const plate = titles(h.search.match("mm what's on my plate"));
    expect(plate).toEqual(expect.arrayContaining(['Send MTCS numbers to Dana', 'renew the domain', 'finish the budget']));
    const review = titles(h.search.match('mm suggestions'));
    expect(review).toEqual(expect.arrayContaining(['Dana to share the roadmap deck', 'Sarah to intro me to Raj', 'ask Raj about MTCS latency']));
  });

  it('"what did I finish this week": done actions by when they were done', () => {
    expect(titles(h.search.match('mm what did I finish this week'))).toEqual(['update the Bingo dashboard']);
  });

  it('mm? for this week’s todos sends the actions due, not notes', () => {
    const prompt = h.mind.askPrompt('what do I need to do this week', { t: h.context.i18n.t });
    expect(prompt).toContain('Send MTCS numbers to Dana');
    expect(prompt).not.toContain('Lunch with Dana');
  });
});

describe('finding notes', () => {
  it('"what did I save yesterday" lists yesterday’s captures', () => {
    const rows = h.search.match('mm what did I save yesterday');
    expect(titles(rows)).toEqual(expect.arrayContaining(['Launch plan — Q4', 'Sarah said the launch moves to Dec 3 because of the security review']));
    for (const q of ['mm what did I capture this morning', 'mm things from yesterday']) expect(titles(h.search.match(q)).length, q).toBeGreaterThan(0);
  });

  it('when the words match nothing in the range, shows everything from it and says so', () => {
    const rows = h.search.match('mm what did I add yesterday about zeppelins');
    const interp = rows.find((r) => r.id === 'mm:interp');
    expect(interp.label).toBe('Nothing matched “zeppelins” — everything from Thu, Nov 5');
    expect(titles(rows).length).toBeGreaterThan(0);
  });

  it('light stemming, typos and an honest empty row', () => {
    expect(titles(h.search.match('mm notes about onboarding'))[0]).toMatch(/^thinking about how we onboard/);
    const typo = h.search.match('mm lauch');
    const fix = typo.find((r) => r.id === 'mm:spelling');
    expect(fix.label).toBe('Did you mean “launch”?');
    expect(fix.data.value).toBe('mm launch');
    const none = h.search.match('mm zeppelins ').find((r) => r.id === 'mm:interp');
    expect(none.label).toBe('No notes match “zeppelins” — try fewer or different words');
  });

  it('says how many matched when it lists only some', () => {
    const interp = h.search.match('mm in october').find((r) => r.id === 'mm:interp');
    expect(interp.description).toMatch(/^8 of \d+ · /);
  });
});

describe('organizing what was saved', () => {
  it('a note about a coming date is dated by its capture, here and for the agent', async () => {
    const item = h.mind.item(X.X18);
    expect(item.occurredAt).toBeUndefined();
    const row = h.search.match('mm launch security review').find((r) => r.id === `mm:i:${X.X18}`);
    expect(row.description.startsWith('Thu, Nov 5')).toBe(true);
    const tool = (await h.tools.execute('search', { query: 'launch security review' })).result;
    expect(tool.results.find((r) => r.cite === `[mm:${X.X18}]`).date).toBe('2026-11-05');
  });

  it('child actions inherit the team, not the people and terms of sibling lines', () => {
    const mtcs = h.mind.resolveEntity('mtcs').entityId;
    const bingo = h.mind.resolveEntity('bingo').entityId;
    const book = child(F.F6, 'book the offsite');
    expect(book.entityIds).toContain(bingo);
    expect(book.entityIds).not.toContain(mtcs);
    const jd = child(X.X15, 'draft the job description');
    expect(jd.entityIds).not.toContain(h.mind.resolveEntity('raj').entityId);
    expect(titles(h.search.match('mm my actions for the bingo team'))).toContain('book the offsite');
  });

  it('todos as people write them become open actions', () => {
    expect(h.mind.item(X.X22)).toMatchObject({ kind: 'action', title: 'renew the domain', status: 'open' });
    expect(h.mind.item(X.X22).suggested).toBeFalsy();
    const pricing = h.mind.childrenOf(X.X17).find((c) => c.kind === 'action');
    expect(pricing).toMatchObject({ title: 'update the pricing page', status: 'open' });
    expect(pricing.suggested).toBeFalsy();
    const plan = h.mind.childrenOf(X.X21).map((c) => [c.title, !!c.suggested]);
    expect(plan).toEqual([['finish the budget', false], ['email Dana the numbers', false], ['book flights to Berlin', false]]);
  });

  it('a page description never invents a team', () => {
    expect(h.mind.resolveEntity('okrs')).toBeNull();
    expect([...h.mind.state.entities.values()].some((e) => e.type === 'team' && /okr/i.test(e.name))).toBe(false);
  });

  it('a link without a page title keeps the user’s words as its title', () => {
    expect(h.mind.item(X.X24).title).toBe('great talk on caching');
  });
});

describe('the map', () => {
  it('a kind word that finds the centre doesn’t filter its lanes ("mm map 1:1 with sarah")', async () => {
    const row = h.search.match('mm map 1:1 with sarah').find((r) => r.id === 'mm:map');
    expect(row.data.ref).toBe(X.X15);
    expect(row.data.kinds).toBeUndefined();
    const neigh = h.mind.neighborhood({ type: 'item', id: X.X15 }, {});
    const left = neigh.lanes.left.nodes.map((n) => n.label);
    expect(left).toEqual(expect.arrayContaining(['draft the job description']));
  });

  it('top and bottom lanes hold four nodes', () => {
    const neigh = h.mind.neighborhood({ type: 'overview' }, {});
    expect(neigh.lanes.up.nodes.length).toBeLessThanOrEqual(4);
    expect(neigh.lanes.down.nodes.length).toBeLessThanOrEqual(4);
  });
});

describe('cards', () => {
  it('a one-line action’s card doesn’t repeat it', async () => {
    const op = h.mind.state.ops.find((o) => o.label?.params?.itemId === X.X22).opId;
    const html = await h.formatter.format(`<p>[mm-card:op:${op}]</p>`, { streaming: false });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('.mm-op-head').textContent).toBe('✓ Saved · action');
    expect(doc.querySelectorAll('.mm-act')).toHaveLength(1);
    expect(doc.querySelector('.mm-op-item')).toBeNull();
  });

  it('a long brain dump lists its first actions, then how many more', async () => {
    h.at(FIXTURE_NOW + 60_000);
    const lines = Array.from({ length: 60 }, (_, i) => `- [ ] task number ${i + 1}`);
    const out = await captureVia(h, `mm+ Big list\n${lines.join('\n')}`);
    const html = await h.formatter.format(`<p>${out.value.split('\n\n')[1]}</p>`, { streaming: false });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.mm-act')).toHaveLength(8);
    const notes = [...doc.querySelectorAll('.mm-note')].map((n) => n.textContent);
    expect(notes).toEqual(['42 more actions — see mm actions', '10 more lines weren’t made actions (the limit is 50); they stay in the note’s text']);
    h.at(FIXTURE_NOW);
  });
});
