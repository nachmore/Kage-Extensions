// @vitest-environment jsdom
// The map explorer end to end (Kage docs/design/EXTENSION_VIEWS.md §24.9):
// the SPEC §3.1 corpus in the floating window, and the explorer in a view
// window on the same data, with storage change events, a recording 2D
// context and hand-run animation frames (test-helpers/mindmap/view-host.mjs).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, makeHarness, makeI18n } from '../../test-helpers/mindmap/corpus.mjs';
import { DARK_THEME, LIGHT_THEME, createChangeBus, installCanvasStub, makeViewContext, manualFrames } from '../../test-helpers/mindmap/view-host.mjs';
import MindMapExplorer from './explorer.js';
import { centerOf, worldToScreen } from './lib/camera.js';
import { getMind } from './mind.js';

let h;
let F;
let bus;
let stub;
const open = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness({ hostFeatures: ['views', 'storage.change_events'] });
  F = await buildCorpus(h);
  h.at(FIXTURE_NOW);
  bus = createChangeBus(h.host);
  stub = installCanvasStub(window);
}, 60_000);

afterAll(() => {
  stub.restore();
  bus.close();
  vi.useRealTimers();
});

afterEach(() => {
  while (open.length) {
    const x = open.pop();
    x.explorer.destroy();
    x.root.remove();
  }
  bus.discard();
});

const idOf = (name, type) => h.mind.resolveEntity(name, type)?.entityId;
const nodeOf = (explorer, ref) => explorer.scene.nodes[explorer.scene.byRef.get(ref)];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openExplorer({ params, theme = DARK_THEME, i18n, storage = true, runSandboxed } = {}) {
  const frames = manualFrames();
  const made = makeViewContext(h.host, { bus: storage ? bus : null, theme, i18n, runSandboxed });
  if (runSandboxed === null) delete made.context.runSandboxed;
  const explorer = new MindMapExplorer({ raf: frames.raf, caf: frames.caf, now: frames.now });
  explorer.initialize(made.context);
  const root = document.createElement('div');
  document.body.appendChild(root);
  await explorer.mount(root, { params, source: 'launcher', reloaded: false });
  // Let the first layout pass land.
  await tick();
  frames.flush();
  const x = { explorer, frames, root, ...made, mind: getMind(made.context), recorder: stub.contexts.find((r) => r.canvas === root.querySelector('canvas')) };
  open.push(x);
  return x;
}

function key(type, k, extra = {}) {
  document.body.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...extra }));
}

function buttonIn(root, cmd) {
  return root.querySelector(`.ex-panel button[data-cmd="${cmd}"]`);
}

describe('opening the explorer', () => {
  it('opens on the focus from params: scene, title, first frame, list', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, view, root } = await openExplorer({ params: { focus: bingo } });
    expect(explorer.focus).toBe(bingo);
    expect(explorer.scene.nodes[0]).toMatchObject({ ref: bingo, focus: true });
    expect(explorer.scene.byRef.has(F.F6)).toBe(true);
    expect(view.setTitle).toHaveBeenCalledWith('Bingo');
    expect(explorer.canvas.stats.frames).toBeGreaterThanOrEqual(1);
    // The focus is on screen.
    const f = nodeOf(explorer, bingo);
    const s = worldToScreen(explorer.canvas.camera, f.x, f.y);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(explorer.canvas.viewport.width);
    // The accessible list mirrors the scene, focus first.
    expect(explorer.panel.listRefs[0]).toBe(bingo);
    expect(explorer.panel.listRefs).toHaveLength(explorer.scene.nodes.length);
    const options = root.querySelectorAll('.ex-list [role="option"]');
    expect(options[0].textContent).toBe('team: Bingo');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.ex-list').getAttribute('role')).toBe('listbox');
    expect(root.querySelector('canvas').getAttribute('aria-hidden')).toBe('true');
    // The details panel shows the focus.
    expect(root.querySelector('.ex-panel .ex-title').textContent).toBe('Bingo');
  });

  it('opens on the overview without params, and ignores bad params', async () => {
    const { explorer, view } = await openExplorer({ params: { focus: '../etc', query: 42 } });
    expect(explorer.focus).toBe('o');
    expect(view.setTitle).toHaveBeenCalledWith('Overview');
    expect(explorer.scene.nodes.length).toBeGreaterThan(3);
  });

  it('applies a launcher query as a lens and highlights the matches', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root } = await openExplorer({ params: { focus: bingo, query: 'kind:doc' } });
    expect(root.querySelector('.ex-search').value).toBe('kind:doc');
    expect(explorer.lens.kinds).toEqual(['doc']);
    const items = explorer.scene.nodes.filter((n) => n.group === 'item');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((n) => n.kind === 'doc')).toBe(true);
    expect([...explorer.matches].every((ref) => h.mind.item(ref)?.kind !== 'note')).toBe(true);
  });

  it('works without change events or a sandboxed runner (older or partial hosts)', async () => {
    const { explorer } = await openExplorer({ storage: false, runSandboxed: null });
    expect(explorer.scene.nodes.length).toBeGreaterThan(1);
    expect(explorer._offStorage).toBeFalsy();
  });
});

