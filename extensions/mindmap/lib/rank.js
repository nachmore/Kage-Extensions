// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Retrieval over a parsed QuerySpec (SPEC §8.2): hard filters, BM25F plus
// structured boosts, AND-first matching with an OR fallback, the labelled
// relaxation ladder, and the ordering and grouping of actions.
//
// ctx = {
//   now, index (lib/bm25.js), getItem(id), idsNewestFirst(): Iterable<id>,
//   idsInRange?(start, end, field) → id[]   (start/end may be null: open-ended),
//   entityItems(entityId) → Set<id>,
//   aliasTerms(entityId) → [{t, w}]         the entity's own name tokens with
//                                           w = 1, alias tokens with w < 1 (0.7),
//   groupOf(item) → entityId | null,
//   hidden?(id) → boolean                   true for private items on the agent path,
//   limit?
// }
// A hard or soft entity a document mentions counts as matching the query
// terms that spell its name ("bingo" matches every item tagged Bingo).
// spec.privateOnly (is:private) keeps private items only; on the agent
// path those are all hidden, so it returns nothing but the hidden count.

export const WEIGHTS = Object.freeze({ entity: 0.6, alias: 0.7, kindDoc: 0.25, kindLink: 0.15, title: 0.2, recency: 0.2, pinned: 0.1 });
export const RELAX_DAYS = 30;
export const DONE_DAYS = 14;
const MAX_TERMS = 30;
const DAY_MS = 86_400_000;

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Calendar arithmetic in local time: never ±86400000 per day (DST).
function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

const lower = (range) => (Number.isFinite(range?.start) ? range.start : -Infinity);
const upper = (range) => (Number.isFinite(range?.end) ? range.end : Infinity);

function times(item, range) {
  if (range?.field === 'due') return Number.isFinite(item.dueAt) ? [item.dueAt] : [];
  if (range?.field === 'done') return Number.isFinite(item.doneAt) ? [item.doneAt] : [];
  return [item.createdAt, item.occurredAt].filter(Number.isFinite);
}

function inRange(item, range) {
  return times(item, range).some((t) => t >= lower(range) && t < upper(range));
}

function distance(item, range) {
  let best = Infinity;
  for (const t of times(item, range)) {
    const d = t < lower(range) ? lower(range) - t : t >= upper(range) ? t - upper(range) + 1 : 0;
    best = Math.min(best, d);
  }
  return best;
}

function widen(range, now) {
  const start = Number.isFinite(range.start) ? addDays(range.start, -RELAX_DAYS) : null;
  let end = Number.isFinite(range.end) ? addDays(range.end, RELAX_DAYS) : null;
  if (range.field !== 'due') end = end === null ? now : Math.min(end, now);
  return { start, end, field: range.field || 'any' };
}

function mentions(item, entityId, ctx) {
  return item.entityIds?.includes(entityId) || !!ctx.entityItems?.(entityId)?.has(item.id);
}

function statusOk(item, status, now) {
  if (status === 'all') return true;
  const action = item.kind === 'action';
  if (!status) return !(action && item.status === 'dismissed');
  if (!action) return false;
  if (status === 'open') return item.status === 'open' && !item.suggested;
  if (status === 'done') return item.status === 'done';
  if (status === 'suggested') return item.status === 'open' && !!item.suggested;
  if (status === 'overdue') return item.status === 'open' && !item.suggested && Number.isFinite(item.dueAt) && item.dueAt < dayStart(now);
  return true;
}

function ownerOk(item, owner) {
  if (!owner || owner === 'anyone') return true;
  return item.kind === 'action' && item.owner === owner;
}

const byNewestId = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const dateOf = (item) => (Number.isFinite(item.occurredAt) ? item.occurredAt : item.createdAt);

function entityIdsOf(ctx, entityId) {
  const set = ctx.entityItems?.(entityId);
  return set ? [...set] : [];
}

