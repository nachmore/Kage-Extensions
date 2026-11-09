import { describe, expect, it } from 'vitest';
import {
  EXPAND_CAP, LANE_OF_ROLE, NODE_SIZE, SCENE_CAP, SCENE_MAX, applyPins, applyRelax, buildScene, carryPositions, collapse,
  diffScene, expand, moveNode, normalizeLens, passesLens, readingOrder, rebuildScene, relaxInput, sceneBounds,
} from './scene.js';

const eid = (n) => `e${String(n).padStart(14, '0')}`;
const iid = (n) => `i${String(n).padStart(14, '0')}`;

// A hand-built graph behind the DataPort's links() (mind.js shape).
function fakePort(graph) {
  return {
    calls: 0,
    links(ref, { limit = 60 } = {}) {
      this.calls += 1;
      const entry = graph.get(ref);
      if (!entry) return null;
      const links = entry.links.filter((l) => graph.has(l.ref)).slice(0, limit).map((l) => ({ style: 'solid', w: 1, ...l, node: graph.get(l.ref).node }));
      return { node: entry.node, links };
    },
  };
}

function entity(n, name, kind = 'team') {
  return { ref: eid(n), group: 'entity', kind, label: name };
}

function item(n, kind, label, extra = {}) {
  return { ref: iid(n), group: 'item', kind, label, at: 1_700_000_000_000 + n, ...extra };
}

// Bingo (team) with related names, actions, docs and notes.
function bingoGraph() {
  const g = new Map();
  const add = (node, links = []) => g.set(node.ref, { node, links });
  const bingo = entity(1, 'Bingo');
  add(bingo, [
    { ref: eid(2), role: 'entities', style: 'thin', w: 1 },
    { ref: iid(10), role: 'actions' },
    { ref: iid(20), role: 'docs' },
    { ref: iid(30), role: 'notes' },
    { ref: eid(3), role: 'entities', style: 'thin', w: 0.5 },
    { ref: iid(11), role: 'actions', style: 'dashed' },
    { ref: iid(21), role: 'docs' },
    { ref: iid(31), role: 'notes' },
    { ref: iid(12), role: 'actions' },
    { ref: iid(13), role: 'actions' },
  ]);
  add(entity(2, 'Dana', 'person'), [{ ref: eid(1), role: 'entities', style: 'thin' }, { ref: iid(40), role: 'notes' }, { ref: iid(41), role: 'docs' }]);
  add(entity(3, 'MTCS', 'topic'), [{ ref: eid(1), role: 'entities', style: 'thin', w: 0.5 }, { ref: iid(20), role: 'docs' }, { ref: iid(42), role: 'notes' }]);
  add(item(10, 'action', 'Send the numbers', { status: 'open', mine: true }), [{ ref: eid(1), role: 'entities' }]);
  add(item(11, 'action', 'Dana to share the deck', { status: 'open', suggested: true, mine: false }), [{ ref: eid(1), role: 'entities' }]);
  add(item(12, 'action', 'Book the offsite', { status: 'done', mine: true }), [{ ref: eid(1), role: 'entities' }]);
  add(item(13, 'action', 'Review the checklist', { status: 'open', mine: true, private: true }), [{ ref: eid(1), role: 'entities' }]);
  add(item(20, 'doc', 'Design review'), [{ ref: eid(1), role: 'entities' }, { ref: eid(3), role: 'entities' }]);
  add(item(21, 'link', 'Launch page'), [{ ref: eid(1), role: 'entities' }]);
  add(item(30, 'meeting', 'Team sync'), [{ ref: eid(1), role: 'entities' }, { ref: iid(10), role: 'actions' }]);
  add(item(31, 'note', 'Lunch thoughts'), [{ ref: eid(1), role: 'entities' }]);
  add(item(40, 'note', 'Dana 1:1'), [{ ref: eid(2), role: 'entities' }]);
  add(item(41, 'doc', 'Roadmap deck'), [{ ref: eid(2), role: 'entities' }]);
  add(item(42, 'note', 'MTCS hiring'), [{ ref: eid(3), role: 'entities' }]);
  return g;
}

const positions = (scene) => Object.fromEntries(scene.nodes.map((n) => [n.ref, [n.x, n.y]]));
const nodeOf = (scene, ref) => scene.nodes[scene.byRef.get(ref)];

