// The map explorer's DOM: toolbar, search, lenses, the ＋ Add box, the
// details panel, the accessible node list and the toast (EXTENSION_VIEWS
// §24.5, §24.7).
//
// Composer: it imports nothing. Strings come from `t`, and view.js helpers
// (icons, kind and type names, dates) are injected by explorer.js, because
// a composer can't import another composer (ARCHITECTURE §1). Everything is
// built with createElement and textContent, never from HTML strings, so no
// user text is ever parsed as markup. Classes are `ex-` prefixed.
//
// The panel only reports what the user did, as commands for explorer.js:
// onCommand({ type, ...}).

const TOAST_MS = 6000;
const TEXT_SHOWN = 600;
export const LENS_KINDS = Object.freeze(['note', 'link', 'doc', 'action', 'meeting']);
// i18n-keys: kind.notes, kind.links, kind.docs, kind.actions, kind.meetings
const LENS_LABEL = Object.freeze({ note: 'kind.notes', link: 'kind.links', doc: 'kind.docs', action: 'kind.actions', meeting: 'kind.meetings' });

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'className') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

export class ExplorerPanel {
  /**
   * opts = { root, t, helpers: { iconOf(node), kindName(node) }, rtl, onCommand,
   *   canAddFile (Kage reads files for Mind Map here: the toolbar's "Add a file…") }
   */
  constructor({ root, t, helpers = {}, rtl = false, onCommand, canAddFile = false } = {}) {
    this.root = root;
    this.doc = root.ownerDocument;
    this.t = typeof t === 'function' ? t : (key) => key;
    this.helpers = helpers;
    this.rtl = !!rtl;
    this.canAddFile = !!canAddFile;
    this.onCommand = typeof onCommand === 'function' ? onCommand : () => {};
    this._toastTimer = null;
    this._options = [];
    this._optionSeq = 0;
    this._hits = [];
  }

  _cmd(type, extra = {}) {
    this.onCommand({ type, ...extra });
  }

  _button(label, type, { cls = 'ex-btn', title, extra, pressed } = {}) {
    const b = el(this.doc, 'button', { type: 'button', className: cls, text: label, title, 'aria-pressed': pressed === undefined ? undefined : String(!!pressed) });
    b.addEventListener('click', () => this._cmd(type, typeof extra === 'function' ? extra() : extra || {}));
    return b;
  }