function evaluate(spec, ctx, { distanceFrom = null, originalRange = null } = {}) {
  // Masks below hold one bit per term or entity: at most 30 of each count.
  const positive = (spec.terms || []).filter((q) => q?.t && !q.neg).slice(0, MAX_TERMS);
  const negative = (spec.terms || []).filter((q) => q?.t && q.neg);
  const entities = (spec.entities || []).filter((e) => e?.entityId);
  const hard = entities.filter((e) => e.hard);
  const range = spec.range && !spec.range.soft ? spec.range : null;
  const softRange = spec.range?.soft ? spec.range : null;

  const info = entities.slice(0, MAX_TERMS).map((e) => {
    const list = Array.isArray(ctx.aliasTerms?.(e.entityId)) ? ctx.aliasTerms(e.entityId) : [];
    return {
      entityId: e.entityId,
      name: new Set(list.filter((a) => a?.t && (a.w ?? 1) >= 1).map((a) => a.t)),
      alias: list.filter((a) => a?.t && (a.w ?? 1) < 1),
    };
  });
  const covers = (name, q) => name.has(q.t) || (q.prefix && [...name].some((t) => t.startsWith(q.t)));

  const query = [
    ...positive.map((q) => ({ t: q.t, w: Number.isFinite(q.w) ? q.w : 1, prefix: !!q.prefix })),
    ...negative.map((q) => ({ t: q.t, neg: true })),
  ];
  const aliasStart = query.length;
  const aliasOwner = [];
  info.forEach((entry, k) => {
    for (const a of entry.alias) {
      if (query.some((q) => !q.neg && q.t === a.t)) continue;
      query.push({ t: a.t, w: Number.isFinite(a.w) ? a.w : WEIGHTS.alias });
      aliasOwner.push(k);
    }
  });

  const checked = new Map();
  const check = (id) => {
    const item = ctx.getItem(id);
    if (!item || item.archived) return false;
    if (spec.privateOnly && !item.private) return false;
    if (spec.kinds?.length && !spec.kinds.includes(item.kind)) return false;
    if (range && !inRange(item, range)) return false;
    if (!statusOk(item, spec.status, ctx.now)) return false;
    if (!ownerOk(item, spec.owner)) return false;
    return hard.every((e) => mentions(item, e.entityId, ctx));
  };
  const passes = (id) => {
    if (!checked.has(id)) checked.set(id, check(id));
    return checked.get(id);
  };

  const bm = new Map();
  let ids;
  if (positive.length) {
    for (const hit of ctx.index.search(query, { filter: passes, limit: Infinity })) bm.set(hit.id, hit);
    ids = new Set(bm.keys());
    info.forEach((entry) => {
      if (positive.some((q) => covers(entry.name, q))) for (const id of entityIdsOf(ctx, entry.entityId)) ids.add(id);
    });
  } else if (hard.length) ids = entityIdsOf(ctx, hard[0].entityId);
  else if (range && typeof ctx.idsInRange === 'function') ids = ctx.idsInRange(range.start ?? null, range.end ?? null, range.field || 'any');
  else ids = ctx.idsNewestFirst();

  const negatives = negative.map((q) => ctx.index.postings(q.t));
  // Bit i of a row's mask: query term i matched (directly, by alias, or
  // through an entity whose name spells it).
  const all = 2 ** positive.length - 1;
  const coverMask = info.map((entry) => positive.reduce((mask, q, i) => (covers(entry.name, q) ? mask | (1 << i) : mask), 0));
  const rows = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!passes(id) || negatives.some((set) => set.has(id))) continue;
    const item = ctx.getItem(id);
    const hit = bm.get(id);
    let mask = 0;
    let viaAlias = 0;
    let direct = 0;
    for (const i of hit?.matched || []) {
      if (i < positive.length) mask |= 1 << i;
      else if (i >= aliasStart) viaAlias |= 1 << aliasOwner[i - aliasStart];
    }
    for (let k = 0; k < info.length; k++) {
      if (mentions(item, info[k].entityId, ctx)) direct |= 1 << k;
      if ((direct | viaAlias) & (1 << k)) mask |= coverMask[k];
    }
    rows.push({ id, item, hit, mask, direct, viaAlias, visible: !ctx.hidden?.(id), score: 0, title: false, inSoft: false });
  }

  let kept = rows;
  if (positive.length) {
    const complete = rows.filter((r) => r.mask === all);
    kept = complete.some((r) => r.visible) ? complete : rows.filter((r) => r.mask !== 0);
  }
  let hiddenPrivate = 0;
  const visible = [];
  for (const r of kept) {
    if (r.visible) visible.push(r);
    else hiddenPrivate++;
  }

  const maxBm = visible.reduce((max, r) => Math.max(max, r.hit?.score || 0), 0);
  const kindBoost = (item) => (spec.kindBoost !== 'doc' ? 0
    : item.kind === 'doc' ? WEIGHTS.kindDoc : item.kind === 'link' ? WEIGHTS.kindLink : 0);
  for (const r of visible) {
    let score = maxBm > 0 && r.hit ? r.hit.score / maxBm : 0;
    if (info.length) {
      let total = 0;
      for (let k = 0; k < info.length; k++) {
        if (r.direct & (1 << k)) total += 1;
        else if (r.viaAlias & (1 << k)) total += WEIGHTS.alias;
      }
      score += WEIGHTS.entity * (total / info.length);
    }
    score += kindBoost(r.item);
    r.title = !!r.hit?.hits.some((t) => ctx.index.fieldHas(r.id, 'title', t));
    if (r.title) score += WEIGHTS.title;
    r.inSoft = !!softRange && inRange(r.item, softRange);
    if (r.inSoft) score += WEIGHTS.recency;
    else if (!originalRange && !softRange) {
      const age = Math.max(0, (ctx.now - r.item.createdAt) / DAY_MS);
      score += WEIGHTS.recency * (spec.recency ? 2 : 1) * 0.5 ** (age / 30);
    }
    if (r.item.pinned) score += WEIGHTS.pinned;
    r.score = score;
  }

  if (distanceFrom) {
    for (const r of visible) r.distance = distance(r.item, distanceFrom);
    visible.sort((a, b) => a.distance - b.distance || b.score - a.score || byNewestId(a, b));
  } else if (positive.length) {
    visible.sort((a, b) => b.score - a.score || byNewestId(a, b));
  } else {
    visible.sort((a, b) => dateOf(b.item) - dateOf(a.item) || byNewestId(a, b));
  }

  // Explanations are built only for the rows the caller returns.
  const describe = (r) => {
    const why = [];
    const terms = [];
    for (const term of r.hit?.hits || []) {
      if (!terms.includes(term)) terms.push(term);
      why.push({ code: 'term', value: term });
    }
    info.forEach((entry, k) => {
      if (r.direct & (1 << k)) why.push({ code: 'entity', value: entry.entityId });
      else if (r.viaAlias & (1 << k)) why.push({ code: 'alias', value: entry.entityId });
    });
    if (kindBoost(r.item)) why.push({ code: 'kind', value: r.item.kind });
    if (r.title) why.push({ code: 'title' });
    if (range || r.inSoft) why.push({ code: 'range' });
    return { id: r.id, score: r.score, why, terms };
  };
  return { rows: visible, hiddenPrivate, describe };
}

