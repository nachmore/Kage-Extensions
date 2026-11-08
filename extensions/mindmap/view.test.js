// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neighborhood } from './lib/graph.js';
import {
  ETYPE_ICONS,
  KIND_ICONS,
  applyUiAction,
  createFormatterState,
  doneText,
  dueText,
  escapeHtml,
  fmtDay,
  fmtRange,
  formatHtml,
  interpLabel,
  itemIcon,
  parseAction,
  relaxText,
  renderCite,
  renderHelpCard,
  renderItemCard,
  renderMapCard,
  renderOpCard,
  ui as moduleState,
} from './view.js';

// --- i18n: the WP-C catalog fragment + a small ICU subset (like the host) --

// jsdom replaces the global URL, so resolve paths with node:path.
const HERE = dirname(fileURLToPath(import.meta.url));
// WP-C's fragment (docs/mindmap/i18n/view.en.json) is merged into the EN catalog.
const CATALOG = JSON.parse(readFileSync(join(HERE, '_locales/en/messages.json'), 'utf8'));

function icu(template, vars) {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '{') {
      out += template[i];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < template.length; j++) {
      if (template[j] === '{') depth++;
      else if (template[j] === '}' && --depth === 0) break;
    }
    const inner = template.slice(i + 1, j);
    const [name, kind, ...rest] = inner.split(',');
    if (!kind) out += name.trim() in vars ? String(vars[name.trim()]) : `{${inner}}`;
    else {
      const n = Number(vars[name.trim()]);
      const arms = {};
      const body = rest.join(',');
      for (const m of body.matchAll(/(=?\w+)\s*\{([^{}]*)\}/g)) arms[m[1]] = m[2];
      const arm = arms[`=${n}`] ?? (n === 1 ? arms.one : undefined) ?? arms.other ?? '';
      out += arm.replace(/#/g, String(n));
    }
    i = j;
  }
  return out;
}

const used = new Set();
const t = (key, vars = {}) => {
  used.add(key);
  const tpl = CATALOG[key]?.message;
  return tpl === undefined ? key : icu(tpl, vars);
};
const echo = (key, vars) => (vars && Object.keys(vars).length ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key);

// --- Fixture store (SPEC §3.1 shapes) and a fake DataPort ---------------------

const id = (prefix, n) => `${prefix}${String(n).padStart(14, '0')}`;
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 11, 6, 10);
const E = { bingo: id('e', 1), dana: id('e', 2), mtcs: id('e', 3) };
const I = { f1: id('i', 1), f2: id('i', 2), f6: id('i', 6), a1: id('i', 61), a2: id('i', 62), a3: id('i', 63), a4: id('i', 64), f7: id('i', 7), f9: id('i', 9), f10: id('i', 10), gone: id('i', 99) };
const OP = id('o', 1);

function store() {
  const entities = {
    [E.bingo]: { id: E.bingo, type: 'team', name: 'Bingo' },
    [E.dana]: { id: E.dana, type: 'person', name: 'Dana' },
    [E.mtcs]: { id: E.mtcs, type: 'term', name: 'MTCS' },
  };
  const items = {};
  const add = (key, o) => {
    items[I[key]] = { id: I[key], entityIds: [], createdAt: local(2026, 11, 1), ...o };
  };
  add('f1', { kind: 'doc', title: 'MTCS design review', summary: 'Failover and capacity plan for MTCS.', url: 'https://wiki.example.com/mtcs/design-review', createdAt: local(2026, 10, 26, 9, 12), entityIds: [E.mtcs] });
  add('f2', { kind: 'doc', title: 'MTCS rollout plan.docx', createdAt: local(2026, 10, 28, 14, 3), source: { app: 'Microsoft Word' }, entityIds: [E.mtcs] });
  add('f6', { kind: 'meeting', title: 'Bingo team sync', text: 'Bingo team sync\n- [ ] Send MTCS numbers to Dana by Friday\n- Dana to share the roadmap deck\n- I\'ll book the offsite\nAction items:\n- review the Bingo launch checklist', createdAt: local(2026, 10, 30, 16), entityIds: [E.bingo, E.dana, E.mtcs] });
  const child = { parentId: I.f6, createdAt: local(2026, 10, 30, 16), kind: 'action', status: 'open' };
  add('a1', { ...child, title: 'Send MTCS numbers to Dana', seg: 1, dueAt: local(2026, 11, 6), entityIds: [E.bingo, E.dana, E.mtcs] });
  add('a2', { ...child, title: 'Dana to share the roadmap deck', suggested: true, seg: 2, entityIds: [E.bingo, E.dana] });
  add('a3', { ...child, title: 'book the offsite', seg: 3, entityIds: [E.bingo] });
  add('a4', { ...child, title: 'review the Bingo launch checklist', seg: 5, entityIds: [E.bingo] });
  add('f7', { kind: 'action', status: 'open', title: 'email the bingo team about the demo date', createdAt: local(2026, 11, 2, 9), entityIds: [E.bingo] });
  add('f9', { kind: 'action', status: 'done', title: 'update the Bingo dashboard', createdAt: local(2026, 11, 4, 9), doneAt: local(2026, 11, 4, 9), entityIds: [E.bingo] });
  add('f10', { kind: 'note', title: 'bingo salary thoughts', text: 'bingo salary thoughts', private: true, createdAt: local(2026, 11, 4, 12), entityIds: [E.bingo] });
  return { entities, items };
}

function graphCtx(s) {
  const all = () => Object.values(s.items);
  return {
    getItem: (iid) => s.items[iid] || null,
    getEntity: (eid) => s.entities[eid] || null,
    itemsOfEntity: (eid) => all().filter((i) => i.entityIds.includes(eid)).map((i) => i.id),
    cooccur: (eid) => {
      const w = new Map();
      for (const item of all()) {
        if (!item.entityIds.includes(eid)) continue;
        for (const o of item.entityIds) if (o !== eid) w.set(o, (w.get(o) || 0) + 1);
      }
      return [...w].map(([oid, weight]) => ({ id: oid, w: weight }));
    },
    related: (iid) => (iid === I.f6 ? [{ id: I.f1, score: 0.8 }, { id: I.f2, score: 0.7 }] : []),
    childrenOf: (iid) => all().filter((i) => i.parentId === iid).map((i) => i.id),
    overview: () => ({ teams: [{ id: E.bingo, n: 8 }], people: [{ id: E.dana, n: 4 }], topics: [{ id: E.mtcs, n: 5 }], reviewCount: 1, openCount: 5, recent: [I.f10, I.f9], counts: { items: 10, entities: 3, actions: 5 } }),
  };
}

function citeVm(s, iid) {
  const item = s.items[iid];
  if (item) {
    if (item.private) return { private: true };
    return { id: iid, kind: item.kind, title: item.title, day: item.createdAt, snippet: item.summary || item.text || '', url: item.url, private: false, missing: false };
  }
  const e = s.entities[iid];
  if (e) return { id: iid, kind: e.type, title: e.name, day: null, snippet: '', private: !!e.private, missing: false };
  return null;
}

function makePort({ loaded = true, rev = 5 } = {}) {
  const s = store();
  const g = graphCtx(s);
  const port = {
    loaded,
    rev,
    s,
    ensureLoaded: vi.fn(async () => {
      port.loaded = true;
    }),
    cite: vi.fn((iid) => citeVm(s, iid)),
    nameOf: (rid) => s.entities[rid]?.name || s.items[rid]?.title || '',
    map: vi.fn((focus, page) => neighborhood(focus, { ...g, page })),
    op: vi.fn((opId) => (opId === OP
      ? {
          opId: OP,
          code: 'capture',
          undone: false,
          canUndo: true,
          at: local(2026, 10, 30, 16),
          item: { id: I.f6, kind: 'meeting', title: 'Bingo team sync', private: false },
          entities: [{ id: E.bingo, name: 'Bingo', type: 'team' }, { id: E.dana, name: 'Dana', type: 'person' }, { id: E.mtcs, name: 'MTCS', type: 'term' }],
          actions: [I.a1, I.a2, I.a3, I.a4].map((a) => ({ id: a, title: s.items[a].title, status: 'open', suggested: !!s.items[a].suggested, dueAt: s.items[a].dueAt })),
          related: [citeVm(s, I.f1), citeVm(s, I.f2), citeVm(s, I.f7)],
          truncated: false,
        }
      : null)),
    item: vi.fn((iid) => {
      const it = s.items[iid];
      if (!it) return null;
      return {
        id: iid,
        kind: it.kind,
        title: it.title,
        text: it.text || '',
        day: it.createdAt,
        createdAt: it.createdAt,
        app: it.source?.app,
        url: it.url,
        status: it.status,
        suggested: it.suggested,
        dueAt: it.dueAt,
        private: !!it.private,
        summary: it.summary,
        entities: it.entityIds.map((e) => ({ ...s.entities[e], private: false })),
        actions: g.childrenOf(iid).map((c) => ({ id: c, title: s.items[c].title, status: s.items[c].status, suggested: !!s.items[c].suggested, dueAt: s.items[c].dueAt })),
        parent: it.parentId ? citeVm(s, it.parentId) : undefined,
        related: g.related(iid).map((r) => citeVm(s, r.id)),
      };
    }),
  };
  return port;
}

