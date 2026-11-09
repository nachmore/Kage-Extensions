// Mind Map's map explorer: the module of contributes.views "explorer"
// (Kage docs/design/EXTENSION_VIEWS.md §9.1 and §24). A full window with a
// pan/zoom map on Canvas 2D, draggable nodes that stay where you pin them,
// a details panel, search, lenses and an accessible list of the nodes.
//
// Entry module: it may import composers (mind.js, view.js, the two
// explorer composers) and leaves.
//
// Data:
//   - notes come from the window's Mind (getMind), like every other provider;
//   - pinned positions are mm-layout (shared, under the lock, mind.setPins);
//   - camera, focus, history, lenses and the scroll mode are mm-view, this
//     computer only, written at most once every 2 s (mind.saveView);
//   - another window's change arrives as a storage change event: the
//     explorer syncs, rebuilds the same scene (positions kept) and redraws
//     once (EXTENSION_VIEWS §10, §24.5).
//
// Private items are drawn here (it's local) but never reach compose text or
// a prompt. Logs are English with no user text.

import { getMind } from './mind.js';
import { ETYPE_ICONS, doneText, dueText, etypeLabel, fmtDay, itemIcon, kindLabel } from './view.js';
import { ExplorerCanvas, clipLabel, keyIntent, nearestInDirection } from './explorer-canvas.js';
import { ExplorerPanel, LENS_KINDS } from './explorer-panel.js';
import { EXPAND_CAP, REF_RE, SCENE_CAP, SCENE_MAX, applyRelax, buildScene, collapse, diffScene, expand, moveNode, normalizeLens, readingOrder, rebuildScene, relaxInput } from './lib/scene.js';
import { RELAX_ITERATIONS, RELAX_TIMEOUT_MS, relax } from './lib/layout.js';
import { centerOf, worldToScreen } from './lib/camera.js';
import { triggerOf } from './defaults.js';

const VIEW_SAVE_MS = 2000;
const HISTORY_MAX = 20;
const UNDO_MAX = 50;
const SEARCH_MS = 120;
const SEARCH_LIMIT = 50;
const HITS_SHOWN = 8;
const QUERY_MAX = 200;
const LOCK = '🔒';
const PRIVATE_TITLE_MAX = 60;

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isHttp = (value) => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);

function cleanParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  if (typeof params.focus === 'string' && REF_RE.test(params.focus)) out.focus = params.focus;
  if (typeof params.query === 'string') {
    const q = oneLine(params.query).slice(0, QUERY_MAX);
    if (q) out.query = q;
  }
  return out;
}

function isEditable(target) {
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!target.isContentEditable;
}

const isButton = (target) => typeof target?.tagName === 'string' && target.tagName.toLowerCase() === 'button';

// Scroll pans on macOS (trackpads) and zooms elsewhere (EXTENSION_VIEWS §25 Q3).
function defaultScroll(win) {
  const nav = win?.navigator || globalThis.navigator;
  const platform = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '');
  return /mac/i.test(platform) ? 'pan' : 'zoom';
}

export default class MindMapExplorer {
  /** `options` exist for tests: { raf, caf, now }. The host passes none. */
  constructor(options = {}) {
    this.options = options || {};
    this.scene = null;
    this.selected = null;
    this.history = [];
    this.undoStack = [];
    this.matches = null;
    this.searchHits = [];
    this._sceneSeq = 0;
    this._fullText = null;
    this._pending = null;
    this._changeRun = null;
    this._destroyed = false;
    this._timers = new Set();
  }

