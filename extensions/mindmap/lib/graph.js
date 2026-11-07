// Focus-graph neighbourhoods and their layout for the map card (SPEC §9).
//
// Leaf module: no imports, no `context`, no clock. Everything comes in
// through `ctx` (getters over the in-memory store), so the same code serves
// the formatter, the tests and any later canvas renderer. Output is plain
// data: view.js turns it into HTML.
//
// Determinism: every lane is sorted with a total order that ends in
// `id asc`, so a node keeps its slot across renders while the data is
// unchanged.

export const LANES = Object.freeze(['up', 'left', 'right', 'down']);

export const LANE_CAP = Object.freeze({ up: 5, down: 5, left: 4, right: 4 });

const SIDE_X = 14;

// The full-lane slot grid (percent of the stage). A lane that isn't full
// is centre-justified on the same axis (`slotPositions`), so two nodes
// don't huddle in one corner and every node gets room for its label. The
// side lanes sit at 14% / 86% (SPEC §9.2 says 12 / 88): with 26%-wide
// nodes that is the widest label that still clears the 36% centre card
// (docs/mindmap/BUILD_NOTES.md, WP-C).
export const SLOTS = Object.freeze({
  up: Object.freeze([18, 34, 50, 66, 82].map((x) => Object.freeze({ x, y: 12 }))),
  down: Object.freeze([18, 34, 50, 66, 82].map((x) => Object.freeze({ x, y: 88 }))),
  left: Object.freeze([27, 42, 57, 72].map((y) => Object.freeze({ x: SIDE_X, y }))),
  right: Object.freeze([27, 42, 57, 72].map((y) => Object.freeze({ x: 100 - SIDE_X, y }))),
  center: Object.freeze({ x: 50, y: 50 }),
});

const ROW_X = {
  1: [50],
  2: [34, 66],
  3: [18, 50, 82],
  4: [18, 39, 61, 82],
  5: [18, 34, 50, 66, 82],
};
// Side lanes step 15% (SPEC: 16% from 28%): two-line labels then clear the
// up/down rows at both ends of the column (BUILD_NOTES WP-C).
const COL_Y = {
  1: [50],
  2: [42, 58],
  3: [35, 50, 65],
  4: [27, 42, 57, 72],
};

// Lane roles per focus type (SPEC §9.2 table).
const ROLES = {
  entity: { up: 'entities', left: 'actions', right: 'docs', down: 'notes' },
  item: { up: 'entities', left: 'actions', right: 'docs', down: 'notes' },
  overview: { up: 'teams', left: 'people', right: 'topics', down: 'stats' },
};

const DOC_KINDS = new Set(['doc', 'link']);
const NOTE_KINDS = new Set(['note', 'meeting']);
// Structural neighbours (parent/child) outrank any similarity score.
const STRUCTURAL = 1e9;
const OVERVIEW_RECENT = 2;

/**
 * Slot positions for `n` nodes in a lane, in percent, left-to-right
 * (`layout` mirrors x for RTL).
 * @param {'up'|'down'|'left'|'right'} side
 * @param {number} n
 * @returns {{x:number, y:number}[]}
 */
export function slotPositions(side, n) {
  if (!n) return [];
  if (side === 'up' || side === 'down') {
    const y = side === 'up' ? 12 : 88;
    return (ROW_X[n] || ROW_X[5]).slice(0, n).map((x) => ({ x, y }));
  }
  const x = side === 'left' ? SIDE_X : 100 - SIDE_X;
  return (COL_Y[n] || COL_Y[4]).slice(0, n).map((y) => ({ x, y }));
}

/** Degree → size class. */
export function sizeOf(degree) {
  const d = Number(degree) || 0;
  if (d >= 8) return 'l';
  if (d >= 3) return 'm';
  return 's';
}

const byId = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

function lengthOf(list) {
  return Array.isArray(list) ? list.length : 0;
}

