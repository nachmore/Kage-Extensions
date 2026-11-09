// @vitest-environment jsdom
// The explorer's renderer and pointer input (explorer-canvas.js) on a
// recording 2D context (test-helpers/mindmap/view-host.mjs).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DARK_THEME, LIGHT_THEME, installCanvasStub, manualFrames } from '../../test-helpers/mindmap/view-host.mjs';
import { ExplorerCanvas, LOD, backingSize, clipLabel, keyIntent, lodOf, nearestInDirection, paletteOf } from './explorer-canvas.js';
import { centerOn, screenToWorld, worldToScreen } from './lib/camera.js';
import { buildScene, expand } from './lib/scene.js';

let stub;
beforeAll(() => {
  stub = installCanvasStub(window);
});
afterAll(() => stub.restore());

const eid = (n) => `e${String(n).padStart(14, '0')}`;
const iid = (n) => `i${String(n).padStart(14, '0')}`;

// A star: one team with `n` notes around it.
function starPort(n = 12) {
  const hub = { ref: eid(1), group: 'entity', kind: 'team', label: 'Bingo' };
  const items = Array.from({ length: n }, (_, i) => ({ ref: iid(i + 1), group: 'item', kind: i % 3 ? 'note' : 'action', label: `Item number ${i + 1} with a long title`, status: 'open', suggested: i === 3, at: 1_700_000_000_000 }));
  const byRef = new Map([[hub.ref, hub], ...items.map((it) => [it.ref, it])]);
  return {
    links(ref, { limit = 60 } = {}) {
      if (ref === hub.ref) return { node: hub, links: items.slice(0, limit).map((it) => ({ ref: it.ref, role: it.kind === 'action' ? 'actions' : 'notes', style: 'solid', w: 1, node: it })) };
      const node = byRef.get(ref);
      return node ? { node, links: [{ ref: hub.ref, role: 'entities', style: 'solid', w: 1, node: hub }] } : null;
    },
  };
}

function setup({ n = 12, rtl = false, scroll = 'zoom', theme = DARK_THEME } = {}) {
  const frames = manualFrames();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const intents = [];
  const c = new ExplorerCanvas({
    canvas, rtl, scroll, theme, raf: frames.raf, caf: frames.caf, now: frames.now,
    onIntent: (i) => intents.push(i),
    labels: { iconOf: (node) => (node.group === 'entity' ? '👥' : '📝'), subOf: () => 'note · Mon, Oct 26' },
  });
  c.attach();
  c.resize(800, 600, 2);
  const scene = buildScene(starPort(n), { focus: eid(1), rtl });
  c.setScene(scene);
  c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 1), { report: false });
  const rec = stub.contexts.find((r) => r.canvas === canvas);
  frames.flush();
  return { c, canvas, frames, intents, scene, rec };
}

function pointer(canvas, type, x, y, extra = {}) {
  canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }));
}