  initialize(context) {
    this.context = context;
    this.mind = getMind(context);
    this.log = context.log;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  get rtl() {
    try {
      return !!this.context.i18n?.isRtl?.();
    } catch {
      return false;
    }
  }

  get locale() {
    try {
      return this.context.i18n?.language?.() || 'en';
    } catch {
      return 'en';
    }
  }

  get theme() {
    return this.context.view?.theme || null;
  }

  // --- lifecycle (EXTENSION_VIEWS §9.1) ----------------------------------------

  async mount(root, info = {}) {
    this.root = root;
    this.doc = root.ownerDocument;
    this.win = this.doc.defaultView || globalThis;
    const mind = this.mind;
    await mind.ready();
    const [view, layout] = await Promise.all([
      mind.loadView().catch(() => null),
      mind.loadLayout().catch(() => ({ pins: {}, unreadable: false })),
    ]);
    this.view = view || {};
    this.lens = normalizeLens(this.view.lens);
    this.scroll = this.view.scroll || defaultScroll(this.win);
    this.panelOpen = this.view.panelOpen !== false;
    this.listMode = false;
    this.history = (this.view.history || []).filter((ref) => mind.exNode(ref));
    const params = cleanParams(info?.params);
    let focus = params.focus || this.view.focus || 'o';
    if (!mind.exNode(focus)) focus = 'o';
    if (params.focus && this.view.focus && this.view.focus !== focus && mind.exNode(this.view.focus)) this._pushHistory(this.view.focus);
    this.focus = focus;
    this.selected = focus;

    this._buildDom();
    this._setScene(this._build(focus));
    if (params.query) {
      this.panel.setSearchValue(params.query);
      this._runSearch(params.query, { lens: true });
    }
    const saved = this.view.camera;
    if (saved && !params.focus) this.canvas.setCamera(this.canvas.cameraAt(saved.x, saved.y, saved.zoom), { report: false });
    else this.canvas.setCamera(this.canvas.fitCamera(), { report: false });
    // mount resolves once the first frame is drawn (EXTENSION_VIEWS §9.1).
    this.canvas.draw();
    this._title();
    this._subscribe();
    if (layout?.unreadable) this.panel.toast(this.t('explorer.layout_unreadable'));
    this._relax();
  }

  onOpen({ params } = {}) {
    const p = cleanParams(params);
    if (p.focus) this._setFocus(p.focus);
    if (p.query) {
      this.panel.setSearchValue(p.query);
      this._runSearch(p.query, { lens: true });
    }
  }

  onShow() {
    this.canvas?.setVisible(true);
    // Events are hints: anything missed while hidden shows up here (§10.2).
    this._queueChange({ data: true, layout: true });
  }

  onHide() {
    this.canvas?.setVisible(false);
    this._saveView();
  }

  onThemeChange(theme) {
    this.canvas?.setTheme(theme || this.theme);
  }

  onConfigUpdate(config) {
    this.config = config || {};
    this.mind.setConfig(this.config);
    if (this.scene) this._refresh();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._viewTimer) this._saveView();
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    try {
      this._offStorage?.();
    } catch {
      // Already gone.
    }
    this._offStorage = null;
    if (this.doc) {
      this.doc.removeEventListener('keydown', this._onKeyDown, true);
      this.doc.removeEventListener('keyup', this._onKeyUp, true);
    }
    this._resizeObserver?.disconnect?.();
    this.win?.removeEventListener?.('resize', this._onResize);
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    this.canvas?.destroy();
    this.panel?.destroy();
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._destroyed) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  // --- DOM -----------------------------------------------------------------------

  _buildDom() {
    this.panel = new ExplorerPanel({ root: this.root, t: this.t, rtl: this.rtl, onCommand: (c) => this._command(c) });
    const stage = this.panel.build();
    const canvas = this.doc.createElement('canvas');
    canvas.className = 'ex-canvas';
    // The list is the accessible version of the canvas (§24.7).
    canvas.setAttribute('aria-hidden', 'true');
    canvas.tabIndex = -1;
    stage.appendChild(canvas);
    this.canvas = new ExplorerCanvas({
      canvas,
      onIntent: (intent) => this._intent(intent),
      theme: this.theme,
      rtl: this.rtl,
      scroll: this.scroll,
      raf: this.options.raf,
      caf: this.options.caf,
      now: this.options.now,
      labels: {
        iconOf: (node) => this._icon(node),
        subOf: (node) => this._sub(node),
        titleOf: (node) => this._label(node),
      },
    });
    this.canvas.attach();
    this.panel.setScroll(this.scroll);
    this.panel.setLens(this.lens);
    this.panel.setPanelOpen(this.panelOpen);
    this.panel.setListMode(false);
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this.doc.addEventListener('keydown', this._onKeyDown, true);
    this.doc.addEventListener('keyup', this._onKeyUp, true);
    this._onResize = () => this._resize();
    if (typeof this.win.ResizeObserver === 'function') {
      this._resizeObserver = new this.win.ResizeObserver(this._onResize);
      this._resizeObserver.observe(stage);
    } else {
      this.win.addEventListener?.('resize', this._onResize);
    }
    this._watchDpr();
    this._resize();
  }

  // A change of devicePixelRatio (the window moved to another monitor)
  // resizes the backing store (§14).
  _watchDpr() {
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    const dpr = this.win.devicePixelRatio || 1;
    this._onDpr = () => {
      this._resize();
      this._watchDpr();
    };
    try {
      this._dprQuery = this.win.matchMedia?.(`(resolution: ${dpr}dppx)`) || null;
      this._dprQuery?.addEventListener?.('change', this._onDpr);
    } catch {
      this._dprQuery = null;
    }
  }

  _resize() {
    const r = this.panel.stage.getBoundingClientRect?.() || {};
    let w = r.width;
    let h = r.height;
    if (!(w > 0 && h > 0)) {
      // Not laid out yet: the window's size, less the panel and toolbar.
      w = Math.max(320, (this.win.innerWidth || 1024) - (this.panelOpen && !this.listMode ? 320 : 0));
      h = Math.max(240, (this.win.innerHeight || 768) - 96);
    }
    this.canvas.resize(w, h, this.win.devicePixelRatio || 1);
  }

  // --- labels ----------------------------------------------------------------------

  _icon(node) {
    if (!node) return '';
    if (node.group === 'overview') return '🧠';
    const icon = itemIcon(node);
    if (!node.private) return icon;
    return node.kind === 'action' ? `${icon}${LOCK}` : LOCK;
  }