describe('pins (mm-layout)', () => {
  it('a dragged node is pinned, saved, and shown there after reopening', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root, frames } = await openExplorer({ params: { focus: bingo } });
    const node = { ...nodeOf(explorer, F.F6) };
    const canvas = root.querySelector('canvas');
    const s = worldToScreen(explorer.canvas.camera, node.x - node.w / 4, node.y);
    const z = explorer.canvas.camera.zoom;
    const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    expect(explorer.canvas.hitTest(s.x, s.y)).toEqual({ ref: F.F6, handle: false });
    fire('pointerdown', s.x, s.y);
    fire('pointermove', s.x + 40, s.y + 30);
    fire('pointerup', s.x + 80, s.y + 60);
    frames.flush();
    const want = { x: Math.round(node.x + 40 / z), y: Math.round(node.y + 30 / z) };
    expect(nodeOf(explorer, F.F6)).toMatchObject({ ...want, pinned: true });
    await vi.waitFor(() => expect(JSON.parse(h.host.files.get('mm-layout') || '{}').pins?.[F.F6]).toMatchObject(want));
    const stored = JSON.parse(h.host.files.get('mm-layout'));
    expect(stored).toMatchObject({ schema: 1 });
    expect(stored.rev).toBeGreaterThan(0);
    // Another window opens the explorer: the node is where it was pinned.
    explorer.destroy();
    const again = await openExplorer({ params: { focus: bingo } });
    expect(nodeOf(again.explorer, F.F6)).toMatchObject({ ...want, pinned: true });
    // ⌘/Ctrl+Z undoes the move (local stack), and unpins.
    explorer.undoStack.length = 0;
    again.explorer.undoStack.push({ ref: F.F6, before: { pinned: false, x: node.x, y: node.y } });
    key('keydown', 'z', { metaKey: true });
    expect(nodeOf(again.explorer, F.F6)).toMatchObject({ x: Math.round(node.x), y: Math.round(node.y), pinned: false });
    await vi.waitFor(() => expect(JSON.parse(h.host.files.get('mm-layout')).pins[F.F6]).toBeUndefined());
  });

  it('pins and unpins from the keyboard and the panel', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root } = await openExplorer({ params: { focus: bingo } });
    explorer._select(F.F1);
    key('keydown', 'p');
    expect(nodeOf(explorer, F.F1).pinned).toBe(true);
    await vi.waitFor(() => expect(JSON.parse(h.host.files.get('mm-layout')).pins[F.F1]).toBeTruthy());
    expect(buttonIn(root, 'pin').textContent).toBe('Unpin');
    buttonIn(root, 'pin').click();
    expect(nodeOf(explorer, F.F1).pinned).toBe(false);
    await vi.waitFor(() => expect(JSON.parse(h.host.files.get('mm-layout')).pins[F.F1]).toBeUndefined());
  });

  it('another window’s pin moves the node here', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, frames } = await openExplorer({ params: { focus: bingo } });
    bus.discard();
    await h.mind.setPins({ [F.F1]: { x: 4321, y: -1234 } });
    bus.flush();
    await explorer.whenSettled();
    frames.flush();
    expect(nodeOf(explorer, F.F1)).toMatchObject({ x: 4321, y: -1234, pinned: true });
    await h.mind.setPins({ [F.F1]: null });
  });
});