function call(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try {
    return fn(...args);
  } catch {
    return null;
  }
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function itemTime(item) {
  return Number(item.occurredAt || item.createdAt || 0);
}

function visibleItem(item) {
  return !!item && !item.archived && !(item.kind === 'action' && item.status === 'dismissed');
}

function kindAllowed(kinds, kind) {
  return !kinds || kinds.has(kind);
}

function itemNode(item, ctx) {
  const node = {
    ref: item.id,
    group: 'item',
    kind: item.kind,
    label: String(item.title || ''),
    size: sizeOf(lengthOf(item.entityIds) + lengthOf(call(ctx.childrenOf, item.id))),
    at: itemTime(item),
  };
  if (item.kind === 'action') {
    node.status = item.status || 'open';
    if (item.suggested && node.status === 'open') node.suggested = true;
    if (item.dueAt) node.dueAt = Number(item.dueAt);
    if (item.doneAt) node.doneAt = Number(item.doneAt);
  }
  if (item.private) node.private = true;
  return node;
}

function entityNode(entity, degree) {
  const node = {
    ref: entity.id,
    group: 'entity',
    kind: entity.type || 'term',
    label: String(entity.name || ''),
    size: sizeOf(degree),
  };
  if (entity.private) node.private = true;
  return node;
}

/**
 * Cut a sorted lane down to one page. A lane that overflows shows
 * `cap - 1` nodes plus a "+N more" node; the page index wraps, so the
 * last page's more-node ("first page") leads back to the start.
 */
function pageLane(lane, role, sorted, cap, page) {
  const total = sorted.length;
  if (total <= cap) return { role, nodes: sorted, more: 0, page: 0, total };
  const size = cap - 1;
  const pages = Math.ceil(total / size);
  const wanted = Math.trunc(Number(page) || 0);
  const p = ((wanted % pages) + pages) % pages;
  const start = p * size;
  const shown = sorted.slice(start, start + size);
  const rest = total - (start + shown.length);
  const more = { ref: `more:${lane}`, group: 'more', kind: 'more', label: '', size: 's', more: rest, hidden: total - shown.length };
  if (rest === 0) more.wrap = true;
  return { role, nodes: [...shown, more], more: rest, page: p, total };
}

function sortActions(nodes) {
  // SPEC §8.2: open before suggested before done; due first (soonest
  // first); then newest parent first and source order within a parent;
  // then id.
  const rank = (n) => (n.status === 'done' ? 2 : n.suggested ? 1 : 0);
  nodes.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const da = a.dueAt ? 0 : 1;
    const db = b.dueAt ? 0 : 1;
    if (da !== db) return da - db;
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    if ((a.pt || 0) !== (b.pt || 0)) return (b.pt || 0) - (a.pt || 0);
    if ((a.seg || 0) !== (b.seg || 0)) return (a.seg || 0) - (b.seg || 0);
    return byId(a, b);
  });
  for (const n of nodes) {
    delete n.pt;
    delete n.seg;
  }
  return nodes;
}

function sortScored(nodes) {
  // score desc, then newest, then id asc.
  return nodes.sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if ((b.at || 0) !== (a.at || 0)) return (b.at || 0) - (a.at || 0);
    return byId(a, b);
  });
}

function stripScores(nodes) {
  for (const n of nodes) delete n.score;
  return nodes;
}

function entityDegree(ctx, id) {
  return lengthOf(call(ctx.itemsOfEntity, id));
}

function entityFocus(id, ctx, kinds, page) {
  const entity = call(ctx.getEntity, id);
  if (!entity) return null;
  const items = [];
  const seen = new Set();
  for (const iid of asList(call(ctx.itemsOfEntity, id))) {
    if (seen.has(iid)) continue;
    seen.add(iid);
    const item = call(ctx.getItem, iid);
    if (visibleItem(item)) items.push(item);
  }

  const up = [];
  for (const row of asList(call(ctx.cooccur, id))) {
    const eid = typeof row === 'string' ? row : row?.id;
    if (!eid || eid === id) continue;
    const other = call(ctx.getEntity, eid);
    if (!other) continue;
    const node = entityNode(other, entityDegree(ctx, eid));
    node.score = Number(row?.w) || 0;
    up.push(node);
  }

  const left = [];
  const right = [];
  const down = [];
  let openActions = 0;
  let suggested = 0;
  for (const item of items) {
    if (item.kind === 'action') {
      if ((item.status || 'open') !== 'open') continue;
      if (item.suggested) suggested++;
      else openActions++;
      if (!kindAllowed(kinds, 'action')) continue;
      const node = itemNode(item, ctx);
      const parent = item.parentId ? call(ctx.getItem, item.parentId) : null;
      node.pt = itemTime(parent || item);
      node.seg = Number(item.seg) || 0;
      left.push(node);
    } else if (DOC_KINDS.has(item.kind)) {
      if (kindAllowed(kinds, item.kind)) right.push(itemNode(item, ctx));
    } else if (NOTE_KINDS.has(item.kind)) {
      if (kindAllowed(kinds, item.kind)) down.push(itemNode(item, ctx));
    }
  }

  const center = entityNode(entity, items.length);
  center.counts = {
    items: items.length,
    actions: openActions,
    suggested,
    docs: items.filter((i) => DOC_KINDS.has(i.kind)).length,
    notes: items.filter((i) => NOTE_KINDS.has(i.kind)).length,
  };
  return {
    focus: { type: 'entity', id },
    center,
    lanes: buildLanes('entity', page, {
      up: stripScores(sortScored(up)),
      left: sortActions(left),
      right: sortScored(right),
      down: sortScored(down),
    }),
  };
}