  _label(node) {
    if (node?.group === 'overview') return this.t('map.your_map');
    return oneLine(node?.label) || '…';
  }

  _kindName(node) {
    if (node.group === 'overview') return this.t('map.overview');
    return node.group === 'entity' ? etypeLabel(node.kind, this.t) : kindLabel(node.kind, this.t);
  }

  // kind · date · source app (and when it's due), shown above zoom 1.2.
  _sub(node) {
    const t = this.t;
    if (node.group === 'entity') return etypeLabel(node.kind, t);
    if (node.group !== 'item') return '';
    const now = this.mind.now();
    const parts = [kindLabel(node.kind, t)];
    if (Number.isFinite(node.at)) parts.push(fmtDay(node.at, this.locale, { now }));
    if (node.app) parts.push(node.app);
    if (node.kind === 'action' && node.status === 'open' && Number.isFinite(node.dueAt)) parts.push(dueText(node.dueAt, { now, t, locale: this.locale }));
    return parts.filter(Boolean).join(t('chip.sep'));
  }

  // The list option and the announcement for a node: "team: Bingo" or
  // "action: Send the numbers, open, pinned" (map.node / map.node_state).
  _optionLabel(node) {
    const t = this.t;
    const states = [];
    if (node.group === 'item' && node.kind === 'action') {
      if (node.status === 'done') states.push(t('map.state_done'));
      else if (node.suggested) states.push(t('map.state_suggested'));
      else states.push(t('map.state_open'));
    }
    if (node.private) states.push(t('map.state_private'));
    if (node.pinned) states.push(t('explorer.state_pinned'));
    const kind = this._kindName(node);
    const label = this._label(node);
    return states.length ? t('map.node_state', { kind, label, state: states.join(', ') }) : t('map.node', { kind, label });
  }

  _title() {
    const node = this.mind.exNode(this.focus);
    let text;
    if (!node || node.group === 'overview') text = this.t('map.overview');
    // The window title shows in the Dock, taskbar and window switcher.
    else if (node.private) text = this.t('explorer.private_title');
    else text = clipLabel(node.label, PRIVATE_TITLE_MAX) || this.t('map.overview');
    try {
      this.context.view?.setTitle?.(text)?.catch?.(() => {});
    } catch {
      // An older or stub host: no title.
    }
  }

  // --- the scene ---------------------------------------------------------------------

  _build(focus, { origin } = {}) {
    return buildScene(this.mind.port, { focus, hops: 2, cap: SCENE_CAP, pins: this.mind.pins, rtl: this.rtl, lens: this.lens, origin });
  }

  _node(ref) {
    const at = ref ? this.scene?.byRef.get(ref) : undefined;
    return at === undefined ? null : this.scene.nodes[at];
  }

  _setScene(scene, { tweenFrom = null } = {}) {
    this.scene = scene;
    this._sceneSeq += 1;
    this._builtRev = this.mind.rev;
    this.canvas.setScene(scene, { tweenFrom });
    if (this.selected && !scene.byRef.has(this.selected)) this.selected = scene.byRef.has(this.focus) ? this.focus : null;
    this.canvas.setSelection(this.selected);
    if (this.matches) this.canvas.setMatches(this.matches);
    this._renderList();
    this._renderDetails();
    this.panel.setNav({ canBack: this.history.length > 0, atHome: this.focus === 'o' });
  }

  _renderList() {
    if (!this.scene) return;
    const nodes = readingOrder(this.scene);
    this.panel.setList(nodes.map((n) => ({ ref: n.ref, label: this._optionLabel(n) })), this.selected);
  }

  // Rebuilds the same focus and expansions over fresh data, keeping positions.
  _refresh() {
    const prev = this.scene;
    if (!prev) return;
    let next = rebuildScene(prev, this.mind.port, { pins: this.mind.pins, lens: this.lens, hops: 2, cap: SCENE_CAP, max: SCENE_MAX });
    if (next.missing) {
      // The focus is gone (deleted or archived elsewhere): the overview.
      this.focus = 'o';
      next = this._build('o', { origin: centerOf(this.canvas.camera, this.canvas.viewport) });
      this._title();
    }
    this._setScene(next);
    const added = diffScene(prev, next).added;
    if (added.length) this._relax(new Set(added));
  }

  async _relax(free = null) {
    const scene = this.scene;
    const seq = this._sceneSeq;
    if (!scene || scene.nodes.length < 2) return;
    const input = relaxInput(scene, { free, iterations: RELAX_ITERATIONS, budgetMs: RELAX_TIMEOUT_MS - 50 });
    let result;
    try {
      result = typeof this.context.runSandboxed === 'function'
        // One pass off the main thread; on a timeout the seeds stay (§24.4).
        ? await this.context.runSandboxed({ run: relax, data: input, timeoutMs: RELAX_TIMEOUT_MS })
        : relax({ ...input, budgetMs: 60 });
    } catch (error) {
      this.log?.debug?.(`mindmap explorer: layout pass skipped (${error?.name || 'error'})`);
      return;
    }
    // Something moved meanwhile (a drag, a new focus): keep that instead.
    if (this._destroyed || seq !== this._sceneSeq) return;
    this._setScene(applyRelax(scene, result), { tweenFrom: scene });
  }