describe('changes from other windows', () => {
  it('a non-self mm-meta change syncs, rebuilds and redraws once', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, frames, mind } = await openExplorer({ params: { focus: bingo } });
    bus.discard();
    const frameCount = explorer.canvas.stats.frames;
    const out = await h.mind.capture('Bingo retro notes and ideas', { via: 'launcher' });
    await h.mind.whenIdle();
    expect(mind.item(out.itemId)).toBeNull();
    bus.flush();
    await explorer.whenSettled();
    await tick();
    frames.flush();
    expect(explorer.canvas.stats.frames - frameCount).toBe(1);
    expect(mind.item(out.itemId)).toBeTruthy();
    expect(explorer.scene.byRef.has(out.itemId)).toBe(true);
    // Its own writes don't trigger a rebuild.
    const built = explorer._builtRev;
    explorer._onChanges([{ key: 'mm-meta', op: 'save', self: true, source: 'window' }]);
    await explorer.whenSettled();
    expect(explorer._builtRev).toBe(built);
    await h.mind.undo(out.opId);
  });

  it('the launcher’s Mind syncs at once on a change event', async () => {
    const { context } = makeViewContext(h.host, { bus });
    const launcher = getMind(context);
    await launcher.ready();
    const syncs = vi.spyOn(launcher, 'syncIfStale');
    const out = await h.mind.capture('a thought for the launcher', { via: 'launcher' });
    bus.flush();
    await launcher.whenIdle();
    expect(syncs).toHaveBeenCalledWith(0);
    expect(launcher.item(out.itemId)).toBeTruthy();
    launcher._offChanges?.();
    await h.mind.undo(out.opId);
  });
});

describe('privacy', () => {
  it('a private node is drawn here but never reaches compose', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, view, root } = await openExplorer({ params: { focus: bingo } });
    expect(h.mind.item(F.F10).private).toBe(true);
    expect(explorer.scene.byRef.has(F.F10)).toBe(true);
    explorer._select(F.F10);
    const ask = buttonIn(root, 'ask');
    expect(ask.disabled).toBe(true);
    ask.click();
    await explorer._command({ type: 'ask', ref: F.F10 });
    expect(view.compose).not.toHaveBeenCalled();
    expect(root.querySelector('.ex-toast').textContent).toContain('Private items aren’t sent');
    // Centred on it, the window title doesn't name it either.
    explorer._setFocus(F.F10);
    expect(view.setTitle).toHaveBeenLastCalledWith('Private item');
    // A public item asks with the trigger and its title, without sending.
    await explorer._command({ type: 'ask', ref: F.F1 });
    expect(view.compose).toHaveBeenCalledTimes(1);
    expect(view.compose).toHaveBeenCalledWith('mm? what do my notes say about “MTCS design review”?');
    for (const call of view.compose.mock.calls) expect(call[0]).not.toMatch(/salary/i);
  });
});

