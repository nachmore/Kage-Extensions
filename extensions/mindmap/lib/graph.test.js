import { describe, expect, it } from 'vitest';
import { LANES, LANE_CAP, SLOTS, layout, neighborhood, sizeOf, slotPositions } from './graph.js';

// A hand-built store shaped like the SPEC §3.1 corpus around Bingo.
const id = (prefix, n) => `${prefix}${String(n).padStart(14, '0')}`;
const E = { bingo: id('e', 1), dana: id('e', 2), mtcs: id('e', 3), zebra: id('e', 4), atlas: id('e', 5), ops: id('e', 6) };
const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h).getTime();
const I = {
  f1: id('i', 1), f2: id('i', 2), f3: id('i', 3), f4: id('i', 4), f5: id('i', 5), f6: id('i', 6),
  a1: id('i', 61), a2: id('i', 62), a3: id('i', 63), a4: id('i', 64),
  f7: id('i', 7), f8: id('i', 8), f9: id('i', 9), f10: id('i', 10), f11: id('i', 11), arch: id('i', 12), dis: id('i', 13),
};

function corpus() {
  const entities = {
    [E.bingo]: { id: E.bingo, type: 'team', name: 'Bingo' },
    [E.dana]: { id: E.dana, type: 'person', name: 'Dana' },
    [E.mtcs]: { id: E.mtcs, type: 'term', name: 'MTCS' },
    [E.zebra]: { id: E.zebra, type: 'team', name: 'Zebra' },
    [E.atlas]: { id: E.atlas, type: 'project', name: 'Atlas', private: true },
    [E.ops]: { id: E.ops, type: 'topic', name: 'ops' },
  };
  const items = {};
  const add = (key, o) => {
    items[I[key]] = { id: I[key], entityIds: [], createdAt: at(2026, 11, 1), ...o };
  };
  add('f1', { kind: 'doc', title: 'MTCS design review', url: 'https://wiki.example.com/mtcs/design-review', createdAt: at(2026, 10, 26), entityIds: [E.mtcs] });
  add('f2', { kind: 'doc', title: 'MTCS rollout plan.docx', createdAt: at(2026, 10, 28), source: { via: 'launcher', app: 'Microsoft Word' }, entityIds: [E.mtcs] });
  add('f3', { kind: 'doc', title: 'MTCS capacity notes.pdf', path: '~/Documents/MTCS capacity notes.pdf', createdAt: at(2026, 11, 3), entityIds: [E.mtcs] });
  add('f4', { kind: 'link', title: 'An intro to MTCS', createdAt: at(2026, 10, 22), entityIds: [E.mtcs] });
  add('f5', { kind: 'note', title: 'Lunch with Dana, talked about MTCS hiring', createdAt: at(2026, 10, 29), entityIds: [E.dana, E.mtcs] });
  add('f6', { kind: 'meeting', title: 'Bingo team sync', text: 'Bingo team sync\n- [ ] Send MTCS numbers…', createdAt: at(2026, 10, 30, 16), entityIds: [E.bingo, E.dana, E.mtcs] });
  const child = { parentId: I.f6, createdAt: at(2026, 10, 30, 16) };
  add('a1', { ...child, kind: 'action', title: 'Send MTCS numbers to Dana', status: 'open', seg: 1, dueAt: at(2026, 11, 6, 0), entityIds: [E.bingo, E.dana, E.mtcs] });
  add('a2', { ...child, kind: 'action', title: 'Dana to share the roadmap deck', status: 'open', suggested: true, seg: 2, entityIds: [E.bingo, E.dana] });
  add('a3', { ...child, kind: 'action', title: 'book the offsite', status: 'open', seg: 3, entityIds: [E.bingo] });
  add('a4', { ...child, kind: 'action', title: 'review the Bingo launch checklist', status: 'open', seg: 5, entityIds: [E.bingo] });
  add('f7', { kind: 'action', title: 'email the bingo team about the demo date', status: 'open', createdAt: at(2026, 11, 2), entityIds: [E.bingo] });
  add('f8', { kind: 'action', title: 'call the Zebra team about invoices', status: 'open', createdAt: at(2026, 11, 3), entityIds: [E.zebra] });
  add('f9', { kind: 'action', title: 'update the Bingo dashboard', status: 'done', createdAt: at(2026, 11, 4), entityIds: [E.bingo] });
  add('f10', { kind: 'note', title: 'bingo salary thoughts', private: true, createdAt: at(2026, 11, 4, 12), entityIds: [E.bingo] });
  add('f11', { kind: 'link', title: 'Pricing page', createdAt: at(2026, 10, 29, 15) });
  add('arch', { kind: 'note', title: 'archived bingo note', archived: true, createdAt: at(2026, 11, 5), entityIds: [E.bingo] });
  add('dis', { kind: 'action', title: 'not really an action', status: 'dismissed', createdAt: at(2026, 11, 5), entityIds: [E.bingo] });
  return { entities, items };
}