  _pushHistory(ref) {
    if (!REF_RE.test(String(ref || ''))) return;
    if (this.history[this.history.length - 1] !== ref) this.history.push(ref);
    while (this.history.length > HISTORY_MAX) this.history.shift();
  }

  /** Centres the map on `ref` (Enter, a double click, onOpen, Back, Home). */
  _setFocus(ref, { push = true } = {}) {
    if (!REF_RE.test(String(ref || ''))) return;
    if (!this.mind.exNode(ref)) {
      this.panel.toast(this.t('map.missing'));
      return;
    }
    if (ref === this.focus && this.scene) {
      const f = this._node(ref);
      if (f) this.canvas.setCamera(this.canvas.cameraAt(f.x, f.y), { animate: true });
      this._select(ref);
      return;
    }
    // The new focus starts where it is now, so the camera glides to it.
    const here = this._node(ref) || centerOf(this.canvas.camera, this.canvas.viewport);
    if (push && this.focus) this._pushHistory(this.focus);
    this.focus = ref;
    this.selected = ref;
    this._fullText = null;
    this._setScene(this._build(ref, { origin: { x: here.x, y: here.y } }));
    const f = this.scene.nodes[0];
    this.canvas.setCamera(this.canvas.cameraAt(f.x, f.y), { animate: true });
    this._title();
    this.panel.announce(this.t('explorer.showing', { name: this._focusName() }));
    this._scheduleViewSave();
    this._relax();
  }

  _focusName() {
    const node = this.mind.exNode(this.focus);
    if (!node || node.group === 'overview') return this.t('map.overview');
    return node.private ? this.t('explorer.private_title') : this._label(node);
  }

  _back() {
    while (this.history.length) {
      const ref = this.history.pop();
      if (this.mind.exNode(ref)) {
        this._setFocus(ref, { push: false });
        return;
      }
    }
  }

  _select(ref, { announce = true } = {}) {
    const next = ref && this.scene?.byRef.has(ref) ? ref : null;
    if (next !== this.selected) this._fullText = null;
    this.selected = next;
    this.canvas.setSelection(next);
    this.panel.setListSelection(next);
    this._renderDetails();
    const node = this._node(next);
    if (announce && node) this.panel.announce(this._optionLabel(node));
  }

  // Keeps a node on screen when the keyboard moves the selection to it.
  _reveal(ref) {
    const node = this._node(ref);
    if (!node) return;
    const vp = this.canvas.viewport;
    const s = worldToScreen(this.canvas.camera, node.x, node.y);
    const m = 48;
    if (s.x < m || s.y < m || s.x > vp.width - m || s.y > vp.height - m) this.canvas.setCamera(this.canvas.cameraAt(node.x, node.y), { animate: true });
  }

  _toggleExpand(ref) {
    if (!this._node(ref)) return;
    if (this.scene.expanded.includes(ref)) {
      this._setScene(collapse(this.scene, ref).scene);
      this._renderDetails();
      return;
    }
    const out = expand(this.scene, ref, this.mind.port, { cap: EXPAND_CAP, max: SCENE_MAX, pins: this.mind.pins });
    if (!out.added.length) {
      // i18n-keys: explorer.full, explorer.nothing_more
      this.panel.toast(this.t(out.full ? 'explorer.full' : 'explorer.nothing_more'));
      return;
    }
    if (out.full) this.panel.toast(this.t('explorer.full'));
    this._setScene(out.scene);
    this._relax(new Set(out.added));
  }

  // --- pins and the layout undo stack ----------------------------------------------------

  _pushUndo(entry) {
    this.undoStack.push(entry);
    while (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
  }

  async _savePins(changes) {
    const out = await this.mind.setPins(changes).catch((error) => ({ ok: false, code: error?.code }));
    if (!out.ok) this.panel.toast(out.code === 'unreadable' ? this.t('explorer.layout_unreadable') : this._err(out.code));
    return out;
  }

  // A node dropped after a drag: it stays there (pinned) and syncs as a pin.
  _moved({ ref, x, y, from }) {
    const node = this._node(ref);
    if (!node) return;
    this._pushUndo({ ref, before: { pinned: !!node.pinned, x: Number.isFinite(from?.x) ? from.x : node.x, y: Number.isFinite(from?.y) ? from.y : node.y } });
    this._setScene(moveNode(this.scene, ref, x, y, { pinned: true }));
    this._savePins({ [ref]: { x: Math.round(x), y: Math.round(y) } });
  }

  _togglePin(ref) {
    const node = this._node(ref);
    if (!node) return;
    this._pushUndo({ ref, before: { pinned: !!node.pinned, x: node.x, y: node.y } });
    const pinned = !node.pinned;
    this._setScene(moveNode(this.scene, ref, node.x, node.y, { pinned }));
    // i18n-keys: explorer.pinned, explorer.unpinned
    this.panel.announce(this.t(pinned ? 'explorer.pinned' : 'explorer.unpinned'));
    this._savePins({ [ref]: pinned ? { x: node.x, y: node.y } : null });
  }

  _undoLayout() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const { ref, before } = entry;
    if (this._node(ref)) this._setScene(moveNode(this.scene, ref, before.x, before.y, { pinned: before.pinned }));
    this.panel.announce(this.t('explorer.layout_undone'));
    this._savePins({ [ref]: before.pinned ? { x: before.x, y: before.y } : null });
  }

