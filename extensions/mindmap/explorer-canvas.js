// The map explorer's Canvas 2D renderer and pointer input (EXTENSION_VIEWS
// §24.3–§24.5).
//
// Composer: it imports only leaves (ARCHITECTURE §1). Labels, icons and sub
// lines come in through `labels` (explorer.js builds them from view.js), so
// this file never needs view.js.
//
// How it stays fast (EXTENSION_VIEWS §14):
//   - the backing store is the viewport times devicePixelRatio (at most
//     8192 px a side and 32 megapixels), never the whole map;
//   - it draws on demand: invalidate() asks for one animation frame, and
//     nothing runs while idle or hidden;
//   - a uniform grid (lib/spatial.js) culls nodes and answers hit tests;
//   - below zoom 0.35 nodes are dots without text, and measureText results
//     are cached; no shadows, filters or getImageData.
//
// Input becomes intents for explorer.js: select, move, focus, expand,
// camera. Pan and zoom happen here and are reported as `camera`.

import { centerOn, clampZoom, fit, lerpCamera, panBy, screenToWorld, visibleRect, zoomAt } from './lib/camera.js';
import { createGrid, hit, insert, query } from './lib/spatial.js';

export const LOD = Object.freeze({ dots: 0.35, short: 0.7, sub: 1.2 });
export const LABEL_CHARS = Object.freeze({ short: 12, long: 24 });
const MAX_SIDE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const DRAG_PX = 4;
const HANDLE_PX = 10;
const MEASURE_CACHE_MAX = 4000;
const TWEEN_MS = 280;

const mono = () => globalThis.performance?.now?.() ?? Date.now();

/** The canvas backing store for a CSS size and devicePixelRatio, within the caps. */
export function backingSize(cssWidth, cssHeight, dpr = 1) {
  const w = Math.max(1, Math.round(Number(cssWidth) || 1));
  const h = Math.max(1, Math.round(Number(cssHeight) || 1));
  let scale = Number(dpr) > 0 ? Number(dpr) : 1;
  scale = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

/** Level of detail for a zoom: 'dot' | 'short' | 'long' | 'full'. */
export function lodOf(zoom) {
  if (zoom < LOD.dots) return 'dot';
  if (zoom < LOD.short) return 'short';
  if (zoom <= LOD.sub) return 'long';
  return 'full';
}

/** `text` cut to `n` code points with an ellipsis (never splits an emoji's pair). */
export function clipLabel(text, n) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (chars.length <= n) return chars.join('');
  return `${chars.slice(0, Math.max(1, n - 1)).join('').trimEnd()}…`;
}

/**
 * The node nearest to `from` in direction `dir` ('left' | 'right' | 'up' |
 * 'down', on screen), within a wide cone; null when there is none.
 */
export function nearestInDirection(nodes, from, dir) {
  if (!from) return null;
  let best = null;
  let bestScore = Infinity;
  for (const node of nodes || []) {
    if (node.ref === from.ref) continue;
    const dx = node.x - from.x;
    const dy = node.y - from.y;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const perp = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || perp > along * 1.5) continue;
    const score = along + perp * 2;
    if (score < bestScore || (score === bestScore && node.ref < best.ref)) {
      best = node;
      bestScore = score;
    }
  }
  return best ? best.ref : null;
}

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const PAN_STEP = 60;

/**
 * A key press as an explorer intent, or null. `editing` is true while a
 * text field has focus (then only Escape counts, and ⌘/Ctrl+Z is the
 * field's own undo). Space is a hold (see ExplorerCanvas.spaceDown).
 */