const baseCtx = (extra = {}) => ({ t, locale: 'en', rtl: false, now: NOW, canReformat: true, state: createFormatterState(), ...extra });

// --- Sanitizer contract (SPEC §10.2) ------------------------------------------

const TAGS = new Set(['DIV', 'SPAN', 'BUTTON', 'A', 'DETAILS', 'SUMMARY', 'UL', 'LI', 'SMALL', 'STRONG', 'EM', 'SVG', 'LINE']);
const ATTRS = new Set(['class', 'title', 'role', 'aria-label', 'type', 'href', 'x1', 'y1', 'x2', 'y2', 'data-ext-action', 'dir', 'open']);
const INLINE = new Set(['SPAN', 'BUTTON', 'A', 'SMALL', 'STRONG', 'EM', 'BR', 'CODE', 'B', 'I']);

// Checks every element we render. For formatHtml output, `ours` limits the
// walk to our chips and cards (the message's own markup is the host's).
function assertAllowed(html, { ours = false } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const all = ours
    ? [...tpl.content.querySelectorAll('.mm-cite, .mm-cite-x, .mm-block')].flatMap((el) => [el, ...el.querySelectorAll('*')])
    : tpl.content.querySelectorAll('*');
  expect(all.length).toBeGreaterThan(0);
  for (const el of all) {
    const tag = el.tagName.toUpperCase();
    expect(TAGS.has(tag), `tag <${tag.toLowerCase()}>`).toBe(true);
    for (const a of Array.from(el.attributes)) {
      expect(ATTRS.has(a.name), `attribute ${a.name} on <${tag.toLowerCase()}>`).toBe(true);
      if (a.name === 'data-ext-action') {
        expect(['BUTTON', 'A', 'SPAN', 'DIV']).toContain(tag);
        expect(a.value).toMatch(/^[a-z0-9:]+$/);
        expect(parseAction(a.value), a.value).not.toBeNull();
      }
      if (a.name === 'href') expect(a.value).toMatch(/^https?:\/\//);
      if (a.name === 'open') expect(tag).toBe('DETAILS');
      if (a.name === 'dir') expect(['ltr', 'rtl']).toContain(a.value);
      if (a.name === 'role') expect(['group', 'navigation', 'presentation']).toContain(a.value);
      if (a.name === 'class') for (const c of a.value.split(/\s+/)) expect(c).toMatch(/^mm-[a-z0-9-]+$/);
    }
  }
}

function assertInlineInParagraphs(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const p of tpl.content.querySelectorAll('p')) {
    for (const el of p.querySelectorAll('*')) expect(INLINE.has(el.tagName.toUpperCase()), `<${el.tagName.toLowerCase()}> inside <p>`).toBe(true);
  }
}

const frag = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
};

// --- Labels -------------------------------------------------------------------

describe('labels', () => {
  it('formats days and ranges for the fixture dates', () => {
    expect(fmtDay(local(2026, 10, 26), 'en')).toBe('Mon, Oct 26');
    expect(fmtDay(local(2025, 12, 31), 'en', { now: NOW })).toBe('Wed, Dec 31, 2025');
    expect(fmtRange(local(2026, 10, 26), local(2026, 11, 2), 'en')).toBe('Mon, Oct 26 – Sun, Nov 1');
    expect(fmtRange(local(2026, 10, 26), local(2026, 11, 2), 'en', { t })).toBe('Mon, Oct 26 – Sun, Nov 1');
    expect(fmtRange(local(2026, 11, 5), local(2026, 11, 6), 'en')).toBe('Thu, Nov 5');
    expect(fmtRange(local(2026, 10, 6), NOW, 'en', { short: true })).toBe('Oct 6 – Nov 6');
    expect(fmtDay('nope', 'en')).toBe('');
    expect(fmtDay(local(2026, 10, 26), 'not a locale!!')).toBe('Mon, Oct 26');
  });

  it('describes due dates relative to now', () => {
    expect(dueText(local(2026, 11, 6), { now: NOW, t })).toBe('due today (Fri, Nov 6)');
    expect(dueText(local(2026, 11, 7), { now: NOW, t })).toBe('due tomorrow (Sat, Nov 7)');
    expect(dueText(local(2026, 11, 2), { now: NOW, t })).toBe('overdue · Mon, Nov 2');
    expect(dueText(local(2026, 11, 13), { now: NOW, t })).toBe('due Fri, Nov 13');
    expect(doneText(local(2026, 11, 4, 9), { t })).toBe('done Wed, Nov 4');
    expect(dueText(undefined, { now: NOW, t })).toBe('');
  });

  it('labels AT-1: docs & links, last week, “mtcs”', () => {
    const spec = {
      intent: 'find',
      kinds: ['doc', 'link'],
      kindBoost: 'doc',
      range: { start: local(2026, 10, 26), end: local(2026, 11, 2), granularity: 'week', code: 'last_week', field: 'any' },
      owner: null,
      entities: [{ entityId: E.mtcs, hard: false, via: 'dict' }],
      unresolved: [],
      terms: [{ t: 'mtcs', w: 1 }, { t: 'mtcs', w: 0.7 }],
      phrases: [],
    };
    const nameOf = (eid) => store().entities[eid]?.name;
    expect(interpLabel(spec, { relaxed: null }, { t, locale: 'en', nameOf })).toBe('🔎 Docs & links · Mon, Oct 26 – Sun, Nov 1 · “mtcs”');
    // with an echoing t, every part is a key
    expect(interpLabel(spec, null, { t: echo, locale: 'en', nameOf })).toBe(
      'chip.interp(parts=chip.kinds_doc_linkchip.seprange.span(from=Mon, Oct 26,to=Sun, Nov 1)chip.sepchip.terms(terms=mtcs))',
    );
  });

  it('labels AT-1b: the widened range explains itself', () => {
    const spec = { intent: 'find', kinds: ['doc', 'link'], range: { start: local(2026, 11, 5), end: local(2026, 11, 6), granularity: 'day', code: 'yesterday', field: 'any' }, entities: [], unresolved: [], terms: [{ t: 'mtcs', w: 1 }] };
    const result = { relaxed: { code: 'range_widened', range: { start: local(2026, 10, 6), end: NOW } } };
    expect(interpLabel(spec, result, { t, locale: 'en', now: NOW })).toBe('Nothing from Thu, Nov 5 — closest matches from Oct 6 – Nov 6');
    expect(relaxText(result.relaxed, spec, { t })).toBe('Nothing from Thu, Nov 5 — closest matches from Oct 6 – Nov 6');
  });

  it('labels AT-2: actions · mine · Bingo (team) · open + recently done', () => {
    const spec = {
      intent: 'actions',
      kinds: null,
      range: null,
      status: 'open',
      owner: 'me',
      entities: [{ entityId: E.bingo, hard: true, via: 'phrase' }],
      unresolved: [],
      terms: [{ t: 'bingo', w: 1 }],
    };
    const s = store();
    const opts = { t, locale: 'en', nameOf: (eid) => s.entities[eid]?.name, typeOf: (eid) => s.entities[eid]?.type };
    expect(interpLabel(spec, null, opts)).toBe('🔎 Actions · mine · Bingo (team) · open + recently done');
    // status left unset by the parser means the same thing for the actions intent
    expect(interpLabel({ ...spec, status: null }, null, opts)).toBe('🔎 Actions · mine · Bingo (team) · open + recently done');
    expect(interpLabel({ ...spec, owner: 'anyone', status: 'done' }, null, opts)).toBe('🔎 Actions · everyone\'s · Bingo (team) · done');
  });

  it('labels AT-2b: an unknown team, then "no actions"', () => {
    const spec = { intent: 'actions', owner: 'me', entities: [], unresolved: [{ phrase: 'walrus', type: 'team' }], terms: [{ t: 'walrus', w: 1 }] };
    const result = { relaxed: { code: 'none' } };
    expect(interpLabel(spec, result, { t })).toBe('No team called “walrus” yet — searching the word instead');
    expect(relaxText(result.relaxed, spec, { t })).toBe('No actions found for “walrus”');
    expect(relaxText({ code: 'none' }, { intent: 'find', terms: [] }, { t, trigger: 'brain' })).toBe('Nothing matched — try brain+ to save it, or broaden the question');
  });

  it('covers the other relaxations, filters and empty specs', () => {
    const spec = { kinds: ['note'], range: { start: local(2026, 11, 2), end: local(2026, 11, 9), field: 'due' }, entities: [{ entityId: E.dana, hard: true }], terms: [{ t: 'roadmap', w: 1 }, { t: 'deck', neg: true }], phrases: ['share the'] };
    const nameOf = (eid) => store().entities[eid]?.name;
    expect(interpLabel(spec, null, { t, nameOf })).toBe('🔎 Notes · Dana · due Mon, Nov 2 – Sun, Nov 8 · “roadmap "share the"” · not “deck”');
    expect(relaxText({ code: 'range_dropped' }, spec, { t })).toBe('Nothing from Mon, Nov 2 – Sun, Nov 8 — showing matches from any time');
    expect(relaxText({ code: 'kinds_dropped' }, spec, { t })).toBe('Notes: nothing matched — showing every kind');
    expect(relaxText({ code: 'entities_softened' }, spec, { t, nameOf })).toBe('Nothing linked to Dana — showing mentions instead');
    expect(relaxText({ code: 'mystery' }, spec, { t })).toBe('');
    expect(interpLabel({ terms: [] }, null, { t })).toBe('');
    expect(interpLabel(null, null, { t })).toBe('');
    expect(interpLabel({ range: { start: local(2026, 10, 1), end: NOW, code: 'since' } }, null, { t })).toBe('🔎 since Thu, Oct 1');
    expect(interpLabel({ range: { start: null, end: local(2026, 10, 1), code: 'before' } }, null, { t })).toBe('🔎 before Thu, Oct 1');
    expect(interpLabel({ terms: [{ t: 'mtc', w: 1, prefix: true }] }, null, { t })).toBe('🔎 “mtc…”');
  });

  it('reads the parser\'s own entity names, raw words and flags (lib/query.js)', () => {
    const spec = {
      intent: 'find',
      entities: [{ entityId: E.bingo, hard: true, via: 'marker', name: 'Bingo', type: 'team' }],
      terms: [{ t: 'mtcs', raw: 'MTCSs', w: 1 }, { t: 'roadmap', raw: 'roadmap', w: 1, phrase: true }, { t: 'deck', raw: 'deck', w: 1, phrase: true }, { t: 'bingo', raw: 'Bingo', w: 1 }],
      phrases: ['roadmap deck'],
      privateOnly: true,
    };
    expect(interpLabel(spec, null, { t })).toBe('🔎 Bingo (team) · private only · “MTCSs "roadmap deck"”');
  });

  it('exports icons for kinds, action states and entity types', () => {
    expect(KIND_ICONS).toMatchObject({ note: '📝', link: '🔗', doc: '📄', meeting: '🗓️', action: '☐', action_done: '☑', action_suggested: '❔' });
    expect(ETYPE_ICONS).toEqual({ person: '👤', team: '👥', project: '📁', topic: '#️⃣', term: '🔤', org: '🏢' });
    expect(itemIcon({ kind: 'action', status: 'done' })).toBe('☑');
    expect(itemIcon({ kind: 'action', status: 'open', suggested: true })).toBe('❔');
    expect(itemIcon({ kind: 'team' })).toBe('👥');
  });
});

