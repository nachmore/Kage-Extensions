// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// What the explorer draws (EXTENSION_VIEWS §24.4): a focus, its neighbours
// up to `hops` links away, and the edges between them, with a world
// position for every node. Plain data in, plain data out; the only input is
// a DataPort's `links(ref, {limit})` (mind.js):
//
//   links(ref) → null | { node: ExNode, links: [{ ref, role, style, w, node: ExNode }] }
//   ExNode     = { ref, group: 'entity'|'item'|'overview', kind, label,
//                  status?, suggested?, private?, mine?, at?, app?, dueAt?, doneAt? }
//
// Seed positions follow the map card's lanes so the two feel alike:
// entities above, actions on the start side, docs and links on the end
// side, notes and meetings below. In RTL the whole picture mirrors around
// the focus. Pinned nodes (mm-layout) keep their saved positions. Every
// order is total (link order, then insertion), so the same input gives the
// same scene.

export const SCENE_CAP = 300;
export const EXPAND_CAP = 60;
export const SCENE_MAX = 2000;
export const HOPS = 2;

export const REF_RE = /^(?:o|me|[ie][0-9a-z]{14})$/;
export const ITEM_KINDS = Object.freeze(['note', 'link', 'doc', 'action', 'meeting']);
export const LANE_ORDER = Object.freeze(['up', 'start', 'end', 'down']);

// Which side a link's role seeds on (the map card's lanes, SPEC §9.2).
export const LANE_OF_ROLE = Object.freeze({
  entities: 'up', teams: 'up',
  actions: 'start', parent: 'start', people: 'start',
  docs: 'end', topics: 'end',
  notes: 'down', stats: 'down',
});

export const NODE_SIZE = Object.freeze({
  entity: Object.freeze({ w: 140, h: 32 }),
  item: Object.freeze({ w: 184, h: 44 }),
  overview: Object.freeze({ w: 200, h: 56 }),
});
const FOCUS_SCALE = 1.2;

const STYLE_RANK = { solid: 3, dashed: 2, thin: 1 };

// Lane geometry for the focus's own neighbours (logical, LTR).
const LANES = {
  up: { per: 6, gap: 176, first: 150, step: 56, axis: 'x', dir: -1 },
  down: { per: 5, gap: 204, first: 150, step: 64, axis: 'x', dir: 1 },
  start: { per: 8, gap: 58, first: 330, step: 214, axis: 'y', dir: -1 },
  end: { per: 8, gap: 58, first: 330, step: 214, axis: 'y', dir: 1 },
};

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

// 0, +1, -1, +2, -2, … — the k-th slot of a row, nearest the axis first.
function slotOffset(k) {
  if (k === 0) return 0;
  return k % 2 ? (k + 1) / 2 : -k / 2;
}

/** A lens as the scene uses it: { kinds: string[]|null, mine, done }. */
export function normalizeLens(lens) {
  const kinds = Array.isArray(lens?.kinds) ? ITEM_KINDS.filter((k) => lens.kinds.includes(k)) : null;
  return { kinds: kinds && kinds.length && kinds.length < ITEM_KINDS.length ? kinds : null, mine: !!lens?.mine, done: !!lens?.done };
}

/** True when a lens lets `node` into the scene (entities always pass). */
export function passesLens(node, lens) {
  if (!node || node.group !== 'item') return true;
  if (lens.kinds && !lens.kinds.includes(node.kind)) return false;
  if (node.kind === 'action') {
    if (!lens.done && node.status === 'done') return false;
    if (lens.mine && node.mine === false) return false;
  }
  return true;
}

export function nodeRect(node) {
  return { x: node.x - node.w / 2, y: node.y - node.h / 2, w: node.w, h: node.h };
}

function emptyScene(focus, { rtl, lens }) {
  return { focus, rtl: !!rtl, lens, nodes: [], edges: [], byRef: new Map(), edgeKeys: new Map(), expanded: [], bounds: null, missing: false, full: false };
}