describe('pure helpers', () => {
  it('caps the backing store at 8192 px a side and 32 megapixels', () => {
    expect(backingSize(800, 600, 2)).toEqual({ width: 1600, height: 1200, scale: 2 });
    expect(backingSize(5000, 1000, 2).width).toBeLessThanOrEqual(8192);
    const big = backingSize(4000, 4000, 2);
    expect(big.width * big.height).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(backingSize(0, 0, 0)).toEqual({ width: 1, height: 1, scale: 1 });
  });

  it('picks the level of detail from the zoom', () => {
    expect(LOD).toEqual({ dots: 0.35, short: 0.7, sub: 1.2 });
    expect(lodOf(0.2)).toBe('dot');
    expect(lodOf(0.5)).toBe('short');
    expect(lodOf(1)).toBe('long');
    expect(lodOf(1.5)).toBe('full');
  });

  it('clips labels by code point', () => {
    expect(clipLabel('Send the MTCS numbers to Dana', 12)).toBe('Send the MT…');
    expect(clipLabel('🧠🧠🧠🧠', 3)).toBe('🧠🧠…');
    expect(clipLabel('  short  ', 12)).toBe('short');
  });

  it('finds the nearest node in a direction', () => {
    const nodes = [{ ref: 'a', x: 0, y: 0 }, { ref: 'b', x: 100, y: 10 }, { ref: 'c', x: 300, y: 0 }, { ref: 'd', x: 0, y: -100 }, { ref: 'e', x: 10, y: 400 }];
    expect(nearestInDirection(nodes, nodes[0], 'right')).toBe('b');
    expect(nearestInDirection(nodes, nodes[0], 'up')).toBe('d');
    expect(nearestInDirection(nodes, nodes[0], 'down')).toBe('e');
    expect(nearestInDirection(nodes, nodes[0], 'left')).toBeNull();
    expect(nearestInDirection(nodes, null, 'left')).toBeNull();
  });

  it('maps keys to intents', () => {
    const k = (key, extra = {}) => ({ key, ...extra });
    expect(keyIntent(k('+'))).toEqual({ type: 'zoom', factor: 1.25 });
    expect(keyIntent(k('-'))).toEqual({ type: 'zoom', factor: 0.8 });
    expect(keyIntent(k('0'))).toEqual({ type: 'fit' });
    expect(keyIntent(k('/'))).toEqual({ type: 'search' });
    expect(keyIntent(k('f', { ctrlKey: true }))).toEqual({ type: 'search' });
    expect(keyIntent(k('z', { metaKey: true }))).toEqual({ type: 'undoLayout' });
    expect(keyIntent(k('z', { metaKey: true }), { editing: true })).toBeNull();
    expect(keyIntent(k('ArrowLeft'))).toEqual({ type: 'pan', dx: 60, dy: 0 });
    expect(keyIntent(k('ArrowLeft'), { selected: 'x' })).toEqual({ type: 'step', dir: 'left' });
    expect(keyIntent(k('Enter'), { selected: 'x' })).toEqual({ type: 'focus', ref: 'x' });
    expect(keyIntent(k('Enter'))).toBeNull();
    expect(keyIntent(k('p'), { selected: 'x' })).toEqual({ type: 'pin', ref: 'x' });
    expect(keyIntent(k('Escape'), { editing: true })).toEqual({ type: 'escape' });
    expect(keyIntent(k('a'), { editing: true })).toBeNull();
    expect(keyIntent(k('w', { metaKey: true }))).toBeNull();
  });

  it('takes every colour from the theme tokens', () => {
    const p = paletteOf(LIGHT_THEME);
    expect(p.bg).toBe('#fafafa');
    expect(p.accent).toBe(LIGHT_THEME.tokens['kage-accent']);
    expect(p.font).toBe(LIGHT_THEME.tokens['kage-font']);
    expect(paletteOf(null).bg).toBe('#1e1e1e');
    expect(paletteOf({ ...LIGHT_THEME, fontSize: 21 }).textScale).toBe(1.5);
    expect(paletteOf({ fontSize: 'big' }).textScale).toBe(1);
  });
});