describe('re-centring', () => {
  it('onOpen re-centres on a new focus, pushes history and retitles', async () => {
    const bingo = idOf('bingo', 'team');
    const dana = idOf('dana', 'person');
    const { explorer, view } = await openExplorer({ params: { focus: bingo } });
    explorer.onOpen({ params: { focus: dana }, source: 'launcher' });
    expect(explorer.focus).toBe(dana);
    expect(explorer.history.at(-1)).toBe(bingo);
    const f = explorer.scene.nodes[0];
    expect(f.ref).toBe(dana);
    const c = centerOf(explorer.canvas.camera, explorer.canvas.viewport);
    expect(c.x).toBeCloseTo(f.x, 6);
    expect(c.y).toBeCloseTo(f.y, 6);
    expect(view.setTitle).toHaveBeenLastCalledWith('Dana');
    // Back returns to Bingo; Home goes to the overview.
    explorer._command({ type: 'back' });
    expect(explorer.focus).toBe(bingo);
    explorer._command({ type: 'home' });
    expect(explorer.focus).toBe('o');
    // A focus that no longer exists keeps the current one.
    explorer.onOpen({ params: { focus: 'e0000000000zzzz' } });
    expect(explorer.focus).toBe('o');
  });

  it('saves this computer’s view (mm-view) and restores it', async () => {
    const dana = idOf('dana', 'person');
    const first = await openExplorer({ params: { focus: dana } });
    first.explorer._command({ type: 'scroll' });
    first.explorer.canvas.zoomBy(1.5);
    await first.explorer._saveView();
    const saved = JSON.parse(h.host.files.get('mm-view'));
    expect(saved).toMatchObject({ schema: 1, focus: dana, scroll: first.explorer.scroll, panelOpen: true });
    expect(saved.camera.zoom).toBeCloseTo(first.explorer.canvas.camera.zoom, 6);
    first.explorer.destroy();
    const second = await openExplorer();
    expect(second.explorer.focus).toBe(dana);
    expect(second.explorer.scroll).toBe(saved.scroll);
    expect(second.explorer.canvas.camera.zoom).toBeCloseTo(saved.camera.zoom, 6);
    const c = centerOf(second.explorer.canvas.camera, second.explorer.canvas.viewport);
    expect(c.x).toBeCloseTo(saved.camera.x, 0);
  });
});

describe('keyboard and panel', () => {
  it('moves the selection with arrows, focuses with Enter and expands with Space', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root } = await openExplorer({ params: { focus: bingo } });
    expect(explorer.selected).toBe(bingo);
    key('keydown', 'ArrowDown');
    const below = explorer.selected;
    expect(below).not.toBe(bingo);
    expect(nodeOf(explorer, below).y).toBeGreaterThan(nodeOf(explorer, bingo).y);
    expect(root.querySelector('.ex-sr').textContent).toBeTruthy();
    key('keydown', 'Enter');
    expect(explorer.focus).toBe(below);
    const count = explorer.scene.nodes.length;
    const target = explorer.scene.nodes.find((n) => n.group === 'entity' && !n.focus)?.ref || explorer.focus;
    explorer._select(target);
    key('keydown', ' ');
    key('keyup', ' ');
    expect(explorer.scene.nodes.length >= count).toBe(true);
    key('keydown', '/');
    expect(document.activeElement).toBe(root.querySelector('.ex-search'));
    root.querySelector('.ex-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('steps through the list with Up and Down', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root } = await openExplorer({ params: { focus: bingo } });
    const list = root.querySelector('.ex-list');
    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(explorer.selected).toBe(explorer.panel.listRefs[1]);
    expect(list.getAttribute('aria-activedescendant')).toBe(root.querySelectorAll('.ex-list [role="option"]')[1].id);
  });

  it('marks an action done with Undo', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root, mind } = await openExplorer({ params: { focus: bingo } });
    expect(h.mind.item(F.F7).status).toBe('open');
    explorer._select(F.F7);
    await explorer._command({ type: 'done', ref: F.F7 });
    expect(mind.item(F.F7).status).toBe('done');
    // Done actions leave the default lens.
    expect(explorer.scene.byRef.has(F.F7)).toBe(false);
    const undo = root.querySelector('.ex-toast button');
    expect(undo.textContent).toBe('↶ Undo');
    undo.click();
    await vi.waitFor(() => expect(mind.item(F.F7).status).toBe('open'));
    await vi.waitFor(() => expect(explorer.scene.byRef.has(F.F7)).toBe(true));
  });

  it('opens links in the browser and copies file paths', async () => {
    const bingo = idOf('bingo', 'team');
    const mtcs = idOf('mtcs');
    const { explorer, view } = await openExplorer({ params: { focus: mtcs || bingo } });
    h.opened.length = 0;
    await explorer._command({ type: 'open', ref: F.F1 });
    expect(h.opened).toEqual([h.mind.item(F.F1).url]);
    await explorer._command({ type: 'open', ref: F.F3 });
    expect(view.copyText).toHaveBeenCalledWith(h.mind.item(F.F3).path);
  });

  it('searches, highlights the hits and focuses the first on Enter', async () => {
    const { explorer, root } = await openExplorer();
    explorer._command({ type: 'searchSubmit', text: 'mtcs design' });
    expect(explorer.searchHits[0]).toBe(F.F1);
    expect(explorer.focus).toBe(F.F1);
    expect(root.querySelectorAll('.ex-hits .ex-hit').length).toBeGreaterThan(0);
    expect(explorer.canvas.matches.has(F.F1)).toBe(true);
    explorer._escape(document.body);
    expect(explorer.matches).toBeNull();
    explorer._runSearch('zzzzqqq');
    expect(root.querySelector('.ex-hits').textContent).toBe('Nothing matches');
  });

  it('lenses: Show done brings done actions in; My actions leaves others out', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root } = await openExplorer({ params: { focus: bingo } });
    expect(h.mind.item(F.F9).status).toBe('done');
    expect(explorer.scene.byRef.has(F.F9)).toBe(false);
    explorer._command({ type: 'lens', done: true });
    expect(explorer.scene.byRef.has(F.F9)).toBe(true);
    const chips = [...root.querySelectorAll('.ex-lenses .ex-chip')];
    expect(chips.find((b) => b.textContent === 'Show done').getAttribute('aria-pressed')).toBe('true');
    explorer._command({ type: 'lens', mine: true });
    const others = explorer.scene.nodes.filter((n) => n.kind === 'action' && n.mine === false);
    expect(others).toEqual([]);
    explorer._command({ type: 'lens', kind: 'note' });
    expect(explorer.lens.kinds).not.toContain('note');
    explorer._command({ type: 'lens', done: true });
    explorer._command({ type: 'lens', mine: true });
    explorer._command({ type: 'lens', kind: 'note' });
    expect(explorer.lens).toEqual({ kinds: null, mine: false, done: false });
  });

  it('adds a capture from its ＋ Add box', async () => {
    const bingo = idOf('bingo', 'team');
    const { explorer, root, mind } = await openExplorer({ params: { focus: bingo } });
    const input = root.querySelector('.ex-add-input');
    input.value = 'Bingo launch party ideas';
    await explorer._command({ type: 'capture', text: input.value });
    const added = [...mind.state.items.values()].find((i) => i.title === 'Bingo launch party ideas');
    expect(added?.source?.via).toBe('explorer');
    expect(input.value).toBe('');
    expect(explorer.scene.byRef.has(added.id)).toBe(true);
    expect(root.querySelector('.ex-toast').textContent).toContain('Saved “Bingo launch party ideas”');
    await mind.undo();
  });
});