// --- Cards ----------------------------------------------------------------------

describe('cards', () => {
  const port = makePort();
  const ctx = { t, locale: 'en', now: NOW, canReformat: true, block: { blk: 'k1', rev: '1', dataRev: '5' } };

  it('op card: saved summary, action buttons, related, undo and map', () => {
    const html = renderOpCard(port.op(OP), ctx);
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.className).toBe(`mm-block mm-bk1 mm-r1 mm-d5 mm-t-op mm-f-${OP}`);
    expect(root.getAttribute('role')).toBe('group');
    expect(root.querySelector('.mm-op-head').textContent).toBe('✓ Saved · meeting · Bingo, Dana, MTCS · 4 actions (1 suggested) · 3 related');
    const acts = [...root.querySelectorAll('.mm-act')];
    expect(acts.map((a) => a.querySelector('.mm-at').textContent)).toEqual(['Send MTCS numbers to Dana', 'Dana to share the roadmap deck', 'book the offsite', 'review the Bingo launch checklist']);
    expect(acts[0].querySelector('.mm-meta').textContent).toBe('due today (Fri, Nov 6)');
    const actions = [...root.querySelectorAll('[data-ext-action]')].map((b) => b.getAttribute('data-ext-action'));
    expect(actions).toContain(`mm:a:accept:${I.a2}`);
    expect(actions).toContain(`mm:a:dismiss:${I.a2}`);
    expect(actions).toContain(`mm:a:dismiss:${I.a1}`);
    expect(actions).not.toContain(`mm:a:accept:${I.a1}`);
    expect(actions).toContain(`mm:b k1:f:${I.f1}`.replace(' ', ''));
    expect(actions).toContain(`mm:a:undo:${OP}`);
    expect(actions).toContain('mm:bk1:map');
  });

  it('op card: deduped, undone, truncated and missing variants', () => {
    const vm = port.op(OP);
    const dedup = renderOpCard({ ...vm, code: 'capture', dedupedInto: { id: I.f1, day: local(2026, 10, 26) }, actions: [], related: [] }, ctx);
    assertAllowed(dedup);
    expect(frag(dedup).querySelector('.mm-op-head').textContent).toBe('Already saved Mon, Oct 26 · note added · Bingo, Dana, MTCS');
    const undone = renderOpCard({ ...vm, undone: true }, ctx);
    assertAllowed(undone);
    const u = frag(undone);
    expect(u.querySelector('.mm-op-head').textContent).toBe('↶ Undone');
    expect(u.querySelector('[data-ext-action]')).toBeNull();
    const trunc = renderOpCard({ ...vm, truncated: true }, ctx);
    expect(frag(trunc).querySelector('.mm-note').textContent).toBe('Saved the first 8,000 characters');
    const gone = renderOpCard(null, ctx);
    assertAllowed(gone);
    expect(frag(gone).textContent).toBe('This change is no longer in your history.');
    expect(frag(renderOpCard({ ...vm, code: 'status_done', actions: [], related: [] }, ctx)).querySelector('.mm-op-title').textContent).toBe('✓ Marked done');
  });

  it('op card: one headline per lib/model.js label code', () => {
    const vm = { ...port.op(OP), actions: [], related: [], entities: [] };
    const head = (code) => frag(renderOpCard({ ...vm, code }, ctx)).querySelector('.mm-op-title').textContent;
    expect(['capture', 'capture_dedup', 'status_done', 'status_open', 'dismiss', 'accept', 'edit', 'privacy_on', 'privacy_off', 'delete', 'annotate', 'merge', 'forget', 'rename', 'import', 'undo', 'mystery'].map(head)).toEqual([
      '✓ Saved', 'Already saved · note added', '✓ Marked done', '↺ Reopened', '✕ Not an action', '✓ Added to your actions', '✓ Updated', '🔒 Made private',
      'Made shareable', '🗑 Deleted', '✓ Updated by your agent', '✓ Merged', '✓ Forgotten', '✓ Renamed', '✓ Imported', '↶ Undone', '✓ Done',
    ]);
  });

  it('item card: meta, text, entities, actions, related and controls', () => {
    const html = renderItemCard(port.item(I.f6), ctx);
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.querySelector('.mm-title').textContent).toBe('Bingo team sync');
    expect(root.querySelector('.mm-meta').textContent).toBe('meeting · Fri, Oct 30');
    expect(root.querySelector('.mm-text').textContent).toContain('- [ ] Send MTCS numbers to Dana by Friday');
    expect([...root.querySelectorAll('.mm-echip')].map((b) => b.getAttribute('data-ext-action'))).toEqual([E.bingo, E.dana, E.mtcs].map((e) => `mm:bk1:f:${e}`));
    expect(root.querySelectorAll('.mm-act')).toHaveLength(4);
    const actions = [...root.querySelectorAll('[data-ext-action]')].map((b) => b.getAttribute('data-ext-action'));
    expect(actions).toEqual(expect.arrayContaining([`mm:a:done:${I.a1}`, `mm:a:accept:${I.a2}`, 'mm:bk1:map', `mm:a:private:${I.f6}`, `mm:a:delete:${I.f6}`]));
    expect(actions).not.toContain(`mm:a:open:${I.f6}`); // notes and meetings have nothing to open
  });

  it('item card: doc with url opens; action shows due and parent; private and long text', () => {
    const doc = renderItemCard(port.item(I.f1), ctx);
    assertAllowed(doc);
    const d = frag(doc);
    expect(d.querySelector('[data-ext-action^="mm:a:open:"]').getAttribute('data-ext-action')).toBe(`mm:a:open:${I.f1}`);
    expect(d.querySelector('.mm-where').getAttribute('dir')).toBe('ltr');
    expect(d.querySelector('.mm-summary').textContent).toBe('Failover and capacity plan for MTCS.');
    const act = frag(renderItemCard(port.item(I.a1), ctx));
    expect(act.querySelector('.mm-meta').textContent).toBe('action · Fri, Oct 30 · due today (Fri, Nov 6)');
    expect(act.querySelector('.mm-parent [data-ext-action]').getAttribute('data-ext-action')).toBe(`mm:bk1:f:${I.f6}`);
    expect(act.querySelector(`[data-ext-action="mm:a:done:${I.a1}"]`)).not.toBeNull();
    const priv = frag(renderItemCard(port.item(I.f10), ctx));
    expect(priv.querySelector('.mm-badge').textContent).toBe('🔒 private');
    expect(priv.querySelector(`[data-ext-action="mm:a:share:${I.f10}"]`)).not.toBeNull();
    const long = renderItemCard({ ...port.item(I.f6), text: 'word '.repeat(300) }, ctx);
    assertAllowed(long);
    expect(frag(long).querySelector('details.mm-more summary').textContent).toBe('Show more');
    expect(frag(renderItemCard(null, ctx)).textContent).toBe('This item no longer exists.');
  });

  it('item card does not repeat its own actions or parent under Related', () => {
    const vm = port.item(I.f6);
    vm.related = [citeVm(port.s, I.a1), citeVm(port.s, I.f1), citeVm(port.s, I.f6)];
    const rels = [...frag(renderItemCard(vm, ctx)).querySelectorAll('.mm-rels .mm-rel')].map((b) => b.getAttribute('data-ext-action'));
    expect(rels).toEqual([`mm:bk1:f:${I.f1}`]);
  });

  it('help card lists the syntax with LTR code spans', () => {
    const html = renderHelpCard({ t, trigger: 'mm', block: { blk: 'k2', rev: '1', dataRev: '5' } });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.className).toBe('mm-block mm-bk2 mm-r1 mm-d5 mm-t-help');
    expect(root.querySelectorAll('.mm-help li').length).toBeGreaterThan(8);
    expect([...root.querySelectorAll('.mm-code')].every((c) => c.getAttribute('dir') === 'ltr')).toBe(true);
    expect(root.textContent).toContain('mm+ …');
  });

  it('escapes user text everywhere', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const vm = { ...port.item(I.f6), title: evil, text: evil, summary: evil, app: evil, entities: [{ id: E.dana, name: evil, type: 'person' }], related: [{ id: I.f1, kind: 'doc', title: evil, day: NOW }] };
    for (const html of [
      renderItemCard(vm, ctx),
      renderOpCard({ ...port.op(OP), item: { id: I.f6, kind: 'note', title: evil }, entities: [{ id: E.dana, name: evil }], actions: [{ id: I.a1, title: evil, status: 'open' }] }, ctx),
      renderCite({ id: I.f1, kind: 'doc', title: evil, day: NOW, snippet: evil, url: 'javascript:alert(1)' }, { id: I.f1, n: 1, msg: '1', expanded: true, t }),
      renderMapCard({ focus: { type: 'item', id: I.f6 }, center: { ref: I.f6, group: 'item', kind: 'note', label: evil, snippet: evil, app: evil }, lanes: { up: { role: 'entities', nodes: [{ ref: E.dana, group: 'entity', kind: 'person', label: evil }] }, left: { role: 'actions', nodes: [] }, right: { role: 'docs', nodes: [] }, down: { role: 'notes', nodes: [] } } }, { history: [{ ref: I.f6, label: evil }] }, { t }),
    ]) {
      assertAllowed(html);
      expect(html).not.toContain('<img');
      expect(frag(html).querySelector('img')).toBeNull();
      expect(html).not.toContain('javascript:');
    }
  });
});