function itemFocus(id, ctx, kinds, page) {
  const item = call(ctx.getItem, id);
  if (!item) return null;

  const up = [];
  for (const eid of asList(item.entityIds)) {
    const entity = call(ctx.getEntity, eid);
    if (!entity) continue;
    const node = entityNode(entity, entityDegree(ctx, eid));
    node.score = entityDegree(ctx, eid);
    up.push(node);
  }

  const left = [];
  const right = [];
  const down = [];
  const placed = new Set([id]);
  const place = (other, score) => {
    if (!visibleItem(other) || placed.has(other.id)) return;
    if (other.kind === 'action') return;
    const lane = DOC_KINDS.has(other.kind) ? right : NOTE_KINDS.has(other.kind) ? down : null;
    if (!lane || !kindAllowed(kinds, other.kind)) return;
    placed.add(other.id);
    const node = itemNode(other, ctx);
    node.score = score;
    lane.push(node);
  };

  const parent = item.parentId ? call(ctx.getItem, item.parentId) : null;
  let leftRole = 'actions';
  if (item.kind === 'action') {
    leftRole = 'parent';
    if (visibleItem(parent) && kindAllowed(kinds, parent.kind)) {
      placed.add(parent.id);
      left.push(itemNode(parent, ctx));
    }
  } else if (parent) {
    place(parent, STRUCTURAL);
  }

  const children = asList(call(ctx.childrenOf, id))
    .map((cid) => call(ctx.getItem, cid))
    .filter(visibleItem);
  for (const child of children) {
    if (child.kind === 'action') {
      if (!kindAllowed(kinds, 'action') || item.kind === 'action') continue;
      placed.add(child.id);
      const node = itemNode(child, ctx);
      node.seg = Number(child.seg) || 0;
      left.push(node);
    } else {
      place(child, STRUCTURAL);
    }
  }

  for (const row of asList(call(ctx.related, id))) {
    const rid = typeof row === 'string' ? row : row?.id;
    if (!rid) continue;
    place(call(ctx.getItem, rid), Number(row?.score) || 0);
  }

  // Child actions keep source order; a parent is a single node.
  left.sort((a, b) => (a.seg || 0) - (b.seg || 0) || byId(a, b));
  for (const n of left) delete n.seg;

  const center = itemNode(item, ctx);
  center.snippet = String(item.summary || item.text || '');
  center.day = itemTime(item);
  if (item.source?.app) center.app = String(item.source.app);
  if (item.url) center.url = String(item.url);
  if (item.path) center.path = String(item.path);

  return {
    focus: { type: 'item', id },
    center,
    lanes: buildLanes('item', page, {
      up: stripScores(sortScored(up)),
      left,
      right: stripScores(sortScored(right)),
      down: stripScores(sortScored(down)),
    }, { left: leftRole }),
  };
}

function overviewEntities(ctx, list) {
  const out = [];
  const seen = new Set();
  for (const row of asList(list)) {
    const id = typeof row === 'string' ? row : row?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entity = call(ctx.getEntity, id);
    if (!entity) continue;
    const n = typeof row === 'string' ? entityDegree(ctx, id) : Number(row?.n) || 0;
    const node = entityNode(entity, n);
    node.score = n;
    out.push(node);
  }
  return stripScores(sortScored(out));
}

