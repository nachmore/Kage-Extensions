import { describe, expect, it } from 'vitest';
import { createIndex } from './bm25.js';
import { WEIGHTS, runActions, runQuery } from './rank.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 6, 10);
const tok = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) || [];

let n = 0;
const idAt = (ms) => `i${ms.toString(36).padStart(9, '0')}${(n++).toString(36).padStart(5, '0')}`;

const ENTITIES = {
  me: { id: 'me', type: 'person', name: 'Me', aliases: [] },
  bingo: { id: 'e0000000000bngo', type: 'team', name: 'Bingo', aliases: [] },
  dana: { id: 'e0000000000dana', type: 'person', name: 'Dana', aliases: [] },
  mtcs: { id: 'e0000000000mtcs', type: 'term', name: 'MTCS', aliases: ['Multi Tenant Control Service'] },
  zebra: { id: 'e000000000zebra', type: 'team', name: 'Zebra', aliases: [] },
  launch: { id: 'e00000000launch', type: 'topic', name: 'launch', aliases: [] },
};
const E = Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, v.id]));

function item(createdAt, fields) {
  return { id: idAt(createdAt), createdAt, updatedAt: createdAt, entityIds: [], text: '', title: '', ...fields };
}

// The SPEC §3.1 corpus as Mind Map organizes it (after link enrichment).
function corpus() {
  const F1 = item(at(2026, 10, 26, 9, 12), { kind: 'doc', title: 'MTCS design review', summary: 'Failover and capacity plan for MTCS.', text: 'https://wiki.example.com/mtcs/design-review', url: 'https://wiki.example.com/mtcs/design-review', entityIds: [E.mtcs] });
  const F2 = item(at(2026, 10, 28, 14, 3), { kind: 'doc', title: 'MTCS rollout plan.docx', source: { via: 'launcher', app: 'Microsoft Word' }, entityIds: [E.mtcs] });
  const F3 = item(at(2026, 11, 3, 11), { kind: 'doc', title: 'MTCS capacity notes.pdf', path: '~/Documents/MTCS capacity notes.pdf', text: '~/Documents/MTCS capacity notes.pdf', entityIds: [E.mtcs] });
  const F4 = item(at(2026, 10, 22, 8, 30), { kind: 'link', title: 'An intro to MTCS', text: 'https://example.com/blog/mtcs-intro', entityIds: [E.mtcs] });
  const F5 = item(at(2026, 10, 29, 13, 10), { kind: 'note', title: 'Lunch with Dana, talked about MTCS hiring', text: 'Lunch with Dana, talked about MTCS hiring', entityIds: [E.dana, E.mtcs] });
  const f6At = at(2026, 10, 30, 16);
  const F6 = item(f6At, { kind: 'meeting', title: 'Bingo team sync', text: 'Bingo team sync\n- [ ] Send MTCS numbers to Dana by Friday\n- Dana to share the roadmap deck\n- I\'ll book the offsite\nAction items:\n- review the Bingo launch checklist', entityIds: [E.bingo, E.dana, E.mtcs] });
  const child = (seg, title, fields = {}) => item(f6At, { kind: 'action', title, text: title, parentId: F6.id, seg, status: 'open', suggested: false, owner: 'me', entityIds: [E.bingo, E.dana, E.mtcs], ...fields });
  const A1 = child(1, 'Send MTCS numbers to Dana', { dueAt: at(2026, 11, 6) });
  const A2 = child(2, 'Dana to share the roadmap deck', { suggested: true, owner: E.dana });
  const A3 = child(3, 'book the offsite');
  const A4 = child(5, 'review the Bingo launch checklist', { entityIds: [E.bingo, E.dana, E.mtcs, E.launch] });
  const F7 = item(at(2026, 11, 2, 9), { kind: 'action', title: 'email the bingo team about the demo date', text: 'todo: email the bingo team about the demo date', status: 'open', suggested: false, owner: 'me', entityIds: [E.bingo] });
  const F8 = item(at(2026, 11, 3, 9), { kind: 'action', title: 'call the Zebra team about invoices', text: 'call the Zebra team about invoices', status: 'open', suggested: false, owner: 'me', entityIds: [E.zebra] });
  const F9 = item(at(2026, 11, 4, 9), { kind: 'action', title: 'update the Bingo dashboard', text: '[x] update the Bingo dashboard', status: 'done', doneAt: at(2026, 11, 4, 9), owner: 'me', entityIds: [E.bingo] });
  const F10 = item(at(2026, 11, 4, 12), { kind: 'note', title: 'bingo salary thoughts', text: 'bingo salary thoughts', private: true, entityIds: [E.bingo] });
  const F11 = item(at(2026, 10, 29, 15), { kind: 'link', title: 'Pricing page', text: 'https://example.org/pricing' });
  return { F1, F2, F3, F4, F5, F6, A1, A2, A3, A4, F7, F8, F9, F10, F11 };
}