// QuerySpec → { hits: [{id, score, why, terms}], relaxed, total, hiddenPrivate }.
// relaxed is null when the query matched as asked; otherwise the step that
// produced the hits ('range_widened' with its range, 'range_dropped',
// 'kinds_dropped', 'entities_softened') or 'none' when nothing matched.
export function runQuery(spec, ctx) {
  const limit = Number.isFinite(ctx.limit) ? ctx.limit : 50;
  const originalRange = spec.range && !spec.range.soft ? spec.range : null;
  const steps = [{ spec, relaxed: null }];
  // Each step relaxes one more thing. (A patch object rather than
  // `x = { ...x, … }`, which sends the repo's static analyzer into a loop.)
  const relax = {};
  if (originalRange) {
    const widened = widen(originalRange, ctx.now);
    steps.push({
      spec: { ...spec, range: { ...originalRange, start: widened.start, end: widened.end } },
      relaxed: { code: 'range_widened', range: widened },
      distanceFrom: originalRange,
    });
    relax.range = null;
    steps.push({ spec: { ...spec, ...relax }, relaxed: { code: 'range_dropped' } });
  }
  if (spec.kinds?.length) {
    relax.kinds = null;
    steps.push({ spec: { ...spec, ...relax }, relaxed: { code: 'kinds_dropped' } });
  }
  if ((spec.entities || []).some((e) => e?.hard)) {
    relax.entities = spec.entities.map((e) => ({ ...e, hard: false }));
    steps.push({ spec: { ...spec, ...relax }, relaxed: { code: 'entities_softened' } });
  }
  // Last: a time was asked and its leftover words match nothing anywhere
  // ("what did I add on tuesday blah"): everything from that time, as asked.
  const positive = (spec.terms || []).filter((q) => q?.t && !q.neg);
  if (originalRange && positive.length) {
    steps.push({ spec: { ...spec, terms: (spec.terms || []).filter((q) => q?.neg) }, relaxed: { code: 'terms_dropped', range: originalRange } });
  }
  let first = null;
  for (const step of steps) {
    const result = evaluate(step.spec, ctx, { distanceFrom: step.distanceFrom, originalRange });
    first ??= result;
    if (result.rows.length) {
      return {
        hits: result.rows.slice(0, limit).map(result.describe),
        relaxed: step.relaxed,
        total: result.rows.length,
        hiddenPrivate: result.hiddenPrivate,
      };
    }
  }
  return { hits: [], relaxed: { code: 'none' }, total: 0, hiddenPrivate: first.hiddenPrivate };
}