function cloneScene(scene) {
  const next = { ...scene, nodes: scene.nodes.map((n) => ({ ...n })), edges: scene.edges.map((e) => ({ ...e })), expanded: [...scene.expanded] };
  next.byRef = new Map(next.nodes.map((n, i) => [n.ref, i]));
  next.edgeKeys = new Map(next.edges.map((e, i) => [edgeKey(e.a, e.b), i]));
  return next;
}

function addNode(scene, vm, { depth, lane, via }) {
  const base = NODE_SIZE[vm.group] || NODE_SIZE.item;
  const focus = depth === 0;
  const node = {
    ...vm,
    depth,
    lane,
    via,
    focus,
    w: Math.round(base.w * (focus ? FOCUS_SCALE : 1)),
    h: Math.round(base.h * (focus ? FOCUS_SCALE : 1)),
    x: 0,
    y: 0,
    pinned: false,
  };
  scene.byRef.set(node.ref, scene.nodes.length);
  scene.nodes.push(node);
  return node;
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function addEdge(scene, a, b, link) {
  if (a === b) return;
  let style = STYLE_RANK[link?.style] ? link.style : 'solid';
  // A suggested action's edges stay dashed whichever side reports them.
  const suggested = [a, b].some((ref) => scene.nodes[scene.byRef.get(ref)]?.suggested);
  if (suggested && style === 'solid') style = 'dashed';
  const w = Number.isFinite(link?.w) ? Math.min(1, Math.max(0, link.w)) : 1;
  const key = edgeKey(a, b);
  const at = scene.edgeKeys.get(key);
  if (at !== undefined) {
    const old = scene.edges[at];
    if (STYLE_RANK[style] > STYLE_RANK[old.style] && !(suggested && old.style === 'dashed')) Object.assign(old, { style, role: link?.role || old.role });
    old.w = Math.max(old.w, w);
    return;
  }
  scene.edgeKeys.set(key, scene.edges.length);
  scene.edges.push({ a, b, style, w, role: link?.role || '' });
}

function pinOf(pins, ref) {
  const p = pins && Object.hasOwn(pins, ref) ? pins[ref] : null;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
}

function laneSlot(lane, index, c) {
  const g = LANES[lane] || LANES.down;
  const row = Math.floor(index / g.per);
  const off = slotOffset(index % g.per) * g.gap;
  const out = g.first + row * g.step;
  return g.axis === 'x' ? { x: c.x + off, y: c.y + g.dir * out } : { x: c.x + g.dir * out, y: c.y + off };
}

// The k-th child seeded around `p`, outward along unit vector `u`.
function fanSlot(p, u, k) {
  const horizontal = Math.abs(u.x) > Math.abs(u.y);
  const row = Math.floor(k / 5);
  const off = slotOffset(k % 5) * (horizontal ? 58 : 196);
  const out = horizontal ? 214 + row * 214 : 120 + row * 58;
  const v = { x: -u.y, y: u.x };
  return { x: p.x + u.x * out + v.x * off, y: p.y + u.y * out + v.y * off };
}

const LANE_DIR = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, start: { x: -1, y: 0 }, end: { x: 1, y: 0 }, center: { x: 0, y: 1 } };

function unit(dx, dy, fallback) {
  const d = Math.hypot(dx, dy);
  return d > 1 ? { x: dx / d, y: dy / d } : fallback;
}

// Seeds every unpinned node in `refs` (in order) in logical (LTR) space,
// then mirrors back for RTL. `counters` carries slot numbers across calls
// so an expansion continues where the lane or fan left off.
function seed(scene, refs, pins, counters) {
  const focus = scene.nodes[scene.byRef.get(scene.focus)];
  const fx = focus.x;
  const mirror = (x) => (scene.rtl ? 2 * fx - x : x);
  const logical = (n) => ({ x: mirror(n.x), y: n.y });
  const centre = logical(focus);
  for (const ref of refs) {
    const node = scene.nodes[scene.byRef.get(ref)];
    if (!node || node.focus) continue;
    const pin = pinOf(pins, ref);
    if (pin) {
      node.x = pin.x;
      node.y = pin.y;
      node.pinned = true;
      continue;
    }
    node.pinned = false;
    let pos;
    const parent = node.via !== null ? scene.nodes[scene.byRef.get(node.via)] : null;
    if (!parent || parent.focus) {
      const key = `lane:${node.lane}`;
      const k = counters.get(key) || 0;
      counters.set(key, k + 1);
      pos = laneSlot(node.lane, k, centre);
    } else {
      const key = `via:${parent.ref}`;
      const k = counters.get(key) || 0;
      counters.set(key, k + 1);
      const p = logical(parent);
      pos = fanSlot(p, unit(p.x - centre.x, p.y - centre.y, LANE_DIR[parent.lane] || LANE_DIR.down), k);
    }
    node.x = Math.round(mirror(pos.x));
    node.y = Math.round(pos.y);
  }
}