function makeCtx(items, { now = NOW, agent = false, limit } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const entities = new Map(Object.values(ENTITIES).map((e) => [e.id, e]));
  const index = createIndex();
  for (const i of items) {
    index.add(i.id, {
      title: tok(i.title), body: tok(i.text), sum: tok(i.summary),
      ent: i.entityIds.flatMap((id) => tok(entities.get(id)?.name)),
    });
  }
  const groupOf = (i) => {
    const types = i.entityIds.map((id) => entities.get(id)).filter(Boolean);
    return (types.find((e) => e.type === 'team' || e.type === 'project') || types.find((e) => e.type === 'topic'))?.id ?? null;
  };
  return {
    now, index, limit,
    getItem: (id) => byId.get(id),
    idsNewestFirst: () => [...byId.keys()].sort().reverse(),
    idsInRange: (start, end, field) => [...byId.values()].filter((i) => {
      const ts = field === 'due' ? [i.dueAt] : [i.createdAt, i.occurredAt];
      return ts.some((t) => Number.isFinite(t) && t >= (start ?? -Infinity) && t < (end ?? Infinity));
    }).map((i) => i.id),
    entityItems: (eid) => new Set(items.filter((i) => i.entityIds.includes(eid)).map((i) => i.id)),
    aliasTerms: (eid) => {
      const e = entities.get(eid);
      return e ? [...tok(e.name).map((t) => ({ t, w: 1 })), ...e.aliases.flatMap(tok).map((t) => ({ t, w: WEIGHTS.alias }))] : [];
    },
    groupOf,
    hidden: agent ? (id) => !!byId.get(id)?.private : undefined,
  };
}

const spec = (overrides = {}) => ({
  raw: '', command: null, intent: 'find', kinds: null, kindBoost: null, range: null, recency: false,
  status: null, owner: null, entities: [], unresolved: [], terms: [], phrases: [], includePrivate: false, ...overrides,
});
const LAST_WEEK = { start: at(2026, 10, 26), end: at(2026, 11, 2), granularity: 'week', span: [0, 9], code: 'last_week', field: 'any' };
const at1 = () => spec({ kinds: ['doc', 'link'], kindBoost: 'doc', range: LAST_WEEK, terms: [{ t: 'mtcs', w: 1 }], entities: [{ entityId: E.mtcs, hard: false, via: 'dict' }] });