function makeCtx(overrides = {}) {
  const { entities, items } = corpus();
  const all = () => Object.values(items);
  const ctx = {
    getItem: (iid) => items[iid] || null,
    getEntity: (eid) => entities[eid] || null,
    itemsOfEntity: (eid) => all().filter((i) => i.entityIds.includes(eid)).map((i) => i.id),
    cooccur: (eid) => {
      const w = new Map();
      for (const item of all()) {
        if (!item.entityIds.includes(eid) || item.archived) continue;
        for (const other of item.entityIds) if (other !== eid) w.set(other, (w.get(other) || 0) + 1);
      }
      return [...w].map(([oid, weight]) => ({ id: oid, w: weight }));
    },
    related: (iid) => (iid === I.f6 ? [{ id: I.f1, score: 0.8 }, { id: I.f5, score: 0.6 }, { id: I.f2, score: 0.9 }, { id: I.f11, score: 0.1 }] : []),
    childrenOf: (iid) => all().filter((i) => i.parentId === iid).map((i) => i.id),
    overview: () => ({
      teams: [{ id: E.zebra, n: 1 }, { id: E.bingo, n: 7 }],
      projects: [{ id: E.atlas, n: 2 }],
      people: [{ id: E.dana, n: 4 }],
      topics: [{ id: E.mtcs, n: 6 }, { id: E.ops, n: 1 }],
      reviewCount: 1,
      openCount: 6,
      recent: [I.f10, I.f9, I.f8],
      counts: { items: 17, entities: 6, actions: 6 },
    }),
    ...overrides,
  };
  return { ctx, items, entities };
}

const labels = (lane) => lane.nodes.map((n) => (n.group === 'more' ? `+${n.more}` : n.label));

describe('constants', () => {
  it('declares four lanes with the SPEC caps and slot grid', () => {
    expect(LANES).toEqual(['up', 'left', 'right', 'down']);
    // Four per row (not SPEC §9.2's five): legible labels at 570 px (BUILD_NOTES).
    expect(LANE_CAP).toEqual({ up: 4, down: 4, left: 4, right: 4 });
    expect(SLOTS.up.map((s) => s.x)).toEqual([16, 39, 61, 84]);
    expect(SLOTS.up.every((s) => s.y === 12)).toBe(true);
    expect(SLOTS.down.every((s) => s.y === 88)).toBe(true);
    // side lanes sit at x 14 / 86 and step 15% from 27% (BUILD_NOTES WP-C)
    expect(SLOTS.left).toEqual([{ x: 14, y: 27 }, { x: 14, y: 42 }, { x: 14, y: 57 }, { x: 14, y: 72 }]);
    expect(SLOTS.right.every((s) => s.x === 86)).toBe(true);
    expect(SLOTS.center).toEqual({ x: 50, y: 50 });
  });

  it('full lanes use exactly the SPEC slots; partial lanes centre-justify', () => {
    expect(slotPositions('up', 4)).toEqual(SLOTS.up.map((s) => ({ ...s })));
    expect(slotPositions('left', 4)).toEqual(SLOTS.left.map((s) => ({ ...s })));
    expect(slotPositions('up', 1)).toEqual([{ x: 50, y: 12 }]);
    expect(slotPositions('down', 2)).toEqual([{ x: 34, y: 88 }, { x: 66, y: 88 }]);
    expect(slotPositions('right', 1)).toEqual([{ x: 86, y: 50 }]);
    expect(slotPositions('left', 0)).toEqual([]);
  });

  it('sizes nodes by degree', () => {
    expect([sizeOf(0), sizeOf(2), sizeOf(3), sizeOf(7), sizeOf(8)]).toEqual(['s', 's', 'm', 'm', 'l']);
  });
});

