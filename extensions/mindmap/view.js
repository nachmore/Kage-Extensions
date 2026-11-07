// Mind Map presentation: labels, card HTML and the message-formatter core.
//
// Composer: it imports only the graph leaf (ARCHITECTURE §1). Everything it
// returns is an HTML *string* that the host sanitizes before it touches the
// page, so it only ever uses the sanitizer's allowlist (SPEC §10.2): div,
// span, button, a, details, summary, ul, li, small, strong, em, svg, line;
// class, title, role, aria-label, type, href, x1/y1/x2/y2, dir, open and
// data-ext-action. No ids, no inline styles. Every dynamic value is escaped.
//
// Data comes in through a DataPort (ARCHITECTURE §6.7) built by mind.js;
// UI state (map focus history, expanded chips, docked maps) lives in a
// per-window FormatterState and is mirrored into card classes so it can be
// rebuilt when the module state is lost.

import { LANES, layout } from './lib/graph.js';

// --- Icons -----------------------------------------------------------------

export const KIND_ICONS = Object.freeze({
  note: '📝',
  link: '🔗',
  doc: '📄',
  meeting: '🗓️',
  action: '☐',
  action_done: '☑',
  action_suggested: '❔',
});

export const ETYPE_ICONS = Object.freeze({
  person: '👤',
  team: '👥',
  project: '📁',
  topic: '#️⃣',
  term: '🔤',
  org: '🏢',
});

const LOCK = '🔒';
const ITEM_KINDS = new Set(['note', 'link', 'doc', 'action', 'meeting']);
const ENTITY_TYPES = new Set(['person', 'team', 'project', 'topic', 'term', 'org']);

/** Icon for an item-like record ({kind, status, suggested}). */
export function itemIcon(vm) {
  if (!vm) return '';
  if (vm.kind === 'action') {
    if (vm.status === 'done') return KIND_ICONS.action_done;
    if (vm.status === 'dismissed') return '✕';
    if (vm.suggested) return KIND_ICONS.action_suggested;
    return KIND_ICONS.action;
  }
  if (ETYPE_ICONS[vm.kind]) return ETYPE_ICONS[vm.kind];
  return KIND_ICONS[vm.kind] || '•';
}

// --- Ids and markers (copies: view.js imports only lib/graph.js; these
// must match lib/ids.js, and view.test.js checks that they do) -------------