describe('runQuery: the owner\'s questions', () => {
  it('AT-1: docs about mtcs last week are F1 and F2, scored by the formula', () => {
    const c = corpus();
    const result = runQuery(at1(), makeCtx(Object.values(c)));
    expect(result.relaxed).toBeNull();
    expect(result.total).toBe(2);
    expect(new Set(result.hits.map((h) => h.id))).toEqual(new Set([c.F1.id, c.F2.id]));
    expect(result.hits[0].score).toBeGreaterThanOrEqual(result.hits[1].score);
    // Top hit: bm25n 1 + entity 0.6 + doc 0.25 + title 0.2; no recency (a range was given).
    expect(result.hits[0].score).toBeCloseTo(1 + 0.6 + 0.25 + 0.2, 10);
    for (const hit of result.hits) {
      expect(hit.terms).toEqual(['mtcs']);
      expect(hit.why).toEqual(expect.arrayContaining([{ code: 'term', value: 'mtcs' }, { code: 'entity', value: E.mtcs }, { code: 'kind', value: 'doc' }, { code: 'title' }, { code: 'range' }]));
    }
  });

  it('AT-1b: nothing yesterday widens ±30 days bounded by now, ordered by closeness', () => {
    const c = corpus();
    const yesterday = { start: at(2026, 11, 5), end: at(2026, 11, 6), granularity: 'day', code: 'yesterday', field: 'any' };
    const result = runQuery(spec({ ...at1(), range: yesterday }), makeCtx(Object.values(c)));
    expect(result.relaxed).toEqual({ code: 'range_widened', range: { start: at(2026, 10, 6), end: NOW, field: 'any' } });
    expect(result.hits.map((h) => h.id)).toEqual([c.F3.id, c.F2.id, c.F1.id, c.F4.id]);
  });

  it('AT-5: the agent never sees the private match; AND falls back to OR and counts it hidden', () => {
    const c = corpus();
    const q = spec({ terms: [{ t: 'bingo' }, { t: 'salary' }], entities: [{ entityId: E.bingo, hard: false, via: 'dict' }] });
    const agent = runQuery(q, makeCtx(Object.values(c), { agent: true }));
    expect(agent.hiddenPrivate).toBe(1);
    expect(agent.hits.map((h) => h.id)).not.toContain(c.F10.id);
    expect(agent.hits.map((h) => h.id)).toEqual(expect.arrayContaining([c.F6.id, c.F7.id, c.F9.id]));
    expect(agent.hits.every((h) => !h.terms.includes('salary'))).toBe(true);

    const launcher = runQuery(q, makeCtx(Object.values(c)));
    expect(launcher.hiddenPrivate).toBe(0);
    expect(launcher.hits.map((h) => h.id)).toEqual([c.F10.id]);
  });

  it('matches the last word by prefix while typing', () => {
    const c = corpus();
    const result = runQuery(spec({ kinds: ['doc'], terms: [{ t: 'mtc', w: 0.8, prefix: true }] }), makeCtx(Object.values(c)));
    expect(new Set(result.hits.map((h) => h.id))).toEqual(new Set([c.F1.id, c.F2.id, c.F3.id]));
    expect(result.hits[0].terms).toEqual(['mtcs']);
  });

  it('counts an entity alias as matching the entity\'s name terms', () => {
    const extra = item(at(2026, 11, 5), { kind: 'note', title: 'control service notes', text: 'the multi tenant control service had an outage' });
    const result = runQuery(spec({ terms: [{ t: 'mtcs' }, { t: 'outage' }], entities: [{ entityId: E.mtcs, hard: false, via: 'dict' }] }), makeCtx([...Object.values(corpus()), extra]));
    expect(result.hits.map((h) => h.id)).toEqual([extra.id]);
    expect(result.hits[0].why).toEqual(expect.arrayContaining([{ code: 'alias', value: E.mtcs }]));
  });
});