// Slots already taken in each lane and around each parent, so new nodes
// continue after them. `skip` (refs) are the nodes about to be seeded.
function countersOf(scene, skip) {
  const counters = new Map();
  for (const node of scene.nodes) {
    if (node.focus || node.pinned || skip.has(node.ref)) continue;
    const parent = node.via !== null ? scene.nodes[scene.byRef.get(node.via)] : null;
    const key = !parent || parent.focus ? `lane:${node.lane}` : `via:${parent.ref}`;
    counters.set(key, (counters.get(key) || 0) + 1);
  }
  return counters;
}

/** The bounding box of every node, or null for an empty scene. */
export function sceneBounds(nodes) {
  let b = null;
  for (const n of nodes) {
    const r = nodeRect(n);
    if (!b) b = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
    else {
      b.minX = Math.min(b.minX, r.x);
      b.minY = Math.min(b.minY, r.y);
      b.maxX = Math.max(b.maxX, r.x + r.w);
      b.maxY = Math.max(b.maxY, r.y + r.h);
    }
  }
  return b;
}

function finish(scene) {
  scene.bounds = sceneBounds(scene.nodes);
  return scene;
}

/**
 * The scene around `focus`.
 * opts = { focus: 'o'|itemId|entityId, hops: 2, cap: 300, pins: {[ref]:{x,y}},
 *          rtl, lens: {kinds, mine, done}, origin: {x, y}, linkLimit: 60, hopLimit: 12 }
 * The focus sits at its pin, else at `origin` (default 0, 0).
 */
export function buildScene(port, opts = {}) {
  const focus = REF_RE.test(String(opts.focus || '')) ? opts.focus : 'o';
  const hops = clamp(opts.hops, 1, 3, HOPS);
  const cap = clamp(opts.cap, 1, SCENE_MAX, SCENE_CAP);
  const lens = normalizeLens(opts.lens);
  const pins = opts.pins || {};
  const scene = emptyScene(focus, { rtl: opts.rtl, lens });
  const root = safe(() => port.links(focus, { limit: clamp(opts.linkLimit, 1, 200, 60) }));
  if (!root?.node) {
    scene.missing = true;
    return finish(scene);
  }
  const center = addNode(scene, { ...root.node, ref: focus }, { depth: 0, lane: 'center', via: null });
  const fp = pinOf(pins, focus);
  if (fp) {
    center.x = fp.x;
    center.y = fp.y;
    center.pinned = true;
  } else if (Number.isFinite(opts.origin?.x) && Number.isFinite(opts.origin?.y)) {
    center.x = Math.round(opts.origin.x);
    center.y = Math.round(opts.origin.y);
  }
  const hopLimit = clamp(opts.hopLimit, 1, 200, 12);
  let frontier = [[focus, root.links]];
  for (let depth = 1; depth <= hops; depth++) {
    const next = [];
    for (const [from, links] of frontier) {
      const parent = scene.nodes[scene.byRef.get(from)];
      for (const link of Array.isArray(links) ? links : []) {
        if (!link?.node || !REF_RE.test(String(link.ref)) || link.ref === 'o') continue;
        if (!passesLens(link.node, lens)) continue;
        if (!scene.byRef.has(link.ref)) {
          if (scene.nodes.length >= cap) {
            scene.full = true;
            continue;
          }
          const lane = depth === 1 ? LANE_OF_ROLE[link.role] || 'down' : parent.lane;
          addNode(scene, { ...link.node, ref: link.ref }, { depth, lane, via: from });
          next.push(link.ref);
        }
        addEdge(scene, from, link.ref, link);
      }
    }
    if (depth === hops || !next.length) break;
    frontier = next.map((ref) => [ref, safe(() => port.links(ref, { limit: hopLimit }))?.links || []]);
  }
  seed(scene, scene.nodes.map((n) => n.ref), pins, new Map());
  return finish(scene);
}