describe('entity focus (SPEC AT-6)', () => {
  it('assigns the typed lanes for Bingo (team)', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    expect(n.focus).toEqual({ type: 'entity', id: E.bingo });
    expect(n.center).toMatchObject({ ref: E.bingo, group: 'entity', kind: 'team', label: 'Bingo' });
    // up: co-occurring entities by weight
    expect(n.lanes.up.role).toBe('entities');
    expect(labels(n.lanes.up)).toEqual(['Dana', 'MTCS']);
    // left: 4 open + 1 suggested in a 4-slot lane → 3 nodes + "+2 more"
    expect(n.lanes.left.role).toBe('actions');
    expect(labels(n.lanes.left)).toEqual(['Send MTCS numbers to Dana', 'email the bingo team about the demo date', 'book the offsite', '+2']);
    expect(n.lanes.left.more).toBe(2);
    // right: no docs or links mention Bingo
    expect(n.lanes.right.role).toBe('docs');
    expect(n.lanes.right.nodes).toEqual([]);
    // down: notes + meetings, newest first; the private note is flagged
    expect(n.lanes.down.role).toBe('notes');
    expect(labels(n.lanes.down)).toEqual(['bingo salary thoughts', 'Bingo team sync']);
    expect(n.lanes.down.nodes[0].private).toBe(true);
    expect(n.lanes.down.nodes[1].private).toBeUndefined();
  });

  it('counts open, suggested, docs and notes on the centre', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    // visible: F6, its 4 actions, F7, F9 (done), F10 — not the archived note or the dismissed action
    expect(n.center.counts).toEqual({ items: 8, actions: 4, suggested: 1, docs: 0, notes: 2 });
  });

  it('excludes done, dismissed and archived items', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'entity', id: E.bingo }, { ...ctx, page: { left: 1 } });
    const refs = LANES.flatMap((l) => n.lanes[l].nodes.map((x) => x.ref));
    expect(refs).not.toContain(I.f9);
    expect(refs).not.toContain(I.dis);
    expect(refs).not.toContain(I.arch);
  });

  it('pages a full lane and wraps back to the first page', () => {
    const { ctx } = makeCtx();
    const p1 = neighborhood({ type: 'entity', id: E.bingo }, { ...ctx, page: { left: 1 } });
    expect(labels(p1.lanes.left)).toEqual(['review the Bingo launch checklist', 'Dana to share the roadmap deck', '+0']);
    expect(p1.lanes.left.page).toBe(1);
    const more = p1.lanes.left.nodes.at(-1);
    expect(more).toMatchObject({ ref: 'more:left', group: 'more', wrap: true, more: 0 });
    // suggested actions are marked
    expect(p1.lanes.left.nodes[1].suggested).toBe(true);
    const p2 = neighborhood({ type: 'entity', id: E.bingo }, { ...ctx, page: { left: 2 } });
    expect(labels(p2.lanes.left)).toEqual(labels(neighborhood({ type: 'entity', id: E.bingo }, ctx).lanes.left));
    expect(p2.lanes.left.page).toBe(0);
  });

  it('is deterministic: the same input gives deep-equal output', () => {
    const { ctx } = makeCtx();
    const a = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    const b = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    expect(a).toEqual(b);
  });

  it('breaks ties on id ascending, whatever order the store returns', () => {
    const { ctx } = makeCtx();
    const reversed = { ...ctx, itemsOfEntity: (eid) => ctx.itemsOfEntity(eid).reverse(), cooccur: (eid) => ctx.cooccur(eid).reverse() };
    const a = neighborhood({ type: 'entity', id: E.mtcs }, ctx);
    const b = neighborhood({ type: 'entity', id: E.mtcs }, reversed);
    expect(b).toEqual(a);
    // MTCS docs and links newest first: F3 (Nov 3), F2 (Oct 28), F1 (Oct 26), F4 (Oct 22)
    expect(labels(a.lanes.right)).toEqual(['MTCS capacity notes.pdf', 'MTCS rollout plan.docx', 'MTCS design review', 'An intro to MTCS']);
  });

  it('passes kinds through to the lanes', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'entity', id: E.mtcs }, { ...ctx, kinds: ['doc'] });
    expect(labels(n.lanes.right)).toEqual(['MTCS capacity notes.pdf', 'MTCS rollout plan.docx', 'MTCS design review']);
    expect(n.lanes.left.nodes).toEqual([]);
    expect(n.lanes.down.nodes).toEqual([]);
    expect(n.lanes.up.nodes.length).toBeGreaterThan(0);
  });

  it('flags private entities', () => {
    const { ctx } = makeCtx({ cooccur: () => [{ id: E.atlas, w: 1 }] });
    const n = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    expect(n.lanes.up.nodes[0]).toMatchObject({ label: 'Atlas', private: true });
  });

  it('returns null for a missing focus or a bad focus shape', () => {
    const { ctx } = makeCtx();
    expect(neighborhood({ type: 'entity', id: id('e', 99) }, ctx)).toBeNull();
    expect(neighborhood({ type: 'item', id: id('i', 99) }, ctx)).toBeNull();
    expect(neighborhood({ type: 'entity' }, ctx)).toBeNull();
    expect(neighborhood({ type: 'galaxy', id: 'x' }, ctx)).toBeNull();
    expect(neighborhood(null, ctx)).toBeNull();
  });

  it('survives ctx functions that throw or are missing', () => {
    const { ctx } = makeCtx();
    const broken = { ...ctx, cooccur: () => { throw new Error('boom'); }, related: undefined };
    const n = neighborhood({ type: 'entity', id: E.bingo }, broken);
    expect(n.lanes.up.nodes).toEqual([]);
    expect(n.lanes.left.nodes.length).toBe(4);
  });
});