describe('runQuery: hard filters', () => {
  it('filters by kind, and by range on createdAt or occurredAt', () => {
    const c = corpus();
    const meeting = item(at(2026, 11, 5), { kind: 'meeting', title: 'MTCS retro', occurredAt: at(2026, 10, 27, 15) });
    const ctx = makeCtx([...Object.values(c), meeting]);
    const result = runQuery(spec({ range: LAST_WEEK, terms: [{ t: 'mtcs' }] }), ctx);
    expect(result.hits.map((h) => h.id)).toContain(meeting.id);
    expect(result.hits.map((h) => h.id)).not.toContain(c.F3.id);
    const notes = runQuery(spec({ kinds: ['note'], terms: [{ t: 'mtcs' }] }), ctx);
    expect(notes.hits.map((h) => h.id)).toEqual([c.F5.id]);
  });

  it('filters by due range, status, owner and hard entity, and always drops archived items', () => {
    const c = corpus();
    const archived = item(at(2026, 11, 5), { kind: 'note', title: 'bingo archive', archived: true, entityIds: [E.bingo] });
    const ctx = makeCtx([...Object.values(c), archived]);
    const due = runQuery(spec({ range: { start: at(2026, 11, 2), end: at(2026, 11, 9), field: 'due', code: 'this_week' } }), ctx);
    expect(due.hits.map((h) => h.id)).toEqual([c.A1.id]);
    expect(runQuery(spec({ status: 'done' }), ctx).hits.map((h) => h.id)).toEqual([c.F9.id]);
    expect(runQuery(spec({ status: 'suggested' }), ctx).hits.map((h) => h.id)).toEqual([c.A2.id]);
    expect(runQuery(spec({ owner: E.dana }), ctx).hits.map((h) => h.id)).toEqual([c.A2.id]);
    const bingo = runQuery(spec({ terms: [{ t: 'bingo' }], entities: [{ entityId: E.bingo, hard: true, via: 'marker' }] }), ctx);
    expect(bingo.hits.map((h) => h.id)).not.toContain(archived.id);
    expect(bingo.hits.every((h) => ctx.getItem(h.id).entityIds.includes(E.bingo))).toBe(true);
    expect(runQuery(spec({ terms: [{ t: 'bingo' }, { t: 'salary', neg: true }] }), ctx).hits.map((h) => h.id)).not.toContain(c.F10.id);
  });

  it('keeps only private items for is:private, which the agent path never sees', () => {
    const c = corpus();
    expect(runQuery(spec({ privateOnly: true }), makeCtx(Object.values(c))).hits.map((h) => h.id)).toEqual([c.F10.id]);
    expect(runQuery(spec({ privateOnly: true }), makeCtx(Object.values(c), { agent: true }))).toMatchObject({ hits: [], hiddenPrivate: 1 });
    expect(runActions(spec({ privateOnly: true, owner: 'anyone' }), makeCtx(Object.values(c))).total).toBe(0);
  });

  it('lists filter-only queries newest first', () => {
    const c = corpus();
    const result = runQuery(spec({ kinds: ['doc'] }), makeCtx(Object.values(c)));
    expect(result.hits.map((h) => h.id)).toEqual([c.F3.id, c.F2.id, c.F1.id]);
  });
});

describe('runQuery: scoring', () => {
  it('adds recency only without a range, pins, and breaks ties newest first', () => {
    const twinA = item(NOW, { kind: 'note', title: 'alpha', text: 'alpha' });
    const twinB = item(NOW, { kind: 'note', title: 'alpha', text: 'alpha' });
    const old = item(NOW - 60 * 86_400_000, { kind: 'note', title: 'alpha', text: 'alpha', pinned: true });
    const result = runQuery(spec({ terms: [{ t: 'alpha' }] }), makeCtx([twinA, twinB, old]));
    expect(result.hits.map((h) => h.id)).toEqual([twinB.id, twinA.id, old.id]);
    expect(result.hits[0].score).toBeCloseTo(1 + WEIGHTS.title + WEIGHTS.recency, 10);
    // 60 days old: a quarter of the recency boost, plus the pin.
    expect(result.hits[2].score).toBeCloseTo(1 + WEIGHTS.title + WEIGHTS.recency * 0.25 + WEIGHTS.pinned, 6);
    const recently = runQuery(spec({ terms: [{ t: 'alpha' }], recency: true }), makeCtx([twinA]));
    expect(recently.hits[0].score).toBeCloseTo(1 + WEIGHTS.title + 2 * WEIGHTS.recency, 10);
  });

  it('boosts links less than docs, and an alias match less than a direct one', () => {
    const doc = item(at(2026, 10, 27), { kind: 'doc', title: 'plan', entityIds: [E.mtcs] });
    const link = item(at(2026, 10, 27), { kind: 'link', title: 'plan', entityIds: [E.mtcs] });
    const result = runQuery(spec({ range: LAST_WEEK, kindBoost: 'doc', kinds: ['doc', 'link'], terms: [{ t: 'plan' }], entities: [{ entityId: E.mtcs, hard: false }] }), makeCtx([doc, link]));
    const score = Object.fromEntries(result.hits.map((h) => [h.id, h.score]));
    expect(score[doc.id] - score[link.id]).toBeCloseTo(WEIGHTS.kindDoc - WEIGHTS.kindLink, 10);
  });

  it('honours the result limit but reports the total', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(NOW - i, { kind: 'note', title: `bingo ${i}`, text: 'bingo' }));
    const result = runQuery(spec({ terms: [{ t: 'bingo' }] }), makeCtx(many, { limit: 5 }));
    expect(result.hits).toHaveLength(5);
    expect(result.total).toBe(12);
  });
});