// --- Citation chips -------------------------------------------------------------

describe('citations (SPEC §10.1, AT-7)', () => {
  it('numbers by first appearance, reuses numbers, marks deleted and private', () => {
    const port = makePort();
    const ctx = baseCtx();
    const html = `<p>See [mm:${I.f1}] and [mm:${I.f2}], and again [mm:${I.f1}]. Gone: [mm:${I.gone}]. Secret: [mm:${I.f10}].</p>`;
    const out = formatHtml(html, port, ctx);
    assertAllowed(out, { ours: true });
    assertInlineInParagraphs(out);
    const chips = [...frag(out).querySelectorAll('.mm-cite')];
    expect(chips.map((c) => c.textContent)).toEqual(['[1] MTCS design review', '[2] MTCS rollout plan.docx', '[1]', '[3] (deleted item)', '[4] private item']);
    expect(chips[0].getAttribute('title')).toBe('MTCS design review · Mon, Oct 26 — Failover and capacity plan for MTCS.');
    expect(chips[4].getAttribute('title')).not.toContain('salary');
    expect(out).not.toContain('salary');
    expect(chips[3].classList.contains('mm-cite-missing')).toBe(true);
    const msg = /mm:c([0-9a-z]+):x:1:/.exec(chips[0].getAttribute('data-ext-action'))[1];
    expect(chips[2].getAttribute('data-ext-action')).toBe(`mm:c${msg}:x:1:${I.f1}`);
    expect(frag(out).querySelector('p').textContent).toBe('See [1] MTCS design review and [2] MTCS rollout plan.docx, and again [1]. Gone: [3] (deleted item). Secret: [4] private item.');
  });

  it('is idempotent and returns null without markers', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>Read [mm:${I.f1}]</p><p>[mm-card:map:${E.bingo}]</p><p>[mm-card:help]</p>`, port, ctx);
    expect(out).toBeTypeOf('string');
    expect(formatHtml(out, port, ctx)).toBeNull();
    expect(formatHtml('<p>Hello, no markers here.</p>', port, ctx)).toBeNull();
    expect(formatHtml('', port, ctx)).toBeNull();
    expect(formatHtml(null, port, ctx)).toBeNull();
  });

  it('leaves tokens inside code, pre and links alone', () => {
    const port = makePort();
    const html = `<p><code>[mm:${I.f1}]</code></p><pre>[mm:${I.f1}]</pre><p><a href="https://example.com">[mm:${I.f1}]</a></p>`;
    expect(formatHtml(html, port, baseCtx())).toBeNull();
  });

  it('ignores malformed ids', () => {
    const port = makePort();
    expect(formatHtml('<p>[mm:../x] [mm:I00000000000001] [mm:i000000000000011]</p>', port, baseCtx())).toBeNull();
  });

  it('expands a chip inline and collapses it again', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>See [mm:${I.f1}] and [mm:${I.f1}].</p>`, port, ctx);
    const action = frag(out).querySelector('.mm-cite').getAttribute('data-ext-action');
    expect(applyUiAction(ctx.state, parseAction(action))).toEqual({ changed: true });
    const open = formatHtml(out, port, ctx);
    assertAllowed(open, { ours: true });
    assertInlineInParagraphs(open);
    const xs = frag(open).querySelectorAll('.mm-cite-x');
    expect(xs).toHaveLength(1);
    expect(xs[0].previousElementSibling.textContent).toBe('[1] MTCS design review');
    expect(xs[0].textContent).toContain('📄 doc · Mon, Oct 26');
    expect(xs[0].querySelector('a').getAttribute('href')).toBe('https://wiki.example.com/mtcs/design-review');
    expect(xs[0].querySelector('button').getAttribute('data-ext-action')).toMatch(new RegExp(`^mm:c[0-9a-z]+:map:${I.f1}$`));
    expect(formatHtml(open, port, ctx)).toBeNull();
    applyUiAction(ctx.state, parseAction(action));
    const closed = formatHtml(open, port, ctx);
    expect(frag(closed).querySelectorAll('.mm-cite-x')).toHaveLength(0);
  });

  it('docks a map card at the end of the message from a chip', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>See [mm:${I.f6}].</p><p>More text.</p>`, port, ctx);
    const msg = /mm:c([0-9a-z]+):/.exec(out)[1];
    applyUiAction(ctx.state, parseAction(`mm:c${msg}:map:${I.f6}`));
    const docked = formatHtml(out, port, ctx);
    assertAllowed(docked, { ours: true });
    const root = frag(docked);
    const last = root.lastElementChild;
    expect(last.classList.contains('mm-dock')).toBe(true);
    expect(last.classList.contains('mm-t-map')).toBe(true);
    expect(last.classList.contains(`mm-f-${I.f6}`)).toBe(true);
    expect(formatHtml(docked, port, ctx)).toBeNull();
    // Map on another chip of the same message re-centres the docked card.
    applyUiAction(ctx.state, parseAction(`mm:c${msg}:map:${I.f1}`));
    const again = formatHtml(docked, port, ctx);
    expect(frag(again).querySelectorAll('.mm-dock')).toHaveLength(1);
    expect(frag(again).querySelector('.mm-dock').classList.contains(`mm-f-${I.f1}`)).toBe(true);
  });

  it('renders placeholders until loaded, then upgrades them', async () => {
    const port = makePort({ loaded: false });
    const requestReformat = vi.fn();
    const ctx = baseCtx({ requestReformat });
    const out = formatHtml(`<p>See [mm:${I.f1}].</p><p>[mm-card:op:${OP}]</p>`, port, ctx);
    assertAllowed(out, { ours: true });
    const f = frag(out);
    expect(f.querySelector('.mm-cite').textContent).toBe('[1] …');
    expect(f.querySelector('.mm-block').textContent).toBe('Loading your mind map…');
    expect(port.ensureLoaded).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(requestReformat).toHaveBeenCalledTimes(1);
    expect(port.loaded).toBe(true);
    const ready = formatHtml(out, port, ctx);
    expect(frag(ready).querySelector('.mm-cite').textContent).toBe('[1] MTCS design review');
    expect(frag(ready).querySelector('.mm-op-title').textContent).toBe('✓ Saved');
    expect(formatHtml(ready, port, ctx)).toBeNull();
  });

  it('re-renders chips when data changes, unless the port says they are unaffected', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>See [mm:${I.f1}].</p>`, port, ctx);
    port.s.items[I.f1].title = 'MTCS design review v2';
    port.rev = 6;
    port.changedSince = vi.fn(() => false);
    expect(formatHtml(out, port, ctx)).toBeNull();
    expect(port.changedSince).toHaveBeenCalledWith(5, [I.f1]);
    port.changedSince = vi.fn(() => true);
    expect(frag(formatHtml(out, port, ctx)).querySelector('.mm-cite').textContent).toBe('[1] MTCS design review v2');
    delete port.changedSince;
    port.rev = 7;
    port.s.items[I.f1].title = 'v3';
    const v3 = formatHtml(out, port, ctx);
    expect(frag(v3).querySelector('.mm-cite').textContent).toBe('[1] v3');
  });
});