describe('drawing', () => {
  it('draws on demand: one frame per change, none when idle or hidden', () => {
    const { c, frames } = setup();
    const n = c.stats.frames;
    expect(frames.flush()).toBe(0);
    c.setSelection(iid(1));
    c.setSelection(iid(2));
    expect(frames.flush()).toBe(1);
    expect(c.stats.frames).toBe(n + 1);
    c.setVisible(false);
    c.invalidate();
    expect(frames.flush()).toBe(0);
    c.setVisible(true);
    expect(frames.flush()).toBe(1);
  });

  it('draws labels with the theme’s font and colours, start-aligned', () => {
    const { c, rec, frames } = setup();
    rec.reset();
    c.invalidate();
    frames.flush();
    const bg = rec.calls.find((call) => call.name === 'fillRect');
    expect(bg.fillStyle).toBe(DARK_THEME.tokens['kage-bg']);
    expect(rec.texts.length).toBeGreaterThan(0);
    expect(rec.texts.every((t) => t.direction === 'ltr' && t.textAlign !== 'center')).toBe(true);
    expect(rec.texts.some((t) => t.font.includes(DARK_THEME.tokens['kage-font']))).toBe(true);
    c.setTheme(LIGHT_THEME);
    rec.reset();
    frames.flush();
    expect(rec.calls.find((call) => call.name === 'fillRect').fillStyle).toBe('#fafafa');
  });

  it('sets the canvas text direction for RTL', () => {
    const { rec, c, frames } = setup({ rtl: true });
    rec.reset();
    c.invalidate();
    frames.flush();
    expect(rec.texts.length).toBeGreaterThan(0);
    expect(rec.texts.every((t) => t.direction === 'rtl')).toBe(true);
  });

  it('follows the level of detail: dots, short labels, sub lines', () => {
    const { c, rec, frames } = setup();
    c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 0.2), { report: false });
    rec.reset();
    frames.flush();
    expect(rec.texts).toHaveLength(0);
    expect(rec.calls.some((call) => call.name === 'arc')).toBe(true);
    c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 0.5), { report: false });
    rec.reset();
    frames.flush();
    expect(rec.texts.length).toBeGreaterThan(0);
    expect(rec.texts.every((t) => Array.from(t.text).length <= 12 + 3)).toBe(true);
    c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 1.5), { report: false });
    rec.reset();
    frames.flush();
    expect(rec.texts.some((t) => t.text.startsWith('note ·'))).toBe(true);
  });

  it('culls nodes outside the viewport', () => {
    const { c, frames, scene } = setup({ n: 40 });
    c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 0.4), { report: false });
    frames.flush();
    expect(c.stats.nodes).toBe(scene.nodes.length);
    c.setCamera(centerOn(c.camera, 0, 0, c.viewport, 4), { report: false });
    frames.flush();
    expect(c.stats.nodes).toBeLessThan(scene.nodes.length);
    expect(c.stats.nodes).toBeGreaterThan(0);
  });

  it('draws 2,000 nodes and their edges within a frame budget (soft: 8 ms)', () => {
    const { c, frames } = setup({ n: 60 });
    let scene = c.scene;
    const port = starPort(60);
    // Grow the scene by repeated expansion of the hub with a big graph.
    const big = buildScene({
      links(ref, { limit = 60 } = {}) {
        if (ref === eid(1)) {
          const links = Array.from({ length: Math.min(limit, 2000) }, (_, i) => ({ ref: iid(i + 1), role: 'notes', style: i % 2 ? 'thin' : 'solid', w: 0.5, node: { ref: iid(i + 1), group: 'item', kind: 'note', label: `Note ${i}` } }));
          return { node: { ref: eid(1), group: 'entity', kind: 'team', label: 'Hub' }, links };
        }
        return port.links(ref);
      },
    }, { focus: eid(1), hops: 1, cap: 2000, linkLimit: 200 });
    scene = expand(big, eid(1), { links: () => ({ node: big.nodes[0], links: [] }) }).scene;
    c.setScene(scene);
    c.setCamera(c.fitCamera(), { report: false });
    frames.flush();
    if (c.stats.ms > 8) console.warn(`frame took ${c.stats.ms.toFixed(1)} ms for ${c.stats.nodes} nodes`);
    expect(c.stats.nodes).toBeGreaterThan(0);
  });
});