/**
 * Adds up to `cap` neighbours of `ref` (the scene holds at most `max`
 * nodes), seeded outward from it. → { scene, added: ref[], full }
 */
export function expand(scene, ref, port, { cap = EXPAND_CAP, max = SCENE_MAX, pins = {} } = {}) {
  const at = scene.byRef.get(ref);
  if (at === undefined) return { scene, added: [], full: false };
  const res = safe(() => port.links(ref, { limit: Math.min(200, Math.max(24, cap * 2)) }));
  const next = cloneScene(scene);
  const node = next.nodes[at];
  const added = [];
  let full = false;
  for (const link of Array.isArray(res?.links) ? res.links : []) {
    if (!link?.node || !REF_RE.test(String(link.ref)) || link.ref === 'o') continue;
    if (!passesLens(link.node, next.lens)) continue;
    if (!next.byRef.has(link.ref)) {
      if (added.length >= cap) continue;
      if (next.nodes.length >= max) {
        full = true;
        continue;
      }
      const lane = node.focus ? LANE_OF_ROLE[link.role] || 'down' : node.lane;
      addNode(next, { ...link.node, ref: link.ref }, { depth: node.depth + 1, lane, via: ref });
      added.push(link.ref);
    }
    addEdge(next, ref, link.ref, link);
  }
  if (!next.expanded.includes(ref)) next.expanded.push(ref);
  seed(next, added, pins, countersOf(next, new Set(added)));
  if (full) next.full = true;
  return { scene: finish(next), added, full };
}

/** Removes what expanding `ref` added (and what those nodes added in turn). → { scene, removed } */
export function collapse(scene, ref) {
  const drop = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of scene.nodes) {
      if (n.focus || drop.has(n.ref)) continue;
      if (n.via === ref || drop.has(n.via)) {
        drop.add(n.ref);
        grew = true;
      }
    }
  }
  if (!drop.size && !scene.expanded.includes(ref)) return { scene, removed: [] };
  const next = cloneScene(scene);
  next.nodes = next.nodes.filter((n) => !drop.has(n.ref));
  next.edges = next.edges.filter((e) => !drop.has(e.a) && !drop.has(e.b));
  next.expanded = next.expanded.filter((r) => r !== ref && !drop.has(r));
  next.byRef = new Map(next.nodes.map((n, i) => [n.ref, i]));
  next.edgeKeys = new Map(next.edges.map((e, i) => [edgeKey(e.a, e.b), i]));
  next.full = false;
  return { scene: finish(next), removed: [...drop] };
}

/** Moves pinned nodes to their pins and flags them; unpinned nodes stay put. */
export function applyPins(scene, pins = {}) {
  const next = cloneScene(scene);
  for (const node of next.nodes) {
    const pin = pinOf(pins, node.ref);
    if (pin) {
      node.x = pin.x;
      node.y = pin.y;
      node.pinned = true;
    } else {
      node.pinned = false;
    }
  }
  return finish(next);
}

/** Copies prev's positions onto next's unpinned nodes that both have. */
export function carryPositions(prev, next) {
  const out = cloneScene(next);
  for (const node of out.nodes) {
    if (node.pinned) continue;
    const at = prev.byRef.get(node.ref);
    if (at === undefined) continue;
    node.x = prev.nodes[at].x;
    node.y = prev.nodes[at].y;
  }
  return finish(out);
}

/**
 * The same focus and expansions over fresh data, with positions kept
 * (a change from another window, EXTENSION_VIEWS §24.5).
 */