describe('runQuery: relaxation ladder', () => {
  const c = corpus();
  const ancient = item(at(2026, 8, 1), { kind: 'doc', title: 'ancient spreadsheet', text: 'quarterly spreadsheet' });
  const ctx = makeCtx([...Object.values(c), ancient]);
  const THIS_WEEK = { start: at(2026, 11, 2), end: at(2026, 11, 9), code: 'this_week', field: 'any' };

  it('widens, then drops the range', () => {
    expect(runQuery(spec({ range: THIS_WEEK, kinds: ['link'], terms: [{ t: 'intro' }] }), ctx).relaxed.code).toBe('range_widened');
    const dropped = runQuery(spec({ range: THIS_WEEK, terms: [{ t: 'spreadsheet' }] }), ctx);
    expect(dropped.relaxed).toEqual({ code: 'range_dropped' });
    expect(dropped.hits.map((h) => h.id)).toEqual([ancient.id]);
  });

  it('then drops the kinds, then softens hard entities, then gives up', () => {
    expect(runQuery(spec({ kinds: ['doc'], terms: [{ t: 'pricing' }] }), ctx).relaxed).toEqual({ code: 'kinds_dropped' });
    const softened = runQuery(spec({ range: LAST_WEEK, kinds: ['doc'], terms: [{ t: 'invoices' }], entities: [{ entityId: E.bingo, hard: true, via: 'phrase' }] }), ctx);
    expect(softened.relaxed).toEqual({ code: 'entities_softened' });
    expect(softened.hits.map((h) => h.id)).toEqual([c.F8.id]);
    expect(runQuery(spec({ range: LAST_WEEK, terms: [{ t: 'walrus' }] }), ctx)).toEqual({ hits: [], relaxed: { code: 'none' }, total: 0, hiddenPrivate: 0 });
    expect(runQuery(spec({ terms: [{ t: 'walrus' }] }), ctx).relaxed).toEqual({ code: 'none' });
  });

  it('reports what the asked scope hid when nothing visible matched', () => {
    const result = runQuery(spec({ terms: [{ t: 'salary' }] }), makeCtx(Object.values(c), { agent: true }));
    expect(result).toEqual({ hits: [], relaxed: { code: 'none' }, total: 0, hiddenPrivate: 1 });
  });
});