  // --- input -----------------------------------------------------------------------------

  _intent(intent) {
    switch (intent?.type) {
      case 'select': this._select(intent.ref); break;
      case 'focus': this._setFocus(intent.ref); break;
      case 'expand': this._toggleExpand(intent.ref); break;
      case 'move': this._moved(intent); break;
      case 'camera': this._scheduleViewSave(); break;
      default: break;
    }
  }

  _keyDown(e) {
    if (this._destroyed || !this.scene) return;
    const target = e.target;
    const editing = isEditable(target);
    const inList = target === this.panel.list;
    if (e.key === ' ' && !editing && !isButton(target) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (!e.repeat) this.canvas.spaceDown();
      return;
    }
    if (inList && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const ref = this.panel.listNeighbour(this.selected, e.key === 'ArrowUp' ? -1 : 1);
      if (ref) {
        this._select(ref);
        this._reveal(ref);
      }
      return;
    }
    // A focused button handles its own Enter.
    if (isButton(target) && e.key === 'Enter') return;
    const intent = keyIntent(e, { selected: this.selected, editing });
    if (!intent) return;
    e.preventDefault();
    switch (intent.type) {
      case 'search': this.panel.focusSearch(); break;
      case 'escape': this._escape(target); break;
      case 'undoLayout': this._undoLayout(); break;
      case 'zoom': this.canvas.zoomBy(intent.factor); break;
      case 'fit': this.canvas.setCamera(this.canvas.fitCamera(), { animate: true }); break;
      case 'pan': this.canvas.panBy(intent.dx, intent.dy); break;
      case 'step': {
        const from = this._node(this.selected);
        const ref = nearestInDirection(this.scene.nodes, from, intent.dir);
        if (ref) {
          this._select(ref);
          this._reveal(ref);
        }
        break;
      }
      case 'focus': this._setFocus(intent.ref); break;
      case 'pin': this._togglePin(intent.ref); break;
      default: break;
    }
  }

  _keyUp(e) {
    if (this._destroyed || e.key !== ' ') return;
    if (this.canvas.spaceUp() && this.selected && !isEditable(e.target)) this._toggleExpand(this.selected);
  }

  _escape(target) {
    if (this.panel.searchText || this.matches) {
      this.panel.setSearchValue('');
      this._runSearch('');
      if (target === this.panel.search) this.panel.list.focus?.();
      return;
    }
    if (isEditable(target)) {
      target.blur?.();
      return;
    }
    this._select(null);
  }

  // --- search (`/` or ⌘/Ctrl+F) ----------------------------------------------------------

  _runSearch(text, { lens = false } = {}) {
    const q = oneLine(text).slice(0, QUERY_MAX);
    if (!q) {
      this.matches = null;
      this.searchHits = [];
      this.canvas.setMatches(null);
      this.panel.setHits([]);
      return;
    }
    const mind = this.mind;
    const spec = mind.parse(q, { trailingSpace: true });
    // A query from the launcher (`kind:doc @bingo`) is also a lens (§24.2).
    if (lens && spec.kinds?.length && /(?<!\S)kind:/i.test(q)) {
      this.lens = normalizeLens({ ...this.lens, kinds: [...spec.kinds] });
      this.panel.setLens(this.lens);
      this._refresh();
    }
    // `@bingo` puts Bingo first; a name met in plain words ("mtcs design")
    // comes after the notes that match.
    const refs = [];
    const add = (ref) => {
      if (ref && !refs.includes(ref)) refs.push(ref);
    };
    const names = (spec.entities || []).map((e) => ({ e, entity: mind.entity(e.entityId) })).filter((x) => x.entity);
    for (const { e, entity } of names) if (e.hard) add(entity.id);
    for (const hit of mind.find(spec, { limit: SEARCH_LIMIT }).hits) add(hit.item.id);
    for (const { e, entity } of names) if (!e.hard && e.via === 'dict') add(entity.id);
    this.searchHits = refs;
    this.matches = new Set(refs);
    this.canvas.setMatches(this.matches);
    const shown = refs.slice(0, HITS_SHOWN).map((ref) => mind.exNode(ref)).filter(Boolean);
    this.panel.setHits(shown.length ? shown.map((n) => ({ ref: n.ref, icon: this._icon(n), label: clipLabel(this._label(n), 60) })) : null);
    this.panel.announce(this.t('explorer.hits', { n: refs.length }));
  }