describe('item focus', () => {
  it('meeting: its entities up, child actions left in source order, related right/down', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'item', id: I.f6 }, ctx);
    expect(n.center).toMatchObject({ ref: I.f6, group: 'item', kind: 'meeting', label: 'Bingo team sync' });
    expect(n.center.snippet).toContain('Bingo team sync');
    expect(n.center.day).toBe(at(2026, 10, 30, 16));
    // entities ordered by degree: Bingo (10 items) > MTCS (7) > Dana (4)
    expect(labels(n.lanes.up)).toEqual(['Bingo', 'MTCS', 'Dana']);
    expect(n.lanes.left.role).toBe('actions');
    expect(labels(n.lanes.left)).toEqual(['Send MTCS numbers to Dana', 'Dana to share the roadmap deck', 'book the offsite', 'review the Bingo launch checklist']);
    // related docs/links by score: F2 (0.9), F1 (0.8), F11 (0.1)
    expect(labels(n.lanes.right)).toEqual(['MTCS rollout plan.docx', 'MTCS design review', 'Pricing page']);
    expect(labels(n.lanes.down)).toEqual(['Lunch with Dana, talked about MTCS hiring']);
  });

  it('action: its parent on the left (role "parent")', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'item', id: I.a1 }, ctx);
    expect(n.center).toMatchObject({ kind: 'action', status: 'open', dueAt: at(2026, 11, 6, 0) });
    expect(n.lanes.left.role).toBe('parent');
    expect(labels(n.lanes.left)).toEqual(['Bingo team sync']);
    expect(labels(n.lanes.up)).toEqual(['Bingo', 'MTCS', 'Dana']);
  });

  it('a stand-alone action has an empty parent lane', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'item', id: I.f7 }, ctx);
    expect(n.lanes.left).toMatchObject({ role: 'parent', nodes: [], more: 0 });
  });

  it('a child that is a doc puts its meeting parent in the notes lane', () => {
    const { ctx, items } = makeCtx();
    items[I.f3].parentId = I.f6;
    const n = neighborhood({ type: 'item', id: I.f3 }, ctx);
    expect(labels(n.lanes.down)).toEqual(['Bingo team sync']);
  });

  it('carries source app and url for the centre card', () => {
    const { ctx } = makeCtx();
    expect(neighborhood({ type: 'item', id: I.f2 }, ctx).center.app).toBe('Microsoft Word');
    expect(neighborhood({ type: 'item', id: I.f1 }, ctx).center.url).toBe('https://wiki.example.com/mtcs/design-review');
  });
});