export function keyIntent(e, { selected = null, editing = false } = {}) {
  if (!e || typeof e.key !== 'string') return null;
  const key = e.key;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (mod && !e.altKey && !e.shiftKey && (key === 'z' || key === 'Z')) return editing ? null : { type: 'undoLayout' };
  if (mod && !e.altKey && (key === 'f' || key === 'F')) return { type: 'search' };
  if (editing) return key === 'Escape' ? { type: 'escape' } : null;
  if (mod || e.altKey) return null;
  if (ARROWS[key]) {
    const dir = ARROWS[key];
    if (selected && !e.shiftKey) return { type: 'step', dir };
    const step = e.shiftKey ? PAN_STEP * 4 : PAN_STEP;
    // The picture moves the other way to the view, as when dragging it.
    const dx = dir === 'left' ? step : dir === 'right' ? -step : 0;
    const dy = dir === 'up' ? step : dir === 'down' ? -step : 0;
    return { type: 'pan', dx, dy };
  }
  switch (key) {
    case '/': return { type: 'search' };
    case '+':
    case '=': return { type: 'zoom', factor: 1.25 };
    case '-':
    case '_': return { type: 'zoom', factor: 0.8 };
    case '0': return { type: 'fit' };
    case 'Escape': return { type: 'escape' };
    case 'Enter': return selected ? { type: 'focus', ref: selected } : null;
    case 'p':
    case 'P': return selected ? { type: 'pin', ref: selected } : null;
    default: return null;
  }
}