const ITEM_ID = /^i[0-9a-z]{14}$/;
const ENTITY_ID = /^(?:e[0-9a-z]{14}|me)$/;
const OP_ID = /^o[0-9a-z]{14}$/;
const MAP_REF = /^(?:o|me|[ie][0-9a-z]{14})$/;
const CITE_ID = /^(?:[ie][0-9a-z]{14}|me)$/;
const COUNTER = /^[0-9a-z]{1,12}$/;
const CITE_SCAN = /\[mm:([ie][0-9a-z]{14}|me)\]/g;
const CARD_ONLY = /^\[mm-card:(op|item|map|help)(?::(o|me|[ieo][0-9a-z]{14}))?\]$/;
const QUICK = /\[mm:|\[mm-card:|class="mm-/;

// --- Text ------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

const esc = escapeHtml;

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Truncate by code point (never split an emoji's surrogate pair).
function clip(s, n) {
  const chars = Array.from(String(s ?? ''));
  if (chars.length <= n) return chars.join('');
  return `${chars.slice(0, Math.max(1, n - 1)).join('').trimEnd()}…`;
}

function tOf(ctx) {
  return typeof ctx?.t === 'function' ? ctx.t : (key) => key;
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// --- Dates -------------------------------------------------------------------

const DAY_OPTS = { calendar: 'gregory', weekday: 'short', month: 'short', day: 'numeric' };
const DAY_YEAR_OPTS = { ...DAY_OPTS, year: 'numeric' };
const SHORT_OPTS = { calendar: 'gregory', month: 'short', day: 'numeric' };
const SHORT_YEAR_OPTS = { ...SHORT_OPTS, year: 'numeric' };
const formats = new Map();

function dtf(locale, opts, name) {
  const key = `${locale}|${name}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale || 'en', opts);
    } catch {
      f = new Intl.DateTimeFormat('en', opts);
    }
    if (formats.size > 64) formats.clear();
    formats.set(key, f);
  }
  return f;
}

function finite(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? n : null;
}

function otherYear(ms, now) {
  return now != null && new Date(ms).getFullYear() !== new Date(now).getFullYear();
}

/** 'Mon, Oct 26' (gregory). Adds the year when `now` is in another year. */
export function fmtDay(ms, locale = 'en', { now } = {}) {
  const n = finite(ms);
  if (n === null) return '';
  return otherYear(n, now) ? dtf(locale, DAY_YEAR_OPTS, 'dy').format(n) : dtf(locale, DAY_OPTS, 'd').format(n);
}

function fmtShort(ms, locale, now) {
  return otherYear(ms, now) ? dtf(locale, SHORT_YEAR_OPTS, 'sy').format(ms) : dtf(locale, SHORT_OPTS, 's').format(ms);
}

function localDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayDiff(from, to) {
  return Math.round((localDay(to) - localDay(from)) / 86400000);
}

/**
 * 'Mon, Oct 26 – Sun, Nov 1' for [start, endExclusive). One day collapses
 * to that day. `short` drops the weekday ('Oct 6 – Nov 6').
 */
export function fmtRange(start, endExclusive, locale = 'en', { t, short = false, now } = {}) {
  const s = finite(start);
  const e = finite(endExclusive);
  if (s === null) return '';
  const last = e === null ? s : Math.max(s, e - 1);
  const day = (ms) => (short ? fmtShort(ms, locale, now) : fmtDay(ms, locale, { now }));
  if (dayDiff(s, last) === 0) return day(s);
  if (typeof t === 'function') return t('range.span', { from: day(s), to: day(last) });
  return `${day(s)} – ${day(last)}`;
}

/** 'due today (Fri, Nov 6)' | 'due tomorrow (…)' | 'overdue · Mon, Nov 2' | 'due Fri, Nov 6'. */
export function dueText(dueAt, { now = Date.now(), t, locale = 'en' } = {}) {
  const at = finite(dueAt);
  if (at === null) return '';
  const tr = tOf({ t });
  const day = fmtDay(at, locale, { now });
  const diff = dayDiff(now, at);
  if (diff === 0) return tr('due.today', { day });
  if (diff === 1) return tr('due.tomorrow', { day });
  if (diff < 0) return tr('due.overdue', { day });
  return tr('due.on', { day });
}

/** 'done Wed, Nov 4'. */
export function doneText(doneAt, { now, t, locale = 'en' } = {}) {
  const at = finite(doneAt);
  if (at === null) return '';
  return tOf({ t })('due.done', { day: fmtDay(at, locale, { now }) });
}

// --- Labels --------------------------------------------------------------------

/** Singular, lower-case kind name ('doc'). */
export function kindLabel(kind, t) {
  if (!ITEM_KINDS.has(kind)) return String(kind || '');
  // i18n-keys: kind.*
  return tOf({ t })(`kind.${kind}`);
}

/** Lower-case entity type ('team'). */
export function etypeLabel(type, t) {
  if (!ENTITY_TYPES.has(type)) return String(type || '');
  // i18n-keys: etype.*
  return tOf({ t })(`etype.${type}`);
}

function kindsLabel(kinds, t) {
  const list = [...new Set((kinds || []).filter((k) => ITEM_KINDS.has(k)))];
  if (!list.length) return '';
  if (list.length === 2 && list.includes('doc') && list.includes('link')) return t('chip.kinds_doc_link');
  // i18n-keys: kind.*
  return list.map((k) => t(`kind.${k}s`)).join(', ');
}

function laneName(role, t) {
  // i18n-keys: map.lane_*
  return t(`map.lane_${role}`);
}

function laneEmpty(role, t) {
  // i18n-keys: map.empty_*
  return t(`map.empty_${role}`);
}

/** Label for a QuerySpec range ('Mon, Oct 26 – Sun, Nov 1', 'since …', 'due …'). */
export function rangeLabel(range, { t, locale = 'en', now } = {}) {
  if (!range) return '';
  const tr = tOf({ t });
  const start = finite(range.start);
  const end = finite(range.end);
  const code = String(range.code || '');
  let label;
  if (start === null || start <= 0 || /before/.test(code)) {
    label = end === null ? '' : tr('range.before', { day: fmtDay(end, locale, { now }) });
  } else if (end === null || /since/.test(code)) {
    label = tr('range.since', { day: fmtDay(start, locale, { now }) });
  } else {
    label = fmtRange(start, end, locale, { t, now });
  }
  if (label && range.field === 'due') label = tr('range.due', { range: label });
  return label;
}

function entityName(id, opts) {
  return String(safe(() => opts.nameOf?.(id)) || '');
}

function hardEntities(spec) {
  return (spec?.entities || []).filter((e) => e && e.hard && e.entityId);
}

function normWord(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function termParts(spec, opts, t) {
  const covered = new Set();
  for (const e of hardEntities(spec)) {
    for (const w of normWord(e.name || entityName(e.entityId, opts)).split(' ')) if (w) covered.add(w);
  }
  const shown = [];
  const negatives = [];
  for (const term of spec?.terms || []) {
    if (!term || typeof term.t !== 'string' || !term.t) continue;
    // `raw` is the word as typed (lib/query.js); `t` is its index form.
    const word = typeof term.raw === 'string' && term.raw ? term.raw : term.t;
    if (term.neg) {
      negatives.push(t('chip.not', { term: word }));
      continue;
    }
    if (term.w != null && term.w < 1) continue; // alias / prefix expansions
    if (term.phrase) continue; // shown with its quoted phrase below
    if (covered.has(normWord(term.t)) || covered.has(normWord(word))) continue;
    shown.push(term.prefix ? `${word}…` : word);
  }
  for (const phrase of spec?.phrases || []) {
    if (typeof phrase === 'string' && phrase) shown.push(`"${phrase}"`);
  }
  const out = [];
  if (shown.length) out.push(t('chip.terms', { terms: [...new Set(shown)].join(' ') }));
  return out.concat(negatives);
}

function statusPart(spec, t) {
  const actions = spec?.intent === 'actions';
  switch (spec?.status) {
    case 'done':
      return t('chip.status_done');
    case 'suggested':
      return t('chip.status_suggested');
    case 'overdue':
      return t('chip.status_overdue');
    case 'all':
      return t('chip.status_all');
    case 'open':
      return actions ? t('chip.status_open_recent') : t('chip.status_open');
    default:
      return actions ? t('chip.status_open_recent') : '';
  }
}

function unresolvedText(u, t) {
  const name = String(u?.phrase || '');
  switch (u?.type) {
    case 'team':
      return t('chip.unresolved_team', { name });
    case 'project':
      return t('chip.unresolved_project', { name });
    case 'person':
      return t('chip.unresolved_person', { name });
    default:
      return t('chip.unresolved', { name });
  }
}

/**
 * The interpretation row label (SPEC AT-1, AT-1b, AT-2, AT-2b).
 * Unknown team/project names and relaxed results explain themselves (in
 * that order); otherwise '🔎 part · part · …'. Returns '' when nothing was
 * understood.
 *
 * opts: { t, locale, nameOf(entityId) → name, typeOf?(entityId) → type, now?, trigger? }
 */
export function interpLabel(spec, result, opts = {}) {
  const t = tOf(opts);
  if (!spec) return '';
  // An unknown team/project explains itself first (AT-2b): the "nothing
  // found" sentence is its own row.
  if (spec.unresolved?.length) return unresolvedText(spec.unresolved[0], t);
  if (result?.relaxed?.code) {
    const text = relaxText(result.relaxed, spec, opts);
    if (text) return text;
  }
  const parts = [];
  if (spec.intent === 'actions') parts.push(t('chip.actions'));
  else if (spec.kinds?.length) parts.push(kindsLabel(spec.kinds, t));
  if (spec.owner === 'me') parts.push(t('chip.owner_me'));
  else if (spec.owner === 'anyone') parts.push(t('chip.owner_anyone'));
  else if (typeof spec.owner === 'string' && spec.owner) parts.push(t('chip.owner_person', { name: entityName(spec.owner, opts) || spec.owner }));
  for (const e of hardEntities(spec)) {
    const name = e.name || entityName(e.entityId, opts);
    if (!name) continue;
    const type = e.type || safe(() => opts.typeOf?.(e.entityId));
    parts.push(type ? t('chip.entity', { name, type: etypeLabel(type, t) }) : name);
  }
  const range = rangeLabel(spec.range, opts);
  if (range) parts.push(range);
  const status = statusPart(spec, t);
  if (status) parts.push(status);
  if (spec.privateOnly) parts.push(t('chip.private'));
  parts.push(...termParts(spec, opts, t));
  const clean = parts.filter(Boolean);
  if (!clean.length) return '';
  return t('chip.interp', { parts: clean.join(t('chip.sep')) });
}

/** The relaxation sentence for QueryResult.relaxed (SPEC §8.2, AT-1b, AT-2b). */
export function relaxText(relaxed, spec, opts = {}) {
  const t = tOf(opts);
  const locale = opts.locale || 'en';
  if (!relaxed?.code) return '';
  const asked = rangeLabel(spec?.range ? { ...spec.range, field: 'any' } : null, opts);
  switch (relaxed.code) {
    case 'range_widened': {
      const r = relaxed.range;
      const range = r ? fmtRange(r.start, r.end, locale, { t, short: true, now: opts.now }) : '';
      return t('relax.range_widened', { asked, range });
    }
    case 'range_dropped':
      return t('relax.range_dropped', { asked });
    case 'kinds_dropped':
      return t('relax.kinds_dropped', { kinds: kindsLabel(spec?.kinds, t) || t('chip.kinds_doc_link') });
    case 'entities_softened': {
      const names = hardEntities(spec).map((e) => e.name || entityName(e.entityId, opts)).filter(Boolean);
      return t('relax.entities_softened', { names: names.join(', ') });
    }
    case 'none': {
      if (spec?.intent === 'actions') {
        const first = hardEntities(spec)[0];
        const name = spec.unresolved?.[0]?.phrase || first?.name || entityName(first?.entityId, opts);
        return name ? t('relax.no_actions_for', { name }) : t('relax.no_actions');
      }
      return t('relax.none', { capture: `${opts.trigger || 'mm'}+` });
    }
    default:
      return '';
  }
}

// --- Shared HTML helpers ---------------------------------------------------------

// An icon span; ❔ gets an outline class (white glyph on light surfaces).
function iconHtml(icon, cls = 'mm-ni') {
  if (!icon) return '';
  return `<span${attr('class', icon.includes(KIND_ICONS.action_suggested) ? `${cls} mm-ic-q` : cls)}>${esc(icon)}</span>`;
}

// A snippet worth reading: bullet and checkbox markers dropped, the line
// that just repeats the title skipped, lines joined with " · ".
function cleanSnippet(text, title) {
  const head = oneLine(title).toLowerCase();
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s*)?/, '').trim())
    .filter(Boolean);
  if (lines.length && lines[0].toLowerCase() === head) lines.shift();
  return oneLine(lines.join(' · '));
}

function attr(name, value) {
  return ` ${name}="${esc(value)}"`;
}

function btn(cls, action, label, { title, aria } = {}) {
  return `<button type="button"${attr('class', cls)}${attr('data-ext-action', action)}${title ? attr('title', title) : ''}${aria ? attr('aria-label', aria) : ''}>${label}</button>`;
}

function blockClass(b) {
  const parts = ['mm-block', `mm-b${b.blk}`, `mm-r${b.rev}`, `mm-d${b.dataRev}`, `mm-t-${b.type}`];
  if (b.ref) parts.push(`mm-f-${b.ref}`);
  if (b.dock) parts.push('mm-dock');
  if (b.wait) parts.push('mm-wait');
  if (b.mode === 'list') parts.push('mm-mode-list');
  return parts.join(' ');
}

function blockOf(ctx, type, ref) {
  const b = ctx?.block || {};
  return {
    blk: COUNTER.test(String(b.blk ?? '')) ? String(b.blk) : '1',
    rev: COUNTER.test(String(b.rev ?? '')) ? String(b.rev) : '1',
    dataRev: COUNTER.test(String(b.dataRev ?? '')) ? String(b.dataRev) : '0',
    type,
    ref: b.ref ?? ref ?? null,
    dock: !!b.dock,
    wait: !!b.wait,
    mode: b.mode,
  };
}

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

function joinSep(parts, t) {
  return parts.filter(Boolean).join(t('chip.sep'));
}

function dayOf(vm, ctx) {
  if (typeof vm?.day === 'string') return vm.day;
  return fmtDay(vm?.day ?? vm?.createdAt, ctx.locale || 'en', { now: ctx.now });
}

// --- Citation chips (SPEC §10.1) ---------------------------------------------------

/**
 * One citation chip, plus its inline expansion when `expanded`.
 * vm: CiteVM | {private:true} | null (deleted) | undefined (still loading).
 * opts: { id, n, msg, rev, dataRev, expanded, repeat, t, locale, now }
 */
export function renderCite(vm, opts = {}) {
  const t = tOf(opts);
  const id = CITE_ID.test(String(vm?.id || '')) ? vm.id : CITE_ID.test(String(opts.id || '')) ? opts.id : null;
  if (!id) return '';
  const n = Math.max(1, Math.trunc(Number(opts.n) || 1));
  const msg = COUNTER.test(String(opts.msg ?? '')) ? String(opts.msg) : '1';
  const rev = COUNTER.test(String(opts.rev ?? '')) ? String(opts.rev) : '1';
  const dataRev = COUNTER.test(String(opts.dataRev ?? '')) ? String(opts.dataRev) : '0';
  const waiting = vm === undefined;
  const missing = !waiting && (!vm || vm.missing);
  const priv = !waiting && !missing && !!vm.private;
  const cls = ['mm-cite', `mm-m${msg}`, `mm-r${rev}`, `mm-d${dataRev}`];
  let label;
  let title;
  if (waiting) {
    cls.push('mm-cite-wait');
    label = `[${n}] ${t('cite.loading')}`;
    title = t('card.loading');
  } else if (missing) {
    cls.push('mm-cite-missing');
    label = `[${n}] ${t('cite.deleted')}`;
    title = t('cite.deleted_note');
  } else if (priv) {
    cls.push('mm-cite-private');
    label = `[${n}] ${t('cite.private')}`;
    title = t('cite.private_note');
  } else {
    if (ITEM_KINDS.has(vm.kind) || ENTITY_TYPES.has(vm.kind)) cls.push(`mm-k-${vm.kind}`);
    const full = oneLine(vm.title) || '…';
    label = opts.repeat ? `[${n}]` : `[${n}] ${clip(full, 40)}`;
    const day = dayOf(vm, opts);
    const snip = cleanSnippet(vm.snippet, vm.title);
    title = `${full}${day ? ` · ${day}` : ''}${snip ? ` — ${clip(snip, 160)}` : ''}`;
  }
  if (opts.repeat) label = `[${n}]`;
  const aria = t('cite.aria', { n, title: waiting ? t('cite.loading') : missing ? t('cite.deleted') : priv ? t('cite.private') : oneLine(vm.title) });
  const chip = btn(cls.join(' '), `mm:c${msg}:x:${n}:${id}`, esc(label), { title, aria });
  if (!opts.expanded || waiting) return chip;
  return chip + citeExpansion(vm, { id, n, msg, priv, missing, t, ctx: opts });
}

function citeExpansion(vm, { id, n, msg, priv, missing, t, ctx }) {
  const cls = `mm-cite-x mm-x${n} mm-m${msg}`;
  if (missing) return `<span${attr('class', cls)}>${esc(t('cite.deleted_note'))}</span>`;
  const mapBtn = btn('mm-cite-btn', `mm:c${msg}:map:${id}`, esc(t('cite.map')));
  if (priv) return `<span${attr('class', cls)}>${esc(t('cite.private_note'))} ${mapBtn}</span>`;
  const kind = ENTITY_TYPES.has(vm.kind) ? etypeLabel(vm.kind, t) : kindLabel(vm.kind, t);
  const head = joinSep([`${itemIcon(vm)} ${kind}`.trim(), dayOf(vm, ctx)], t);
  const snip = cleanSnippet(vm.snippet, vm.title);
  const open = isHttp(vm.url) ? ` <a${attr('class', 'mm-cite-btn mm-cite-open')}${attr('href', vm.url)}>${esc(t('cite.open'))}</a>` : '';
  return `<span${attr('class', cls)}><span class="mm-cite-meta">${esc(head)}</span>${snip ? ` <span class="mm-cite-snip">${esc(clip(snip, 160))}</span>` : ''}${open} ${mapBtn}</span>`;
}

// --- Op card (SPEC §10.2) ------------------------------------------------------------

function opHeadline(vm, t, ctx) {
  if (vm.undone) return t('card.op_undone');
  if (vm.dedupedInto) return t('card.op_deduped', { day: dayOf(vm.dedupedInto, ctx) });
  // Codes are lib/model.js op label codes (BUILD_NOTES WP-B), plus a few
  // plain-word aliases.
  switch (vm.code) {
    case 'capture':
    case 'saved':
      return t('card.op_saved');
    case 'capture_dedup':
      return t('card.op_deduped_plain');
    case 'edit':
      return t('card.op_edited');
    case 'merge':
      return t('card.op_merged');
    case 'forget':
      return t('card.op_forgotten');
    case 'rename':
      return t('card.op_renamed');
    case 'done':
    case 'status_done':
      return t('card.op_done');
    case 'reopen':
    case 'reopened':
    case 'status_open':
      return t('card.op_reopened');
    case 'accept':
    case 'accepted':
      return t('card.op_accepted');
    case 'dismiss':
    case 'dismissed':
      return t('card.op_dismissed');
    case 'delete':
    case 'deleted':
      return t('card.op_deleted');
    case 'private':
    case 'privacy_on':
      return t('card.op_private');
    case 'share':
    case 'shared':
    case 'privacy_off':
      return t('card.op_shared');
    case 'annotate':
    case 'annotated':
    case 'enrich':
    case 'reextract':
      return t('card.op_annotated');
    case 'import':
    case 'imported':
      return t('card.op_imported');
    case 'undo':
      return t('card.op_undone');
    default:
      return t('card.op_generic');
  }
}

function actionState(a, t) {
  if (a.status === 'dismissed') return t('card.dismissed');
  if (a.suggested && a.status !== 'done') return t('card.suggested');
  return '';
}

function actionRow(a, { t, ctx, buttons }) {
  if (!a?.id) return '';
  const status = a.status || 'open';
  const cls = ['mm-act', `mm-st-${status}`];
  if (a.suggested && status === 'open') cls.push('mm-sug');
  const extra = [];
  if (a.dueAt && status === 'open') extra.push(dueText(a.dueAt, { now: ctx.now ?? Date.now(), t, locale: ctx.locale || 'en' }));
  if (a.owner && a.owner.id !== 'me' && a.owner.name) extra.push(t('card.owner', { name: a.owner.name }));
  const state = actionState(a, t);
  if (state) extra.push(state);
  const title = oneLine(a.title) || '…';
  return `<li${attr('class', cls.join(' '))}>${iconHtml(itemIcon({ kind: 'action', status, suggested: a.suggested }), 'mm-ai')}<span class="mm-at"${attr('title', title)}>${esc(clip(title, 90))}</span>${extra.length ? `<small class="mm-meta">${esc(joinSep(extra, t))}</small>` : ''}${buttons ? `<span class="mm-ab">${buttons}</span>` : ''}</li>`;
}

function actionButtons(a, t, { full = false } = {}) {
  const status = a.status || 'open';
  if (status === 'dismissed') return '';
  const out = [];
  if (a.suggested && status === 'open') {
    out.push(btn('mm-btn mm-btn-primary', `mm:a:accept:${a.id}`, esc(t('card.accept'))));
    out.push(btn('mm-btn', `mm:a:dismiss:${a.id}`, esc(t('card.not_action'))));
    return out.join('');
  }
  if (full) {
    if (status === 'done') out.push(btn('mm-btn', `mm:a:reopen:${a.id}`, esc(t('card.reopen'))));
    else out.push(btn('mm-btn mm-btn-primary', `mm:a:done:${a.id}`, esc(t('card.done'))));
  }
  if (status === 'open') out.push(btn('mm-btn', `mm:a:dismiss:${a.id}`, esc(t('card.not_action'))));
  return out.join('');
}

function relatedChip(c, blk, t, ctx, nav) {
  if (!c?.id || !MAP_REF.test(c.id)) return '';
  const priv = !!c.private;
  const title = priv ? t('cite.private') : oneLine(c.title) || '…';
  const icon = priv ? LOCK : itemIcon(c);
  const day = c.missing ? '' : dayOf(c, ctx);
  const tip = c.missing ? t('cite.deleted_note') : `${title}${day ? ` · ${day}` : ''}`;
  const label = `${iconHtml(icon)}<span class="mm-nl">${esc(clip(title, 40))}</span>`;
  if (!nav || c.missing) return `<span${attr('class', 'mm-rel')}${attr('title', tip)}>${label}</span>`;
  return btn('mm-rel', `mm:b${blk}:f:${c.id}`, label, { title: tip });
}

/** Card for a journal op: "✓ Saved · meeting · Bingo · 4 actions · 3 related". */
export function renderOpCard(vm, ctx = {}) {
  const t = tOf(ctx);
  const b = blockOf(ctx, 'op', vm?.opId);
  const nav = ctx.canReformat !== false && ctx.canNavigate !== false;
  const open = `<div${attr('class', blockClass(b))} role="group"${attr('aria-label', t('card.aria'))}>`;
  if (!vm) return `${open}<span class="mm-muted">${esc(t('card.op_missing'))}</span></div>`;
  const head = opHeadline(vm, t, ctx);
  const facts = [];
  if (!vm.undone) {
    if (vm.item?.kind && !vm.dedupedInto) facts.push(kindLabel(vm.item.kind, t));
    const names = (vm.entities || []).filter((e) => e && e.id !== 'me' && e.name).map((e) => e.name);
    if (names.length) facts.push(names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
    const actions = (vm.actions || []).filter((a) => a && a.status !== 'dismissed');
    if (actions.length) {
      const s = actions.filter((a) => a.suggested && a.status === 'open').length;
      facts.push(s ? t('card.n_actions_suggested', { n: actions.length, s }) : t('card.n_actions', { n: actions.length }));
    }
    if (vm.related?.length) facts.push(t('card.n_related', { n: vm.related.length }));
  }
  const parts = [`<div class="mm-op-head"><strong class="mm-op-title">${esc(head)}</strong>${facts.length ? `<span class="mm-op-facts">${esc(t('chip.sep'))}${esc(joinSep(facts, t))}</span>` : ''}</div>`];
  if (vm.item?.id) {
    const priv = vm.item.private ? ` <span class="mm-badge">${esc(t('card.private_badge'))}</span>` : '';
    const title = oneLine(vm.item.title) || '…';
    parts.push(`<div${attr('class', vm.undone ? 'mm-op-item mm-gone' : 'mm-op-item')}>${iconHtml(itemIcon(vm.item))}<span class="mm-op-name"${attr('title', title)}>${esc(clip(title, 80))}</span>${priv}</div>`);
  }
  if (vm.truncated && !vm.undone) parts.push(`<small class="mm-note">${esc(t('card.truncated', { n: safe(() => (8000).toLocaleString(ctx.locale || 'en'), '8,000') }))}</small>`);
  if (!vm.undone && vm.actions?.length) {
    const rows = vm.actions.map((a) => actionRow(a, { t, ctx, buttons: nav ? actionButtons(a, t) : '' })).join('');
    if (rows) parts.push(`<ul class="mm-acts">${rows}</ul>`);
  }
  if (!vm.undone && vm.related?.length) {
    parts.push(`<div class="mm-rels"><small class="mm-cap">${esc(t('card.related'))}</small>${vm.related.slice(0, 5).map((c) => relatedChip(c, b.blk, t, ctx, nav)).join('')}</div>`);
  }
  const buttons = [];
  if (!vm.undone && vm.canUndo && OP_ID.test(String(vm.opId || ''))) buttons.push(btn('mm-btn', `mm:a:undo:${vm.opId}`, esc(t('card.undo'))));
  if (!vm.undone && nav && vm.item?.id && ITEM_ID.test(vm.item.id)) buttons.push(btn('mm-btn', `mm:b${b.blk}:map`, esc(t('card.map'))));
  if (buttons.length) parts.push(`<div class="mm-btns">${buttons.join('')}</div>`);
  return `${open}${parts.join('')}</div>`;
}

// --- Item card (SPEC §10.2) ------------------------------------------------------------

const TEXT_SHOWN = 600;

function splitText(text) {
  const s = String(text || '');
  if (s.length <= TEXT_SHOWN) return [s, ''];
  let cut = s.lastIndexOf(' ', TEXT_SHOWN);
  if (cut < TEXT_SHOWN * 0.7) cut = TEXT_SHOWN;
  return [s.slice(0, cut), s.slice(cut)];
}

function entityChip(e, blk, t, nav) {
  if (!e?.id || !ENTITY_ID.test(e.id)) return '';
  const icon = ETYPE_ICONS[e.type] || '•';
  const name = oneLine(e.name) || '…';
  const label = `<span class="mm-ni">${esc(icon)}</span><span class="mm-nl">${esc(clip(name, 32))}</span>${e.private ? `<span class="mm-ni">${LOCK}</span>` : ''}`;
  const tip = `${name} (${etypeLabel(e.type, t)})`;
  if (!nav) return `<span${attr('class', `mm-echip mm-k-${ENTITY_TYPES.has(e.type) ? e.type : 'term'}`)}${attr('title', tip)}>${label}</span>`;
  return btn(`mm-echip mm-k-${ENTITY_TYPES.has(e.type) ? e.type : 'term'}`, `mm:b${blk}:f:${e.id}`, label, { title: tip });
}

function itemMeta(vm, t, ctx) {
  const parts = [kindLabel(vm.kind, t), dayOf(vm, ctx)];
  if (vm.app) parts.push(oneLine(vm.app));
  if (vm.kind === 'action') {
    if (vm.status === 'done' && vm.doneAt) parts.push(doneText(vm.doneAt, { t, locale: ctx.locale, now: ctx.now }));
    else if (vm.dueAt && vm.status !== 'done') parts.push(dueText(vm.dueAt, { now: ctx.now ?? Date.now(), t, locale: ctx.locale || 'en' }));
    if (vm.owner && vm.owner.id !== 'me' && vm.owner.name) parts.push(t('card.owner', { name: vm.owner.name }));
    const state = actionState(vm, t);
    if (state) parts.push(state);
  }
  return joinSep(parts, t);
}

/** Card for one item: text, entities, actions, parent, related, and its controls. */
export function renderItemCard(vm, ctx = {}) {
  const t = tOf(ctx);
  const b = blockOf(ctx, 'item', vm?.id);
  const nav = ctx.canReformat !== false && ctx.canNavigate !== false;
  const open = `<div${attr('class', blockClass(b))} role="group"${attr('aria-label', t('card.aria'))}>`;
  if (!vm || !vm.id) {
    const msg = vm?.private ? `${LOCK} ${t('cite.private')}` : t('card.item_missing');
    return `${open}<span class="mm-muted">${esc(msg)}</span></div>`;
  }
  const title = oneLine(vm.title) || '…';
  const parts = [];
  parts.push(`<div class="mm-head">${iconHtml(itemIcon(vm), 'mm-hi')}<strong class="mm-title"${attr('title', title)}>${esc(clip(title, 120))}</strong>${vm.private ? `<span class="mm-badge">${esc(t('card.private_badge'))}</span>` : ''}</div>`);
  parts.push(`<small class="mm-meta">${esc(itemMeta(vm, t, ctx))}</small>`);
  if (vm.summary && oneLine(vm.summary) !== oneLine(vm.text)) parts.push(`<div class="mm-summary">${esc(vm.summary)}</div>`);
  const [head, rest] = splitText(vm.text);
  if (head.trim()) parts.push(`<div class="mm-text">${esc(head)}${rest ? '…' : ''}</div>`);
  if (rest) parts.push(`<details class="mm-more"><summary>${esc(t('card.show_more'))}</summary><div class="mm-text">${esc(rest)}</div></details>`);
  const where = vm.url || vm.path;
  if (where) parts.push(`<div class="mm-where" dir="ltr"${attr('title', where)}>${esc(clip(where, 140))}</div>`);
  const chips = (vm.entities || []).map((e) => entityChip(e, b.blk, t, nav)).join('');
  if (chips) parts.push(`<div class="mm-chips">${chips}</div>`);
  if (vm.actions?.length) {
    const rows = vm.actions.map((a) => actionRow(a, { t, ctx, buttons: nav ? actionButtons(a, t, { full: true }) : '' })).join('');
    if (rows) parts.push(`<div class="mm-sec"><small class="mm-cap">${esc(t('card.actions'))}</small><ul class="mm-acts">${rows}</ul></div>`);
  }
  if (vm.parent?.id) parts.push(`<div class="mm-sec mm-parent"><small class="mm-cap">${esc(t('card.from'))}</small>${relatedChip(vm.parent, b.blk, t, ctx, nav)}</div>`);
  // Its own actions and parent are listed above; don't repeat them.
  const shown = new Set([vm.id, vm.parent?.id, ...(vm.actions || []).map((a) => a?.id)]);
  const related = (vm.related || []).filter((c) => c?.id && !shown.has(c.id)).slice(0, 5);
  if (related.length) {
    parts.push(`<div class="mm-rels"><small class="mm-cap">${esc(t('card.related'))}</small>${related.map((c) => relatedChip(c, b.blk, t, ctx, nav)).join('')}</div>`);
  }
  const buttons = [];
  if (canOpen(vm)) buttons.push(btn('mm-btn mm-btn-primary', `mm:a:open:${vm.id}`, esc(t('card.open'))));
  if (nav) buttons.push(btn('mm-btn', `mm:b${b.blk}:map`, esc(t('card.map'))));
  if (nav && vm.kind === 'action') buttons.push(actionButtons(vm, t, { full: true }));
  if (nav) {
    buttons.push(vm.private
      ? btn('mm-btn', `mm:a:share:${vm.id}`, esc(t('card.make_shareable')))
      : btn('mm-btn', `mm:a:private:${vm.id}`, esc(t('card.make_private'))));
    buttons.push(btn('mm-btn mm-btn-danger', `mm:a:delete:${vm.id}`, esc(t('card.delete'))));
  }
  const row = buttons.filter(Boolean).join('');
  if (row) parts.push(`<div class="mm-btns">${row}</div>`);
  return `${open}${parts.join('')}</div>`;
}

function canOpen(vm) {
  if (!ITEM_ID.test(String(vm?.id || ''))) return false;
  return isHttp(vm.url) || vm.kind === 'doc' || vm.kind === 'link';
}

// --- Map card (SPEC §9) ------------------------------------------------------------------

const ARROWS = { up: '↑', down: '↓', left: '←', right: '→' };
// Node labels wrap to two clamped lines (styles.css), so the cap is the
// longest label that can still fit them; the full text is in title and
// aria-label.
const NODE_LABEL = 40;

function nodeLabel(node, t) {
  if (node.group === 'more') return node.wrap ? t('map.more_first') : t('map.more', { n: node.more });
  if (node.group === 'stat') return node.ref === 'review' ? t('map.stat_review', { n: node.count }) : t('map.stat_actions', { n: node.count });
  return oneLine(node.label) || '…';
}

function nodeIcon(node) {
  if (node.group === 'more') return '';
  if (node.group === 'stat') return node.ref === 'review' ? KIND_ICONS.action_suggested : KIND_ICONS.action;
  const icon = itemIcon(node);
  if (!node.private) return icon;
  return node.kind === 'action' ? `${icon}${LOCK}` : LOCK;
}

function nodeStates(node, t) {
  const states = [];
  if (node.kind === 'action' && node.group === 'item') {
    if (node.status === 'done') states.push(t('map.state_done'));
    else if (node.suggested) states.push(t('map.state_suggested'));
    else states.push(t('map.state_open'));
  }
  if (node.private) states.push(t('map.state_private'));
  return states.join(', ');
}

function nodeKindName(node, t) {
  return node.group === 'entity' ? etypeLabel(node.kind, t) : kindLabel(node.kind, t);
}

function nodeAria(node, lane, t) {
  if (node.group === 'more') {
    const name = laneName(lane.role, t);
    return node.wrap ? t('map.more_first_aria', { lane: name }) : t('map.more_aria', { n: node.more, lane: name });
  }
  const label = nodeLabel(node, t);
  if (node.group === 'stat') return label;
  const state = nodeStates(node, t);
  const kind = nodeKindName(node, t);
  return state ? t('map.node_state', { kind, label, state }) : t('map.node', { kind, label });
}

function nodeSub(node, t, ctx) {
  if (node.group === 'entity') return etypeLabel(node.kind, t);
  if (node.group !== 'item') return '';
  const parts = [kindLabel(node.kind, t)];
  if (node.at) parts.push(fmtDay(node.at, ctx.locale || 'en', { now: ctx.now }));
  if (node.kind === 'action' && node.status === 'open' && node.dueAt) parts.push(dueText(node.dueAt, { now: ctx.now ?? Date.now(), t, locale: ctx.locale || 'en' }));
  return joinSep(parts, t);
}

function nodeAction(node, blk) {
  if (node.group === 'more') return `mm:b${blk}:more:${node.lane}`;
  if ((node.group === 'item' || node.group === 'entity') && MAP_REF.test(String(node.ref))) return `mm:b${blk}:f:${node.ref}`;
  return null;
}

function nodeHtml(node, lanes, blk, nav, t, ctx) {
  const lane = lanes[node.lane] || { role: '' };
  const label = nodeLabel(node, t);
  const icon = nodeIcon(node);
  const cls = ['mm-node', `mm-g-${node.group}`, `mm-k-${node.kind}`, `mm-s-${node.slot}`, `mm-sz-${node.size || 's'}`, `mm-w-${node.w || 's'}`, `mm-x-${node.x}`, `mm-y-${node.y}`];
  if (node.status) cls.push(`mm-st-${node.status}`);
  if (node.suggested) cls.push('mm-sug');
  if (node.private) cls.push('mm-priv');
  const sub = nodeSub(node, t, ctx);
  let title = sub ? `${label} — ${sub}` : label;
  if (node.group === 'stat') title = `${label} — ${t('map.stat_hint', { cmd: `${ctx.trigger || 'mm'} ${node.ref === 'review' ? 'review' : 'actions'}` })}`;
  // The icon sits inside the label so a wrapped second line gets the full width.
  const inner = `<span class="mm-nl">${iconHtml(icon)}${esc(node.group === 'item' || node.group === 'entity' ? clip(label, NODE_LABEL) : label)}</span>`;
  const action = nav ? nodeAction(node, blk) : null;
  if (!action) return `<span${attr('class', cls.join(' '))}${attr('title', title)}>${inner}</span>`;
  return btn(cls.join(' '), action, inner, { title, aria: nodeAria(node, lane, t) });
}

function highlight(text, terms) {
  const words = (terms || []).map((w) => String(w || '').trim()).filter((w) => w.length > 1);
  if (!words.length) return esc(text);
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return String(text).split(pattern).map((part, i) => (i % 2 ? `<strong class="mm-hl">${esc(part)}</strong>` : esc(part))).join('');
}

function countsLine(counts, t) {
  if (!counts) return '';
  const parts = [];
  if (counts.actions) parts.push(t('map.count_actions', { n: counts.actions }));
  if (counts.suggested) parts.push(t('map.count_suggested', { n: counts.suggested }));
  if (counts.docs) parts.push(t('map.count_docs', { n: counts.docs }));
  if (counts.notes) parts.push(t('map.count_notes', { n: counts.notes }));
  return joinSep(parts, t);
}

function centerLabel(center, t) {
  if (!center) return '';
  if (center.group === 'overview') return t('map.overview');
  return oneLine(center.label) || '…';
}

function centerButtons(center, nav, t) {
  if (center.group !== 'item' || !ITEM_ID.test(String(center.ref))) return '';
  const out = [];
  if (isHttp(center.url) || center.kind === 'doc' || center.kind === 'link') out.push(btn('mm-btn mm-btn-primary', `mm:a:open:${center.ref}`, esc(t('card.open'))));
  if (nav && center.kind === 'action') out.push(actionButtons({ id: center.ref, status: center.status, suggested: center.suggested }, t, { full: true }));
  return out.join('');
}

function centerHtml(neigh, nav, t, ctx) {
  const c = neigh.center || {};
  const cls = ['mm-center', `mm-g-${c.group || 'overview'}`, `mm-k-${c.kind || 'overview'}`];
  if (c.status) cls.push(`mm-st-${c.status}`);
  if (c.suggested) cls.push('mm-sug');
  if (c.private) cls.push('mm-priv');
  const trigger = ctx.trigger || 'mm';
  let title;
  let meta = '';
  let snip = '';
  if (c.group === 'overview') {
    const counts = c.counts || {};
    const hasData = Object.values(counts).some((v) => Number(v) > 0);
    title = `🧠 ${hasData ? t('map.your_map') : t('map.empty_title')}`;
    // Open actions have their own node in the lane below, so the centre
    // only counts what's in the map.
    meta = hasData
      ? joinSep([counts.items ? t('map.count_items', { n: counts.items }) : '', counts.entities ? t('map.count_entities', { n: counts.entities }) : ''], t)
      : t('map.empty_hint', { capture: `${trigger}+` });
    return `<div${attr('class', cls.join(' '))}><strong class="mm-c-title">${esc(title)}</strong><small class="mm-c-meta">${esc(meta)}</small></div>`;
  }
  const icon = c.private ? (c.kind === 'action' ? `${itemIcon(c)}${LOCK}` : LOCK) : itemIcon(c);
  const label = oneLine(c.label) || '…';
  if (c.group === 'entity') {
    meta = etypeLabel(c.kind, t);
    snip = countsLine(c.counts, t);
  } else if (c.kind === 'action') {
    // What matters about an action is when it's due (or when it was done).
    const parts = [];
    const now = ctx.now ?? Date.now();
    if (c.status === 'done' && c.doneAt) parts.push(doneText(c.doneAt, { now, t, locale: ctx.locale || 'en' }));
    else if (c.status === 'open' && c.dueAt) parts.push(dueText(c.dueAt, { now, t, locale: ctx.locale || 'en' }));
    else parts.push(kindLabel(c.kind, t), fmtDay(c.day, ctx.locale || 'en', { now: ctx.now }));
    if (c.suggested) parts.push(t('card.suggested'));
    meta = joinSep(parts, t);
    snip = clip(cleanSnippet(c.snippet, c.label), 180);
  } else {
    const parts = [kindLabel(c.kind, t), fmtDay(c.day, ctx.locale || 'en', { now: ctx.now })];
    if (c.app) parts.push(oneLine(c.app));
    meta = joinSep(parts, t);
    snip = clip(cleanSnippet(c.snippet, c.label), 180);
  }
  if (snip && snip.toLowerCase() === label.toLowerCase()) snip = '';
  const buttons = centerButtons(c, nav, t);
  const snipHtml = snip ? `<span class="mm-c-snip">${c.group === 'item' ? highlight(snip, c.highlight) : esc(snip)}</span>` : '';
  return `<div${attr('class', cls.join(' '))}><strong class="mm-c-title"${attr('title', label)}>${iconHtml(icon, 'mm-ci')} ${esc(label)}</strong><small class="mm-c-meta">${esc(meta)}</small>${snipHtml}${buttons ? `<span class="mm-c-btns">${buttons}</span>` : ''}</div>`;
}

function edgeHtml(e) {
  const cls = ['mm-e', `mm-e-${e.lane}`, `mm-e-g-${e.group}`, `mm-e-k-${e.kind}`];
  if (e.style === 'dashed') cls.push('mm-e-dash');
  return `<line x1="50%" y1="50%"${attr('x2', `${e.x2}%`)}${attr('y2', `${e.y2}%`)}${attr('class', cls.join(' '))}></line>`;
}

function stageHtml(neigh, placed, blk, nav, t, ctx) {
  const edges = placed.edges.map(edgeHtml).join('');
  const nodes = placed.nodes.map((n) => nodeHtml(n, neigh.lanes, blk, nav, t, ctx)).join('');
  const hints = placed.hints.map((h) => `<span${attr('class', `mm-hint mm-x-${h.x} mm-y-${h.y}`)}>${esc(laneEmpty(h.role, t))}</span>`).join('');
  return `<div class="mm-stage"><svg class="mm-edges" role="presentation">${edges}</svg>${centerHtml(neigh, nav, t, ctx)}${nodes}${hints}</div>`;
}

function listItem(node, lane, blk, nav, t, ctx) {
  const label = nodeLabel(node, t);
  const icon = nodeIcon(node);
  const inner = `${iconHtml(icon)}<span class="mm-nl">${esc(label)}</span>`;
  const action = nav ? nodeAction({ ...node, lane }, blk) : null;
  const cls = `mm-li mm-g-${node.group} mm-k-${node.kind}${node.status ? ` mm-st-${node.status}` : ''}`;
  const head = action ? btn(cls, action, inner, { aria: nodeAria(node, { role: node.role }, t) }) : `<span${attr('class', cls)}>${inner}</span>`;
  const sub = nodeSub(node, t, ctx);
  return `<li>${head}${sub ? ` <small class="mm-meta">${esc(sub)}</small>` : ''}</li>`;
}

function listHtml(neigh, ui, blk, nav, t, ctx) {
  const c = neigh.center || {};
  const centerLine = c.group === 'overview'
    ? `🧠 ${t('map.overview')}`
    : `${c.private ? LOCK : itemIcon(c)} ${oneLine(c.label) || '…'}`;
  const secs = LANES.map((lane) => {
    const data = neigh.lanes?.[lane] || { role: '', nodes: [] };
    const items = (data.nodes || []).map((n) => listItem({ ...n, role: data.role }, lane, blk, nav, t, ctx)).join('');
    const body = items ? `<ul>${items}</ul>` : `<small class="mm-muted">${esc(laneEmpty(data.role, t))}</small>`;
    return `<div class="mm-list-sec"><strong class="mm-cap">${esc(laneName(data.role, t))}</strong>${body}</div>`;
  }).join('');
  return `<details class="mm-list"${ui.mode === 'list' ? ' open' : ''}><summary>${esc(t('map.list_summary'))}</summary><div class="mm-list-center">${esc(centerLine)}</div>${secs}</details>`;
}

function crumbLabel(entry, ctx, t) {
  if (entry.ref === 'o') return t('map.overview');
  const name = entry.label || safe(() => ctx.nameOf?.(entry.ref)) || '…';
  return clip(oneLine(name), 22);
}

function barHtml(ui, current, blk, nav, rtl, t, ctx) {
  const history = ui.history.length ? ui.history : [{ ref: current }];
  const shown = history.slice(-3);
  const sep = `<span class="mm-sep">${rtl ? '‹' : '›'}</span>`;
  const crumbs = shown.map((h, i) => {
    const label = esc(crumbLabel(h, ctx, t));
    if (i === shown.length - 1) return `<strong class="mm-crumb mm-cur">${label}</strong>`;
    return nav && MAP_REF.test(h.ref) ? btn('mm-crumb', `mm:b${blk}:f:${h.ref}`, label) : `<span class="mm-crumb">${label}</span>`;
  });
  const lead = history.length > shown.length ? `<span class="mm-crumb mm-muted">…</span>${sep}` : '';
  const tools = [];
  if (nav) {
    if (history.length > 1 || ui.origin) tools.push(btn('mm-tool', `mm:b${blk}:back`, `${rtl ? '→' : '←'} ${esc(t('map.back'))}`));
    if (current !== 'o') tools.push(btn('mm-tool', `mm:b${blk}:home`, `⌂ ${esc(t('map.home'))}`));
    tools.push(ui.mode === 'list'
      ? btn('mm-tool', `mm:b${blk}:mode:map`, `◎ ${esc(t('map.map'))}`)
      : btn('mm-tool', `mm:b${blk}:mode:list`, `☰ ${esc(t('map.list'))}`));
  }
  return `<div class="mm-bar"><span class="mm-trail" role="navigation"${attr('aria-label', t('map.trail'))}><span class="mm-brand">🧠</span>${lead}${crumbs.join(sep)}</span>${tools.length ? `<span class="mm-tools">${tools.join('')}</span>` : ''}</div>`;
}

function legendHtml(neigh, rtl, t) {
  return LANES.map((lane) => {
    const role = neigh.lanes?.[lane]?.role || '';
    const side = rtl && lane === 'left' ? 'right' : rtl && lane === 'right' ? 'left' : lane;
    return `<span${attr('class', `mm-lg mm-lg-${role}`)}>${ARROWS[side]} ${esc(laneName(role, t))}</span>`;
  }).join('');
}

/**
 * The map card (SPEC §9).
 * ui = { blk, rev, dataRev, history:[{ref,label}], mode:'map'|'list', canNavigate, origin?, dock? }
 * ctx = { t, locale, rtl, now, trigger, nameOf }
 */
export function renderMapCard(neigh, ui = {}, ctx = {}) {
  const t = tOf(ctx);
  const rtl = !!ctx.rtl;
  const nav = ui.canNavigate !== false;
  const view = { ...ui, history: Array.isArray(ui.history) ? ui.history.filter((h) => h && MAP_REF.test(String(h.ref))) : [] };
  const current = view.history.length ? view.history[view.history.length - 1].ref : (neigh?.center?.ref && MAP_REF.test(neigh.center.ref) ? neigh.center.ref : 'o');
  const b = blockOf({ block: { ...ui, ref: current } }, 'map', current);
  b.mode = view.mode;
  const dir = rtl ? ' dir="rtl"' : '';
  if (!neigh) {
    const home = nav && current !== 'o' ? `<div class="mm-btns">${btn('mm-btn', `mm:b${b.blk}:home`, `⌂ ${esc(t('map.home'))}`)}</div>` : '';
    return `<div${attr('class', blockClass(b))} role="group"${attr('aria-label', t('map.aria_overview'))}${dir}><span class="mm-muted">${esc(t('map.missing'))}</span>${home}</div>`;
  }
  const isOverview = neigh.focus?.type === 'overview' || neigh.center?.group === 'overview';
  const name = centerLabel(neigh.center, t);
  const typeName = neigh.center?.group === 'entity' ? etypeLabel(neigh.center.kind, t) : '';
  const aria = isOverview ? t('map.aria_overview') : t('map.aria', { name: typeName ? t('chip.entity', { name, type: typeName }) : name });
  const placed = layout(neigh, { rtl });
  const parts = [];
  if (view.mode !== 'list') parts.push(stageHtml(neigh, placed, b.blk, nav, t, ctx));
  parts.push(listHtml(neigh, view, b.blk, nav, t, ctx));
  parts.push(barHtml(view, current, b.blk, nav, rtl, t, ctx));
  const foot = [];
  if (view.mode !== 'list') foot.push(`<span class="mm-legend">${legendHtml(neigh, rtl, t)}</span>`);
  if (!nav) foot.push(`<small class="mm-static">${esc(t('map.static', { cmd: `${ctx.trigger || 'mm'} @name` }))}</small>`);
  if (foot.length) parts.push(`<div class="mm-foot">${foot.join('')}</div>`);
  return `<div${attr('class', blockClass(b))} role="group"${attr('aria-label', aria)}${dir}>${parts.join('')}</div>`;
}

// --- Help card ---------------------------------------------------------------------------

/** Static syntax reference. */
export function renderHelpCard(ctx = {}) {
  const t = tOf(ctx);
  const b = blockOf(ctx, 'help', null);
  b.ref = null;
  const m = ctx.trigger || 'mm';
  const rows = [
    [`${m}+ …`, t('help.capture')],
    [`${m}+`, t('help.capture_window')],
    [`${m} …`, t('help.find')],
    [`${m} actions @team`, t('help.actions')],
    [`${m} review`, t('help.review')],
    [`${m} @name · ${m} #topic`, t('help.entity')],
    [`${m} map @name`, t('help.map')],
    [`${m}? …`, t('help.ask')],
    [`${m} recent`, t('help.recent')],
    [`${m} undo`, t('help.undo')],
    [`${m}+ ! …  ·  #private`, t('help.private')],
  ];
  const filters = ['kind:doc,link', 'when:last-week', 'when:2026-10-26..2026-11-01', 'due:this-week', '@name', '#topic', 'is:open|done|suggested|overdue|private', 'owner:me|anyone|name', '"exact phrase"', '-word'];
  const list = rows.map(([syntax, text]) => `<li><span class="mm-code" dir="ltr">${esc(syntax)}</span><span class="mm-help-d">${esc(text)}</span></li>`).join('');
  const chips = filters.map((f) => `<span class="mm-code" dir="ltr">${esc(f)}</span>`).join('');
  return `<div${attr('class', blockClass(b))} role="group"${attr('aria-label', t('help.title'))}><strong class="mm-title">🧠 ${esc(t('help.title'))}</strong><ul class="mm-help">${list}</ul><small class="mm-cap">${esc(t('help.filters'))}</small><div class="mm-chips">${chips}</div></div>`;
}

// --- UI actions (ARCHITECTURE §7.2) ------------------------------------------------------

const DATA_VERBS = new Set(['done', 'reopen', 'accept', 'dismiss', 'undo', 'open', 'private', 'share', 'delete']);
const A_RE = /^mm:a:([a-z]+):([a-z0-9]{15})$/;
const B_RE = /^mm:b([0-9a-z]{1,12}):(f|back|home|more|mode|map)(?::([a-z0-9]{1,15}))?$/;
const C_RE = /^mm:c([0-9a-z]{1,12}):(x|map):([a-z0-9:]{2,24})$/;

/** Parse a data-ext-action id. Returns null for anything outside the grammar. */
export function parseAction(actionId) {
  if (typeof actionId !== 'string' || actionId.length > 64) return null;
  let m = A_RE.exec(actionId);
  if (m) {
    const [, verb, id] = m;
    if (!DATA_VERBS.has(verb)) return null;
    if (verb === 'undo' ? !OP_ID.test(id) : !ITEM_ID.test(id)) return null;
    return { scope: 'data', verb, id };
  }
  m = B_RE.exec(actionId);
  if (m) {
    const [, blk, verb, arg] = m;
    if (verb === 'f') return arg && MAP_REF.test(arg) ? { scope: 'block', blk, verb: 'focus', ref: arg } : null;
    if (verb === 'more') return arg && LANES.includes(arg) ? { scope: 'block', blk, verb: 'more', lane: arg } : null;
    if (verb === 'mode') return arg === 'map' || arg === 'list' ? { scope: 'block', blk, verb: 'mode', mode: arg } : null;
    return arg === undefined ? { scope: 'block', blk, verb } : null;
  }
  m = C_RE.exec(actionId);
  if (m) {
    const [, msg, verb, arg] = m;
    if (verb === 'map') return CITE_ID.test(arg) ? { scope: 'cite', msg, verb: 'dock', id: arg } : null;
    const x = /^([1-9][0-9]{0,3}):(.+)$/.exec(arg);
    if (!x || !CITE_ID.test(x[2])) return null;
    return { scope: 'cite', msg, verb: 'expand', n: Number(x[1]), id: x[2] };
  }
  return null;
}

const MAX_HISTORY = 20;
const MAX_STATE = 300;

/** A fresh per-window formatter state. `start` seeds the block/message counter. */
export function createFormatterState({ start = 1 } = {}) {
  return { blocks: new Map(), msgs: new Map(), next: Math.max(1, Math.trunc(Number(start) || 1)), loading: false };
}

// Seeded from the clock so a reloaded sandbox never reuses the counters of
// cards still on screen from before the reload.
export const ui = createFormatterState({ start: Date.now() });

function alloc(state) {
  const id = state.next.toString(36);
  state.next += 1;
  return id;
}

function seen(state, id36) {
  const n = parseInt(id36, 36);
  if (Number.isFinite(n) && n >= state.next) state.next = n + 1;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_STATE) map.delete(map.keys().next().value);
  return value;
}

function newBlockState(blk, type, ref) {
  return {
    blk,
    type,
    ref: type === 'map' ? null : ref || null,
    rev: 1,
    history: type === 'map' ? [{ ref: ref || 'o' }] : [],
    page: {},
    mode: 'map',
    origin: null,
    itemId: type === 'item' ? ref : null,
    dock: false,
    refs: null,
    stub: false,
    pending: [],
  };
}

function currentRef(st) {
  if (st.type === 'map') return st.history[st.history.length - 1]?.ref || 'o';
  return st.ref;
}

function navigate(st, ref) {
  const cur = currentRef(st);
  if (st.history.length && cur === ref) return false;
  const at = st.history.findIndex((h) => h.ref === ref);
  if (at >= 0) st.history.length = at + 1;
  else st.history.push({ ref });
  while (st.history.length > MAX_HISTORY) st.history.shift();
  st.page = {};
  return true;
}

function toMap(st) {
  const base = st.type === 'item' ? st.ref : st.itemId;
  st.origin = { type: st.type, ref: st.ref, itemId: st.itemId };
  st.type = 'map';
  st.history = base && MAP_REF.test(base) ? [{ ref: base }] : [];
  st.page = {};
  st.mode = 'map';
}

function blockAction(st, p) {
  switch (p.verb) {
    case 'focus':
      if (st.type !== 'map') {
        toMap(st);
        navigate(st, p.ref);
        return true;
      }
      return navigate(st, p.ref);
    case 'map':
      if (st.type === 'map' || st.type === 'help') return false;
      toMap(st);
      if (!st.history.length) st.history.push({ ref: 'o' });
      return true;
    case 'home':
      if (st.type !== 'map') {
        toMap(st);
        navigate(st, 'o');
        return true;
      }
      return navigate(st, 'o');
    case 'back':
      if (st.type !== 'map') return false;
      if (st.history.length > 1) {
        st.history.pop();
        st.page = {};
        return true;
      }
      if (st.origin) {
        st.type = st.origin.type;
        st.ref = st.origin.ref;
        st.itemId = st.origin.itemId;
        st.origin = null;
        st.history = [];
        return true;
      }
      return false;
    case 'more':
      if (st.type !== 'map') return false;
      st.page = { ...st.page, [p.lane]: (Number(st.page[p.lane]) || 0) + 1 };
      return true;
    case 'mode':
      if (st.type !== 'map' || st.mode === p.mode) return false;
      st.mode = p.mode;
      return true;
    default:
      return false;
  }
}

/**
 * Apply a parsed block/cite action to the formatter state. Data actions
 * (`mm:a:*`) belong to mind.js and are ignored here.
 * @returns {{changed: boolean}}
 */
export function applyUiAction(state, parsed) {
  if (!state || !parsed) return { changed: false };
  if (parsed.scope === 'block') {
    let st = state.blocks.get(parsed.blk);
    if (!st) {
      // The module state was lost (sandbox reload); the card is still on
      // screen. Queue the action until the formatter sees the card again.
      st = remember(state.blocks, parsed.blk, { ...newBlockState(parsed.blk, 'map', 'o'), stub: true });
      st.pending.push(parsed);
      seen(state, parsed.blk);
      return { changed: true };
    }
    if (st.stub) {
      st.pending.push(parsed);
      return { changed: true };
    }
    const changed = blockAction(st, parsed);
    if (changed) st.rev += 1;
    return { changed };
  }
  if (parsed.scope === 'cite') {
    let ms = state.msgs.get(parsed.msg);
    if (!ms) {
      ms = remember(state.msgs, parsed.msg, { rev: 1, expanded: new Set(), dockBlk: null, stub: true });
      seen(state, parsed.msg);
    }
    if (parsed.verb === 'expand') {
      if (ms.expanded.has(parsed.n)) ms.expanded.delete(parsed.n);
      else ms.expanded.add(parsed.n);
      ms.rev += 1;
      return { changed: true };
    }
    if (parsed.verb === 'dock') {
      const docked = ms.dockBlk ? state.blocks.get(ms.dockBlk) : null;
      if (docked && !docked.stub) {
        if (docked.type !== 'map') toMap(docked);
        const changed = navigate(docked, parsed.id);
        if (changed) docked.rev += 1;
        return { changed };
      }
      const blk = alloc(state);
      const st = remember(state.blocks, blk, newBlockState(blk, 'map', parsed.id));
      st.dock = true;
      ms.dockBlk = blk;
      ms.rev += 1;
      return { changed: true };
    }
  }
  return { changed: false };
}

// --- Formatter core (SPEC §10) ------------------------------------------------------------

const BLOCK_WORDS = new Set(['mm-block', 'mm-dock', 'mm-wait', 'mm-mode-list']);

function blockInfo(el) {
  return classInfo(el.getAttribute('class'));
}

function classInfo(classes) {
  const info = { blk: null, rev: null, data: null, type: null, ref: null, dock: false, wait: false, list: false };
  for (const c of String(classes || '').split(/\s+/)) {
    if (c === 'mm-dock') info.dock = true;
    else if (c === 'mm-wait') info.wait = true;
    else if (c === 'mm-mode-list') info.list = true;
    if (BLOCK_WORDS.has(c)) continue;
    let m;
    if ((m = /^mm-t-(op|item|map|help)$/.exec(c))) info.type = m[1];
    else if ((m = /^mm-f-(o|me|[ieo][0-9a-z]{14})$/.exec(c))) info.ref = m[1];
    else if ((m = /^mm-b([0-9a-z]{1,12})$/.exec(c))) info.blk = m[1];
    else if ((m = /^mm-r([0-9a-z]{1,12})$/.exec(c))) info.rev = m[1];
    else if ((m = /^mm-d([0-9a-z]{1,12})$/.exec(c))) info.data = m[1];
  }
  if (!info.blk || !info.rev || !info.type) return null;
  return info;
}

function rebuildBlock(info) {
  const st = newBlockState(info.blk, info.type, info.ref || (info.type === 'map' ? 'o' : null));
  st.rev = parseInt(info.rev, 36) || 1;
  st.mode = info.list ? 'list' : 'map';
  st.dock = info.dock;
  return st;
}

function syncBlock(state, info) {
  seen(state, info.blk);
  const st = state.blocks.get(info.blk);
  if (st && !st.stub) return st;
  const base = rebuildBlock(info);
  if (st?.stub) {
    for (const p of st.pending) blockAction(base, p);
    base.rev = Math.max(parseInt(info.rev, 36) || 0, st.rev) + 1;
  }
  return remember(state.blocks, info.blk, base);
}

function blockStale(st, info, env) {
  if (st.rev.toString(36) !== info.rev) return true;
  if (!env.loaded) return false;
  if (info.wait) return true;
  if (info.data !== env.dataRev) {
    if (st.refs && typeof env.port.changedSince === 'function') {
      return !!safe(() => env.port.changedSince(parseInt(info.data, 36) || 0, [...st.refs]), true);
    }
    return true;
  }
  return false;
}

function focusOf(ref) {
  if (ref === 'o') return { type: 'overview' };
  if (ENTITY_ID.test(ref)) return { type: 'entity', id: ref };
  return { type: 'item', id: ref };
}

function collectRefs(vmRefs) {
  const out = new Set();
  for (const r of vmRefs) if (typeof r === 'string' && r) out.add(r);
  return out;
}

function renderBlock(st, env) {
  const ref = currentRef(st);
  const block = { blk: st.blk, rev: st.rev.toString(36), dataRev: env.dataRev, ref, dock: st.dock, mode: st.mode };
  if (!env.loaded) {
    env.waiting = true;
    const t = env.t;
    return `<div${attr('class', blockClass({ ...block, type: st.type, wait: true }))} role="group"${attr('aria-label', t('card.aria'))}><span class="mm-muted mm-loading">${esc(t('card.loading'))}</span></div>`;
  }
  const port = env.port;
  const ctx = { ...env.ctx, block };
  switch (st.type) {
    case 'op': {
      const vm = safe(() => port.op(st.ref));
      st.itemId = vm?.item?.id || null;
      st.refs = vm ? collectRefs([vm.item?.id, ...(vm.actions || []).map((a) => a?.id), ...(vm.related || []).map((c) => c?.id), ...(vm.entities || []).map((e) => e?.id)]) : null;
      return renderOpCard(vm, ctx);
    }
    case 'item': {
      const vm = safe(() => port.item(st.ref));
      st.refs = vm ? collectRefs([vm.id, vm.parent?.id, ...(vm.actions || []).map((a) => a?.id), ...(vm.related || []).map((c) => c?.id), ...(vm.entities || []).map((e) => e?.id)]) : null;
      return renderItemCard(vm, ctx);
    }
    case 'map': {
      const neigh = safe(() => port.map(focusOf(ref), { ...st.page }));
      if (neigh?.lanes) {
        const top = st.history[st.history.length - 1];
        if (top) top.label = centerLabel(neigh.center, env.t);
        st.refs = collectRefs([neigh.center?.ref, ...LANES.flatMap((l) => (neigh.lanes[l]?.nodes || []).map((n) => n.ref))]);
      } else {
        st.refs = null;
      }
      return renderMapCard(neigh?.lanes ? neigh : null, { ...block, history: st.history, mode: st.mode, canNavigate: env.canNavigate, origin: !!st.origin }, ctx);
    }
    case 'help':
      st.refs = new Set();
      return renderHelpCard(ctx);
    default:
      return '';
  }
}

function newBlock(state, type, ref) {
  const blk = alloc(state);
  return remember(state.blocks, blk, newBlockState(blk, type, ref));
}

function fragmentOf(doc, markup) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = markup;
  return tpl.content;
}

function cardMarker(text) {
  const m = CARD_ONLY.exec(text.trim());
  if (!m) return null;
  const [, type, ref] = m;
  if (type === 'help') return ref ? null : { type, ref: null };
  if (type === 'op') return ref && OP_ID.test(ref) ? { type, ref } : null;
  if (type === 'item') return ref && ITEM_ID.test(ref) ? { type, ref } : null;
  if (ref && OP_ID.test(ref)) return null;
  return { type, ref: ref || 'o' };
}

// A card marker must be the only content of its paragraph. A display line
// joined to it by a single newline ("…\n[mm-card:…]") arrives as
// "<p>line<br>[mm-card:…]</p>" — the marker after the last <br> counts too.
function cardParagraph(p) {
  if (!p.querySelector('*:not(br)')) {
    const whole = cardMarker(p.textContent || '');
    if (whole) return { ...whole, mode: 'whole' };
  }
  const kids = Array.from(p.childNodes);
  let i = kids.length - 1;
  while (i >= 0 && kids[i].nodeType === 3 && !kids[i].textContent.trim()) i--;
  const last = kids[i];
  if (!last || last.nodeType !== 3) return null;
  let j = i - 1;
  while (j >= 0 && kids[j].nodeType === 3 && !kids[j].textContent.trim()) j--;
  const br = kids[j];
  if (!br || br.nodeType !== 1 || br.tagName !== 'BR') return null;
  const tail = cardMarker(last.textContent || '');
  return tail ? { ...tail, mode: 'tail', nodes: kids.slice(j) } : null;
}

const SKIP_TEXT = 'code, pre, a, button, summary, script, style, textarea, .mm-block, .mm-cite-x';

function rawCites(body) {
  const out = [];
  const doc = body.ownerDocument;
  const walker = doc.createTreeWalker(body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || '';
    if (!text.includes('[mm:')) continue;
    if (node.parentElement?.closest(SKIP_TEXT)) continue;
    CITE_SCAN.lastIndex = 0;
    if (CITE_SCAN.test(text)) out.push(node);
  }
  CITE_SCAN.lastIndex = 0;
  return out;
}

function chipInfo(el) {
  return chipClassInfo(el.getAttribute('class'), el.getAttribute('data-ext-action'));
}

function chipClassInfo(classes, action) {
  const p = parseAction(action || '');
  if (!p || p.scope !== 'cite' || p.verb !== 'expand') return null;
  const info = { msg: p.msg, n: p.n, id: p.id, rev: null, data: null, wait: false };
  for (const c of String(classes || '').split(/\s+/)) {
    let m;
    if (c === 'mm-cite-wait') info.wait = true;
    else if ((m = /^mm-r([0-9a-z]{1,12})$/.exec(c))) info.rev = m[1];
    else if ((m = /^mm-d([0-9a-z]{1,12})$/.exec(c))) info.data = m[1];
  }
  return info;
}

function syncMsg(state, msg, domRev) {
  seen(state, msg);
  let ms = state.msgs.get(msg);
  const dom = domRev ? parseInt(domRev, 36) || 0 : 0;
  if (!ms) return remember(state.msgs, msg, { rev: dom || 1, expanded: new Set(), dockBlk: null, stub: false });
  if (ms.stub) {
    ms.stub = false;
    ms.rev = Math.max(dom, ms.rev) + 1;
  }
  return ms;
}

function chipsStale(infos, ms, env) {
  const rev = ms.rev.toString(36);
  if (infos.some((c) => c.rev !== rev)) return true;
  if (!env.loaded) return false;
  if (infos.some((c) => c.wait)) return true;
  const old = infos.filter((c) => c.data !== env.dataRev);
  if (!old.length) return false;
  if (typeof env.port.changedSince === 'function') {
    return old.some((c) => safe(() => env.port.changedSince(parseInt(c.data, 36) || 0, [c.id]), true));
  }
  return true;
}

function chipHtml(id, n, first, msg, ms, env) {
  const vm = env.loaded ? safe(() => env.port.cite(id)) : undefined;
  if (!env.loaded) env.waiting = true;
  return renderCite(vm === undefined && env.loaded ? null : vm, {
    ...env.ctx,
    id,
    n,
    msg,
    rev: ms.rev.toString(36),
    dataRev: env.dataRev,
    expanded: first && ms.expanded.has(n),
    repeat: !first,
  });
}

function formatCites(doc, body, state, env) {
  const chipEls = Array.from(body.querySelectorAll('button.mm-cite'));
  const infos = [];
  for (const el of chipEls) {
    const info = chipInfo(el);
    if (info) infos.push({ ...info, el });
  }
  const raw = rawCites(body);
  if (!infos.length && !raw.length) return false;
  const msg = infos[0]?.msg || alloc(state);
  const ms = syncMsg(state, msg, infos[0]?.rev);
  if (!ms.dockBlk) {
    // After a reload, adopt the map already docked in this message.
    const docked = body.querySelector('div.mm-block.mm-dock');
    const blk = docked ? blockInfo(docked)?.blk : null;
    if (blk && state.blocks.has(blk)) ms.dockBlk = blk;
  }
  const mine = infos.filter((c) => c.msg === msg);
  let changed = false;
  const firstSeen = new Set();
  const nums = new Map();
  let maxN = 0;
  for (const c of mine) {
    if (!nums.has(c.id)) nums.set(c.id, c.n);
    maxN = Math.max(maxN, c.n);
  }
  if (mine.length && chipsStale(mine, ms, env)) {
    for (const x of Array.from(body.querySelectorAll('.mm-cite-x'))) {
      if (x.classList.contains(`mm-m${msg}`)) x.remove();
    }
    for (const c of mine) {
      const first = !firstSeen.has(c.n);
      firstSeen.add(c.n);
      c.el.replaceWith(fragmentOf(doc, chipHtml(c.id, c.n, first, msg, ms, env)));
    }
    changed = true;
  } else {
    for (const c of mine) firstSeen.add(c.n);
  }
  for (const node of raw) {
    const text = node.nodeValue;
    let out = '';
    let last = 0;
    CITE_SCAN.lastIndex = 0;
    for (let m = CITE_SCAN.exec(text); m; m = CITE_SCAN.exec(text)) {
      out += esc(text.slice(last, m.index));
      const id = m[1];
      let n = nums.get(id);
      if (!n) {
        n = ++maxN;
        nums.set(id, n);
      }
      const first = !firstSeen.has(n);
      firstSeen.add(n);
      out += chipHtml(id, n, first, msg, ms, env);
      last = m.index + m[0].length;
    }
    CITE_SCAN.lastIndex = 0;
    out += esc(text.slice(last));
    node.replaceWith(fragmentOf(doc, out));
    changed = true;
  }
  if (ms.dockBlk) {
    const st = state.blocks.get(ms.dockBlk);
    if (st && !st.stub && !body.querySelector(`.mm-b${ms.dockBlk}`)) {
      body.appendChild(fragmentOf(doc, renderBlock(st, env)));
      changed = true;
    }
  }
  return changed;
}

const BLOCK_ATTR = /class="(mm-block [^"]*)"/g;
const CHIP_TAG = /<button\b[^>]*\bclass="(mm-cite [^"]*)"[^>]*\bdata-ext-action="([^"]*)"/g;

// Most reformat passes hit messages whose cards and chips are current.
// Decide that from the serialized classes alone, without building a DOM;
// anything unusual (raw markers, unknown state, a pending dock) takes the
// full pass, which is always correct.
function unchanged(html, state, env) {
  if (html.includes('[mm:') || html.includes('[mm-card:')) return false;
  BLOCK_ATTR.lastIndex = 0;
  for (const m of html.matchAll(BLOCK_ATTR)) {
    const info = classInfo(m[1]);
    if (!info) continue;
    const st = state.blocks.get(info.blk);
    if (!st || st.stub || blockStale(st, info, env)) return false;
  }
  const chips = [];
  CHIP_TAG.lastIndex = 0;
  for (const m of html.matchAll(CHIP_TAG)) {
    const info = chipClassInfo(m[1], m[2].replace(/&amp;/g, '&'));
    if (info) chips.push(info);
  }
  if (chips.length) {
    const ms = state.msgs.get(chips[0].msg);
    if (!ms || ms.stub) return false;
    if (chipsStale(chips.filter((c) => c.msg === chips[0].msg), ms, env)) return false;
    if (ms.dockBlk && !html.includes(`mm-b${ms.dockBlk} `)) return false;
  }
  return true;
}

function kickLoad(port, ctx, state) {
  if (state.loading || typeof port?.ensureLoaded !== 'function') return;
  const pending = safe(() => port.ensureLoaded());
  if (!pending || typeof pending.then !== 'function') return;
  state.loading = true;
  pending.then(
    () => {
      state.loading = false;
      if (ctx.canReformat) safe(() => ctx.requestReformat?.());
    },
    () => {
      state.loading = false;
    },
  );
}

/**
 * Turn `[mm:ID]` citations into chips and `[mm-card:…]` paragraphs into
 * cards; refresh cards and chips whose UI or data changed (SPEC §10).
 *
 * ctx = { t, locale, rtl, now?, trigger?, canReformat, requestReformat?, log?, state = ui }
 * @returns {string|null} new body HTML, or null when nothing changed.
 */
export function formatHtml(html, port, ctx = {}) {
  if (typeof html !== 'string' || !QUICK.test(html)) return null;
  try {
    const state = ctx.state || ui;
    const loaded = !!port?.loaded;
    const t = tOf(ctx);
    const env = {
      port: port || {},
      loaded,
      dataRev: loaded ? Math.max(0, Math.trunc(Number(port.rev) || 0)).toString(36) : '0',
      canNavigate: !!ctx.canReformat,
      t,
      waiting: false,
      ctx: {
        t,
        locale: ctx.locale || 'en',
        rtl: !!ctx.rtl,
        now: ctx.now ?? Date.now(),
        trigger: ctx.trigger || 'mm',
        canReformat: !!ctx.canReformat,
        canNavigate: !!ctx.canReformat,
        nameOf: (id) => safe(() => port?.nameOf?.(id)) || '',
      },
    };
    if (unchanged(html, state, env)) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    let changed = false;

    for (const el of Array.from(body.querySelectorAll('div.mm-block'))) {
      const info = blockInfo(el);
      if (!info) continue;
      const st = syncBlock(state, info);
      if (!blockStale(st, info, env)) continue;
      el.replaceWith(fragmentOf(doc, renderBlock(st, env)));
      changed = true;
    }

    for (const p of Array.from(body.querySelectorAll('p'))) {
      if (p.closest('.mm-block')) continue;
      const hit = cardParagraph(p);
      if (!hit) continue;
      const st = newBlock(state, hit.type, hit.ref);
      const frag = fragmentOf(doc, renderBlock(st, env));
      if (hit.mode === 'whole') {
        p.replaceWith(frag);
      } else {
        for (const n of hit.nodes) n.remove();
        p.after(frag);
      }
      changed = true;
    }

    if (formatCites(doc, body, state, env)) changed = true;
    if (env.waiting) kickLoad(port, ctx, state);
    return changed ? body.innerHTML : null;
  } catch (e) {
    safe(() => ctx.log?.warn?.(`mindmap formatter skipped a message: ${e?.name || 'error'}`));
    return null;
  }
}