describe('overview focus', () => {
  it('teams + projects up, people left, topics right, stats + recent down', () => {
    const { ctx } = makeCtx();
    const n = neighborhood({ type: 'overview' }, ctx);
    expect(n.focus).toEqual({ type: 'overview' });
    expect(n.center).toMatchObject({ ref: 'o', group: 'overview', counts: { items: 17, entities: 6, actions: 6 } });
    expect(n.lanes.up.role).toBe('teams');
    expect(labels(n.lanes.up)).toEqual(['Bingo', 'Atlas', 'Zebra']);
    expect(n.lanes.up.nodes[1].private).toBe(true);
    expect(labels(n.lanes.left)).toEqual(['Dana']);
    expect(labels(n.lanes.right)).toEqual(['MTCS', 'ops']);
    const down = n.lanes.down.nodes;
    expect(n.lanes.down.role).toBe('stats');
    expect(down.map((x) => x.ref)).toEqual(['review', 'actions', I.f10, I.f9]);
    expect(down[0]).toMatchObject({ group: 'stat', count: 1 });
    expect(down[1]).toMatchObject({ group: 'stat', count: 6 });
  });

  it('skips zero counts and copes with an empty store', () => {
    const n = neighborhood({ type: 'overview' }, { overview: () => ({}) });
    for (const lane of LANES) expect(n.lanes[lane].nodes).toEqual([]);
    expect(n.center.counts).toEqual({});
  });
});

