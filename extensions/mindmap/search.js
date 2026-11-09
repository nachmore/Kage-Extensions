// Mind Map's launcher: `mm` (find, browse, commands), `mm+` (capture) and
// `mm?` (ask your agent). Entry module: it may import composers.
//
// Every row id is a fixed string or `mm:i:<itemId>` / `mm:e:<entityId>`:
// the host stores result ids in frecency, so they never carry user text
// (SPEC §6.1). Row `data` follows ARCHITECTURE §7.1.
//
// match() is synchronous and serves the in-memory snapshot (which may be
// up to ~1.5 s stale); matchAsync() syncs first and supplies fresh rows,
// or [] when they would be identical (the host then keeps match()'s rows).

import { getMind } from './mind.js';
import { KIND_ICONS, ETYPE_ICONS, applyUiAction, boundAction, doneText, dueText, etypeLabel, exploreRef, fmtDay, interpLabel, itemIcon, kindLabel, parseAction, ui } from './view.js';
import { DEFAULTS, LIMITS, triggerOf } from './defaults.js';

// view.js resolves these through an alias of t() (dueText, doneText, rangeLabel):
// i18n-keys: due.today, due.tomorrow, due.overdue, due.done, range.since, range.before, range.due

const TYPE = 'mindmap';
const ICON = '🧠';
const HIT_TOP = 90;
const HIT_FLOOR = 71;
const ITEM_ID_RE = /^i[0-9a-z]{14}$/;
const DATA_VERBS = new Set(['done', 'reopen', 'accept', 'dismiss', 'undo', 'open', 'private', 'share', 'delete']);
// ARCHITECTURE §7.2 values only ever contain [a-z0-9:]; keep anything else out.
const ACTION_ID_RE = /^mm:[a-z0-9:]{1,60}$/;
const SOURCE_WAIT_MS = 400;
// `mm archive <words>` (archive one of the hits) and `mm archived [words]` /
// `mm unarchive [words]` (archived items; Enter restores). P2.
const ARCHIVE_RE = /^\s*(archive|archived|unarchive)(?:\s+([\s\S]*))?$/i;
const ARCHIVE_ROWS = 8;
// `mm explore [focus]` opens the map explorer (EXTENSION_VIEWS §24.2), on
// hosts that offer views. Elsewhere "explore" is just a word to search for.
const EXPLORE_RE = /^\s*explore(?:\s+([\s\S]*))?$/i;
const MAP_REF_RE = /^(?:o|me|[ie][0-9a-z]{14})$/;
const EXPLORE_QUERY_MAX = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clip(value, n) {
  const chars = Array.from(oneLine(value));
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('').trimEnd()}…`;
}

// User text placed into display Markdown: escaped, no angle brackets.
function md(value) {
  return oneLine(value).replace(/[<>]/g, '').replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&');
}

// A short escaped plain-text line, then the card token alone in its paragraph (SPEC §10.2).
function display(line, token) {
  return { type: 'display', value: token ? `${line}\n\n${token}` : line };
}

// Splits the raw input into (mode, rest) for the configured trigger, or
// null when the input isn't ours. The host gate already guarantees the
// trimmed input is the keyword or starts with "keyword ".
export function splitTrigger(query, trigger) {
  const raw = String(query ?? '');
  const lead = raw.length - raw.trimStart().length;
  const body = raw.slice(lead);
  const lower = body.toLowerCase();
  for (const [suffix, mode] of [['+', 'capture'], ['?', 'ask'], ['', 'find']]) {
    const kw = trigger + suffix;
    if (!lower.startsWith(kw)) continue;
    const after = body.slice(kw.length);
    if (after && !/^\s/.test(after)) continue;
    // One separating space; newlines after it belong to a brain dump.
    const rest = after.replace(/^ /, '');
    return { mode, rest, trailingSpace: /\s$/.test(raw) };
  }
  return null;
}

export default class MindMapSearchProvider {
  initialize(context) {
    this.context = context;
    this.mind = getMind(context);
    this.invoke = context.invoke;
    this.log = context.log;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.generation = 0;
    this.last = null;
  }

  onConfigUpdate(config) {
    this.config = config || {};
    this.mind.setConfig(this.config);
  }

  get trigger() {
    return triggerOf(this.config);
  }

  // True where this window can open Mind Map's explorer: the host offers
  // views and the user approved them (EXTENSION_VIEWS §9.4).
  get canExplore() {
    const features = this.context?.hostFeatures;
    return Array.isArray(features) && features.includes('views');
  }

  get locale() {
    try {
      return this.context.i18n?.language?.() || 'en';
    } catch {
      return 'en';
    }
  }

  // i18n-keys: keyword.find.label, keyword.find.desc, keyword.capture.label, keyword.capture.desc, keyword.ask.label, keyword.ask.desc
  getKeywords() {
    const m = this.trigger;
    return [
      { keyword: m, labelKey: 'keyword.find.label', descriptionKey: 'keyword.find.desc', icon: ICON, acceptsArgs: true },
      { keyword: `${m}+`, labelKey: 'keyword.capture.label', descriptionKey: 'keyword.capture.desc', icon: '💾', acceptsArgs: true },
      { keyword: `${m}?`, labelKey: 'keyword.ask.label', descriptionKey: 'keyword.ask.desc', icon: '💬', acceptsArgs: true },
    ];
  }

  // --- matching ------------------------------------------------------------

  match(query) {
    this.generation++;
    if (this.config.enabled === false) return [];
    const parsed = splitTrigger(query, this.trigger);
    if (!parsed) return [];
    const mind = this.mind;
    this.last = { query, rev: mind.rev, loaded: mind.loaded };
    if (!mind.loaded) {
      mind.ready().catch(() => {});
      if (parsed.mode === 'capture' && parsed.rest.trim()) return this.captureRows(parsed);
      return [this.row('mm:loading', '⏳', this.t('row.loading'), '', 99, { a: 'noop', query })];
    }
    try {
      return this.rows(parsed, query);
    } catch (error) {
      this.log?.warn?.(`mindmap: match failed (${error?.name || 'error'})`);
      return [];
    }
  }

  async matchAsync(query) {
    const generation = ++this.generation;
    if (this.config.enabled === false) return [];
    const parsed = splitTrigger(query, this.trigger);
    if (!parsed) return [];
    const mind = this.mind;
    try {
      await mind.ready();
      await mind.syncIfStale();
    } catch (error) {
      this.log?.warn?.(`mindmap: load failed (${error?.code || error?.name || 'error'})`);
      if (generation !== this.generation) return [];
      return [this.row('mm:loaderror', '⚠️', this.t('row.load_failed'), this.t('row.load_failed_hint'), 99, { a: 'noop', query })];
    }
    if (generation !== this.generation) return [];
    if (parsed.mode === 'capture' && !parsed.rest.trim()) {
      const win = await this.fetchSourceWindow();
      if (generation !== this.generation) return [];
      const rows = this.emptyCaptureRows(win);
      return rows.length > 1 ? rows : this.unchanged(query) ? [] : rows;
    }
    if (this.unchanged(query)) return [];
    this.last = { query, rev: mind.rev, loaded: true };
    return this.rows(parsed, query);
  }

  unchanged(query) {
    const last = this.last;
    return !!last && last.query === query && last.loaded && last.rev === this.mind.rev;
  }

  // The window that was in front before Kage opened (or null). It changes
  // every time the launcher opens, so it is never cached.
  async fetchSourceWindow() {
    try {
      const win = await Promise.race([this.invoke('get_source_window'), sleep(SOURCE_WAIT_MS).then(() => null)]);
      return win && typeof win === 'object' ? win : null;
    } catch {
      return null;
    }
  }

  rows(parsed, query) {
    if (parsed.mode === 'capture') {
      return parsed.rest.trim() ? this.captureRows(parsed) : this.emptyCaptureRows(null);
    }
    if (parsed.mode === 'ask') return this.askRows(parsed.rest);
    return this.findRows(parsed, query);
  }

  row(id, icon, label, description, score, data) {
    return { id, type: TYPE, icon, label, description: description || '', score, data };
  }

  readOnlyRow() {
    if (!this.mind.readOnly) return null;
    return this.row('mm:readonly', '⚠️', this.t('row.readonly'), this.t('row.readonly_hint'), 99, { a: 'settings' });
  }

  // --- capture -------------------------------------------------------------

  previewText(preview) {
    const t = this.t;
    const parts = [];
    parts.push(`${KIND_ICONS[preview.kind] || ''} ${kindLabel(preview.kind, t)}`.trim());
    for (const name of preview.entityNames || []) parts.push(name);
    // A one-line action is itself the action: count only its children.
    const self = preview.extraction?.self;
    const actions = preview.actionCount - (self ? 1 : 0);
    const suggested = preview.suggestedCount - (self?.suggested ? 1 : 0);
    if (actions > 0) {
      parts.push(suggested > 0
        ? t('card.n_actions_suggested', { n: actions, s: suggested })
        : t('card.n_actions', { n: actions }));
    }
    if (preview.linkCount) parts.push(t('row.n_links', { n: preview.linkCount }));
    if (Number.isFinite(preview.nextDue)) parts.push(t('due.on', { day: fmtDay(preview.nextDue, this.locale, { now: this.mind.now() }) }));
    if (preview.private) parts.push(t('card.private_badge'));
    if (preview.truncated) parts.push(t('card.truncated', { n: LIMITS.captureText.toLocaleString(this.locale) }));
    return [...new Set(parts.filter(Boolean))].join(t('chip.sep'));
  }

  captureRows(parsed) {
    const banner = this.readOnlyRow();
    if (banner) {
      return [banner, this.row('mm:capture', '💾', this.t('row.capture'), this.t('err.readonly'), 95, { a: 'settings' })];
    }
    const preview = this.mind.preview(parsed.rest);
    if (preview.empty) return [this.hintRow()];
    return [this.row('mm:capture', '💾', this.t('row.capture'), this.previewText(preview), 95, { a: 'capture', text: parsed.rest })];
  }

  hintRow() {
    return this.row('mm:hint', '✍️', this.t('row.capture_hint'), this.t('row.capture_hint_desc'), 90, { a: 'noop' });
  }

  emptyCaptureRows(win) {
    const rows = [];
    const banner = this.readOnlyRow();
    if (banner) rows.push(banner);
    if (!banner && win && typeof win === 'object') {
      const app = oneLine(win.processName ?? win.process_name ?? '');
      const source = { window: oneLine(win.title ?? ''), app };
      const preview = this.mind.preview('', { source });
      if (!preview.empty && preview.kind === 'doc' && preview.title) {
        const label = app ? this.t('row.window', { title: preview.title, app }) : this.t('row.window_no_app', { title: preview.title });
        rows.push(this.row('mm:window', '📄', label, this.t('row.window_desc'), 94, { a: 'window', title: source.window, app }));
      }
    }
    rows.push(this.hintRow());
    return rows;
  }

  // --- ask -------------------------------------------------------------------

  askRows(question) {
    const q = oneLine(question);
    if (!q) return [this.row('mm:askhint', '💬', this.t('row.ask_hint'), this.t('row.ask_hint_desc'), 90, { a: 'noop' })];
    const { records, relaxed } = this.mind.askRecords(q);
    // i18n-keys: row.ask_found, row.ask_found_relaxed
    const found = relaxed ? 'row.ask_found_relaxed' : 'row.ask_found';
    const desc = records.length ? this.t(found, { n: records.length }) : this.t('row.ask_none');
    return [this.row('mm:askgo', '💬', this.t('row.ask_go', { question: clip(q, 80) }), desc, 95, { a: 'ask', question: q })];
  }

  // --- find, browse and commands ---------------------------------------------------

  findRows(parsed, query) {
    const mind = this.mind;
    const banner = this.readOnlyRow();
    // `mm explore` and the P2 archive commands. The query grammar
    // (lib/query.js) doesn't know them, so they are recognised here, before
    // parsing, like its own commands: by the first word.
    const explore = this.canExplore ? EXPLORE_RE.exec(parsed.rest) : null;
    if (explore) {
      const rows = this.exploreRows(explore[1] || '');
      return banner ? [banner, ...rows] : rows;
    }
    const archive = ARCHIVE_RE.exec(parsed.rest);
    if (archive) {
      const verb = archive[1].toLowerCase();
      const args = archive[2] || '';
      const rows = verb === 'archive' ? this.archiveRows(args, parsed, query) : this.archivedRows(args, parsed, query);
      return banner ? [banner, ...rows] : rows;
    }
    const spec = mind.parse(parsed.rest, { trailingSpace: parsed.trailingSpace });
    let rows;
    if (spec.intent === 'home') rows = this.homeRows();
    else if (spec.command === 'help') rows = [this.helpRow(95)];
    else if (spec.command === 'undo') rows = this.undoRows();
    else if (spec.command === 'recent') rows = this.recentRows();
    else if (spec.command === 'review') rows = this.reviewRows(query);
    else if (spec.command === 'map') rows = this.mapRows(spec);
    else if (spec.command === 'organize') rows = this.organizeRows();
    else if (spec.command === 'merge' || spec.command === 'forget' || spec.command === 'rename') rows = this.entityCommandRows(spec);
    else if (spec.intent === 'actions') rows = this.actionRows(spec, query, parsed.rest);
    else if (spec.intent === 'entity') rows = this.entityRows(spec, parsed.rest, query);
    else rows = this.hitRows(spec, parsed.rest, query);
    return banner ? [banner, ...rows] : rows;
  }

  fill(value) {
    return { a: 'fill', value };
  }

  helpRow(score) {
    return this.row('mm:help', '❔', this.t('row.help'), this.t('row.help_desc', { cmd: `${this.trigger} help` }), score, { a: 'help' });
  }

  askRow(args, score = 60) {
    const q = oneLine(args);
    return this.row('mm:ask', '💬', this.t('row.ask'), q ? `${this.trigger}? ${clip(q, 80)}` : this.t('row.ask_desc'), score, this.fill(`${this.trigger}? ${q}`));
  }

  scores(n, top = HIT_TOP) {
    return Array.from({ length: n }, (_, i) => Math.max(HIT_FLOOR, top - i));
  }

  homeRows() {
    const mind = this.mind;
    const t = this.t;
    const m = this.trigger;
    const now = mind.now();
    const stats = mind.stats({ size: false });
    const rows = [this.row('mm:home:capture', '💾', t('row.home_capture'), t('row.home_capture_desc', { cmd: `${m}+` }), 92, this.fill(`${m}+ `))];
    const open = mind.actions(mind.parse('actions', { trailingSpace: true }), { limit: LIMITS.actionsMax * 4 }).open;
    const weekEnd = mind.weekEnd(now);
    const today = new Date(now).setHours(0, 0, 0, 0);
    const overdue = open.filter((item) => Number.isFinite(item.dueAt) && item.dueAt < today).length;
    const dueSoon = open.filter((item) => Number.isFinite(item.dueAt) && item.dueAt >= today && item.dueAt < weekEnd).length;
    if (stats.openActions) {
      // i18n-keys: row.home_actions, row.home_actions_overdue
      const label = overdue ? t('row.home_actions_overdue', { n: stats.openActions, o: overdue, m: dueSoon }) : t('row.home_actions', { n: stats.openActions, m: dueSoon });
      rows.push(this.row('mm:home:actions', KIND_ICONS.action, label, `${m} actions`, 91, this.fill(`${m} actions`)));
    }
    if (stats.suggestions) {
      rows.push(this.row('mm:home:review', KIND_ICONS.action_suggested, t('row.home_review', { n: stats.suggestions }), `${m} review`, 90, this.fill(`${m} review`)));
    }
    const recent = mind.recent(5);
    recent.forEach((item, i) => rows.push(this.itemRow(item, { score: 89 - i })));
    if (stats.items) rows.push(this.row('mm:home:map', '🗺️', t('row.home_map'), t('row.home_map_desc'), 80, { a: 'map', ref: 'o' }));
    else rows.push(this.row('mm:home:empty', ICON, t('row.empty'), t('row.empty_desc', { cmd: `${m}+` }), 80, this.fill(`${m}+ `)));
    rows.push(this.askRow('', 60));
    rows.push(this.helpRow(55));
    return rows;
  }

  // One launcher row for an item (find hits, recent, entity pages).
  itemRow(item, { score, spec, hit, query } = {}) {
    const mind = this.mind;
    const t = this.t;
    const now = mind.now();
    const vm = { kind: item.kind, status: item.status, suggested: item.suggested };
    const icon = item.private ? `${itemIcon(vm)}🔒` : itemIcon(vm);
    const parts = [fmtDay(item.occurredAt ?? item.createdAt, this.locale, { now })];
    if (item.source?.app) parts.push(item.source.app);
    if (item.kind === 'action') {
      if (item.status === 'done') parts.push(doneText(item.doneAt, { t, locale: this.locale, now }));
      else if (Number.isFinite(item.dueAt)) parts.push(dueText(item.dueAt, { now, t, locale: this.locale }));
    }
    const snippet = mind.snippetFor(item, spec?.terms || [], LIMITS.launcherSnippet);
    // A snippet that only repeats the title is noise, except as the
    // evidence of a match (a window doc has no other text).
    if (snippet && (hit || oneLine(snippet).toLowerCase() !== oneLine(item.title).toLowerCase())) parts.push(snippet);
    const matched = hit ? this.matchedText(hit, spec) : '';
    if (matched) parts.push(t('row.matched', { what: matched }));
    const data = item.kind === 'action' && query !== undefined
      ? { a: item.suggested && item.status === 'open' ? 'accept' : 'toggle', id: item.id, query }
      : { a: 'open', id: item.id };
    return this.row(`mm:i:${item.id}`, icon, clip(item.title, 120), parts.filter(Boolean).join(t('chip.sep')), score, data);
  }

  matchedText(hit, spec) {
    const out = [];
    const raw = new Map();
    for (const term of spec?.terms || []) if (term?.t && !raw.has(term.t)) raw.set(term.t, term.raw || term.t);
    for (const term of hit.terms || []) out.push(raw.get(term) || term);
    for (const why of hit.why || []) {
      if ((why.code === 'entity' || why.code === 'alias') && why.value) {
        const name = this.mind.nameOf(why.value);
        if (name) out.push(name);
      }
    }
    const seen = new Set();
    return out.filter((w) => {
      const k = String(w).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).join(', ');
  }

  interpRow(spec, result, score) {
    const label = interpLabel(spec, result, {
      t: this.t,
      locale: this.locale,
      now: this.mind.now(),
      trigger: this.trigger,
      nameOf: (id) => this.mind.nameOf(id),
      typeOf: (id) => this.mind.entity(id)?.type,
    });
    if (!label) return null;
    const syntax = spec.syntax ? `${this.trigger} ${spec.syntax}` : this.trigger;
    // The host draws the icon; chip.interp's leading 🔎 would repeat it.
    const shown = label.startsWith('🔎') ? label.replace(/^🔎\s*/u, '') : label;
    let desc = this.t('row.refine', { syntax });
    // More matches than rows: say how many, so "refine" means something.
    const listed = result?.hits?.length || 0;
    if (listed && result.total > listed) desc = `${this.t('row.shown_of', { n: listed, total: result.total })}${this.t('chip.sep')}${desc}`;
    return this.row('mm:interp', '🔎', shown, desc, score, { a: 'refine', syntax: spec.syntax || '' });
  }

  hitRows(spec, args, query) {
    const mind = this.mind;
    const result = mind.find(spec, { limit: LIMITS.findRows });
    const scores = this.scores(result.hits.length);
    const rows = result.hits.map((hit, i) => this.itemRow(hit.item, { score: scores[i], spec, hit, query }));
    const empty = !rows.length;
    const interp = this.interpRow(spec, result, empty || result.relaxed ? 93 : 70);
    if (interp) rows.push(interp);
    else if (empty) rows.push(this.row('mm:interp', '🔎', this.t('relax.none', { capture: `${this.trigger}+` }), '', 93, this.fill(`${this.trigger}+ ${oneLine(args)}`)));
    if (empty) {
      // A typo ("mm lauch"): offer the spelling the notes use.
      const fixed = mind.suggestSpelling(args);
      if (fixed) rows.push(this.row('mm:spelling', '✏️', this.t('row.did_you_mean', { query: clip(fixed, 60) }), `${this.trigger} ${fixed}`, 94, this.fill(`${this.trigger} ${fixed}`)));
    }
    rows.push(this.askRow(args));
    return rows;
  }

  // Action rows in SPEC §8.2 order; Enter toggles (or accepts) and refreshes.
  actionRows(spec, query, args) {
    const mind = this.mind;
    const t = this.t;
    const result = mind.actions(spec, { limit: LIMITS.actionsMax });
    // "actions for Sarah" with nothing open: Sarah's suggested actions
    // ("Sarah to intro me to Raj") are what there is, marked as suggestions.
    const person = spec.owner && spec.owner !== 'me' && spec.owner !== 'anyone' ? mind.entity(spec.owner) : null;
    if (person && spec.status === 'open' && !result.open.length) {
      result.suggested = mind.actions({ ...spec, status: 'suggested' }, { limit: LIMITS.actionsMax }).suggested;
    }
    const list = [...result.open, ...(spec.status === 'suggested' ? [] : result.suggested), ...result.done];
    if (spec.status === 'suggested') list.unshift(...result.suggested);
    const scores = this.scores(list.length);
    const seenParents = new Set();
    const rows = list.map((item, i) => this.actionRow(item, { score: scores[i], query, seenParents }));
    if (!rows.length) {
      const interp = this.interpRow(spec, null, 93);
      if (interp) rows.push(interp);
      const name = spec.unresolved?.[0]?.phrase || spec.entities?.find((e) => e.hard)?.name;
      rows.push(this.row('mm:noactions', '🔎', name ? t('relax.no_actions_for', { name }) : t('relax.no_actions'),
        t('row.try_actions', { cmd: `${this.trigger} actions` }), 92, this.fill(`${this.trigger} actions`)));
    } else {
      // "No action matched every word" when only some words matched.
      const interp = this.interpRow(spec, result.relaxed ? { relaxed: result.relaxed } : null, result.relaxed ? 93 : 70);
      if (interp) rows.push(interp);
    }
    if (spec.owner === 'me') {
      const syntax = `${this.trigger} ${spec.syntax} owner:anyone`.replace(/\s+/g, ' ').trim();
      rows.push(this.row('mm:everyone', '👥', t('row.everyone'), syntax, 65, this.fill(syntax)));
      // "my actions for Dana" lists mine that involve Dana; Dana's own are one Enter away.
      const other = spec.entities.find((e) => e.hard && mind.entity(e.entityId)?.type === 'person' && e.entityId !== 'me');
      if (other) {
        const entity = mind.entity(other.entityId);
        const slug = entity.key && /^[a-z0-9-]+$/.test(entity.key) ? entity.key : entity.name.toLowerCase().replace(/\s+/g, '-');
        const theirs = `${this.trigger} actions owner:${slug}`;
        rows.push(this.row('mm:theirs', '👤', t('row.person_actions', { name: entity.name }), theirs, 64, this.fill(theirs)));
      }
    }
    rows.push(this.askRow(args));
    return rows;
  }

  actionRow(item, { score, query, seenParents }) {
    const mind = this.mind;
    const t = this.t;
    const now = mind.now();
    const locale = this.locale;
    const vm = { kind: 'action', status: item.status, suggested: item.suggested };
    const parts = [];
    const parent = item.parentId ? mind.item(item.parentId) : null;
    const fromText = () => {
      if (!parent) return '';
      const first = !seenParents.has(parent.id);
      seenParents.add(parent.id);
      const title = clip(parent.title, 40);
      return first
        ? t('row.from_day', { title, day: fmtDay(parent.occurredAt ?? parent.createdAt, locale, { now }) })
        : t('row.from', { title });
    };
    if (item.status === 'done') {
      parts.push(doneText(item.doneAt, { t, locale, now }));
      parts.push(fromText());
    } else {
      if (item.suggested) parts.push(t('card.suggested'));
      if (Number.isFinite(item.dueAt)) parts.push(dueText(item.dueAt, { now, t, locale }));
      const group = mind.groupOf(item);
      if (group) parts.push(mind.nameOf(group));
      if (item.owner && item.owner !== 'me') parts.push(t('card.owner', { name: mind.nameOf(item.owner) }));
      const from = fromText();
      if (from) parts.push(from);
      // A second date after a due date says what it is ("saved Sat, Oct 31").
      else if (Number.isFinite(item.dueAt)) parts.push(t('row.saved_on', { day: fmtDay(item.createdAt, locale, { now }) }));
      else parts.push(fmtDay(item.createdAt, locale, { now }));
    }
    const icon = item.private ? `${itemIcon(vm)}🔒` : itemIcon(vm);
    const a = item.status === 'open' && item.suggested ? 'accept' : 'toggle';
    return this.row(`mm:i:${item.id}`, icon, clip(item.title, 120), parts.filter(Boolean).join(t('chip.sep')), score, { a, id: item.id, query });
  }

  reviewRows(query) {
    const mind = this.mind;
    const t = this.t;
    const spec = mind.parse('actions is:suggested owner:anyone', { trailingSpace: true });
    const result = mind.actions(spec, { limit: LIMITS.actionsMax });
    const list = [...result.suggested].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const scores = this.scores(list.length);
    const seenParents = new Set();
    const rows = list.map((item, i) => this.actionRow(item, { score: scores[i], query, seenParents }));
    if (!rows.length) rows.push(this.row('mm:review:none', '✓', t('row.review_none'), t('row.review_none_desc'), 90, { a: 'noop' }));
    return rows;
  }

  recentRows() {
    const items = this.mind.recent(LIMITS.recentRows);
    const scores = this.scores(items.length);
    const rows = items.map((item, i) => this.itemRow(item, { score: scores[i] }));
    if (!rows.length) rows.push(this.row('mm:home:empty', ICON, this.t('row.empty'), this.t('row.empty_desc', { cmd: `${this.trigger}+` }), 90, this.fill(`${this.trigger}+ `)));
    return rows;
  }

  undoRows() {
    const t = this.t;
    const target = this.mind.undoTarget();
    if (!target) return [this.row('mm:undo', '↶', t('row.undo_nothing'), '', 95, { a: 'noop' })];
    const label = t('row.undo', { what: this.opText(target.summary) });
    if (!target.verdict.ok) return [this.row('mm:undo', '↶', label, this.undoErr(target.verdict.code), 95, { a: 'noop' })];
    return [this.row('mm:undo', '↶', label, fmtDay(target.op.at, this.locale, { now: this.mind.now() }), 95, { a: 'undo', opId: target.op.opId })];
  }

  // "Saved “Bingo team sync” (5 items)" for an op summary.
  opText(summary) {
    const t = this.t;
    const title = clip(summary.title || this.t('row.untitled'), 60);
    const known = new Set(['capture', 'capture_dedup', 'status_done', 'status_open', 'dismiss', 'accept', 'edit', 'privacy_on',
      'privacy_off', 'delete', 'annotate', 'merge', 'forget', 'rename', 'import', 'archive', 'unarchive']);
    const code = known.has(summary.code) ? summary.code : 'generic';
    // i18n-keys: op.*
    const text = t(`op.${code}`, { title, name: summary.name || title, from: summary.from || summary.name || title, n: summary.count });
    return summary.count > 1 && (code === 'capture' || code === 'delete') ? t('op.with_count', { text, n: summary.count }) : text;
  }

  entityRows(spec, args, query) {
    const mind = this.mind;
    const t = this.t;
    const hard = spec.entities.find((e) => e.hard);
    const summary = hard ? mind.entitySummary(hard.entityId) : null;
    if (!summary) return this.hitRows(spec, args, query);
    const { entity, counts, related } = summary;
    const headParts = [];
    if (counts.openActions) headParts.push(t('map.count_actions', { n: counts.openActions }));
    if (counts.suggested) headParts.push(t('map.count_suggested', { n: counts.suggested }));
    if (counts.docs) headParts.push(t('map.count_docs', { n: counts.docs }));
    if (counts.notes) headParts.push(t('map.count_notes', { n: counts.notes }));
    const icon = ETYPE_ICONS[entity.type] || ICON;
    const label = `${entity.name} (${etypeLabel(entity.type, t)})`;
    const rows = [this.row(`mm:e:${entity.id}`, icon, label, [...headParts, t('row.entity_open_map')].join(t('chip.sep')), 95, { a: 'entity', id: entity.id })];
    const items = [...(mind.itemsOf(entity.id))].filter((item) => !item.archived && !(item.kind === 'action' && item.status === 'dismissed'));
    const byNewest = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
    const open = mind.entityActions(entity.id, { limit: 6 });
    const docs = items.filter((i) => i.kind === 'doc' || i.kind === 'link').sort(byNewest).slice(0, 5);
    const notes = items.filter((i) => i.kind === 'note' || i.kind === 'meeting').sort(byNewest).slice(0, 5);
    let score = 90;
    const seenParents = new Set();
    for (const item of open) rows.push(this.actionRow(item, { score: score--, query, seenParents }));
    for (const item of docs) rows.push(this.itemRow(item, { score: score-- }));
    for (const item of notes) rows.push(this.itemRow(item, { score: score-- }));
    for (const rel of related.slice(0, 5)) {
      const other = mind.entity(rel.id);
      if (!other || other.id === 'me') continue;
      const name = other.key && /^[a-z0-9-]+$/.test(other.key) ? other.key : other.name.toLowerCase().replace(/\s+/g, '-');
      rows.push(this.row(`mm:e:${other.id}`, ETYPE_ICONS[other.type] || ICON, `${other.name} (${etypeLabel(other.type, t)})`,
        t('row.related_entity', { n: rel.w }), Math.max(HIT_FLOOR, score--), this.fill(`${this.trigger} @${name}`)));
    }
    rows.push(this.askRow(args));
    return rows;
  }

  // `mm map [entity | item | query]` (F-MAP-1).
  mapRows(spec) {
    const mind = this.mind;
    const t = this.t;
    const target = mind.mapTarget(spec.args);
    const label = target.ref === 'o' ? t('row.map_overview') : t('row.map', { name: clip(target.name, 60) });
    const data = { a: 'map', ref: target.ref };
    if (target.kinds) data.kinds = target.kinds;
    if (target.highlight?.length) data.highlight = target.highlight;
    // Nothing matched the words: say so rather than silently showing the overview.
    const desc = target.missed ? t('row.map_nomatch', { query: clip(spec.args, 60) }) : t('row.map_desc');
    const rows = [this.row('mm:map', '🗺️', label, desc, 95, data)];
    // With views, "Open in explorer" leads (EXTENSION_VIEWS §24.2).
    if (this.canExplore) rows.unshift(this.exploreRow(target, 96));
    return rows;
  }

  // The explorer row for a map target ({ ref, name, kinds? }).
  exploreRow(target, score) {
    const t = this.t;
    const label = target.ref === 'o' ? t('row.explore') : t('row.explore_named', { name: clip(target.name, 60) });
    const data = { a: 'explore', ref: target.ref };
    // `mm map @bingo kind:doc`: the explorer applies the kinds as a lens.
    if (target.kinds?.length) data.query = `kind:${target.kinds.join(',')}`;
    return this.row('mm:explore', '🗺️', label, t('row.explore_desc'), score, data);
  }

  // `mm explore [focus]`: one row that opens the explorer there.
  exploreRows(args) {
    const target = this.mind.mapTarget(args);
    const row = this.exploreRow(target, 95);
    if (target.missed) row.description = this.t('row.map_nomatch', { query: clip(args, 60) });
    return [row];
  }

  // The open_view effect for the explorer (needs the `views` capability).
  // permissions: views
  openExplorer(ref, query) {
    const params = { focus: MAP_REF_RE.test(String(ref || '')) ? ref : 'o' };
    const q = oneLine(query);
    if (q) params.query = q.slice(0, EXPLORE_QUERY_MAX);
    return { type: 'open_view', view: 'explorer', params };
  }

  organizeRows() {
    const items = this.mind.organizeItems();
    if (!items.length) return [this.row('mm:organize', '✨', this.t('row.organize_none'), '', 95, { a: 'noop' })];
    return [this.row('mm:organize', '✨', this.t('row.organize', { n: items.length }), this.t('row.organize_desc'), 95, { a: 'organize' })];
  }

  // P2: `mm merge @a into @b`, `mm forget @x`, `mm rename @x to New name`.
  entityCommandRows(spec) {
    const t = this.t;
    const plan = this.mind.planEntityCommand(spec.command, spec.args);
    if (!plan.ok) {
      // i18n-keys: row.cmd_usage_merge, row.cmd_usage_forget, row.cmd_usage_rename
      return [this.row(`mm:${spec.command}`, '🛠️', t(`row.cmd_usage_${spec.command}`, { cmd: this.trigger }), plan.code ? t('row.cmd_not_found', { name: plan.name || '' }) : '', 95, { a: 'noop' })];
    }
    // i18n-keys: row.cmd_merge, row.cmd_forget, row.cmd_rename
    const label = t(`row.cmd_${spec.command}`, { from: plan.fromName, into: plan.intoName || '', name: plan.newName || '' });
    return [this.row(`mm:${spec.command}`, '🛠️', label, t('row.cmd_undoable', { cmd: `${this.trigger} undo` }), 95,
      { a: spec.command, from: plan.fromId, into: plan.intoId, name: plan.newName })];
  }

  // P2 `mm archive <words>`: the find hits for the words, each archived on
  // Enter (undoable). Archived items leave every list, the map and the
  // agent's results, but stay in exports and in `mm archived`.
  archiveRows(args, parsed, query) {
    const mind = this.mind;
    const t = this.t;
    const m = this.trigger;
    const words = oneLine(args);
    const count = mind.archivedItems('', { limit: Infinity }).length;
    const rows = [];
    if (words) {
      const spec = mind.parse(args, { trailingSpace: parsed.trailingSpace });
      const hits = mind.find(spec, { limit: ARCHIVE_ROWS }).hits;
      const scores = this.scores(hits.length);
      hits.forEach((hit, i) => {
        const row = this.itemRow(hit.item, { score: scores[i], spec, hit });
        rows.push({ ...row, icon: '🗄️', label: t('row.archive_item', { title: clip(hit.item.title, 100) }), data: { a: 'archive', id: hit.item.id, query } });
      });
      if (!hits.length) rows.push(this.row('mm:archive', '🗄️', t('row.archive_none', { query: clip(words, 60) }), t('row.archive_usage', { cmd: `${m} archive` }), 93, { a: 'noop' }));
    } else {
      rows.push(this.row('mm:archive', '🗄️', t('row.archive_usage', { cmd: `${m} archive` }), t('row.archive_usage_desc'), 95, this.fill(`${m} archive `)));
    }
    if (count) rows.push(this.row('mm:archived', '🗃️', t('row.archived_count', { n: count }), `${m} archived`, 60, this.fill(`${m} archived`)));
    return rows;
  }

  // P2 `mm archived [words]`: archived items, newest first; Enter restores one.
  archivedRows(args, parsed, query) {
    const mind = this.mind;
    const t = this.t;
    const items = mind.archivedItems(args, { limit: LIMITS.findRows, trailingSpace: parsed.trailingSpace });
    const scores = this.scores(items.length);
    const now = mind.now();
    const rows = items.map((item, i) => {
      const row = this.itemRow(item, { score: scores[i] });
      const desc = [t('row.archived_on', { day: fmtDay(item.updatedAt, this.locale, { now }) }), t('row.archived_restore')].join(t('chip.sep'));
      return { ...row, description: desc, data: { a: 'unarchive', id: item.id, query } };
    });
    if (!rows.length) {
      const words = oneLine(args);
      rows.push(this.row('mm:archived', '🗃️', words ? t('row.archived_none_for', { query: clip(words, 60) }) : t('row.archived_none'),
        t('row.archive_usage', { cmd: `${this.trigger} archive` }), 93, { a: 'noop' }));
    }
    return rows;
  }

  // --- execute ------------------------------------------------------------------------

  async execute(result) {
    this.generation++;
    const data = result?.data || {};
    const t = this.t;
    const mind = this.mind;
    try {
      switch (data.a) {
        case 'capture':
          return await this.doCapture(String(data.text ?? ''));
        case 'window':
          return await this.doCaptureWindow(data);
        case 'open':
          return await this.open(data.id);
        case 'toggle': {
          await mind.ready();
          await mind.toggle(data.id);
          return { type: 'replace_input', value: data.query ?? '' };
        }
        case 'accept': {
          await mind.ready();
          await mind.accept(data.id);
          return { type: 'replace_input', value: data.query ?? '' };
        }
        case 'refine':
          return { type: 'replace_input', value: `${this.trigger} ${data.syntax ?? ''}`.trimEnd() };
        case 'fill':
          return { type: 'replace_input', value: String(data.value ?? '') };
        case 'explore': {
          if (this.canExplore) return this.openExplorer(data.ref, data.query);
          // Not approved (or an older host) after all: the map card instead.
          const ref = MAP_REF_RE.test(String(data.ref || '')) ? data.ref : 'o';
          await mind.ready();
          const name = ref === 'o' ? t('map.overview') : mind.nameOf(ref);
          return display(`🗺️ ${md(name || t('map.your_map'))}`, `[mm-card:map:${ref}]`);
        }
        case 'entity':
        case 'map': {
          const ref = data.a === 'entity' ? data.id : data.ref || 'o';
          await mind.ready();
          mind.setMapFilter(ref, { kinds: Array.isArray(data.kinds) ? data.kinds : undefined, highlight: Array.isArray(data.highlight) ? data.highlight : undefined });
          const name = ref === 'o' ? t('map.overview') : mind.nameOf(ref);
          return display(`🗺️ ${md(name || t('map.your_map'))}`, `[mm-card:map:${ref}]`);
        }
        case 'undo': {
          const out = await mind.undo(data.opId);
          if (!out.ok) return display(`↶ ${this.undoErr(out.code)}`, '');
          return display(`↶ ${t('row.undone')}`, `[mm-card:op:${out.undone}]`);
        }
        case 'ask':
          await mind.ready();
          return { type: 'prompt', value: mind.askPrompt(String(data.question ?? ''), { t }) };
        case 'organize': {
          await mind.ready();
          const prompt = mind.organizePrompt({ t });
          return prompt ? { type: 'prompt', value: prompt } : null;
        }
        case 'merge':
        case 'forget':
        case 'rename': {
          const out = data.a === 'merge' ? await mind.merge(data.from, data.into)
            : data.a === 'forget' ? await mind.forget(data.from) : await mind.rename(data.from, data.name);
          if (!out.ok) return display(`⚠️ ${this.entityErr(out.code)}`, '');
          const op = mind.state.ops.find((o) => o.opId === out.opId);
          return display(`🧠 ${md(op ? this.opText(mind.opSummary(op)) : t('row.done'))}`, `[mm-card:op:${out.opId}]`);
        }
        case 'archive':
        case 'unarchive': {
          if (!ITEM_ID_RE.test(String(data.id || ''))) return null;
          const out = await mind.setArchived(data.id, data.a === 'archive');
          if (!out.ok) return display(`⚠️ ${this.errText(out.code)}`, '');
          const title = md(clip(mind.item(data.id)?.title || '', 80));
          // i18n-keys: row.archived_line, row.unarchived_line
          return display(`${data.a === 'archive' ? '🗄️' : '↩️'} ${t(`row.${data.a}d_line`, { title })}`, `[mm-card:op:${out.opId}]`);
        }
        case 'help':
          return display(`🧠 ${t('help.title')}`, `[mm-card:help]\n\n${this.helpMore()}`);
        case 'settings':
          return { type: 'open_extension_settings' };
        default:
          return null;
      }
    } catch (error) {
      this.log?.warn?.(`mindmap: execute failed (${error?.code || error?.name || 'error'})`);
      return display(`⚠️ ${this.errText(error?.code)}`, '');
    }
  }

  undoErr(code) {
    // i18n-keys: err.undo_superseded, err.undo_already_undone, err.undo_missing, err.undo_nothing, err.undo_too_large
    return ['superseded', 'already_undone', 'missing', 'nothing', 'too_large'].includes(code) ? this.t(`err.undo_${code}`) : this.errText(code);
  }

  // Refusals of mm merge / forget / rename (lib/model.js codes): 'conflict'
  // is a rename onto a name another entity already has, not a write race.
  entityErr(code) {
    if (code === 'conflict') return this.t('err.rename_taken', { cmd: `${this.trigger} merge` });
    if (code === 'not_found') return this.t('err.entity_missing');
    return this.errText(code);
  }

  // The commands the help card doesn't list (P2), as a line after it.
  helpMore() {
    const m = this.trigger;
    const cmds = [`${m} organize`, `${m} archive …`, `${m} archived`, `${m} merge @a into @b`, `${m} rename @a to …`, `${m} forget @a`];
    return this.t('help.more', { cmds: cmds.map((c) => `\`${c}\``).join(' · ') });
  }

  errText(code) {
    const known = new Set(['readonly', 'busy', 'conflict', 'io', 'empty', 'not_found', 'not_action', 'noop', 'same', 'me', 'bad_format', 'future_schema', 'unreadable']);
    // i18n-keys: err.*
    return this.t(known.has(code) ? `err.${code}` : 'err.generic');
  }

  async sourceFor() {
    if (!(this.config.record_source_window ?? DEFAULTS.record_source_window)) return undefined;
    const win = await this.fetchSourceWindow();
    if (!win) return undefined;
    return { app: oneLine(win.processName ?? win.process_name ?? '') || undefined, window: oneLine(win.title ?? '') || undefined };
  }

  async doCapture(text) {
    const mind = this.mind;
    await mind.ready();
    const source = await this.sourceFor();
    const out = await mind.capture(text, { via: 'launcher', source });
    return this.captureDisplay(out);
  }

  async doCaptureWindow(data) {
    const out = await this.mind.captureWindow({ title: data.title, processName: data.app });
    return this.captureDisplay(out);
  }

  captureDisplay(out) {
    const t = this.t;
    if (out.code) return display(`⚠️ ${this.errText(out.code)}`, '');
    const item = this.mind.item(out.itemId);
    const title = md(clip(item?.title || '', 80));
    // A link whose page title is still being fetched: this line can't
    // change later, so it names the site, not a guessed title.
    const guessed = !out.dedupedInto && item?.titleSource === 'auto' && item?.enrich?.state === 'pending' && /^https?:\/\//i.test(item?.url || '');
    let host = '';
    if (guessed) {
      try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
    }
    const line = out.dedupedInto ? t('row.saved_dedup_line', { title })
      : host ? t('row.saved_link_line', { host: md(host) }) : t('row.saved_line', { title });
    return display(`🧠 ${line}`, `[mm-card:op:${out.opId}]`);
  }

  async open(id) {
    if (!ITEM_ID_RE.test(String(id || ''))) return null;
    const mind = this.mind;
    const target = await mind.openTarget(id);
    if (!target) return null;
    if (target.type === 'copy') return { type: 'copy', value: target.value };
    if (target.type === 'missing') return display(`⚠️ ${this.t('card.item_missing')}`, '');
    const item = mind.item(id);
    return display(`${itemIcon(item)} ${md(clip(item?.title || '', 80))}`, `[mm-card:item:${id}]`);
  }

  // --- formatter actions (ARCHITECTURE §7.2) ------------------------------------------

  async onResultAction(actionId) {
    if (typeof actionId !== 'string' || !ACTION_ID_RE.test(actionId)) return {};
    const parsed = parseAction(actionId);
    if (!parsed) return {};
    const mind = this.mind;
    try {
      if (parsed.scope === 'data') {
        if (!DATA_VERBS.has(parsed.verb)) return {};
        // Only a button on a card this window rendered, for a record that
        // card shows (view.boundAction): never one an agent wrote itself.
        if (!boundAction(ui, parsed)) {
          this.log?.warn?.('mindmap: ignored a card action that no rendered card offers');
          mind.requestReformat();
          return {};
        }
        await mind.ready();
        await this.dataAction(parsed);
        mind.requestReformat();
        return {};
      }
      if (parsed.scope === 'block' && parsed.verb === 'explore') {
        // ⤢ Explorer on a map card, Explore on an item card: the explorer,
        // on what that card shows (EXTENSION_VIEWS §24.2).
        const ref = exploreRef(ui, parsed);
        if (!ref || !this.canExplore) {
          mind.requestReformat();
          return {};
        }
        return { host: this.openExplorer(ref) };
      }
      if (applyUiAction(ui, parsed).changed) mind.requestReformat();
    } catch (error) {
      this.log?.warn?.(`mindmap: card action failed (${error?.code || error?.name || 'error'})`);
    }
    return {};
  }

  async dataAction({ verb, id }) {
    const mind = this.mind;
    switch (verb) {
      case 'done': return mind.setStatus(id, 'done');
      case 'reopen': return mind.setStatus(id, 'open');
      case 'accept': return mind.accept(id);
      case 'dismiss': return mind.dismiss(id);
      case 'undo': return mind.undo(id);
      case 'private': return mind.setPrivate(id, true);
      case 'share': return mind.setPrivate(id, false);
      case 'delete': return mind.remove(id);
      case 'open': {
        const target = await mind.openTarget(id);
        // A card can't copy or open another card; the item card is already on screen.
        return target;
      }
      default: return null;
    }
  }

  destroy() {
    this.generation++;
  }
}