function overviewFocus(ctx, page) {
  const ov = call(ctx.overview) || {};
  const down = [];
  const review = Number(ov.reviewCount) || 0;
  const open = Number(ov.openCount) || 0;
  if (review > 0) down.push({ ref: 'review', group: 'stat', kind: 'stat', label: '', size: 'm', count: review });
  if (open > 0) down.push({ ref: 'actions', group: 'stat', kind: 'stat', label: '', size: 'm', count: open });
  const recent = [];
  for (const iid of asList(ov.recent)) {
    if (recent.length >= OVERVIEW_RECENT) break;
    const item = call(ctx.getItem, typeof iid === 'string' ? iid : iid?.id);
    if (visibleItem(item)) recent.push(itemNode(item, ctx));
  }
  const counts = ov.counts && typeof ov.counts === 'object' ? { ...ov.counts } : {};
  return {
    focus: { type: 'overview' },
    center: { ref: 'o', group: 'overview', kind: 'overview', label: '', size: 'l', counts },
    lanes: buildLanes('overview', page, {
      up: overviewEntities(ctx, [...asList(ov.teams), ...asList(ov.projects)]),
      left: overviewEntities(ctx, ov.people),
      right: overviewEntities(ctx, ov.topics),
      down: [...down, ...recent],
    }),
  };
}

function buildLanes(type, page, sorted, overrides = {}) {
  const lanes = {};
  for (const lane of LANES) {
    const role = overrides[lane] || ROLES[type][lane];
    lanes[lane] = pageLane(lane, role, sorted[lane] || [], LANE_CAP[lane], page?.[lane]);
  }
  return lanes;
}

/**
 * The neighbourhood of one focus (SPEC §9.2).
 *
 * @param {{type:'entity'|'item'|'overview', id?:string}} focus
 * @param {object} ctx — { getItem, getEntity, itemsOfEntity, cooccur, related,
 *   childrenOf, overview, page?, kinds? } (ARCHITECTURE §5.13)
 * @returns {object|null} Neighborhood (ARCHITECTURE §6.6), or null when the
 *   focus no longer exists.
 */
export function neighborhood(focus, ctx = {}) {
  if (!focus || typeof focus !== 'object') return null;
  const kinds = Array.isArray(ctx.kinds) && ctx.kinds.length ? new Set(ctx.kinds) : null;
  const page = ctx.page || {};
  if (focus.type === 'overview') return overviewFocus(ctx, page);
  if (typeof focus.id !== 'string' || !focus.id) return null;
  if (focus.type === 'entity') return entityFocus(focus.id, ctx, kinds, page);
  if (focus.type === 'item') return itemFocus(focus.id, ctx, kinds, page);
  return null;
}

const MIRROR = { left: 'right', right: 'left', up: 'up', down: 'down' };

function widthClass(side, n) {
  if (side === 'left' || side === 'right') return 's';
  if (n >= 5) return 'n';
  if (n === 4) return 'm';
  return 'w';
}

/**
 * Place a neighbourhood on the stage: slot ids, % coordinates and edges.
 * With `rtl`, the left and right lanes swap sides and every x mirrors, so
 * edges mirror with their nodes.
 *
 * @returns {{center, nodes: object[], edges: object[], hints: object[]}}
 */
export function layout(neigh, { rtl = false } = {}) {
  const nodes = [];
  const edges = [];
  const hints = [];
  if (!neigh?.lanes) return { center: neigh?.center || null, nodes, edges, hints };
  for (const lane of LANES) {
    const data = neigh.lanes[lane] || { nodes: [] };
    const list = Array.isArray(data.nodes) ? data.nodes : [];
    const side = rtl ? MIRROR[lane] : lane;
    // Positions come from the logical lane; mirroring x then moves the
    // left lane to the right (and reverses the order along a row).
    const positions = slotPositions(lane, list.length);
    const w = widthClass(side, list.length);
    list.forEach((node, i) => {
      const pos = positions[i] || SLOTS.center;
      const x = rtl ? 100 - pos.x : pos.x;
      const placed = { ...node, lane, side, slot: `${side[0]}${i + 1}`, x, y: pos.y, w };
      nodes.push(placed);
      if (node.group === 'more') return;
      const dashed = node.suggested || node.status === 'done' || node.status === 'dismissed';
      edges.push({ lane, side, x2: x, y2: pos.y, style: dashed ? 'dashed' : 'solid', group: node.group, kind: node.kind, ref: node.ref });
    });
    if (!list.length) {
      const mid = lane === 'up' ? { x: 50, y: 12 } : lane === 'down' ? { x: 50, y: 88 } : { x: lane === 'left' ? SIDE_X : 100 - SIDE_X, y: 50 };
      hints.push({ lane, side, role: data.role, x: rtl ? 100 - mid.x : mid.x, y: mid.y });
    }
  }
  return { center: neigh.center, nodes, edges, hints };
}