describe('layout', () => {
  it('assigns slot ids, coordinates and one edge per real node', () => {
    const { ctx } = makeCtx();
    const placed = layout(neighborhood({ type: 'entity', id: E.bingo }, ctx));
    const bySlot = Object.fromEntries(placed.nodes.map((n) => [n.slot, n]));
    expect(Object.keys(bySlot)).toEqual(['u1', 'u2', 'l1', 'l2', 'l3', 'l4', 'd1', 'd2']);
    expect(bySlot.u1).toMatchObject({ label: 'Dana', lane: 'up', side: 'up', x: 34, y: 12 });
    expect(bySlot.u2).toMatchObject({ x: 66, y: 12 });
    expect(bySlot.l1).toMatchObject({ x: 14, y: 27 });
    expect(bySlot.l4).toMatchObject({ group: 'more', x: 14, y: 72 });
    expect(bySlot.d1).toMatchObject({ x: 34, y: 88 });
    // the more-node gets no edge
    expect(placed.edges).toHaveLength(7);
    expect(placed.edges[0]).toMatchObject({ lane: 'up', x2: 34, y2: 12, style: 'solid' });
    // empty right lane → a hint at its centre
    expect(placed.hints).toEqual([{ lane: 'right', side: 'right', role: 'docs', x: 86, y: 50 }]);
  });

  it('dashes edges to suggested and done nodes', () => {
    const { ctx } = makeCtx();
    const placed = layout(neighborhood({ type: 'entity', id: E.bingo }, { ...ctx, page: { left: 1 } }));
    const sug = placed.edges.find((e) => e.ref === I.a2);
    expect(sug.style).toBe('dashed');
    const done = layout({ center: {}, lanes: { up: { nodes: [{ ref: I.f9, group: 'item', kind: 'action', status: 'done' }] }, left: { nodes: [] }, right: { nodes: [] }, down: { nodes: [] } } });
    expect(done.edges[0].style).toBe('dashed');
  });

  it('RTL swaps the left and right lanes and mirrors x', () => {
    const { ctx } = makeCtx();
    const neigh = neighborhood({ type: 'entity', id: E.bingo }, ctx);
    const ltr = layout(neigh);
    const rtl = layout(neigh, { rtl: true });
    const action = rtl.nodes.find((n) => n.lane === 'left');
    expect(action).toMatchObject({ side: 'right', slot: 'r1', x: 86, y: 27 });
    const up = rtl.nodes.filter((n) => n.lane === 'up').map((n) => [n.label, n.x]);
    expect(up).toEqual([['Dana', 66], ['MTCS', 34]]);
    for (const [i, e] of rtl.edges.entries()) {
      expect(e.x2).toBe(100 - ltr.edges[i].x2);
      expect(e.y2).toBe(ltr.edges[i].y2);
    }
    expect(rtl.hints).toEqual([{ lane: 'right', side: 'left', role: 'docs', x: 14, y: 50 }]);
  });

  it('only ever produces coordinates from the class grid', () => {
    const xs = new Set();
    const ys = new Set();
    for (const rtl of [false, true]) {
      for (const lane of LANES) {
        for (let n = 1; n <= LANE_CAP[lane]; n++) {
          const nodes = Array.from({ length: n }, (_, i) => ({ ref: id('i', i + 1), group: 'item', kind: 'note', label: 'x' }));
          const lanes = Object.fromEntries(LANES.map((l) => [l, { role: 'notes', nodes: l === lane ? nodes : [] }]));
          const placed = layout({ center: {}, lanes }, { rtl });
          for (const p of [...placed.nodes, ...placed.hints]) {
            xs.add(p.x);
            ys.add(p.y);
          }
        }
      }
    }
    expect([...xs].sort((a, b) => a - b)).toEqual([14, 16, 18, 34, 39, 50, 61, 66, 82, 84, 86]);
    expect([...ys].sort((a, b) => a - b)).toEqual([12, 27, 35, 42, 50, 57, 58, 65, 72, 88]);
  });

  it('width classes follow lane density', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ ref: id('e', i + 1), group: 'entity', kind: 'person', label: 'p' }));
    const lanes = { up: { nodes: mk(5) }, down: { nodes: mk(2) }, left: { nodes: mk(1) }, right: { nodes: mk(4) } };
    const placed = layout({ center: {}, lanes });
    const w = (lane) => [...new Set(placed.nodes.filter((n) => n.lane === lane).map((n) => n.w))];
    expect(w('up')).toEqual(['n']);
    expect(w('down')).toEqual(['w']);
    expect(w('left')).toEqual(['s']);
    expect(w('right')).toEqual(['s']);
  });

  it('handles a missing neighbourhood', () => {
    expect(layout(null)).toEqual({ center: null, nodes: [], edges: [], hints: [] });
  });
});