// --- Card replacement and staleness -----------------------------------------------

describe('cards in messages', () => {
  it('replaces only paragraphs that hold just the marker', () => {
    const port = makePort();
    const ctx = baseCtx();
    const html = `<p>🧠 Saved “Bingo team sync”</p><p>[mm-card:op:${OP}]</p><p>Inline [mm-card:help] stays.</p><p>🧠 Map<br>[mm-card:map:${E.bingo}]</p>`;
    const out = formatHtml(html, port, ctx);
    assertAllowed(out, { ours: true });
    const root = frag(out);
    const blocks = root.querySelectorAll('.mm-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].classList.contains('mm-t-op')).toBe(true);
    expect(blocks[1].classList.contains('mm-t-map')).toBe(true);
    expect(root.querySelectorAll('p')[1].textContent).toBe('Inline [mm-card:help] stays.');
    expect(root.querySelectorAll('p')[2].textContent).toBe('🧠 Map');
    expect(root.firstElementChild.textContent).toBe('🧠 Saved “Bingo team sync”');
  });

  it('rejects markers whose ref does not fit the card type', () => {
    const port = makePort();
    expect(formatHtml(`<p>[mm-card:op:${I.f1}]</p><p>[mm-card:item:${OP}]</p><p>[mm-card:help:${I.f1}]</p><p>[mm-card:map:${OP}]</p>`, port, baseCtx())).toBeNull();
    const overview = formatHtml('<p>[mm-card:map]</p>', port, baseCtx());
    expect(frag(overview).querySelector('.mm-block').classList.contains('mm-f-o')).toBe(true);
  });

  it('re-renders a card when its UI revision changes, and only then', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, port, ctx);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    expect(formatHtml(out, port, ctx)).toBeNull();
    expect(applyUiAction(ctx.state, parseAction(`mm:b${blk}:f:${E.dana}`))).toEqual({ changed: true });
    const moved = formatHtml(out, port, ctx);
    const card = frag(moved).querySelector('.mm-block');
    expect(card.classList.contains(`mm-f-${E.dana}`)).toBe(true);
    expect(card.classList.contains('mm-r2')).toBe(true);
    // breadcrumb "Bingo › Dana" (AT-6)
    expect(card.querySelector('.mm-trail').textContent).toBe('🧠Bingo›Dana');
    expect(card.querySelector('.mm-crumb').getAttribute('data-ext-action')).toBe(`mm:b${blk}:f:${E.bingo}`);
    expect(formatHtml(moved, port, ctx)).toBeNull();
  });

  it('re-renders on a data revision change, unless changedSince says the card is unaffected', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, port, ctx);
    port.rev = 6;
    port.changedSince = vi.fn(() => false);
    expect(formatHtml(out, port, ctx)).toBeNull();
    const [since, refs] = port.changedSince.mock.calls[0];
    expect(since).toBe(5);
    expect(refs).toEqual(expect.arrayContaining([E.bingo, E.dana, I.a1]));
    port.changedSince = vi.fn(() => true);
    const again = formatHtml(out, port, ctx);
    expect(frag(again).querySelector('.mm-block').classList.contains('mm-d6')).toBe(true);
  });

  it('rebuilds state from classes after the module state is lost', () => {
    const port = makePort();
    const first = baseCtx();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p><p>[mm:${I.f1}]</p>`, port, first);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    const msg = /mm:c([0-9a-z]+):/.exec(out)[1];
    const fresh = baseCtx(); // new FormatterState, as after a sandbox reload
    expect(formatHtml(out, port, fresh)).toBeNull();
    expect(fresh.state.blocks.get(blk)).toMatchObject({ type: 'map', history: [{ ref: E.bingo }] });
    expect(fresh.state.next).toBeGreaterThan(Math.max(parseInt(blk, 36), parseInt(msg, 36)));
    // An action that arrives before any formatter pass is queued, then applied.
    const lost = baseCtx();
    expect(applyUiAction(lost.state, parseAction(`mm:b${blk}:f:${E.dana}`))).toEqual({ changed: true });
    expect(applyUiAction(lost.state, parseAction(`mm:c${msg}:x:1:${I.f1}`))).toEqual({ changed: true });
    const moved = formatHtml(out, port, lost);
    const card = frag(moved).querySelector('.mm-block');
    expect(card.classList.contains(`mm-f-${E.dana}`)).toBe(true);
    expect(card.querySelector('.mm-trail').textContent).toBe('🧠Bingo›Dana');
    expect(frag(moved).querySelectorAll('.mm-cite-x')).toHaveLength(1);
    expect(formatHtml(moved, port, lost)).toBeNull();
  });

  it('converts op and item cards to a map and back', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>[mm-card:op:${OP}]</p>`, port, ctx);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    applyUiAction(ctx.state, parseAction(`mm:b${blk}:map`));
    const map = formatHtml(out, port, ctx);
    const card = frag(map).querySelector('.mm-block');
    expect(card.classList.contains('mm-t-map')).toBe(true);
    expect(card.classList.contains(`mm-f-${I.f6}`)).toBe(true);
    expect(card.querySelector(`[data-ext-action="mm:b${blk}:back"]`)).not.toBeNull();
    applyUiAction(ctx.state, parseAction(`mm:b${blk}:back`));
    const back = formatHtml(map, port, ctx);
    expect(frag(back).querySelector('.mm-block').classList.contains('mm-t-op')).toBe(true);
    // an entity chip on an item card opens the map on that entity
    const item = formatHtml(`<p>[mm-card:item:${I.f6}]</p>`, port, ctx);
    const iblk = / mm-b([0-9a-z]+) mm-r/.exec(item)[1];
    applyUiAction(ctx.state, parseAction(`mm:b${iblk}:f:${E.dana}`));
    const imap = frag(formatHtml(item, port, ctx)).querySelector('.mm-block');
    expect(imap.classList.contains(`mm-f-${E.dana}`)).toBe(true);
    expect(imap.querySelector('.mm-trail').textContent).toBe('🧠Bingo team sync›Dana');
  });

  it('never throws: a failing port yields null or a safe card', () => {
    const port = makePort();
    const log = { warn: vi.fn() };
    const bad = { ...port, map: () => { throw new Error('x'); }, cite: () => { throw new Error('y'); } };
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}] </p><p>[mm:${I.f1}]</p>`, bad, baseCtx({ log }));
    assertAllowed(out, { ours: true });
    expect(frag(out).querySelector('.mm-block').textContent).toContain('This is no longer in your mind map.');
    expect(frag(out).querySelector('.mm-cite').textContent).toBe('[1] (deleted item)');
    expect(formatHtml('<p>[mm:x', null, baseCtx({ log }))).toBeNull();
    const OrigParser = globalThis.DOMParser;
    globalThis.DOMParser = class { parseFromString() { throw new Error('nope'); } };
    try {
      expect(formatHtml(`<p>[mm:${I.f1}]</p>`, port, baseCtx({ log }))).toBeNull();
      expect(log.warn).toHaveBeenCalled();
      expect(log.warn.mock.calls.at(-1)[0]).not.toContain(I.f1);
    } finally {
      globalThis.DOMParser = OrigParser;
    }
  });

  it('uses the module-level state by default', () => {
    const port = makePort();
    const out = formatHtml(`<p>[mm-card:help]</p>`, port, { t, canReformat: true });
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    expect(moduleState.blocks.has(blk)).toBe(true);
    expect(parseInt(blk, 36)).toBeGreaterThan(1e9); // clock-seeded counter
  });
});

// --- Map card ---------------------------------------------------------------------

describe('map card (SPEC §9, AT-6)', () => {
  const render = (focus, ui = {}, extra = {}) => {
    const port = makePort();
    return renderMapCard(port.map(focus, ui.page || {}), { blk: 'k9', rev: 1, dataRev: '5', history: [{ ref: focus.id || 'o' }], mode: 'map', canNavigate: true, ...ui }, { t, locale: 'en', now: NOW, ...extra });
  };

  it('renders the AT-6 neighbourhood with a11y labels and lane DOM order', () => {
    const html = render({ type: 'entity', id: E.bingo });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-label')).toBe('Mind Map centred on Bingo (team)');
    const stage = root.querySelector('.mm-stage');
    const order = [...stage.children].filter((el) => !el.matches('svg')).map((el) => (el.classList.contains('mm-center') ? 'center' : el.classList.contains('mm-hint') ? 'hint' : /mm-s-([udlr])/.exec(el.className)[1]));
    expect(order).toEqual(['center', 'u', 'u', 'l', 'l', 'l', 'l', 'd', 'd', 'hint']);
    // controls come after the lanes in the DOM
    expect([...root.children].map((el) => el.className.split(' ')[0])).toEqual(['mm-stage', 'mm-list', 'mm-bar', 'mm-foot']);
    const nodes = [...stage.querySelectorAll('.mm-node')];
    expect(nodes.map((n) => n.getAttribute('aria-label'))).toEqual([
      'person: Dana',
      'term: MTCS',
      'action: Send MTCS numbers to Dana, open',
      'action: email the bingo team about the demo date, open',
      'action: book the offsite, open',
      'Show 2 more: Actions',
      'note: bingo salary thoughts, private',
      'meeting: Bingo team sync',
    ]);
    expect(nodes.every((n) => n.tagName === 'BUTTON' && n.getAttribute('type') === 'button')).toBe(true);
    expect(nodes[5].textContent).toBe('+2 more');
    expect(nodes[5].getAttribute('data-ext-action')).toBe('mm:bk9:more:left');
    expect(nodes[6].textContent).toBe('🔒bingo salary thoughts');
    expect(nodes[2].getAttribute('data-ext-action')).toBe(`mm:bk9:f:${I.a1}`);
    expect(nodes[2].getAttribute('title')).toBe('Send MTCS numbers to Dana — action · Fri, Oct 30 · due today (Fri, Nov 6)');
    expect(nodes[3].textContent).toBe('☐email the bingo team about the demo date');
    expect(nodes[3].querySelector('.mm-nl > .mm-ni').textContent).toBe('☐');
    expect(stage.querySelector('.mm-hint').textContent).toBe('No docs yet');
    expect(stage.querySelector('.mm-hint').className).toBe('mm-hint mm-x-86 mm-y-50');
    expect(stage.querySelector('.mm-center').textContent).toBe('👥 Bingoteam4 open actions · 1 suggested · 2 notes');
    // one edge per real node, from the centre
    const lines = [...stage.querySelectorAll('svg.mm-edges line')];
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.getAttribute('x1') === '50%' && l.getAttribute('y1') === '50%')).toBe(true);
    expect(lines[0].getAttribute('x2')).toBe('34%');
    expect(lines[0].getAttribute('y2')).toBe('12%');
    expect(root.querySelector('.mm-legend').textContent).toBe('↑ Related← Actions→ Docs & links↓ Notes & meetings');
  });

  it('header: breadcrumb of the last three foci, back, home and list', () => {
    const history = [{ ref: 'o' }, { ref: E.bingo, label: 'Bingo' }, { ref: I.f6, label: 'Bingo team sync' }, { ref: E.dana, label: 'Dana' }];
    const html = render({ type: 'entity', id: E.dana }, { history });
    const bar = frag(html).querySelector('.mm-bar');
    expect(bar.querySelector('.mm-trail').textContent).toBe('🧠…›Bingo›Bingo team sync›Dana');
    expect(bar.querySelector('.mm-trail').getAttribute('aria-label')).toBe('Map history');
    expect([...bar.querySelectorAll('.mm-tool')].map((b) => b.getAttribute('data-ext-action'))).toEqual(['mm:bk9:back', 'mm:bk9:home', 'mm:bk9:mode:list']);
    const home = frag(render({ type: 'overview' }, { history: [{ ref: 'o' }] })).querySelector('.mm-bar');
    expect([...home.querySelectorAll('.mm-tool')].map((b) => b.getAttribute('data-ext-action'))).toEqual(['mm:bk9:mode:list']);
  });

  it('list mode hides the stage and opens the list', () => {
    const html = render({ type: 'entity', id: E.bingo }, { mode: 'list' });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.querySelector('.mm-stage')).toBeNull();
    expect(root.classList.contains('mm-mode-list')).toBe(true);
    const list = root.querySelector('details.mm-list');
    expect(list.hasAttribute('open')).toBe(true);
    expect([...list.querySelectorAll('.mm-list-sec > .mm-cap')].map((c) => c.textContent)).toEqual(['Related', 'Actions', 'Docs & links', 'Notes & meetings']);
    expect(list.querySelectorAll('ul')).toHaveLength(3);
    expect(list.textContent).toContain('No docs yet');
    expect(root.querySelector('[data-ext-action="mm:bk9:mode:map"]')).not.toBeNull();
    // map mode: the list is still there, collapsed
    const closed = frag(render({ type: 'entity', id: E.bingo })).querySelector('details.mm-list');
    expect(closed.hasAttribute('open')).toBe(false);
    expect(closed.querySelectorAll('li').length).toBe(8);
  });

  it('RTL mirrors the lanes and sets dir', () => {
    const html = render({ type: 'entity', id: E.bingo }, {}, { rtl: true });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.getAttribute('dir')).toBe('rtl');
    const action = root.querySelector(`[data-ext-action="mm:bk9:f:${I.a1}"]`);
    expect(action.classList.contains('mm-x-86')).toBe(true);
    expect(action.classList.contains('mm-s-r1')).toBe(true);
    expect(root.querySelector('.mm-hint').classList.contains('mm-x-14')).toBe(true);
    expect(root.querySelector('.mm-legend').textContent).toBe('↑ Related→ Actions← Docs & links↓ Notes & meetings');
    expect(root.querySelector('.mm-sep')?.textContent ?? '‹').toBe('‹');
  });

  it('item focus: centre buttons for an action, Open for a doc', () => {
    const act = frag(render({ type: 'item', id: I.a2 })).querySelector('.mm-center');
    expect([...act.querySelectorAll('[data-ext-action]')].map((b) => b.getAttribute('data-ext-action'))).toEqual([`mm:a:accept:${I.a2}`, `mm:a:dismiss:${I.a2}`]);
    expect(act.textContent).toContain('❔ Dana to share the roadmap deck');
    const doc = frag(render({ type: 'item', id: I.f2 })).querySelector('.mm-center');
    expect(doc.querySelector('.mm-c-meta').textContent).toBe('doc · Wed, Oct 28 · Microsoft Word');
    expect(doc.querySelector('[data-ext-action]').getAttribute('data-ext-action')).toBe(`mm:a:open:${I.f2}`);
  });

  it('highlights matched terms in the centre card', () => {
    const port = makePort();
    const neigh = port.map({ type: 'item', id: I.f1 }, {});
    neigh.center.highlight = ['mtcs'];
    const html = renderMapCard(neigh, { blk: 'k9', history: [{ ref: I.f1 }] }, { t });
    assertAllowed(html);
    expect([...frag(html).querySelectorAll('.mm-hl')].map((s) => s.textContent)).toEqual(['MTCS']);
  });

  it('overview: stats, recent, empty store', () => {
    const html = render({ type: 'overview' });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.getAttribute('aria-label')).toBe('Mind Map overview');
    expect(root.querySelector('.mm-center').textContent).toBe('🧠 Your mind map10 items · 3 people & topics');
    const stats = [...root.querySelectorAll('.mm-node.mm-g-stat')];
    expect(stats.map((s) => s.textContent)).toEqual(['❔1 to review', '☐5 open actions']);
    expect(stats.every((s) => s.tagName === 'SPAN')).toBe(true);
    const empty = renderMapCard(neighborhood({ type: 'overview' }, { overview: () => ({}) }), { blk: 'k9' }, { t, trigger: 'mm' });
    assertAllowed(empty);
    expect(frag(empty).querySelector('.mm-center').textContent).toBe('🧠 Your mind map is emptyType mm+ to save a thought, link or todo');
    expect(frag(empty).querySelectorAll('.mm-hint')).toHaveLength(4);
  });

  it('older hosts: static nodes and an update note', () => {
    const html = render({ type: 'entity', id: E.bingo }, { canNavigate: false });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.querySelector('.mm-stage button')).toBeNull();
    expect(root.querySelector('.mm-tools')).toBeNull();
    expect(root.querySelector('.mm-static').textContent).toBe('Update Kage to navigate the map — or use mm @name');
    // formatHtml derives it from canReformat
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, makePort(), baseCtx({ canReformat: false }));
    expect(frag(out).querySelector('.mm-static')).not.toBeNull();
  });

  it('clips long labels, keeps the full text in title and aria-label, outlines ❔', () => {
    const port = makePort();
    port.s.items[I.a3].title = 'book the offsite venue for the whole Bingo team and the partners';
    const html = renderMapCard(port.map({ type: 'entity', id: E.bingo }, { left: 1 }), { blk: 'k9', history: [{ ref: E.bingo }] }, { t, now: NOW });
    assertAllowed(html);
    const root = frag(html);
    const sug = root.querySelector(`[data-ext-action="mm:bk9:f:${I.a2}"]`);
    expect(sug.querySelector('.mm-ni').classList.contains('mm-ic-q')).toBe(true);
    const page0 = frag(renderMapCard(port.map({ type: 'entity', id: E.bingo }, {}), { blk: 'k9', history: [{ ref: E.bingo }] }, { t, now: NOW }));
    const long = page0.querySelector(`[data-ext-action="mm:bk9:f:${I.a3}"]`);
    expect(long.textContent).toBe('☐book the offsite venue for the whole Bi…');
    expect(long.getAttribute('aria-label')).toBe('action: book the offsite venue for the whole Bingo team and the partners, open');
    expect(long.getAttribute('title')).toContain('book the offsite venue for the whole Bingo team and the partners');
  });

  it('centre snippets drop bullet markers and the repeated title', () => {
    const html = render({ type: 'item', id: I.f6 });
    const snip = frag(html).querySelector('.mm-c-snip').textContent;
    expect(snip.startsWith('Send MTCS numbers to Dana by Friday · Dana to share the roadmap deck · I\'ll book the offsite')).toBe(true);
    expect(snip).not.toContain('[ ]');
    expect(snip).not.toContain('Bingo team sync');
  });

  it('action centre leads with when it is due', () => {
    const c = frag(render({ type: 'item', id: I.a1 })).querySelector('.mm-center');
    expect(c.querySelector('.mm-c-meta').textContent).toBe('due today (Fri, Nov 6)');
    const done = frag(render({ type: 'item', id: I.f9 })).querySelector('.mm-center');
    expect(done.querySelector('.mm-c-meta').textContent).toBe('done Wed, Nov 4');
    expect(done.classList.contains('mm-st-done')).toBe(true);
    expect(done.querySelector('[data-ext-action]').getAttribute('data-ext-action')).toBe(`mm:a:reopen:${I.f9}`);
  });

  it('overview count nodes say how to open them', () => {
    const stats = [...frag(render({ type: 'overview' })).querySelectorAll('.mm-stage .mm-g-stat')];
    expect(stats.map((s) => s.getAttribute('title'))).toEqual(['1 to review — Type mm review to see them', '5 open actions — Type mm actions to see them']);
  });

  it('a deleted focus shows a message and Home', () => {
    const html = renderMapCard(null, { blk: 'k9', history: [{ ref: I.gone }] }, { t });
    assertAllowed(html);
    const root = frag(html).firstElementChild;
    expect(root.textContent).toContain('This is no longer in your mind map.');
    expect(root.querySelector('[data-ext-action="mm:bk9:home"]')).not.toBeNull();
  });

  it('answers null for an up-to-date message without building a DOM', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>See [mm:${I.f1}] [mm:${I.f2}]</p><p>[mm-card:map:${E.bingo}]</p><p>[mm-card:op:${OP}]</p>`, port, ctx);
    const Orig = globalThis.DOMParser;
    let parses = 0;
    globalThis.DOMParser = class extends Orig {
      parseFromString(...args) {
        parses++;
        return super.parseFromString(...args);
      }
    };
    try {
      const start = performance.now();
      for (let i = 0; i < 200; i++) expect(formatHtml(out, port, ctx)).toBeNull();
      const each = (performance.now() - start) / 200;
      if (each > 1) console.warn(`unchanged-message check took ${each.toFixed(2)} ms`);
      expect(parses).toBe(0);
      // a stale card still takes the full pass
      const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
      applyUiAction(ctx.state, parseAction(`mm:b${blk}:f:${E.dana}`));
      expect(formatHtml(out, port, ctx)).toBeTypeOf('string');
      expect(parses).toBe(1);
    } finally {
      globalThis.DOMParser = Orig;
    }
  });

  it('renders the neighbourhood and HTML within budget', () => {
    const port = makePort();
    const neigh = port.map({ type: 'entity', id: E.bingo }, {});
    const start = performance.now();
    for (let i = 0; i < 20; i++) renderMapCard(neigh, { blk: 'k9', history: [{ ref: E.bingo }] }, { t, now: NOW });
    const each = (performance.now() - start) / 20;
    if (each > 30) console.warn(`map render took ${each.toFixed(1)} ms`);
    expect(each).toBeLessThan(200);
    const s2 = performance.now();
    for (let i = 0; i < 200; i++) formatHtml('<p>A long ordinary answer without any markers at all.</p>'.repeat(20), port, baseCtx());
    expect((performance.now() - s2) / 200).toBeLessThan(5);
  });
});