  /** Builds the whole layout. → the stage element the canvas goes in. */
  build() {
    const { doc, t } = this;
    const app = el(doc, 'div', { className: 'ex-app', dir: this.rtl ? 'rtl' : 'ltr', role: 'region', 'aria-label': t('explorer.aria') });
    this.app = app;

    // Toolbar.
    this.backBtn = this._button(`${this.rtl ? '→' : '←'} ${t('map.back')}`, 'back', { title: t('explorer.back_tip') });
    this.homeBtn = this._button(`⌂ ${t('map.home')}`, 'home');
    const fitBtn = this._button(t('explorer.fit'), 'fit', { title: t('explorer.fit_tip') });
    const outBtn = this._button('−', 'zoom', { cls: 'ex-btn ex-icon', title: t('explorer.zoom_out'), extra: { factor: 0.8 } });
    outBtn.setAttribute('aria-label', t('explorer.zoom_out'));
    const inBtn = this._button('＋', 'zoom', { cls: 'ex-btn ex-icon', title: t('explorer.zoom_in'), extra: { factor: 1.25 } });
    inBtn.setAttribute('aria-label', t('explorer.zoom_in'));
    this.scrollBtn = this._button('', 'scroll', { title: t('explorer.scroll_tip') });
    this.listBtn = this._button(`☰ ${t('map.list')}`, 'list', { pressed: false });
    this.panelBtn = this._button(t('explorer.details'), 'panel', { pressed: true });
    const nav = el(doc, 'div', { className: 'ex-group' }, [this.backBtn, this.homeBtn]);
    const zoom = el(doc, 'div', { className: 'ex-group' }, [outBtn, fitBtn, inBtn, this.scrollBtn]);
    const modes = el(doc, 'div', { className: 'ex-group' }, [this.listBtn, this.panelBtn]);

    // Search.
    this.search = el(doc, 'input', { type: 'search', className: 'ex-search', placeholder: t('explorer.search_placeholder'), 'aria-label': t('explorer.search_label'), autocomplete: 'off', spellcheck: 'false' });
    this.search.addEventListener('input', () => this._cmd('search', { text: this.search.value }));
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._cmd('searchSubmit', { text: this.search.value });
      }
    });
    this.hitsList = el(doc, 'ul', { className: 'ex-hits', role: 'list', hidden: true });
    const searchBox = el(doc, 'div', { className: 'ex-searchbox' }, [this.search, this.hitsList]);

    // Lenses.
    this.lensButtons = new Map();
    const lenses = el(doc, 'div', { className: 'ex-lenses', role: 'group', 'aria-label': t('explorer.lens_label') });
    for (const kind of LENS_KINDS) {
      const b = this._button(t(LENS_LABEL[kind]), 'lens', { cls: 'ex-chip', extra: { kind }, pressed: true });
      this.lensButtons.set(kind, b);
      lenses.appendChild(b);
    }
    this.mineBtn = this._button(t('explorer.lens_mine'), 'lens', { cls: 'ex-chip', extra: { mine: true }, pressed: false });
    this.doneBtn = this._button(t('explorer.lens_done'), 'lens', { cls: 'ex-chip', extra: { done: true }, pressed: false });
    lenses.appendChild(this.mineBtn);
    lenses.appendChild(this.doneBtn);

    // ＋ Add.
    this.addInput = el(doc, 'input', { type: 'text', className: 'ex-add-input', placeholder: t('explorer.add_placeholder'), 'aria-label': t('explorer.add_label'), autocomplete: 'off' });
    const addBtn = this._button(`＋ ${t('explorer.add')}`, 'capture', { extra: () => ({ text: this.addInput.value }) });
    this.addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._cmd('capture', { text: this.addInput.value });
      }
    });
    // "📄 Add a file…" (Kage EXTENSION_FILE_TEXT §11.2 C11): the click opens
    // Kage's file dialog, so it is a plain button, never a key shortcut.
    this.fileBtn = this.canAddFile ? this._button(`📄 ${t('files.row.add')}`, 'addFile', { title: t('files.row.add_sub') }) : null;
    const add = el(doc, 'div', { className: 'ex-add' }, [this.addInput, addBtn, this.fileBtn]);

    const toolbar = el(doc, 'div', { className: 'ex-toolbar', role: 'toolbar', 'aria-label': t('explorer.toolbar') }, [nav, zoom, searchBox, modes]);
    const strip = el(doc, 'div', { className: 'ex-strip' }, [lenses, add]);

    // Stage, list and panel.
    this.stage = el(doc, 'div', { className: 'ex-stage' });
    this.list = el(doc, 'ul', { className: 'ex-list', role: 'listbox', tabindex: '0', 'aria-label': t('explorer.list_label') });
    this.list.addEventListener('click', (e) => {
      const li = e.target?.closest?.('li[data-ref]');
      if (li) this._cmd('select', { ref: li.getAttribute('data-ref'), from: 'list' });
    });
    this.list.addEventListener('dblclick', (e) => {
      const li = e.target?.closest?.('li[data-ref]');
      if (li) this._cmd('focus', { ref: li.getAttribute('data-ref') });
    });
    // The panel sits on the start side (left, or right in RTL languages).
    this.panel = el(doc, 'aside', { className: 'ex-panel', 'aria-label': t('explorer.details') });
    const body = el(doc, 'div', { className: 'ex-body' }, [this.panel, this.stage, this.list]);

    this.toastBox = el(doc, 'div', { className: 'ex-toast', role: 'status', hidden: true });
    this.live = el(doc, 'div', { className: 'ex-sr', 'aria-live': 'polite' });

    app.appendChild(toolbar);
    app.appendChild(strip);
    app.appendChild(body);
    app.appendChild(this.toastBox);
    app.appendChild(this.live);
    this.root.appendChild(app);
    this.showDetails(null);
    return this.stage;
  }

  // --- toolbar state ----------------------------------------------------------

  setNav({ canBack, atHome }) {
    this.backBtn.disabled = !canBack;
    this.homeBtn.disabled = !!atHome;
  }

  setScroll(mode) {
    this.scrollBtn.textContent = mode === 'pan' ? this.t('explorer.scroll_pans') : this.t('explorer.scroll_zooms');
  }

  setListMode(on) {
    this.app.classList.toggle('ex-mode-list', !!on);
    this.listBtn.setAttribute('aria-pressed', String(!!on));
    this.listBtn.textContent = on ? `◎ ${this.t('map.map')}` : `☰ ${this.t('map.list')}`;
  }

  setPanelOpen(on) {
    this.app.classList.toggle('ex-panel-closed', !on);
    this.panelBtn.setAttribute('aria-pressed', String(!!on));
  }

  setLens(lens) {
    for (const [kind, b] of this.lensButtons) b.setAttribute('aria-pressed', String(!lens?.kinds || lens.kinds.includes(kind)));
    this.mineBtn.setAttribute('aria-pressed', String(!!lens?.mine));
    this.doneBtn.setAttribute('aria-pressed', String(!!lens?.done));
  }

  // --- search -------------------------------------------------------------------

  focusSearch() {
    this.search.focus();
    this.search.select?.();
  }

  setSearchValue(text) {
    this.search.value = String(text ?? '');
  }

  get searchText() {
    return this.search.value;
  }

  /** Hits under the search box: [{ ref, icon, label }] (empty hides it); null for "nothing matches". */
  setHits(hits) {
    const { doc } = this;
    this.hitsList.textContent = '';
    this._hits = Array.isArray(hits) ? hits : [];
    if (hits === null) {
      this.hitsList.appendChild(el(doc, 'li', { className: 'ex-muted', text: this.t('explorer.no_hits') }));
      this.hitsList.hidden = false;
      return;
    }
    if (!this._hits.length) {
      this.hitsList.hidden = true;
      return;
    }
    for (const hit of this._hits) {
      const b = el(doc, 'button', { type: 'button', className: 'ex-hit', text: `${hit.icon ? `${hit.icon} ` : ''}${hit.label}` });
      b.addEventListener('click', () => this._cmd('focus', { ref: hit.ref }));
      this.hitsList.appendChild(el(doc, 'li', {}, [b]));
    }
    this.hitsList.hidden = false;
  }

  // --- details ----------------------------------------------------------------------

  /**
   * detail = null | { ref, icon, title, meta, text, full, where, badges: string[],
   *   entities: [{ ref, label }], buttons: [{ type, label, primary?, disabled?, title?, extra? }],
   *   doc? }
   * doc: a picked document's text, a part at a time: { status, parts: [{ label?, text }],
   *   canPrev, canNext } or { note } (loading, or the text isn't on this computer).
   */
  showDetails(detail) {
    const { doc, t } = this;
    this.panel.textContent = '';
    if (!detail) {
      this.panel.appendChild(el(doc, 'p', { className: 'ex-muted', text: t('explorer.panel_empty') }));
      return;
    }
    const head = el(doc, 'div', { className: 'ex-head' }, [
      detail.icon ? el(doc, 'span', { className: 'ex-hicon', 'aria-hidden': 'true', text: detail.icon }) : null,
      el(doc, 'strong', { className: 'ex-title', text: detail.title || '…' }),
    ]);
    this.panel.appendChild(head);
    if (detail.meta) this.panel.appendChild(el(doc, 'div', { className: 'ex-meta', text: detail.meta }));
    if (detail.badges?.length) {
      this.panel.appendChild(el(doc, 'div', { className: 'ex-badges' }, detail.badges.map((b) => el(doc, 'span', { className: 'ex-badge', text: b }))));
    }
    const text = String(detail.text || '');
    if (detail.doc) this._docText(detail);
    else if (text) {
      const shown = detail.full || text.length <= TEXT_SHOWN ? text : `${text.slice(0, TEXT_SHOWN).trimEnd()}…`;
      this.panel.appendChild(el(doc, 'div', { className: 'ex-text', text: shown }));
    }
    if (detail.where) this.panel.appendChild(el(doc, 'div', { className: 'ex-where', dir: 'ltr', title: detail.where, text: detail.where }));
    if (detail.entities?.length) {
      const chips = el(doc, 'div', { className: 'ex-chips' });
      for (const e of detail.entities) {
        const b = el(doc, 'button', { type: 'button', className: 'ex-chip', text: e.label });
        b.addEventListener('click', () => this._cmd('focus', { ref: e.ref }));
        chips.appendChild(b);
      }
      this.panel.appendChild(chips);
    }
    if (detail.buttons?.length) {
      const row = el(doc, 'div', { className: 'ex-actions' });
      for (const spec of detail.buttons) {
        const b = el(doc, 'button', { type: 'button', className: spec.primary ? 'ex-btn ex-primary' : 'ex-btn', text: spec.label, title: spec.title, disabled: !!spec.disabled });
        b.setAttribute('data-cmd', spec.type);
        b.addEventListener('click', () => {
          if (!b.disabled) this._cmd(spec.type, { ref: detail.ref, ...(spec.extra || {}) });
        });
        row.appendChild(b);
      }
      this.panel.appendChild(row);
    }
  }

  // A document's text, one part at a time, with "p. 4" where pages start.
  _docText(detail) {
    const { doc, t } = this;
    const d = detail.doc;
    if (d.note) {
      this.panel.appendChild(el(doc, 'p', { className: 'ex-muted', role: 'status', text: d.note }));
      return;
    }
    if (d.status) this.panel.appendChild(el(doc, 'div', { className: 'ex-meta', text: d.status }));
    const box = el(doc, 'div', { className: 'ex-text', dir: 'auto' });
    for (const part of d.parts || []) {
      if (part.label) box.appendChild(el(doc, 'span', { className: 'ex-badge', text: part.label }));
      box.appendChild(doc.createTextNode(String(part.text ?? '')));
    }
    this.panel.appendChild(box);
    if (d.canPrev || d.canNext) {
      const prev = el(doc, 'button', { type: 'button', className: 'ex-btn', text: t('files.text.prev'), disabled: !d.canPrev });
      const next = el(doc, 'button', { type: 'button', className: 'ex-btn', text: t('files.text.next'), disabled: !d.canNext });
      prev.addEventListener('click', () => this._cmd('docPrev', { ref: detail.ref }));
      next.addEventListener('click', () => this._cmd('docNext', { ref: detail.ref }));
      this.panel.appendChild(el(doc, 'div', { className: 'ex-actions' }, [prev, next]));
    }
  }

  // --- the accessible list -------------------------------------------------------------

  /** options = [{ ref, label }] in reading order; `selected` is a ref. */
  setList(options, selected) {
    const { doc } = this;
    this.list.textContent = '';
    this._options = [];
    const prefix = `ex-o${(++this._optionSeq).toString(36)}-`;
    options.forEach((opt, i) => {
      const id = `${prefix}${i}`;
      const li = el(doc, 'li', { id, role: 'option', 'aria-selected': String(opt.ref === selected), text: opt.label });
      li.setAttribute('data-ref', opt.ref);
      if (opt.ref === selected) li.className = 'ex-on';
      this._options.push({ ref: opt.ref, id, li });
      this.list.appendChild(li);
    });
    this.setListSelection(selected);
  }

  setListSelection(ref) {
    let active = null;
    for (const opt of this._options) {
      const on = opt.ref === ref;
      opt.li.setAttribute('aria-selected', String(on));
      opt.li.className = on ? 'ex-on' : '';
      if (on) active = opt;
    }
    if (active) {
      this.list.setAttribute('aria-activedescendant', active.id);
      active.li.scrollIntoView?.({ block: 'nearest' });
    } else this.list.removeAttribute('aria-activedescendant');
  }

  /** The ref `step` places from `ref` in list order (-1 / +1), or null. */
  listNeighbour(ref, step) {
    const at = this._options.findIndex((o) => o.ref === ref);
    const next = this._options[at < 0 ? 0 : Math.min(this._options.length - 1, Math.max(0, at + step))];
    return next ? next.ref : null;
  }

  get listRefs() {
    return this._options.map((o) => o.ref);
  }

  announce(text) {
    // Clear first so the same words twice are read twice.
    this.live.textContent = '';
    this.live.textContent = String(text || '');
  }

  /** A short message, optionally with an Undo button (onUndo). */
  toast(text, { onUndo, ms = TOAST_MS } = {}) {
    const { doc } = this;
    this.toastBox.textContent = '';
    this.toastBox.appendChild(el(doc, 'span', { text }));
    if (typeof onUndo === 'function') {
      const b = el(doc, 'button', { type: 'button', className: 'ex-btn', text: this.t('card.undo') });
      b.addEventListener('click', () => {
        this.hideToast();
        onUndo();
      });
      this.toastBox.appendChild(b);
    }
    this.toastBox.hidden = false;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.hideToast(), ms);
  }

  hideToast() {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    if (this.toastBox) this.toastBox.hidden = true;
  }

  destroy() {
    this.hideToast();
    this.app?.remove?.();
  }
}