// QuerySpec → { open, suggested, done, groups: [{entityId, ids}], total, hiddenPrivate }.
// Owner defaults to me (anyone for suggestions); status defaults to open,
// which also returns actions done in the last 14 days. Open actions: overdue
// first, then by due date, then undated ones by newest parent, in source
// order within a parent. Suggestions newest first; done by doneAt, newest
// first. Groups follow the primary list (open, suggested or done; all three
// for 'all'), keyed by ctx.groupOf, with the ungrouped ("Other") last.
export function runActions(spec, ctx) {
  const limit = Number.isFinite(ctx.limit) ? ctx.limit : 50;
  const status = spec.status || 'open';
  const owner = spec.owner ?? (status === 'suggested' ? 'anyone' : 'me');
  const today = dayStart(ctx.now);
  const doneSince = addDays(ctx.now, -DONE_DAYS);
  const hard = (spec.entities || []).filter((e) => e?.entityId && e.hard);
  const soft = (spec.entities || []).filter((e) => e?.entityId && !e.hard);
  const positive = (spec.terms || []).filter((q) => q?.t && !q.neg);
  const negatives = (spec.terms || []).filter((q) => q?.t && q.neg).map((q) => ctx.index.postings(q.t));
  const range = spec.range && !spec.range.soft ? spec.range : null;
  const names = [...hard, ...soft].map((e) => ({
    entityId: e.entityId,
    name: new Set((ctx.aliasTerms?.(e.entityId) || []).filter((a) => a?.t && (a.w ?? 1) >= 1).map((a) => a.t)),
  }));

  let termMatches = null;
  if (positive.length) {
    termMatches = new Map();
    for (const hit of ctx.index.search(positive, { limit: Infinity, filter: (id) => ctx.getItem(id)?.kind === 'action' })) {
      termMatches.set(hit.id, new Set(hit.matched));
    }
  }
  // The words of the note an action came from count for it too, from that
  // note's title only ("my actions from the bingo retro").
  const parentTitleHas = (item, q) => {
    if (!item.parentId || typeof ctx.index.fieldTerms !== 'function') return false;
    const terms = ctx.index.fieldTerms(item.parentId, 'title');
    return terms.has(q.t) || (!!q.prefix && [...terms].some((t) => t.startsWith(q.t)));
  };
  // AND first; when no action has every word, any word (relaxed: 'any_word').
  let needAll = true;
  let relaxed = null;

  const source = hard.length ? entityIdsOf(ctx, hard[0].entityId) : [...ctx.idsNewestFirst()];
  let open = [];
  let suggested = [];
  let done = [];
  let hiddenPrivate = 0;
  for (let pass = 0; pass < 2; pass++) {
    open = [];
    suggested = [];
    done = [];
    hiddenPrivate = 0;
    const seen = new Set();
    for (const id of source) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = ctx.getItem(id);
      if (!item || item.kind !== 'action' || item.archived || item.status === 'dismissed') continue;
      if (spec.privateOnly && !item.private) continue;
      if (!ownerOk(item, owner)) continue;
      if (!hard.every((e) => mentions(item, e.entityId, ctx))) continue;
      if (range && !inRange(item, range)) continue;
      if (negatives.some((set) => set.has(id))) continue;
      if (termMatches) {
        const matched = new Set(termMatches.get(id) || []);
        for (const n of names) {
          if (mentions(item, n.entityId, ctx)) positive.forEach((q, i) => { if (n.name.has(q.t)) matched.add(i); });
        }
        positive.forEach((q, i) => { if (!matched.has(i) && parentTitleHas(item, q)) matched.add(i); });
        if (needAll ? matched.size < positive.length : !matched.size) continue;
      }
      let bucket = null;
      if (item.status === 'open' && !item.suggested) {
        if (status === 'open' || status === 'all') bucket = open;
        else if (status === 'overdue' && Number.isFinite(item.dueAt) && item.dueAt < today) bucket = open;
      } else if (item.status === 'open') {
        if (status === 'suggested' || status === 'all') bucket = suggested;
      } else if (item.status === 'done') {
        const at = Number.isFinite(item.doneAt) ? item.doneAt : item.updatedAt;
        if (status === 'done' || status === 'all' || (status === 'open' && at >= doneSince)) bucket = done;
      }
      if (!bucket) continue;
      if (ctx.hidden?.(id)) { hiddenPrivate++; continue; }
      bucket.push(item);
    }
    const found = status === 'suggested' ? suggested : status === 'done' ? done : status === 'all' ? [...open, ...suggested, ...done] : open;
    if (found.length || !termMatches || positive.length < 2 || !needAll) break;
    needAll = false;
    relaxed = { code: 'any_word' };
  }

  const parentOf = (item) => (item.parentId ? ctx.getItem(item.parentId) : null) || item;
  open.sort((a, b) => {
    const ao = Number.isFinite(a.dueAt) && a.dueAt < today;
    const bo = Number.isFinite(b.dueAt) && b.dueAt < today;
    if (ao !== bo) return ao ? -1 : 1;
    const ad = Number.isFinite(a.dueAt) ? a.dueAt : Infinity;
    const bd = Number.isFinite(b.dueAt) ? b.dueAt : Infinity;
    if (ad !== bd) return ad - bd;
    const pa = parentOf(a);
    const pb = parentOf(b);
    if (pa.createdAt !== pb.createdAt) return pb.createdAt - pa.createdAt;
    if (pa.id !== pb.id) return pa.id < pb.id ? 1 : -1;
    return (a.seg ?? 0) - (b.seg ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  suggested.sort((a, b) => b.createdAt - a.createdAt || (a.seg ?? 0) - (b.seg ?? 0) || byNewestId(a, b));
  const doneAt = (item) => (Number.isFinite(item.doneAt) ? item.doneAt : item.updatedAt);
  done.sort((a, b) => doneAt(b) - doneAt(a) || byNewestId(a, b));

  const primary = status === 'suggested' ? suggested : status === 'done' ? done
    : status === 'all' ? [...open, ...suggested, ...done] : open;
  const listed = primary.slice(0, limit);
  const groups = [];
  const byGroup = new Map();
  for (const item of listed) {
    const key = ctx.groupOf?.(item) ?? null;
    if (!byGroup.has(key)) {
      const group = { entityId: key, ids: [] };
      byGroup.set(key, group);
      groups.push(group);
    }
    byGroup.get(key).ids.push(item.id);
  }
  groups.sort((a, b) => (a.entityId === null) - (b.entityId === null));
  const ids = (list) => list.slice(0, limit).map((item) => item.id);
  return {
    open: ids(open), suggested: ids(suggested), done: ids(done), groups, total: primary.length, hiddenPrivate,
    relaxed: primary.length ? relaxed : null,
  };
}