// --- Action grammar (ARCHITECTURE §7.2) ------------------------------------------

describe('parseAction and applyUiAction', () => {
  it('parses every grammar entry', () => {
    for (const verb of ['done', 'reopen', 'accept', 'dismiss', 'open', 'private', 'share', 'delete']) {
      expect(parseAction(`mm:a:${verb}:${I.f1}`)).toEqual({ scope: 'data', verb, id: I.f1 });
    }
    expect(parseAction(`mm:a:undo:${OP}`)).toEqual({ scope: 'data', verb: 'undo', id: OP });
    expect(parseAction(`mm:b1a:f:${E.bingo}`)).toEqual({ scope: 'block', blk: '1a', verb: 'focus', ref: E.bingo });
    expect(parseAction('mm:b1a:f:me')).toEqual({ scope: 'block', blk: '1a', verb: 'focus', ref: 'me' });
    expect(parseAction('mm:b1a:f:o')).toEqual({ scope: 'block', blk: '1a', verb: 'focus', ref: 'o' });
    expect(parseAction('mm:b1a:back')).toEqual({ scope: 'block', blk: '1a', verb: 'back' });
    expect(parseAction('mm:b1a:home')).toEqual({ scope: 'block', blk: '1a', verb: 'home' });
    expect(parseAction('mm:b1a:map')).toEqual({ scope: 'block', blk: '1a', verb: 'map' });
    expect(parseAction('mm:b1a:more:left')).toEqual({ scope: 'block', blk: '1a', verb: 'more', lane: 'left' });
    expect(parseAction('mm:b1a:mode:list')).toEqual({ scope: 'block', blk: '1a', verb: 'mode', mode: 'list' });
    expect(parseAction(`mm:c2:x:3:${I.f1}`)).toEqual({ scope: 'cite', msg: '2', verb: 'expand', n: 3, id: I.f1 });
    expect(parseAction(`mm:c2:map:${E.dana}`)).toEqual({ scope: 'cite', msg: '2', verb: 'dock', id: E.dana });
  });

  it('rejects junk', () => {
    for (const bad of [
      '', null, 42, 'mm:a:done', `mm:a:undo:${I.f1}`, `mm:a:done:${OP}`, `mm:a:launch:${I.f1}`, `mm:a:done:${I.f1}x`,
      'mm:b1:f:../x', `mm:b1:f:${OP}`, 'mm:b1:more:center', 'mm:b1:mode:grid', 'mm:b1:back:x', 'mm:bX1:back', 'mm:b:back',
      `mm:c1:x:0:${I.f1}`, `mm:c1:x:1:${OP}`, 'mm:c1:map:o', `mm:c1:zoom:${I.f1}`, `MM:A:DONE:${I.f1}`, `mm:a:done:${I.f1}`.repeat(3),
    ]) {
      expect(parseAction(bad), String(bad)).toBeNull();
    }
  });

  it('focus pushes, revisiting a crumb truncates, history is capped at 20', () => {
    const state = createFormatterState();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, makePort(), { t, canReformat: true, state });
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    const st = state.blocks.get(blk);
    const go = (ref) => applyUiAction(state, { scope: 'block', blk, verb: 'focus', ref });
    expect(go(E.dana)).toEqual({ changed: true });
    expect(go(E.dana)).toEqual({ changed: false });
    expect(st.history.map((h) => h.ref)).toEqual([E.bingo, E.dana]);
    go(I.f6);
    go(E.bingo);
    expect(st.history.map((h) => h.ref)).toEqual([E.bingo]);
    for (let i = 1; i <= 25; i++) go(id('i', 100 + i));
    expect(st.history).toHaveLength(20);
    expect(st.history.at(-1).ref).toBe(id('i', 125));
  });

  it('back, home, more and mode', () => {
    const state = createFormatterState();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, makePort(), { t, canReformat: true, state });
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    const st = state.blocks.get(blk);
    const act = (p) => applyUiAction(state, { scope: 'block', blk, ...p });
    expect(act({ verb: 'back' })).toEqual({ changed: false });
    expect(act({ verb: 'more', lane: 'left' })).toEqual({ changed: true });
    expect(act({ verb: 'more', lane: 'left' })).toEqual({ changed: true });
    expect(st.page).toEqual({ left: 2 });
    expect(act({ verb: 'home' })).toEqual({ changed: true });
    expect(st.history.map((h) => h.ref)).toEqual([E.bingo, 'o']);
    expect(st.page).toEqual({});
    expect(act({ verb: 'home' })).toEqual({ changed: false });
    expect(act({ verb: 'back' })).toEqual({ changed: true });
    expect(st.history.map((h) => h.ref)).toEqual([E.bingo]);
    expect(act({ verb: 'mode', mode: 'list' })).toEqual({ changed: true });
    expect(act({ verb: 'mode', mode: 'list' })).toEqual({ changed: false });
    expect(st.mode).toBe('list');
    expect(st.rev).toBe(6);
    expect(applyUiAction(state, { scope: 'data', verb: 'done', id: I.f1 })).toEqual({ changed: false });
    expect(applyUiAction(state, null)).toEqual({ changed: false });
    expect(applyUiAction(null, { scope: 'block' })).toEqual({ changed: false });
  });

  it('more pages the lane in the rendered card', () => {
    const port = makePort();
    const ctx = baseCtx();
    const out = formatHtml(`<p>[mm-card:map:${E.bingo}]</p>`, port, ctx);
    const blk = / mm-b([0-9a-z]+) mm-r/.exec(out)[1];
    applyUiAction(ctx.state, parseAction(`mm:b${blk}:more:left`));
    const paged = formatHtml(out, port, ctx);
    const left = [...frag(paged).querySelectorAll('.mm-stage .mm-node')].filter((n) => /mm-s-l/.test(n.className)).map((n) => n.textContent);
    expect(left).toEqual(['☐review the Bingo launch checklist', '❔Dana to share the roadmap deck', '↺ First']);
    expect(port.map).toHaveBeenLastCalledWith({ type: 'entity', id: E.bingo }, { left: 1 });
  });
});

