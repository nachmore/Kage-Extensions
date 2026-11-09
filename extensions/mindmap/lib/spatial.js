// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// A uniform grid over the explorer's world (EXTENSION_VIEWS §14, §24.3), so
// a frame draws and hit-tests only what's near the viewport or the pointer
// instead of every node. Rectangles are { x, y, w, h } with (x, y) the top
// left corner, in world units.

const OFFSET = 1 << 20;
const ROW = 1 << 21;

function cellKey(cx, cy) {
  return (cx + OFFSET) * ROW + (cy + OFFSET);
}

function span(grid, rect) {
  const c = grid.cell;
  return {
    x0: Math.floor(rect.x / c),
    y0: Math.floor(rect.y / c),
    x1: Math.floor((rect.x + Math.max(0, rect.w)) / c),
    y1: Math.floor((rect.y + Math.max(0, rect.h)) / c),
  };
}

const finiteRect = (r) => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite);

/** A grid with square cells of `cell` world units. */
export function createGrid(cell = 256) {
  return { cell: Number.isFinite(cell) && cell > 0 ? cell : 256, cells: new Map(), rects: new Map(), seq: 0 };
}

/** Adds `id` with `rect` (replacing an earlier rect for it); later inserts sit on top. */
export function insert(grid, id, rect) {
  if (!finiteRect(rect)) return;
  if (grid.rects.has(id)) remove(grid, id);
  const entry = { x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h), order: ++grid.seq };
  grid.rects.set(id, entry);
  const s = span(grid, entry);
  for (let cx = s.x0; cx <= s.x1; cx++) {
    for (let cy = s.y0; cy <= s.y1; cy++) {
      const key = cellKey(cx, cy);
      let bucket = grid.cells.get(key);
      if (!bucket) {
        bucket = new Set();
        grid.cells.set(key, bucket);
      }
      bucket.add(id);
    }
  }
}

export function remove(grid, id) {
  const entry = grid.rects.get(id);
  if (!entry) return false;
  const s = span(grid, entry);
  for (let cx = s.x0; cx <= s.x1; cx++) {
    for (let cy = s.y0; cy <= s.y1; cy++) {
      const key = cellKey(cx, cy);
      const bucket = grid.cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (!bucket.size) grid.cells.delete(key);
    }
  }
  grid.rects.delete(id);
  return true;
}

function overlaps(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Ids whose rect meets `rect`, bottom to top (insertion order). */
export function query(grid, rect) {
  if (!finiteRect(rect)) return [];
  const area = { x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h) };
  const s = span(grid, area);
  // A query wider than the whole grid walks the rects, not empty cells.
  if ((s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) > grid.cells.size * 2) {
    return [...grid.rects].filter(([, r]) => overlaps(r, area)).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  }
  const seen = new Set();
  const out = [];
  for (let cx = s.x0; cx <= s.x1; cx++) {
    for (let cy = s.y0; cy <= s.y1; cy++) {
      const bucket = grid.cells.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const id of bucket) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (overlaps(grid.rects.get(id), area)) out.push(id);
      }
    }
  }
  return out.sort((a, b) => grid.rects.get(a).order - grid.rects.get(b).order);
}

/** The topmost id whose rect contains world (x, y), or null. */
export function hit(grid, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const bucket = grid.cells.get(cellKey(Math.floor(x / grid.cell), Math.floor(y / grid.cell)));
  if (!bucket) return null;
  let best = null;
  let order = -1;
  for (const id of bucket) {
    const r = grid.rects.get(id);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && r.order > order) {
      best = id;
      order = r.order;
    }
  }
  return best;
}

export function size(grid) {
  return grid.rects.size;
}