describe('runActions', () => {
  const at2 = () => spec({ intent: 'actions', owner: 'me', status: 'open', entities: [{ entityId: E.bingo, hard: true, via: 'phrase' }] });

  it('AT-2: my open Bingo actions in order, then the recently done', () => {
    const c = corpus();
    const result = runActions(at2(), makeCtx(Object.values(c)));
    expect(result.open).toEqual([c.A1.id, c.F7.id, c.A3.id, c.A4.id]);
    expect(result.done).toEqual([c.F9.id]);
    expect(result.suggested).toEqual([]);
    expect(result.groups).toEqual([{ entityId: E.bingo, ids: [c.A1.id, c.F7.id, c.A3.id, c.A4.id] }]);
    expect(result.total).toBe(4);
    expect(result.hiddenPrivate).toBe(0);
  });

  it('AT-2-agent: defaults to me and open', () => {
    const c = corpus();
    const result = runActions(spec({ entities: [{ entityId: E.bingo, hard: true }] }), makeCtx(Object.values(c), { agent: true }));
    expect(result.open).toEqual([c.A1.id, c.F7.id, c.A3.id, c.A4.id]);
    expect(result.total).toBe(4);
  });

  it('AT-2b: an unknown team searches the word and finds nothing', () => {
    const result = runActions(spec({ intent: 'actions', owner: 'me', terms: [{ t: 'walrus' }] }), makeCtx(Object.values(corpus())));
    expect(result).toEqual({ open: [], suggested: [], done: [], groups: [], total: 0, hiddenPrivate: 0 });
  });

  it('puts overdue first, then due ascending, then undated by newest parent and source order', () => {
    const c = corpus();
    const late = item(at(2026, 10, 20), { kind: 'action', title: 'late bingo thing', status: 'open', owner: 'me', dueAt: at(2026, 11, 2), entityIds: [E.bingo] });
    const later = item(at(2026, 10, 21), { kind: 'action', title: 'later bingo thing', status: 'open', owner: 'me', dueAt: at(2026, 11, 20), entityIds: [E.bingo] });
    const result = runActions(at2(), makeCtx([...Object.values(c), late, later]));
    expect(result.open).toEqual([late.id, c.A1.id, later.id, c.F7.id, c.A3.id, c.A4.id]);
    const overdue = runActions({ ...at2(), status: 'overdue' }, makeCtx([...Object.values(c), late]));
    expect(overdue.open).toEqual([late.id]);
    expect(overdue.done).toEqual([]);
  });

  it('keeps done actions for 14 days by default, and all of them for is:done', () => {
    const c = corpus();
    const old = item(at(2026, 10, 1), { kind: 'action', title: 'old bingo thing', status: 'done', doneAt: at(2026, 10, 20), owner: 'me', entityIds: [E.bingo] });
    const ctx = makeCtx([...Object.values(c), old]);
    expect(runActions(at2(), ctx).done).toEqual([c.F9.id]);
    const done = runActions({ ...at2(), status: 'done' }, ctx);
    expect(done.done).toEqual([c.F9.id, old.id]);
    expect(done.open).toEqual([]);
    expect(done.total).toBe(2);
  });

  it('lists everyone\'s suggestions for review, and everything for status all', () => {
    const c = corpus();
    const ctx = makeCtx(Object.values(c));
    const review = runActions(spec({ intent: 'actions', status: 'suggested' }), ctx);
    expect(review.suggested).toEqual([c.A2.id]);
    expect(review.total).toBe(1);
    const all = runActions(spec({ status: 'all', owner: 'anyone' }), ctx);
    expect(all.open).toHaveLength(5);
    expect(all.suggested).toEqual([c.A2.id]);
    expect(all.done).toEqual([c.F9.id]);
    expect(all.total).toBe(7);
    expect(runActions(spec({ owner: E.dana, status: 'all' }), ctx).suggested).toEqual([c.A2.id]);
  });

  it('groups by the first team or project, else topic, with Other last', () => {
    const c = corpus();
    const topicOnly = item(at(2026, 11, 5), { kind: 'action', title: 'prep the launch notes', status: 'open', owner: 'me', entityIds: [E.launch] });
    const loose = item(at(2026, 11, 5, 1), { kind: 'action', title: 'buy milk', status: 'open', owner: 'me' });
    const result = runActions(spec({ owner: 'me' }), makeCtx([...Object.values(c), topicOnly, loose]));
    // First appearance in the ordered list (undated: newest first), Other last.
    expect(result.groups.map((g) => g.entityId)).toEqual([E.bingo, E.launch, E.zebra, null]);
    expect(result.groups.at(-1).ids).toEqual([loose.id]);
  });

  it('counts private actions as hidden on the agent path', () => {
    const c = corpus();
    const secret = item(at(2026, 11, 5), { kind: 'action', title: 'bingo bonus', status: 'open', owner: 'me', private: true, entityIds: [E.bingo] });
    const result = runActions(at2(), makeCtx([...Object.values(c), secret], { agent: true }));
    expect(result.open).not.toContain(secret.id);
    expect(result.hiddenPrivate).toBe(1);
    expect(runActions(at2(), makeCtx([...Object.values(c), secret])).open).toContain(secret.id);
  });

  it('applies the limit to each list but reports the full total', () => {
    const c = corpus();
    const result = runActions(at2(), { ...makeCtx(Object.values(c)), limit: 2 });
    expect(result.open).toEqual([c.A1.id, c.F7.id]);
    expect(result.total).toBe(4);
  });
});