// --- i18n coverage ------------------------------------------------------------------

describe('i18n', () => {
  it('every literal t() key in view.js exists in the fragment', () => {
    const src = readFileSync(join(HERE, 'view.js'), 'utf8');
    const keys = [...src.matchAll(/(?:^|[^\w$])(?:[\w.$]*\.)?t\s*\(\s*['"]([\w.\-]+)['"]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) expect(CATALOG[key], key).toBeDefined();
    const hints = [...src.matchAll(/\/\/\s*i18n-keys:\s*([\w.\-, *]+)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
    for (const hint of hints) {
      const prefix = hint.replace(/\*$/, '');
      expect(Object.keys(CATALOG).some((k) => k.startsWith(prefix)), hint).toBe(true);
    }
  });

  it('every key requested while rendering exists, in a WP-C namespace', () => {
    // `used` collected keys from every render above (vitest runs this file's tests in order).
    expect(used.size).toBeGreaterThan(60);
    const WP_C = /^(card|map|cite|kind|etype|due|range|relax|chip|help)\./;
    for (const key of used) {
      expect(CATALOG[key], key).toBeDefined();
      expect(key).toMatch(WP_C);
    }
    for (const key of Object.keys(CATALOG).filter((k) => WP_C.test(k))) {
      expect(CATALOG[key].message, key).toBeTypeOf('string');
      expect(CATALOG[key].description, key).toBeTypeOf('string');
    }
  });

  it('dynamic kind, type, lane and empty-lane keys all resolve', () => {
    for (const k of ['note', 'link', 'doc', 'action', 'meeting']) {
      expect(CATALOG[`kind.${k}`]).toBeDefined();
      expect(CATALOG[`kind.${k}s`]).toBeDefined();
    }
    for (const e of Object.keys(ETYPE_ICONS)) expect(CATALOG[`etype.${e}`]).toBeDefined();
    for (const role of ['entities', 'actions', 'parent', 'docs', 'notes', 'teams', 'people', 'topics', 'stats']) {
      expect(CATALOG[`map.lane_${role}`], role).toBeDefined();
      expect(CATALOG[`map.empty_${role}`], role).toBeDefined();
    }
  });

  it('view.js imports only lib/graph.js, which imports nothing; local id patterns match lib/ids.js', () => {
    const src = readFileSync(join(HERE, 'view.js'), 'utf8');
    const imports = [...src.matchAll(/\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports).toEqual(['./lib/graph.js']);
    expect(src.split('\n').filter((l) => /^\s*import\s/.test(l))).toHaveLength(1);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\bexport\s+[^;]*\bfrom\s*['"]/);
    const graph = readFileSync(join(HERE, 'lib/graph.js'), 'utf8');
    expect(graph).not.toMatch(/\bimport\b/);
    const ids = readFileSync(join(HERE, 'lib/ids.js'), 'utf8');
    expect(ids).toContain('/\\[mm:([ie][0-9a-z]{14}|me)\\]/g');
    expect(ids).toContain('/\\[mm-card:(op|item|map|help)(?::(o|me|[ieo][0-9a-z]{14}))?\\]/g');
    expect(src).toContain('/\\[mm:([ie][0-9a-z]{14}|me)\\]/g');
    expect(src).toContain('/^\\[mm-card:(op|item|map|help)(?::(o|me|[ieo][0-9a-z]{14}))?\\]$/');
  });

  it('escapeHtml neutralizes markup characters', () => {
    expect(escapeHtml('<a href="x">\'&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
  });
});
