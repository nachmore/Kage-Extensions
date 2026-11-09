/**
 * A fake Kage view host for the Mind Map explorer tests, coded against
 * Kage's docs/design/EXTENSION_VIEWS.md (the host side is built in
 * parallel; nothing here is copied from it):
 *
 *   - createChangeBus(host): storage change events (§10). The memory host
 *     reports every save and delete; flush() delivers them as one batch,
 *     the way Kage's 100 ms coalescer does: the last change per key wins,
 *     more than 64 keys become { key: '*', op: 'bulk' }, and each window
 *     sees `self` = "this window wrote it".
 *   - makeViewContext(host, …): a sandbox `context` for the view window:
 *     `context.view` (§9.2, every method a vi.fn), `context.storage.onChanged`
 *     (§9.3), the view's host features (§9.4) and a runSandboxed that, like
 *     the real Worker, gets `run` as source text (Function.toString).
 *   - installCanvasStub(window): jsdom has no Canvas 2D; this gives every
 *     canvas a recording 2D context (calls, fillText and a fixed-width
 *     measureText).
 *   - manualFrames(): requestAnimationFrame you run by hand, so a test can
 *     count frames.
 */

import { vi } from 'vitest';
import { makeContext } from './corpus.mjs';

export const VIEW_FEATURES = Object.freeze(['views', 'storage.change_events']);

const TOKENS_DARK = Object.freeze({
  'kage-bg': '#1e1e1e', 'kage-bg-elevated': '#2a2a2a', 'kage-bg-input': '#252525',
  'kage-text': '#e6e6e6', 'kage-text-bright': '#ffffff', 'kage-text-muted': '#9a9a9a',
  'kage-border': '#3c3c3c', 'kage-border-subtle': '#333333',
  'kage-accent': '#4a9eff', 'kage-accent-hover': '#6ab0ff', 'kage-accent-active': '#2f86ea',
  'kage-accent-light': 'rgba(74, 158, 255, 0.2)', 'kage-accent-glow': 'rgba(74, 158, 255, 0.4)',
  'kage-link': '#6ab0ff', 'kage-success': '#4caf50', 'kage-warning': '#ff9800',
  'kage-danger': '#f44336', 'kage-error': '#f44336',
  'kage-font': 'Segoe UI, sans-serif', 'kage-font-mono': 'Consolas, monospace',
});

/** A dark theme snapshot (§11). Reduced motion keeps the tests' frames exact. */
export const DARK_THEME = Object.freeze({ scheme: 'dark', fontSize: 14, reducedMotion: true, tokens: TOKENS_DARK });
export const LIGHT_THEME = Object.freeze({
  scheme: 'light', fontSize: 14, reducedMotion: true,
  tokens: Object.freeze({ ...TOKENS_DARK, 'kage-bg': '#fafafa', 'kage-bg-elevated': '#ffffff', 'kage-text': '#1f1f1f', 'kage-border': '#d4d4d4' }),
});

/** Storage change events over a memory host (EXTENSION_VIEWS §10.1). */
export function createChangeBus(host) {
  const queue = [];
  const subs = new Map();
  let next = 1;
  const off = host.onData((change) => queue.push(change));
  return {
    subscribe(window, fn) {
      const id = next++;
      subs.set(id, { window, fn });
      return () => subs.delete(id);
    },
    get pending() {
      return queue.length;
    },
    get listeners() {
      return subs.size;
    },
    /** Delivers what's queued as one batch. → number of entries */
    flush() {
      if (!queue.length) return 0;
      const batch = new Map();
      for (const change of queue.splice(0)) {
        batch.delete(change.key);
        batch.set(change.key, change);
      }
      const list = [...batch.values()];
      const changes = list.length > 64 ? [{ key: '*', op: 'bulk', window: null }] : list;
      for (const { window, fn } of [...subs.values()]) {
        fn(changes.map((c) => ({ key: c.key, op: c.op, self: c.window === window, source: 'window' })));
      }
      return changes.length;
    },
    discard() {
      queue.length = 0;
    },
    close() {
      off();
      subs.clear();
    },
  };
}

/**
 * The context of the explorer's view window over `host`.
 * opts = { bus, window: host.connect(), theme, hostFeatures, config, i18n, runSandboxed }
 * → { context, view, window }
 */
export function makeViewContext(host, { bus, window, theme = DARK_THEME, hostFeatures = VIEW_FEATURES, config = {}, i18n, runSandboxed } = {}) {
  const win = window || host.connect();
  const context = makeContext(host, { invoke: win.invoke, config, formatter: false, hostFeatures, i18n });
  const view = {
    id: 'explorer',
    theme,
    setTitle: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    compose: vi.fn(async () => {}),
    copyText: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
  };
  context.view = view;
  if (bus) context.storage = { onChanged: (fn) => bus.subscribe(win.index, fn) };
  // The real runner evaluates run's source in a Worker, so a run function
  // that leans on anything outside itself fails here too.
  context.runSandboxed = runSandboxed || vi.fn(async ({ run, data }) => {
    const fresh = new Function(`return (${run.toString()})`)();
    return fresh(structuredClone(data), {});
  });
  return { context, view, window: win };
}

function recordingContext(canvas) {
  const calls = [];
  const texts = [];
  const rec = {
    canvas, calls, texts,
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif',
    globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
  };
  const note = (name, args) => calls.push({ name, args, fillStyle: rec.fillStyle, strokeStyle: rec.strokeStyle, globalAlpha: rec.globalAlpha });
  for (const name of ['save', 'restore', 'setTransform', 'resetTransform', 'translate', 'scale', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'setLineDash']) {
    rec[name] = (...args) => note(name, args);
  }
  rec.fillText = (text, x, y) => {
    note('fillText', [text, x, y]);
    texts.push({ text: String(text), x, y, direction: rec.direction, textAlign: rec.textAlign, fillStyle: rec.fillStyle, font: rec.font });
  };
  rec.measureText = (text) => {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(rec.font)?.[1]) || 10;
    return { width: Array.from(String(text)).length * px * 0.55 };
  };
  rec.reset = () => {
    calls.length = 0;
    texts.length = 0;
  };
  return rec;
}

/** Gives every canvas in `win` a recording 2D context. → { contexts, restore() } */
export function installCanvasStub(win) {
  const proto = win.HTMLCanvasElement.prototype;
  const original = proto.getContext;
  const contexts = [];
  proto.getContext = function getContext(type) {
    if (type !== '2d') return null;
    if (!this.__mmRecorder) {
      this.__mmRecorder = recordingContext(this);
      contexts.push(this.__mmRecorder);
    }
    return this.__mmRecorder;
  };
  return { contexts, restore: () => { proto.getContext = original; } };
}

/** requestAnimationFrame run by hand. flush() runs queued frames. */
export function manualFrames() {
  let queue = new Map();
  let id = 0;
  let t = 0;
  return {
    raf: (fn) => {
      const k = ++id;
      queue.set(k, fn);
      return k;
    },
    caf: (k) => queue.delete(k),
    now: () => t,
    get pending() {
      return queue.size;
    },
    /** Runs up to `rounds` rounds of queued frames. → callbacks run */
    flush(rounds = 20) {
      let ran = 0;
      for (let i = 0; i < rounds && queue.size; i++) {
        const fns = [...queue.values()];
        queue = new Map();
        t += 16;
        for (const fn of fns) fn(t);
        ran += fns.length;
      }
      return ran;
    },
  };
}
