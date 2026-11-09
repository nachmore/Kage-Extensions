// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// The explorer's camera (Kage docs/design/EXTENSION_VIEWS.md §24.3). Pure:
// every function returns a new camera and never mutates its input.
//
// A camera is { x, y, zoom }: a world point (wx, wy) is drawn at screen
// (wx * zoom + x, wy * zoom + y), in CSS pixels of the drawing surface.
// What Mind Map saves in mm-view is the world point at the middle of the
// window plus the zoom (centerOf / centerOn), so a resized window still
// shows the same place.

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** The zoom clamped to [min, max] (defaults 0.1–4). */
export function clampZoom(zoom, { min = ZOOM_MIN, max = ZOOM_MAX } = {}) {
  const z = num(zoom, 1);
  return Math.min(max, Math.max(min, z > 0 ? z : 1));
}

export function createCamera({ x = 0, y = 0, zoom = 1 } = {}) {
  return { x: num(x, 0), y: num(y, 0), zoom: clampZoom(zoom) };
}

export function worldToScreen(cam, wx, wy) {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y };
}

export function screenToWorld(cam, sx, sy) {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

/** Moves the picture by (dx, dy) screen pixels. */
export function panBy(cam, dx, dy) {
  return { x: cam.x + num(dx, 0), y: cam.y + num(dy, 0), zoom: cam.zoom };
}

/** Zooms by `factor`, keeping the world point under screen (sx, sy) where it is. */
export function zoomAt(cam, factor, sx, sy, limits) {
  const zoom = clampZoom(cam.zoom * num(factor, 1), limits);
  const w = screenToWorld(cam, sx, sy);
  return { x: sx - w.x * zoom, y: sy - w.y * zoom, zoom };
}

/** A camera that shows world (wx, wy) in the middle of `viewport` ({width, height}). */
export function centerOn(cam, wx, wy, viewport, zoom = cam.zoom) {
  const z = clampZoom(zoom);
  return { x: viewport.width / 2 - num(wx, 0) * z, y: viewport.height / 2 - num(wy, 0) * z, zoom: z };
}

/** The world point in the middle of `viewport`. */
export function centerOf(cam, viewport) {
  return screenToWorld(cam, viewport.width / 2, viewport.height / 2);
}

/**
 * A camera that fits world `bounds` ({minX, minY, maxX, maxY}) into
 * `viewport` with `pad` pixels on every side. Never zooms in past `max`
 * (default 1.25), so a map of three nodes isn't drawn huge.
 */
export function fit(cam, bounds, viewport, pad = 48, { min = ZOOM_MIN, max = 1.25 } = {}) {
  if (!bounds || !(bounds.maxX >= bounds.minX) || !(bounds.maxY >= bounds.minY)) return centerOn(cam, 0, 0, viewport, 1);
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const availW = Math.max(1, viewport.width - 2 * pad);
  const availH = Math.max(1, viewport.height - 2 * pad);
  const zoom = clampZoom(Math.min(availW / w, availH / h), { min, max: Math.min(max, ZOOM_MAX) });
  return centerOn(cam, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, viewport, zoom);
}

/** The world rectangle the viewport shows, grown by `margin` screen pixels. */
export function visibleRect(cam, viewport, margin = 0) {
  const a = screenToWorld(cam, -margin, -margin);
  const b = screenToWorld(cam, viewport.width + margin, viewport.height + margin);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

/**
 * The camera `t` (0–1) of the way from `a` to `b`: the middle of the window
 * moves in a straight line and the zoom changes evenly on a log scale.
 */
export function lerpCamera(a, b, t, viewport) {
  const k = Math.min(1, Math.max(0, num(t, 1)));
  const ca = centerOf(a, viewport);
  const cb = centerOf(b, viewport);
  const zoom = a.zoom * (b.zoom / a.zoom) ** k;
  return centerOn(a, ca.x + (cb.x - ca.x) * k, ca.y + (cb.y - ca.y) * k, viewport, zoom);
}

export function sameCamera(a, b, eps = 0.01) {
  return !!a && !!b && Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.zoom - b.zoom) < eps / 100;
}