/** Canvas colours and font from the view's theme tokens (EXTENSION_VIEWS §11). */
export function paletteOf(theme) {
  const tk = theme?.tokens || {};
  const dark = theme?.scheme !== 'light';
  const text = tk['kage-text'] || (dark ? '#e6e6e6' : '#1f1f1f');
  const border = tk['kage-border'] || (dark ? '#3c3c3c' : '#d4d4d4');
  const accent = tk['kage-accent'] || '#4a9eff';
  return {
    bg: tk['kage-bg'] || (dark ? '#1e1e1e' : '#fafafa'),
    node: tk['kage-bg-elevated'] || (dark ? '#2a2a2a' : '#ffffff'),
    input: tk['kage-bg-input'] || (dark ? '#252525' : '#f2f2f2'),
    text,
    bright: tk['kage-text-bright'] || text,
    muted: tk['kage-text-muted'] || (dark ? '#9a9a9a' : '#6b6b6b'),
    border,
    subtle: tk['kage-border-subtle'] || border,
    accent,
    accentLight: tk['kage-accent-light'] || accent,
    success: tk['kage-success'] || accent,
    warning: tk['kage-warning'] || accent,
    font: tk['kage-font'] || 'system-ui, sans-serif',
    // Kage's font size setting (14 is the default) scales the labels.
    textScale: Math.min(1.6, Math.max(0.8, (Number(theme?.fontSize) || 14) / 14)),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

const STYLE_ORDER = ['thin', 'dashed', 'solid'];

export class ExplorerCanvas {
  /**
   * opts = { canvas, onIntent(intent), theme, rtl, scroll: 'pan'|'zoom',
   *          labels: { iconOf(node), subOf(node) }, raf?, caf?, now? }
   */
  constructor(opts = {}) {
    this.canvas = opts.canvas;
    this.onIntent = typeof opts.onIntent === 'function' ? opts.onIntent : () => {};
    this.labels = opts.labels || {};
    this.rtl = !!opts.rtl;
    this.scroll = opts.scroll === 'pan' ? 'pan' : 'zoom';
    this.reducedMotion = !!opts.theme?.reducedMotion;
    const win = this.canvas?.ownerDocument?.defaultView || globalThis;
    this.raf = opts.raf || ((fn) => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : setTimeout(() => fn(mono()), 16)));
    this.caf = opts.caf || ((id) => (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame(id) : clearTimeout(id)));
    this.now = opts.now || mono;
    this.ctx = this.canvas?.getContext?.('2d') || null;
    this.viewport = { width: 960, height: 600 };
    this.dpr = 1;
    this.camera = { x: 480, y: 300, zoom: 1 };
    this.scene = null;
    this.nodes = [];
    this.byRef = new Map();
    this.grid = createGrid(256);
    this.selected = null;
    this.hover = null;
    this.matches = null;
    this.visible = true;
    this.spaceHeld = false;
    this.spaceDragged = false;
    this._frame = 0;
    this._down = null;
    this._gesture = null;
    this._anim = null;
    this._tween = null;
    this._measure = new Map();
    this._font = '';
    this.stats = { frames: 0, nodes: 0, edges: 0, ms: 0 };
    this.setTheme(opts.theme);
    this._handlers = {
      pointerdown: (e) => this._onPointerDown(e),
      pointermove: (e) => this._onPointerMove(e),
      pointerup: (e) => this._onPointerUp(e),
      pointercancel: (e) => this._onPointerUp(e, { cancel: true }),
      dblclick: (e) => this._onDblClick(e),
      wheel: (e) => this._onWheel(e),
      gesturestart: (e) => this._onGesture(e, 'start'),
      gesturechange: (e) => this._onGesture(e, 'change'),
      gestureend: (e) => this._onGesture(e, 'end'),
      contextmenu: (e) => e.preventDefault?.(),
    };
  }

  attach() {
    const c = this.canvas;
    if (!c?.addEventListener) return;
    for (const [type, fn] of Object.entries(this._handlers)) {
      // wheel and the WebKit gesture events must be able to preventDefault,
      // so the page itself never scrolls or zooms (EXTENSION_VIEWS §13.1).
      c.addEventListener(type, fn, type === 'wheel' || type.startsWith('gesture') ? { passive: false } : false);
    }
  }

  destroy() {
    const c = this.canvas;
    if (c?.removeEventListener) for (const [type, fn] of Object.entries(this._handlers)) c.removeEventListener(type, fn);
    if (this._frame) this.caf(this._frame);
    this._frame = 0;
    this._anim = null;
    this._tween = null;
    this.scene = null;
  }

  // --- state ------------------------------------------------------------------

  setTheme(theme) {
    this.palette = paletteOf(theme);
    this.reducedMotion = !!theme?.reducedMotion;
    this._measure.clear();
    this.invalidate();
  }

  setRtl(rtl) {
    this.rtl = !!rtl;
    this.invalidate();
  }

  setScrollMode(mode) {
    this.scroll = mode === 'pan' ? 'pan' : 'zoom';
  }

  /**
   * Shows `scene`. With `tweenFrom` (an earlier scene) nodes glide from
   * their old spots, unless the theme asks for reduced motion.
   */
  setScene(scene, { tweenFrom = null } = {}) {
    this.scene = scene;
    // Own copies: a drag moves these, never the caller's scene.
    this.nodes = (scene?.nodes || []).map((n) => ({ ...n }));
    this.byRef = new Map(this.nodes.map((n) => [n.ref, n]));
    this.grid = createGrid(256);
    // Insert order is draw order: the focus last, so it's on top.
    for (const node of this.nodes) if (!node.focus) insert(this.grid, node.ref, this._rect(node));
    for (const node of this.nodes) if (node.focus) insert(this.grid, node.ref, this._rect(node));
    if (this.selected && !this.byRef.has(this.selected)) this.selected = null;
    this._tween = null;
    if (tweenFrom && !this.reducedMotion) {
      const from = new Map();
      for (const node of this.nodes) {
        const old = tweenFrom.byRef?.get(node.ref);
        const prev = old !== undefined ? tweenFrom.nodes[old] : null;
        if (prev && (prev.x !== node.x || prev.y !== node.y)) from.set(node.ref, { x: prev.x, y: prev.y });
      }
      if (from.size) this._tween = { from, start: this.now(), ms: TWEEN_MS };
    }
    this.invalidate();
  }

  // Moves one node while it's dragged, without rebuilding the grid.
  _moveLocal(ref, x, y) {
    const node = this.byRef.get(ref);
    if (!node) return;
    node.x = x;
    node.y = y;
    insert(this.grid, ref, this._rect(node));
    this.invalidate();
  }

  setSelection(ref) {
    const next = ref && this.byRef.has(ref) ? ref : null;
    if (next === this.selected) return;
    this.selected = next;
    this.invalidate();
  }

  /** Dims every node not in `refs` (a Set), or nothing when null. */
  setMatches(refs) {
    this.matches = refs instanceof Set ? refs : null;
    this.invalidate();
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (!this.visible && this._frame) {
      this.caf(this._frame);
      this._frame = 0;
    }
    if (this.visible) this.invalidate();
  }

  resize(width, height, dpr = 1) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const size = backingSize(w, h, dpr);
    const centre = screenToWorld(this.camera, this.viewport.width / 2, this.viewport.height / 2);
    this.viewport = { width: w, height: h };
    this.dpr = size.scale;
    if (this.canvas) {
      if (this.canvas.width !== size.width) this.canvas.width = size.width;
      if (this.canvas.height !== size.height) this.canvas.height = size.height;
    }
    // Keep the same place in the middle of the window.
    this.camera = centerOn(this.camera, centre.x, centre.y, this.viewport);
    this.invalidate();
  }

  setCamera(camera, { animate = false, report = true } = {}) {
    const next = { x: camera.x, y: camera.y, zoom: clampZoom(camera.zoom) };
    this._anim = null;
    if (animate && !this.reducedMotion) {
      this._anim = { from: this.camera, to: next, start: this.now(), ms: TWEEN_MS };
    } else {
      this.camera = next;
    }
    if (report) this.onIntent({ type: 'camera', camera: next });
    this.invalidate();
  }

  /** A camera that shows world (x, y) in the middle, at `zoom` (default: the current one). */
  cameraAt(x, y, zoom = this.camera.zoom) {
    return centerOn(this.camera, x, y, this.viewport, zoom);
  }

  fitCamera() {
    return fit(this.camera, this.scene?.bounds, this.viewport, 48);
  }

  zoomBy(factor, sx = this.viewport.width / 2, sy = this.viewport.height / 2) {
    this.setCamera(zoomAt(this.camera, factor, sx, sy));
  }

  panBy(dx, dy) {
    this.setCamera(panBy(this.camera, dx, dy));
  }

  /** The dragged node's position during a drag (for explorer.js), else null. */
  get dragging() {
    return this._down?.mode === 'node' && this._down.moved ? this._down.ref : null;
  }

  // --- drawing -------------------------------------------------------------------

  invalidate() {
    if (this._frame || !this.visible) return;
    this._frame = this.raf((t) => {
      this._frame = 0;
      this.draw(t);
    });
  }

  _rect(node) {
    return { x: node.x - node.w / 2, y: node.y - node.h / 2, w: node.w, h: node.h };
  }

  // Positions while a tween runs.
  _pos(node, k) {
    const from = this._tween?.from.get(node.ref);
    if (!from || k >= 1) return node;
    const e = 1 - (1 - k) ** 3;
    return { x: from.x + (node.x - from.x) * e, y: from.y + (node.y - from.y) * e };
  }

  _textWidth(text) {
    const key = `${this._font}|${text}`;
    let w = this._measure.get(key);
    if (w === undefined) {
      w = this.ctx.measureText(text).width || 0;
      if (this._measure.size >= MEASURE_CACHE_MAX) this._measure.clear();
      this._measure.set(key, w);
    }
    return w;
  }

  _setFont(px, weight = '') {
    const font = `${weight ? `${weight} ` : ''}${Math.round(px * 10) / 10}px ${this.palette.font}`;
    if (font !== this._font) {
      this._font = font;
      this.ctx.font = font;
    }
  }

  // The longest prefix of `text` that fits `max` (world units), with an ellipsis.
  _fit(text, max) {
    if (this._textWidth(text) <= max) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._textWidth(`${chars.slice(0, mid).join('')}…`) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? `${chars.slice(0, lo).join('').trimEnd()}…` : '';
  }

  /** Draws one frame now (also what an animation frame runs). */
  draw(t = this.now()) {
    const ctx = this.ctx;
    if (!ctx) return;
    // Drawn now: a frame already asked for has nothing left to do.
    if (this._frame) {
      this.caf(this._frame);
      this._frame = 0;
    }
    const started = mono();
    let again = false;
    if (this._anim) {
      const k = Math.min(1, (t - this._anim.start) / this._anim.ms);
      this.camera = lerpCamera(this._anim.from, this._anim.to, k, this.viewport);
      if (k >= 1) {
        this.camera = this._anim.to;
        this._anim = null;
      } else again = true;
    }
    let tk = 1;
    if (this._tween) {
      tk = Math.min(1, (t - this._tween.start) / this._tween.ms);
      if (tk >= 1) this._tween = null;
      else again = true;
    }
    const { width: W, height: H } = this.viewport;
    const p = this.palette;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, W, H);
    this.stats.frames += 1;
    this.stats.nodes = 0;
    this.stats.edges = 0;
    const scene = this.scene;
    const nodes = this.nodes || [];
    if (!scene || !nodes.length) {
      this.stats.ms = mono() - started;
      if (again) this.invalidate();
      return;
    }
    const cam = this.camera;
    const z = cam.zoom;
    const lod = lodOf(z);
    const view = visibleRect(cam, this.viewport, 60);
    // During a tween nodes sit between two places: draw all of them.
    const shown = this._tween
      ? nodes.filter((n) => !n.focus).concat(nodes.filter((n) => n.focus))
      : query(this.grid, { x: view.minX, y: view.minY, w: view.maxX - view.minX, h: view.maxY - view.minY }).map((ref) => this.byRef.get(ref)).filter(Boolean);
    const pos = new Map();
    for (const node of nodes) pos.set(node.ref, this._pos(node, tk));
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * cam.x, dpr * cam.y);
    this._drawEdges(ctx, scene, pos, view, z);
    for (const node of shown) this._drawNode(ctx, node, pos.get(node.ref), lod, z);
    this.stats.nodes = shown.length;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.stats.ms = mono() - started;
    if (again) this.invalidate();
  }

  _drawEdges(ctx, scene, pos, view, z) {
    const p = this.palette;
    const sel = this.selected;
    const lines = { solid: [], dashed: [], thin: [], hot: [] };
    for (const e of scene.edges) {
      const a = pos.get(e.a);
      const b = pos.get(e.b);
      if (!a || !b) continue;
      if (Math.max(a.x, b.x) < view.minX || Math.min(a.x, b.x) > view.maxX || Math.max(a.y, b.y) < view.minY || Math.min(a.y, b.y) > view.maxY) continue;
      const bucket = sel && (e.a === sel || e.b === sel) ? 'hot' : lines[e.style] ? e.style : 'solid';
      lines[bucket].push([a, b, e]);
    }
    const dim = this.matches;
    for (const style of [...STYLE_ORDER, 'hot']) {
      const list = lines[style];
      if (!list.length) continue;
      ctx.strokeStyle = style === 'hot' ? p.accent : style === 'thin' ? p.subtle : p.border;
      ctx.lineWidth = (style === 'hot' ? 2 : style === 'thin' ? 1 : 1.5) / z;
      ctx.setLineDash(style === 'dashed' ? [6 / z, 4 / z] : []);
      if (style === 'thin') {
        // Co-occurrence edges: opacity follows the weight.
        for (const [a, b, e] of list) {
          ctx.globalAlpha = (0.2 + 0.6 * (e.w ?? 1)) * (dim && !(dim.has(e.a) && dim.has(e.b)) ? 0.35 : 1);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.globalAlpha = dim ? 0.5 : 1;
      ctx.beginPath();
      for (const [a, b] of list) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  _alphaOf(node) {
    let a = 1;
    if (node.kind === 'action' && node.status === 'done') a *= 0.55;
    if (this.matches && !this.matches.has(node.ref) && !node.focus) a *= 0.3;
    return a;
  }

  _drawNode(ctx, node, at, lod, z) {
    const p = this.palette;
    const selected = node.ref === this.selected;
    ctx.globalAlpha = this._alphaOf(node);
    if (lod === 'dot') {
      const r = (node.focus ? 7 : selected ? 6 : 4) / z;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
      ctx.fillStyle = selected || node.focus ? p.accent : node.group === 'entity' ? p.text : p.muted;
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    const x = at.x - node.w / 2;
    const y = at.y - node.h / 2;
    const radius = node.group === 'entity' ? node.h / 2 : node.group === 'overview' ? 12 : 8;
    ctx.beginPath();
    roundRect(ctx, x, y, node.w, node.h, radius);
    ctx.fillStyle = node.focus ? p.input : p.node;
    ctx.fill();
    ctx.lineWidth = (selected ? 2.5 : node.focus ? 2 : 1) / z;
    ctx.strokeStyle = selected || node.focus ? p.accent : node.ref === this.hover ? p.text : p.border;
    // Suggested actions are dashed with ❔ (EXTENSION_VIEWS §24.4).
    ctx.setLineDash(node.suggested ? [5 / z, 3 / z] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // Text: icon and label on the start side, sizes kept readable when zoomed out.
    const pad = 10;
    const ts = p.textScale;
    const size = Math.max(12 * ts, (10.5 * ts) / z);
    const n = lod === 'short' ? LABEL_CHARS.short : LABEL_CHARS.long;
    const icon = this.labels.iconOf?.(node) || '';
    const label = clipLabel(node.group === 'overview' ? this.labels.titleOf?.(node) || node.label : node.label || '…', n);
    const sub = lod === 'full' ? this.labels.subOf?.(node) || '' : '';
    ctx.direction = this.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = node.focus ? p.bright : p.text;
    this._setFont(size, node.focus ? '600' : '');
    const startX = this.rtl ? x + node.w - pad : x + pad;
    const room = node.w - pad * 2 - (node.pinned ? 14 : 0);
    const line1 = this._fit(icon ? `${icon} ${label}` : label, room);
    const lineY = sub ? at.y - size * 0.45 : at.y;
    ctx.fillText(line1, startX, lineY);
    if (sub) {
      const subSize = Math.max(10 * ts, (9 * ts) / z);
      this._setFont(subSize);
      ctx.fillStyle = p.muted;
      ctx.fillText(this._fit(sub, room), startX, at.y + subSize * 0.75);
    }
    if (node.pinned) {
      this._setFont(Math.max(10, 9 / z));
      ctx.textAlign = 'end';
      ctx.fillText('📌', this.rtl ? x + pad : x + node.w - 4, y + 9);
      ctx.textAlign = 'start';
    }
    ctx.globalAlpha = 1;
    if (selected) this._drawHandle(ctx, node, at, z);
  }

  // The ＋ handle on the end edge of the selected node: show (or hide) its connections.
  _handleAt(node, at = node) {
    const ex = this.rtl ? at.x - node.w / 2 : at.x + node.w / 2;
    return { x: ex, y: at.y, r: HANDLE_PX / this.camera.zoom };
  }

  _drawHandle(ctx, node, at, z) {
    const p = this.palette;
    const hnd = this._handleAt(node, at);
    ctx.beginPath();
    ctx.arc(hnd.x, hnd.y, hnd.r, 0, Math.PI * 2);
    ctx.fillStyle = p.accent;
    ctx.fill();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = p.bg;
    ctx.beginPath();
    ctx.moveTo(hnd.x - hnd.r * 0.5, hnd.y);
    ctx.lineTo(hnd.x + hnd.r * 0.5, hnd.y);
    if (!this.scene?.expanded?.includes(node.ref)) {
      ctx.moveTo(hnd.x, hnd.y - hnd.r * 0.5);
      ctx.lineTo(hnd.x, hnd.y + hnd.r * 0.5);
    }
    ctx.stroke();
  }

  // --- input -------------------------------------------------------------------------

  _point(e) {
    const r = this.canvas?.getBoundingClientRect?.() || { left: 0, top: 0 };
    return { x: (Number(e.clientX) || 0) - (r.left || 0), y: (Number(e.clientY) || 0) - (r.top || 0) };
  }

  /** The node (or its handle) under screen point (sx, sy). → { ref, handle } | null */
  hitTest(sx, sy) {
    const w = screenToWorld(this.camera, sx, sy);
    const sel = this.selected ? this.byRef.get(this.selected) : null;
    if (sel && lodOf(this.camera.zoom) !== 'dot') {
      const hnd = this._handleAt(sel);
      if (Math.hypot(w.x - hnd.x, w.y - hnd.y) <= hnd.r * 1.3) return { ref: sel.ref, handle: true };
    }
    const ref = hit(this.grid, w.x, w.y);
    return ref ? { ref, handle: false } : null;
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    this._anim = null;
    const pt = this._point(e);
    const found = this.hitTest(pt.x, pt.y);
    const node = found ? this.byRef.get(found.ref) : null;
    let mode = 'pan';
    if (found?.handle) mode = 'handle';
    else if (node && !this.spaceHeld) mode = 'node';
    this._down = { id: e.pointerId, sx: pt.x, sy: pt.y, cam: this.camera, moved: false, mode, ref: found?.ref || null, nx: node?.x, ny: node?.y };
    try {
      if (e.pointerId !== undefined) this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety.
    }
    this.canvas?.focus?.({ preventScroll: true });
  }

  _onPointerMove(e) {
    const pt = this._point(e);
    const d = this._down;
    if (!d) {
      const found = this.hitTest(pt.x, pt.y);
      const ref = found?.ref || null;
      if (ref !== this.hover) {
        this.hover = ref;
        if (this.canvas?.style) this.canvas.style.cursor = ref ? 'pointer' : 'grab';
        this.invalidate();
      }
      return;
    }
    const dx = pt.x - d.sx;
    const dy = pt.y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    if (this.spaceHeld) this.spaceDragged = true;
    if (d.mode === 'node') {
      const z = this.camera.zoom;
      this._moveLocal(d.ref, Math.round(d.nx + dx / z), Math.round(d.ny + dy / z));
    } else if (d.mode === 'pan') {
      this.camera = panBy(d.cam, dx, dy);
      if (this.canvas?.style) this.canvas.style.cursor = 'grabbing';
      this.invalidate();
    }
  }

  _onPointerUp(e, { cancel = false } = {}) {
    const d = this._down;
    if (!d) return;
    this._down = null;
    try {
      if (e?.pointerId !== undefined) this.canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
    if (this.canvas?.style) this.canvas.style.cursor = 'grab';
    if (cancel) {
      if (d.mode === 'node' && d.moved) this._moveLocal(d.ref, d.nx, d.ny);
      return;
    }
    if (!d.moved) {
      if (d.mode === 'handle') this.onIntent({ type: 'expand', ref: d.ref });
      else this.onIntent({ type: 'select', ref: d.ref });
      return;
    }
    if (d.mode === 'node') {
      const node = this.byRef.get(d.ref);
      if (node) this.onIntent({ type: 'move', ref: d.ref, x: node.x, y: node.y, from: { x: d.nx, y: d.ny } });
    } else if (d.mode === 'pan') {
      this.onIntent({ type: 'camera', camera: this.camera });
    }
  }

  _onDblClick(e) {
    const pt = this._point(e);
    const found = this.hitTest(pt.x, pt.y);
    if (found && !found.handle) this.onIntent({ type: 'focus', ref: found.ref });
  }

  _onWheel(e) {
    e.preventDefault?.();
    // While a WebKit pinch runs, its gesture events drive the zoom.
    if (this._gesture) return;
    this._anim = null;
    const pt = this._point(e);
    const unitPx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.height : 1;
    const dx = (Number(e.deltaX) || 0) * unitPx;
    const dy = (Number(e.deltaY) || 0) * unitPx;
    // ctrl + wheel is also how WebView2 reports a trackpad pinch.
    if (e.ctrlKey || e.metaKey || this.scroll === 'zoom') {
      const factor = Math.exp(-dy * (e.ctrlKey || e.metaKey ? 0.01 : 0.0015));
      this.setCamera(zoomAt(this.camera, factor, pt.x, pt.y));
    } else {
      this.setCamera(panBy(this.camera, -dx, -dy));
    }
  }

  _onGesture(e, phase) {
    e.preventDefault?.();
    if (phase === 'start') {
      const pt = this._point(e);
      this._gesture = { cam: this.camera, sx: pt.x, sy: pt.y };
      return;
    }
    const g = this._gesture;
    if (!g) return;
    const scale = Number(e.scale) > 0 ? Number(e.scale) : 1;
    this.camera = zoomAt(g.cam, scale, g.sx, g.sy);
    this.invalidate();
    if (phase === 'end') {
      this._gesture = null;
      this.onIntent({ type: 'camera', camera: this.camera });
    }
  }

  /** Space pressed: a drag pans while it's held. */
  spaceDown() {
    if (this.spaceHeld) return;
    this.spaceHeld = true;
    this.spaceDragged = false;
  }

  /** Space released. → true when it was a plain press (not a pan): expand. */
  spaceUp() {
    const plain = this.spaceHeld && !this.spaceDragged;
    this.spaceHeld = false;
    this.spaceDragged = false;
    return plain;
  }
}