  _search(text) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = this._later(() => {
      this._searchTimer = null;
      this._runSearch(text);
    }, SEARCH_MS);
  }

  // --- commands from the panel and toolbar -------------------------------------------------

  _command(c) {
    const ref = c?.ref;
    switch (c?.type) {
      case 'back': this._back(); break;
      case 'home': this._setFocus('o'); break;
      case 'fit': this.canvas.setCamera(this.canvas.fitCamera(), { animate: true }); break;
      case 'zoom': this.canvas.zoomBy(c.factor); break;
      case 'scroll': this._setScrollMode(this.scroll === 'pan' ? 'zoom' : 'pan'); break;
      case 'list': this._setListMode(!this.listMode); break;
      case 'panel': this._setPanelOpen(!this.panelOpen); break;
      case 'lens': this._toggleLens(c); break;
      case 'search': this._search(c.text); break;
      case 'searchSubmit': this._submitSearch(c.text); break;
      case 'select': this._select(ref); break;
      case 'focus': this._setFocus(ref); break;
      case 'expand': this._toggleExpand(ref); break;
      case 'pin': this._togglePin(ref); break;
      case 'open': return this._open(ref);
      case 'ask': return this._ask(ref);
      case 'capture': return this._capture(c.text);
      case 'done':
      case 'reopen':
      case 'accept':
      case 'dismiss':
      case 'private':
      case 'share': return this._dataOp(c.type, ref);
      default: break;
    }
    return undefined;
  }

  _submitSearch(text) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._runSearch(text);
    const first = this.searchHits[0];
    if (first) this._setFocus(first);
  }

  _setScrollMode(mode) {
    this.scroll = mode;
    this.canvas.setScrollMode(mode);
    this.panel.setScroll(mode);
    this._scheduleViewSave();
  }

  _setListMode(on) {
    this.listMode = !!on;
    this.panel.setListMode(this.listMode);
    if (this.listMode) this.panel.list.focus?.();
    this._resize();
  }

  _setPanelOpen(on) {
    this.panelOpen = !!on;
    this.panel.setPanelOpen(this.panelOpen);
    this._resize();
    this._scheduleViewSave();
  }

  _toggleLens(c) {
    const lens = { ...this.lens };
    if (c.kind) {
      const kinds = new Set(lens.kinds || LENS_KINDS);
      if (kinds.has(c.kind)) kinds.delete(c.kind);
      else kinds.add(c.kind);
      // Keep at least one kind: with none, the map would hold names only.
      if (!kinds.size) return;
      lens.kinds = LENS_KINDS.filter((k) => kinds.has(k));
    }
    if (c.mine) lens.mine = !lens.mine;
    if (c.done) lens.done = !lens.done;
    this.lens = normalizeLens(lens);
    this.panel.setLens(this.lens);
    this._refresh();
    this._scheduleViewSave();
  }

  // Data changes through the Mind, each with an Undo toast (mind.undo).
  async _dataOp(type, ref) {
    const mind = this.mind;
    if (!mind.item(ref)) return;
    const run = {
      done: () => mind.setStatus(ref, 'done'),
      reopen: () => mind.setStatus(ref, 'open'),
      accept: () => mind.accept(ref),
      dismiss: () => mind.dismiss(ref),
      private: () => mind.setPrivate(ref, true),
      share: () => mind.setPrivate(ref, false),
    }[type];
    if (!run) return;
    const out = await run().catch((error) => ({ ok: false, code: error?.code }));
    if (this._destroyed) return;
    if (!out?.ok) {
      this.panel.toast(this._err(out?.code));
      return;
    }
    this._refresh();
    // i18n-keys: card.op_done, card.op_reopened, card.op_accepted, card.op_dismissed, card.op_private, card.op_shared
    const head = { done: 'card.op_done', reopen: 'card.op_reopened', accept: 'card.op_accepted', dismiss: 'card.op_dismissed', private: 'card.op_private', share: 'card.op_shared' }[type];
    this.panel.toast(this.t(head), { onUndo: () => this._undoData(out.opId) });
  }

  async _undoData(opId) {
    const out = await this.mind.undo(opId).catch((error) => ({ ok: false, code: error?.code }));
    if (this._destroyed) return;
    if (!out.ok) {
      this.panel.toast(this._err(out.code));
      return;
    }
    this._refresh();
    this.panel.toast(this.t('card.op_undone'));
  }

  // Links open in the browser; a path is copied (Mind Map has no `launch`);
  // a note shows its whole text in the panel (§24.5).
  async _open(ref) {
    const item = this.mind.item(ref);
    if (!item) return;
    if (isHttp(item.url)) {
      try {
        await this.context.invoke('open_url', { url: item.url });
      } catch {
        this.panel.toast(this.t('err.generic'));
      }
      return;
    }
    if (item.path) {
      try {
        await this.context.view?.copyText?.(item.path);
        this.panel.toast(this.t('explorer.path_copied'));
      } catch {
        this.panel.toast(this.t('explorer.copy_failed'));
      }
      return;
    }
    this._fullText = ref;
    this._renderDetails();
  }

  /**
   * Ask your agent about a node: fills the launcher with `mm? …`, never
   * sends (context.view.compose). Private items, private names, and items
   * that mention a private name never go into that text (§24.6).
   */
  async _ask(ref) {
    const mind = this.mind;
    const item = mind.item(ref);
    const entity = item ? null : mind.entity(ref);
    const hidden = item ? mind.isHidden(item) : !entity || !!entity.private;
    if (hidden) {
      this.panel.toast(this.t('explorer.ask_private'));
      return;
    }
    const name = item ? item.title : entity.id === 'me' ? this.t('card.me') : entity.name;
    const text = `${triggerOf(this.config)}? ${this.t('explorer.ask_about', { title: clipLabel(name, 120) })}`;
    try {
      await this.context.view?.compose?.(text);
    } catch {
      this.panel.toast(this.t('err.generic'));
    }
  }

  async _capture(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return;
    const out = await this.mind.capture(text, { via: 'explorer' }).catch((error) => ({ code: error?.code || 'generic' }));
    if (this._destroyed) return;
    if (out.code) {
      this.panel.toast(this._err(out.code));
      return;
    }
    this.panel.addInput.value = '';
    this._refresh();
    if (this._node(out.itemId)) this._select(out.itemId);
    const title = clipLabel(this.mind.item(out.itemId)?.title || '', 60);
    this.panel.toast(this.t('explorer.saved', { title }), { onUndo: () => this._undoData(out.opId) });
  }

  _err(code) {
    const known = new Set(['readonly', 'busy', 'conflict', 'io', 'empty', 'not_found', 'not_action', 'noop', 'unreadable', 'future_schema',
      'superseded', 'already_undone', 'missing', 'nothing', 'too_large']);
    if (!known.has(code)) return this.t('err.generic');
    // i18n-keys: err.*
    return ['superseded', 'already_undone', 'missing', 'nothing', 'too_large'].includes(code) ? this.t(`err.undo_${code}`) : this.t(`err.${code}`);
  }

  // --- the details panel ---------------------------------------------------------------------

  _renderDetails() {
    const node = this._node(this.selected);
    if (!node) {
      this.panel.showDetails(null);
      return;
    }
    const t = this.t;
    const mind = this.mind;
    const now = mind.now();
    const badges = [];
    if (node.private) badges.push(t('card.private_badge'));
    if (node.suggested) badges.push(t('card.suggested'));
    if (node.pinned) badges.push(`📌 ${t('explorer.pinned')}`);
    const buttons = [];
    // i18n-keys: explorer.collapse, explorer.expand, explorer.unpin, explorer.pin
    const common = () => {
      if (!node.focus) buttons.push({ type: 'focus', label: t('explorer.focus_here') });
      buttons.push({ type: 'expand', label: t(this.scene.expanded.includes(node.ref) ? 'explorer.collapse' : 'explorer.expand') });
      buttons.push({ type: 'pin', label: t(node.pinned ? 'explorer.unpin' : 'explorer.pin') });
    };
    if (node.group === 'overview') {
      const counts = node.counts || {};
      const meta = [counts.items ? t('map.count_items', { n: counts.items }) : '', counts.entities ? t('map.count_entities', { n: counts.entities }) : ''].filter(Boolean).join(t('chip.sep'));
      common();
      this.panel.showDetails({ ref: node.ref, icon: '🧠', title: t('map.your_map'), meta, badges, buttons });
      return;
    }
    if (node.group === 'entity') {
      const summary = mind.entitySummary(node.ref);
      const c = summary?.counts || {};
      const parts = [etypeLabel(node.kind, t)];
      if (c.openActions) parts.push(t('map.count_actions', { n: c.openActions }));
      if (c.suggested) parts.push(t('map.count_suggested', { n: c.suggested }));
      if (c.docs) parts.push(t('map.count_docs', { n: c.docs }));
      if (c.notes) parts.push(t('map.count_notes', { n: c.notes }));
      buttons.push({ type: 'ask', label: t('explorer.ask'), disabled: !!node.private, title: node.private ? t('explorer.ask_private') : undefined });
      common();
      this.panel.showDetails({ ref: node.ref, icon: this._icon(node), title: this._label(node), meta: parts.join(t('chip.sep')), badges, buttons });
      return;
    }
    const vm = mind.port.item(node.ref);
    if (!vm) {
      this.panel.showDetails(null);
      return;
    }
    const meta = [kindLabel(vm.kind, t), fmtDay(vm.day, this.locale, { now })];
    if (vm.app) meta.push(vm.app);
    if (vm.kind === 'action') {
      if (vm.status === 'done' && vm.doneAt) meta.push(doneText(vm.doneAt, { t, locale: this.locale, now }));
      else if (vm.dueAt && vm.status !== 'done') meta.push(dueText(vm.dueAt, { now, t, locale: this.locale }));
      if (vm.owner?.name) meta.push(t('card.owner', { name: vm.owner.name }));
      if (vm.suggested && vm.status === 'open') {
        buttons.push({ type: 'accept', label: t('card.accept'), primary: true });
        buttons.push({ type: 'dismiss', label: t('card.not_action') });
      } else if (vm.status === 'done') {
        buttons.push({ type: 'reopen', label: t('card.reopen') });
      } else {
        buttons.push({ type: 'done', label: t('card.done'), primary: true });
        buttons.push({ type: 'dismiss', label: t('card.not_action') });
      }
    }
    const text = [vm.summary && oneLine(vm.summary) !== oneLine(vm.text) ? vm.summary : '', vm.text].filter(Boolean).join('\n\n');
    if (isHttp(vm.url)) buttons.push({ type: 'open', label: t('card.open'), primary: vm.kind !== 'action' });
    else if (vm.path) buttons.push({ type: 'open', label: t('explorer.copy_path') });
    else if (text.length > 600 && this._fullText !== node.ref) buttons.push({ type: 'open', label: t('card.open') });
    const hidden = mind.isHidden(mind.item(node.ref));
    buttons.push({ type: 'ask', label: t('explorer.ask'), disabled: hidden, title: hidden ? t('explorer.ask_private') : undefined });
    common();
    buttons.push(vm.private ? { type: 'share', label: t('card.make_shareable') } : { type: 'private', label: t('card.make_private') });
    const entities = (vm.entities || []).map((e) => ({ ref: e.id, label: `${e.private ? LOCK : ETYPE_ICONS[e.type] || '•'} ${clipLabel(e.name, 32)}` }));
    this.panel.showDetails({
      ref: node.ref,
      icon: this._icon(node),
      title: oneLine(vm.title) || '…',
      meta: meta.filter(Boolean).join(t('chip.sep')),
      text,
      full: this._fullText === node.ref,
      where: vm.url || vm.path || '',
      badges,
      entities,
      buttons,
    });
  }

  // --- mm-view (this computer's camera, focus and lenses) -------------------------------------

  // At most one write every 2 s while the user pans or zooms (§24.5).
  _scheduleViewSave() {
    if (this._viewTimer || this._destroyed) return;
    this._viewTimer = this._later(() => this._saveView(), VIEW_SAVE_MS);
  }

  _saveView() {
    if (this._viewTimer) clearTimeout(this._viewTimer);
    this._timers.delete(this._viewTimer);
    this._viewTimer = null;
    if (!this.canvas) return Promise.resolve();
    const centre = centerOf(this.canvas.camera, this.canvas.viewport);
    return this.mind.saveView({
      camera: { x: centre.x, y: centre.y, zoom: this.canvas.camera.zoom },
      focus: this.focus,
      history: this.history,
      lens: this.lens,
      scroll: this.scroll,
      panelOpen: this.panelOpen,
    }).catch((error) => this.log?.debug?.(`mindmap explorer: view state not saved (${error?.code || 'error'})`));
  }

  // --- changes from other windows (§10, §24.5) ------------------------------------------------

  _subscribe() {
    const storage = this.context.storage;
    if (typeof storage?.onChanged !== 'function') return;
    try {
      const off = storage.onChanged((changes) => this._onChanges(changes));
      this._offStorage = typeof off === 'function' ? off : null;
    } catch {
      this._offStorage = null;
    }
  }

  _onChanges(changes) {
    let data = false;
    let layout = false;
    for (const change of Array.isArray(changes) ? changes : []) {
      // Our own writes are already on screen.
      if (!change || change.self) continue;
      if (change.key === 'mm-meta' || change.key === '*') data = true;
      if (change.key === 'mm-layout' || change.key === '*') layout = true;
    }
    if (data || layout) this._queueChange({ data, layout });
  }

  // Several events in a row become one sync, one rebuild and one redraw.
  _queueChange({ data, layout }) {
    this._pending = { data: !!(this._pending?.data || data), layout: !!(this._pending?.layout || layout) };
    if (!this._changeRun) this._changeRun = this._applyChanges().finally(() => { this._changeRun = null; });
    return this._changeRun;
  }

  async _applyChanges() {
    await Promise.resolve();
    while (this._pending && !this._destroyed) {
      const { data, layout } = this._pending;
      this._pending = null;
      if (data) await this.mind.syncIfStale(0).catch(() => false);
      if (layout) await this.mind.loadLayout({ force: true }).catch(() => null);
      if (this._destroyed || !this.scene) return;
      if (layout || this.mind.rev !== this._builtRev) this._refresh();
    }
  }

  /** Resolves once queued change events have been applied (tests). */
  whenSettled() {
    return this._changeRun || Promise.resolve();
  }
}