describe('theme and RTL', () => {
  it('mirrors in RTL and draws right-to-left text', async () => {
    const catalog = (await import('../../test-helpers/mindmap/corpus.mjs')).loadCatalog();
    const bingo = idOf('bingo', 'team');
    const { explorer, root, recorder, frames } = await openExplorer({ params: { focus: bingo }, i18n: makeI18n(catalog, { language: 'ar', rtl: true }) });
    expect(root.querySelector('.ex-app').getAttribute('dir')).toBe('rtl');
    const f = nodeOf(explorer, bingo);
    const action = explorer.scene.nodes.find((n) => n.lane === 'start' && n.depth === 1);
    expect(action.x).toBeGreaterThan(f.x);
    recorder.reset();
    explorer.canvas.invalidate();
    frames.flush();
    expect(recorder.texts.length).toBeGreaterThan(0);
    expect(recorder.texts.every((t) => t.direction === 'rtl')).toBe(true);
  });

  it('redraws with a new theme', async () => {
    const { explorer, recorder, frames } = await openExplorer();
    explorer.onThemeChange(LIGHT_THEME);
    recorder.reset();
    frames.flush();
    expect(recorder.calls.find((c) => c.name === 'fillRect').fillStyle).toBe(LIGHT_THEME.tokens['kage-bg']);
  });

  it('stops work when hidden and unsubscribes when destroyed', async () => {
    const { explorer, frames } = await openExplorer();
    const listeners = bus.listeners;
    explorer.onHide();
    explorer.canvas.invalidate();
    expect(frames.flush()).toBe(0);
    explorer.onShow();
    await explorer.whenSettled();
    expect(frames.flush()).toBeGreaterThan(0);
    explorer.destroy();
    expect(bus.listeners).toBe(listeners - 1);
  });
});