describe('pointer and wheel input', () => {
  it('selects a node on click and clears on the background', () => {
    const { c, canvas, intents, scene } = setup();
    const node = scene.nodes.find((n) => n.ref === iid(2));
    const s = worldToScreen(c.camera, node.x, node.y);
    pointer(canvas, 'pointerdown', s.x, s.y);
    pointer(canvas, 'pointerup', s.x, s.y);
    expect(intents.at(-1)).toEqual({ type: 'select', ref: iid(2) });
    pointer(canvas, 'pointerdown', 5, 5);
    pointer(canvas, 'pointerup', 5, 5);
    expect(intents.at(-1)).toEqual({ type: 'select', ref: null });
  });

  it('drags a node and reports the move once, on release', () => {
    const { c, canvas, intents, scene } = setup();
    const node = scene.nodes.find((n) => n.ref === iid(5));
    const start = { x: node.x, y: node.y };
    const s = worldToScreen(c.camera, node.x, node.y);
    pointer(canvas, 'pointerdown', s.x, s.y);
    pointer(canvas, 'pointermove', s.x + 30, s.y + 10);
    expect(c.dragging).toBe(iid(5));
    pointer(canvas, 'pointermove', s.x + 60, s.y + 20);
    expect(intents.filter((i) => i.type === 'move')).toHaveLength(0);
    pointer(canvas, 'pointerup', s.x + 60, s.y + 20);
    const move = intents.filter((i) => i.type === 'move');
    expect(move).toEqual([{ type: 'move', ref: iid(5), x: start.x + 60, y: start.y + 20, from: start }]);
  });

  it('pans when the background is dragged, or with Space held', () => {
    const { c, canvas, intents, scene } = setup();
    const before = { ...c.camera };
    pointer(canvas, 'pointerdown', 10, 10);
    pointer(canvas, 'pointermove', 60, 30);
    pointer(canvas, 'pointerup', 60, 30);
    expect(c.camera.x - before.x).toBe(50);
    expect(c.camera.y - before.y).toBe(20);
    expect(intents.at(-1).type).toBe('camera');
    const node = scene.nodes.find((n) => n.ref === iid(5));
    const s = worldToScreen(c.camera, node.x, node.y);
    c.spaceDown();
    pointer(canvas, 'pointerdown', s.x, s.y);
    pointer(canvas, 'pointermove', s.x + 40, s.y);
    pointer(canvas, 'pointerup', s.x + 40, s.y);
    expect(c.spaceUp()).toBe(false);
    expect(intents.some((i) => i.type === 'move')).toBe(false);
    c.spaceDown();
    expect(c.spaceUp()).toBe(true);
  });

  it('zooms at the cursor on wheel, or pans in pan mode; ⌘/Ctrl + wheel always zooms', () => {
    const { c, canvas } = setup({ scroll: 'zoom' });
    const before = screenToWorld(c.camera, 300, 200);
    const wheel = (extra) => canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 300, clientY: 200, deltaY: -100, cancelable: true, ...extra }));
    wheel();
    expect(c.camera.zoom).toBeGreaterThan(1);
    const after = screenToWorld(c.camera, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    c.setScrollMode('pan');
    const z = c.camera.zoom;
    const y = c.camera.y;
    wheel();
    expect(c.camera.zoom).toBe(z);
    expect(c.camera.y).toBe(y + 100);
    wheel({ ctrlKey: true });
    expect(c.camera.zoom).toBeGreaterThan(z);
    const ev = new WheelEvent('wheel', { deltaY: 10, cancelable: true });
    canvas.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('pinches with WebKit gesture events and ignores wheel meanwhile', () => {
    const { c, canvas } = setup();
    const gesture = (type, scale) => {
      const e = new Event(type, { cancelable: true });
      Object.assign(e, { clientX: 400, clientY: 300, scale });
      canvas.dispatchEvent(e);
    };
    gesture('gesturestart', 1);
    gesture('gesturechange', 2);
    expect(c.camera.zoom).toBeCloseTo(2, 6);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, ctrlKey: true, cancelable: true }));
    expect(c.camera.zoom).toBeCloseTo(2, 6);
    gesture('gestureend', 2);
    expect(c._gesture).toBeNull();
  });

  it('expands from the selected node’s ＋ handle; double click focuses', () => {
    const { c, canvas, intents, frames, scene } = setup();
    c.setSelection(iid(1));
    frames.flush();
    const node = scene.nodes.find((n) => n.ref === iid(1));
    const handle = worldToScreen(c.camera, node.x + node.w / 2, node.y);
    pointer(canvas, 'pointerdown', handle.x, handle.y);
    pointer(canvas, 'pointerup', handle.x, handle.y);
    expect(intents.at(-1)).toEqual({ type: 'expand', ref: iid(1) });
    const s = worldToScreen(c.camera, node.x - 20, node.y);
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: s.x, clientY: s.y, bubbles: true }));
    expect(intents.at(-1)).toEqual({ type: 'focus', ref: iid(1) });
  });

  it('keeps the middle of the window when resized', () => {
    const { c } = setup();
    c.setCamera(centerOn(c.camera, 123, -45, c.viewport, 2), { report: false });
    c.resize(1000, 700, 1);
    const centre = screenToWorld(c.camera, 500, 350);
    expect(centre.x).toBeCloseTo(123, 6);
    expect(centre.y).toBeCloseTo(-45, 6);
    expect(c.canvas.width).toBe(1000);
  });

  it('stops listening when destroyed', () => {
    const { c, canvas, intents } = setup();
    const spy = vi.fn();
    c.onIntent = spy;
    c.destroy();
    pointer(canvas, 'pointerdown', 5, 5);
    pointer(canvas, 'pointerup', 5, 5);
    expect(spy).not.toHaveBeenCalled();
    expect(intents).toHaveLength(0);
  });
});