export function rebuildScene(prev, port, opts = {}) {
  const at = prev.byRef.get(prev.focus);
  const origin = at !== undefined ? { x: prev.nodes[at].x, y: prev.nodes[at].y } : undefined;
  let next = buildScene(port, { ...opts, focus: prev.focus, rtl: prev.rtl, lens: opts.lens ?? prev.lens, origin });
  for (const ref of prev.expanded) {
    if (!next.byRef.has(ref)) continue;
    next = expand(next, ref, port, { pins: opts.pins, max: opts.max ?? SCENE_MAX }).scene;
  }
  return carryPositions(prev, next);
}

const CHANGE_FIELDS = ['label', 'kind', 'status', 'suggested', 'private', 'mine', 'dueAt', 'doneAt', 'pinned'];

/** What changed between two scenes. → { added, removed, moved, changed } (refs) */
export function diffScene(prev, next) {
  const out = { added: [], removed: [], moved: [], changed: [] };
  const before = prev?.byRef || new Map();
  for (const node of next?.nodes || []) {
    const at = before.get(node.ref);
    if (at === undefined) {
      out.added.push(node.ref);
      continue;
    }
    const old = prev.nodes[at];
    if (old.x !== node.x || old.y !== node.y) out.moved.push(node.ref);
    if (CHANGE_FIELDS.some((f) => old[f] !== node[f])) out.changed.push(node.ref);
  }
  for (const node of prev?.nodes || []) if (!next?.byRef?.has(node.ref)) out.removed.push(node.ref);
  return out;
}

/** Nodes in reading order: the focus, then each lane (up, start, end, down), nearest first. */
export function readingOrder(scene) {
  const rank = (lane) => {
    const i = LANE_ORDER.indexOf(lane);
    return i < 0 ? LANE_ORDER.length : i;
  };
  return scene.nodes
    .map((node, i) => ({ node, i }))
    .sort((a, b) => (b.node.focus - a.node.focus) || rank(a.node.lane) - rank(b.node.lane) || a.node.depth - b.node.depth || a.i - b.i)
    .map((x) => x.node);
}

/**
 * Input for layout.relax: the scene's nodes and edges as indices. `free`
 * (a Set of refs) limits who may move; pinned nodes and the focus never do.
 */
export function relaxInput(scene, { free = null, iterations = 300, budgetMs = 200 } = {}) {
  const nodes = scene.nodes.map((n) => ({ id: n.ref, x: n.x, y: n.y, w: n.w, h: n.h, fixed: n.pinned || n.focus || (free ? !free.has(n.ref) : false) }));
  const edges = [];
  for (const e of scene.edges) {
    const a = scene.byRef.get(e.a);
    const b = scene.byRef.get(e.b);
    if (a === undefined || b === undefined) continue;
    const na = scene.nodes[a];
    const nb = scene.nodes[b];
    // Rest length: room for both boxes, longer for weak links.
    const len = (Math.max(na.w, nb.w) * 0.8 + 90) * (e.style === 'thin' ? 1.3 : 1);
    edges.push({ a, b, len: Math.round(len) });
  }
  return { nodes, edges, iterations, budgetMs };
}

/** Applies layout.relax output (xy pairs in scene order) to a copy of the scene. */
export function applyRelax(scene, result) {
  const xy = Array.isArray(result?.xy) ? result.xy : null;
  if (!xy || xy.length !== scene.nodes.length * 2) return scene;
  const next = cloneScene(scene);
  next.nodes.forEach((node, i) => {
    if (node.pinned || node.focus) return;
    const x = xy[i * 2];
    const y = xy[i * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      node.x = x;
      node.y = y;
    }
  });
  return finish(next);
}

/** Moves one node (a drag); pinned says whether it's now pinned. */
export function moveNode(scene, ref, x, y, { pinned } = {}) {
  const at = scene.byRef.get(ref);
  if (at === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return scene;
  const next = cloneScene(scene);
  const node = next.nodes[at];
  node.x = Math.round(x);
  node.y = Math.round(y);
  if (pinned !== undefined) node.pinned = !!pinned;
  return finish(next);
}