describe('buildScene', () => {
  it('centres the focus and seeds the map card’s lanes', () => {
    const scene = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    const f = nodeOf(scene, eid(1));
    expect(f).toMatchObject({ focus: true, depth: 0, x: 0, y: 0, pinned: false });
    expect(f.w).toBeGreaterThan(NODE_SIZE.entity.w);
    // Entities above, actions on the start side, docs on the end side, notes below.
    expect(nodeOf(scene, eid(2)).y).toBeLessThan(0);
    expect(nodeOf(scene, iid(10)).x).toBeLessThan(0);
    expect(nodeOf(scene, iid(20)).x).toBeGreaterThan(0);
    expect(nodeOf(scene, iid(30)).y).toBeGreaterThan(0);
    expect(LANE_OF_ROLE).toMatchObject({ entities: 'up', actions: 'start', docs: 'end', notes: 'down' });
    // Depth 2 comes from the neighbours' links.
    expect(nodeOf(scene, iid(40))).toMatchObject({ depth: 2, via: eid(2), lane: 'up' });
    expect(nodeOf(scene, iid(40)).y).toBeLessThan(nodeOf(scene, eid(2)).y);
    expect(scene.bounds).toEqual(sceneBounds(scene.nodes));
  });

  it('is deterministic: the same input gives the same positions', () => {
    const a = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    const b = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    expect(positions(a)).toEqual(positions(b));
    expect(a.edges).toEqual(b.edges);
  });

  it('mirrors around the focus in RTL', () => {
    const ltr = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    const rtl = buildScene(fakePort(bingoGraph()), { focus: eid(1), rtl: true });
    expect(rtl.rtl).toBe(true);
    for (const node of ltr.nodes) {
      const other = nodeOf(rtl, node.ref);
      expect(other.x, node.ref).toBe(node.x === 0 ? 0 : -node.x);
      expect(other.y).toBe(node.y);
    }
    // Actions sit on the start side, which is the right in RTL.
    expect(nodeOf(rtl, iid(10)).x).toBeGreaterThan(0);
  });

  it('mirrors around a focus that isn’t at the origin', () => {
    const origin = { x: 500, y: 40 };
    const ltr = buildScene(fakePort(bingoGraph()), { focus: eid(1), origin });
    const rtl = buildScene(fakePort(bingoGraph()), { focus: eid(1), origin, rtl: true });
    for (const node of ltr.nodes) expect(nodeOf(rtl, node.ref).x).toBe(2 * 500 - node.x);
  });

  it('keeps pinned nodes where they were pinned (RTL too)', () => {
    const pins = { [iid(20)]: { x: 999, y: -999, at: 1 }, [eid(1)]: { x: 100, y: 50, at: 1 } };
    for (const rtl of [false, true]) {
      const scene = buildScene(fakePort(bingoGraph()), { focus: eid(1), pins, rtl });
      expect(nodeOf(scene, iid(20))).toMatchObject({ x: 999, y: -999, pinned: true });
      expect(nodeOf(scene, eid(1))).toMatchObject({ x: 100, y: 50, pinned: true });
      // Neighbours seed around the pinned focus.
      expect(nodeOf(scene, iid(30)).y).toBeGreaterThan(50);
    }
  });

  it('applies the lens: done actions hidden by default, kinds and my actions', () => {
    const port = fakePort(bingoGraph());
    const plain = buildScene(port, { focus: eid(1) });
    expect(plain.byRef.has(iid(12))).toBe(false);
    expect(buildScene(port, { focus: eid(1), lens: { done: true } }).byRef.has(iid(12))).toBe(true);
    const docs = buildScene(port, { focus: eid(1), lens: { kinds: ['doc'] } });
    expect(docs.nodes.filter((n) => n.group === 'item').map((n) => n.kind)).toEqual(['doc', 'doc']);
    expect(docs.byRef.has(eid(2))).toBe(true);
    const mine = buildScene(port, { focus: eid(1), lens: { mine: true } });
    expect(mine.byRef.has(iid(11))).toBe(false);
    expect(mine.byRef.has(iid(10))).toBe(true);
    expect(normalizeLens({ kinds: ['note', 'link', 'doc', 'action', 'meeting'] }).kinds).toBeNull();
    expect(normalizeLens({ kinds: ['bogus'] }).kinds).toBeNull();
    expect(passesLens({ group: 'entity' }, normalizeLens({ kinds: ['doc'] }))).toBe(true);
  });

  it('caps the scene and says it’s full', () => {
    const scene = buildScene(fakePort(bingoGraph()), { focus: eid(1), cap: 5 });
    expect(scene.nodes).toHaveLength(5);
    expect(scene.full).toBe(true);
    expect(SCENE_CAP).toBe(300);
    expect(SCENE_MAX).toBe(2000);
    expect(EXPAND_CAP).toBe(60);
  });

  it('marks a focus that no longer exists', () => {
    const scene = buildScene(fakePort(bingoGraph()), { focus: eid(99) });
    expect(scene).toMatchObject({ missing: true, nodes: [], bounds: null });
    expect(buildScene(fakePort(bingoGraph()), { focus: '../x' }).focus).toBe('o');
  });

  it('keeps one edge per pair, with the strongest style', () => {
    const scene = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    const keys = scene.edges.map((e) => [e.a, e.b].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    const sug = scene.edges.find((e) => [e.a, e.b].includes(iid(11)));
    expect(sug.style).toBe('dashed');
    const co = scene.edges.find((e) => [e.a, e.b].includes(eid(3)) && [e.a, e.b].includes(eid(1)));
    expect(co).toMatchObject({ style: 'thin', w: 0.5 });
  });
});

describe('expand and collapse', () => {
  it('adds a node’s neighbours outward from it, and collapses them again', () => {
    const port = fakePort(bingoGraph());
    const scene = buildScene(port, { focus: eid(1), hops: 1 });
    expect(scene.byRef.has(iid(40))).toBe(false);
    const out = expand(scene, eid(2), port);
    expect(out.added.sort()).toEqual([iid(40), iid(41)].sort());
    expect(out.scene.expanded).toEqual([eid(2)]);
    expect(scene.expanded).toEqual([]);
    const dana = nodeOf(out.scene, eid(2));
    for (const ref of out.added) {
      const n = nodeOf(out.scene, ref);
      expect(n.via).toBe(eid(2));
      expect(n.depth).toBe(2);
      expect(n.y).toBeLessThan(dana.y);
    }
    const back = collapse(out.scene, eid(2));
    expect(back.removed.sort()).toEqual(out.added.sort());
    expect(back.scene.nodes.map((n) => n.ref).sort()).toEqual(scene.nodes.map((n) => n.ref).sort());
    expect(back.scene.expanded).toEqual([]);
  });

  it('stops at the scene limit', () => {
    const port = fakePort(bingoGraph());
    const scene = buildScene(port, { focus: eid(1), hops: 1 });
    const out = expand(scene, eid(2), port, { max: scene.nodes.length + 1 });
    expect(out.added).toHaveLength(1);
    expect(out.full).toBe(true);
    expect(expand(scene, eid(77), port).added).toEqual([]);
  });

  it('continues a lane when the focus itself is expanded', () => {
    const g = bingoGraph();
    const port = fakePort(g);
    const scene = buildScene(port, { focus: eid(1), hops: 1, linkLimit: 4 });
    const out = expand(scene, eid(1), port, { cap: 10 });
    expect(out.added.length).toBeGreaterThan(0);
    const taken = new Set(scene.nodes.map((n) => `${n.x},${n.y}`));
    for (const ref of out.added) expect(taken.has(`${nodeOf(out.scene, ref).x},${nodeOf(out.scene, ref).y}`)).toBe(false);
  });
});

describe('rebuilding, diffs and pins', () => {
  it('rebuilds over fresh data, keeping positions and expansions', () => {
    const g = bingoGraph();
    const port = fakePort(g);
    let scene = buildScene(port, { focus: eid(1), hops: 1 });
    scene = expand(scene, eid(2), port).scene;
    scene = moveNode(scene, iid(20), 777, 333);
    // Another window adds a note about Bingo and renames a doc.
    g.set(iid(50), { node: item(50, 'note', 'New thought'), links: [{ ref: eid(1), role: 'entities' }] });
    g.get(eid(1)).links.push({ ref: iid(50), role: 'notes' });
    g.get(iid(21)).node = { ...g.get(iid(21)).node, label: 'Launch page v2' };
    const next = rebuildScene(scene, port, { hops: 1 });
    expect(nodeOf(next, iid(20))).toMatchObject({ x: 777, y: 333 });
    expect(next.byRef.has(iid(40))).toBe(true);
    expect(next.expanded).toEqual([eid(2)]);
    const d = diffScene(scene, next);
    expect(d.added).toEqual([iid(50)]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([iid(21)]);
    // The new note is seeded below the focus.
    expect(nodeOf(next, iid(50)).y).toBeGreaterThan(0);
  });

  it('applies pins from another window and carries positions', () => {
    const port = fakePort(bingoGraph());
    const scene = buildScene(port, { focus: eid(1) });
    const pinned = applyPins(scene, { [iid(30)]: { x: -50, y: 900 } });
    expect(nodeOf(pinned, iid(30))).toMatchObject({ x: -50, y: 900, pinned: true });
    expect(nodeOf(applyPins(pinned, {}), iid(30)).pinned).toBe(false);
    const moved = moveNode(scene, iid(31), 5, 6);
    const carried = carryPositions(moved, buildScene(port, { focus: eid(1) }));
    expect(nodeOf(carried, iid(31))).toMatchObject({ x: 5, y: 6 });
    expect(diffScene(scene, moved).moved).toEqual([iid(31)]);
  });

  it('lists nodes in reading order: focus, then up, start, end, down', () => {
    const scene = buildScene(fakePort(bingoGraph()), { focus: eid(1) });
    const order = readingOrder(scene);
    expect(order[0].ref).toBe(eid(1));
    const lanes = order.slice(1).map((n) => n.lane);
    const rank = { up: 0, start: 1, end: 2, down: 3 };
    for (let i = 1; i < lanes.length; i++) expect(rank[lanes[i]]).toBeGreaterThanOrEqual(rank[lanes[i - 1]]);
  });

  it('feeds relax and applies its result to free nodes only', () => {
    const port = fakePort(bingoGraph());
    const scene = applyPins(buildScene(port, { focus: eid(1) }), { [iid(20)]: { x: 1, y: 1 } });
    const free = new Set([iid(30), iid(20)]);
    const input = relaxInput(scene, { free });
    expect(input.nodes.find((n) => n.id === eid(1)).fixed).toBe(true);
    expect(input.nodes.find((n) => n.id === iid(20)).fixed).toBe(true);
    expect(input.nodes.find((n) => n.id === iid(30)).fixed).toBe(false);
    expect(input.nodes.find((n) => n.id === iid(31)).fixed).toBe(true);
    expect(input.edges.every((e) => e.len > 0 && Number.isInteger(e.a) && Number.isInteger(e.b))).toBe(true);
    const xy = scene.nodes.flatMap(() => [42, 43]);
    const out = applyRelax(scene, { xy });
    expect(nodeOf(out, iid(30))).toMatchObject({ x: 42, y: 43 });
    expect(nodeOf(out, eid(1))).toMatchObject({ x: 0, y: 0 });
    expect(nodeOf(out, iid(20))).toMatchObject({ x: 1, y: 1 });
    expect(applyRelax(scene, { xy: [1] })).toBe(scene);
  });

  it('builds 2,000 nodes quickly (soft budget: 50 ms)', () => {
    const g = new Map();
    const hub = entity(1, 'Hub');
    const links = [];
    for (let i = 0; i < 60; i++) {
      const e = entity(100 + i, `Topic ${i}`, 'topic');
      const kids = [];
      for (let j = 0; j < 40; j++) {
        const it = item(10_000 + i * 100 + j, j % 2 ? 'note' : 'doc', `Note ${i}.${j}`);
        g.set(it.ref, { node: it, links: [{ ref: e.ref, role: 'entities' }] });
        kids.push({ ref: it.ref, role: j % 2 ? 'notes' : 'docs' });
      }
      g.set(e.ref, { node: e, links: [{ ref: hub.ref, role: 'entities' }, ...kids] });
      links.push({ ref: e.ref, role: 'entities', style: 'thin' });
    }
    g.set(hub.ref, { node: hub, links });
    const started = performance.now();
    const scene = buildScene(fakePort(g), { focus: hub.ref, cap: 2000, hopLimit: 40 });
    const ms = performance.now() - started;
    if (ms > 50) console.warn(`buildScene took ${ms.toFixed(1)} ms for ${scene.nodes.length} nodes`);
    expect(scene.nodes.length).toBe(2000);
  });
});
