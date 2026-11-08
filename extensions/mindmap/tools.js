// Mind Map's agent tools (SPEC §11): search, actions, get, entity, capture
// and annotate. Entry module.
//
// Every result is compact JSON (≈8 KB at most), framed as data with the
// same `note`, and never contains private items, items that mention a
// private entity, or window titles / app names (except a doc's own title).
// Write tools are additive and journaled, so `mm undo` reverts them.

import { getMind } from './mind.js';
import { rangeLabel } from './view.js';
import { DEFAULTS, LIMITS } from './defaults.js';

const KINDS = Object.freeze(['note', 'link', 'doc', 'action', 'meeting']);
const STATUSES = Object.freeze(['open', 'done', 'suggested', 'all']);
const ETYPES = Object.freeze(['person', 'team', 'project', 'topic', 'org', 'term']);
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Arrays may arrive as arrays, JSON strings or comma lists.
export function toList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Not JSON: a comma list.
      }
    }
    return s.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return [value];
}

// Objects (or arrays of objects) may arrive as JSON strings.
function toObjects(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object');
  return value && typeof value === 'object' ? [value] : [];
}

function str(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value) {
  if (typeof value === 'string') return /^(?:true|yes|1|on)$/i.test(value.trim());
  return value === true;
}

function isoDay(value) {
  const s = str(value, 32);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m && ISO_DAY_RE.test(m[1]) ? m[1] : null;
}

// Keeps a result under the size cap by dropping trailing list entries.
function capSize(result, listKey, max = LIMITS.toolBytes) {
  const list = result[listKey];
  if (!Array.isArray(list)) return result;
  let size = JSON.stringify(result).length;
  let cut = false;
  while (size > max && list.length) {
    list.pop();
    cut = true;
    size = JSON.stringify(result).length;
  }
  if (cut) result.truncated = true;
  return result;
}

export default class MindMapToolProvider {
  initialize(context) {
    this.context = context;
    this.mind = getMind(context);
    this.log = context.log;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  onConfigUpdate(config) {
    this.config = config || {};
    this.mind.setConfig(this.config);
  }

  get enabled() {
    return this.config.enabled !== false && (this.config.agent_tools ?? DEFAULTS.agent_tools) !== false;
  }

  getToolTimeout() {
    return LIMITS.toolTimeoutMs;
  }

  getTools() {
    if (!this.enabled) return [];
    const t = this.t;
    const kinds = KINDS.join('|');
    return [
      {
        name: 'search',
        description: t('tool.search', { kinds, max: LIMITS.searchMax }),
        parameters: {
          query: { type: 'string', required: true, description: t('tool.search_query') },
          kinds: { type: 'array', items: { type: 'string', enum: [...KINDS] }, description: t('tool.search_kinds', { kinds }) },
          entity: { type: 'string', description: t('tool.search_entity') },
          from: { type: 'string', description: t('tool.search_from') },
          to: { type: 'string', description: t('tool.search_to') },
          when: { type: 'string', description: t('tool.search_when') },
          limit: { type: 'number', default: LIMITS.searchDefault, description: t('tool.limit', { max: LIMITS.searchMax }) },
        },
      },
      {
        name: 'actions',
        description: t('tool.actions', { statuses: STATUSES.join('|') }),
        parameters: {
          entity: { type: 'string', description: t('tool.actions_entity') },
          assignee: { type: 'string', default: 'me', description: t('tool.actions_assignee') },
          status: { type: 'string', enum: [...STATUSES], default: 'open', description: t('tool.actions_status', { statuses: STATUSES.join('|') }) },
          due_before: { type: 'string', description: t('tool.actions_due_before') },
          limit: { type: 'number', default: LIMITS.actionsDefault, description: t('tool.limit', { max: LIMITS.actionsMax }) },
        },
      },
      {
        name: 'get',
        description: t('tool.get'),
        parameters: { id: { type: 'string', required: true, description: t('tool.get_id') } },
      },
      {
        name: 'entity',
        description: t('tool.entity'),
        parameters: { name: { type: 'string', required: true, description: t('tool.entity_name') } },
      },
      {
        name: 'capture',
        description: t('tool.capture', { max: LIMITS.captureText }),
        parameters: {
          text: { type: 'string', required: true, description: t('tool.capture_text', { max: LIMITS.captureText }) },
          title: { type: 'string', description: t('tool.capture_title') },
          kind: { type: 'string', enum: [...KINDS], description: t('tool.capture_kind', { kinds }) },
          url: { type: 'string', description: t('tool.capture_url') },
          path: { type: 'string', description: t('tool.capture_path') },
          summary: { type: 'string', description: t('tool.capture_summary') },
          terms: { type: 'array', items: { type: 'string' }, description: t('tool.capture_terms') },
          actions: { type: 'array', items: { type: 'object' }, description: t('tool.capture_actions') },
          private: { type: 'boolean', default: false, description: t('tool.capture_private') },
        },
      },
      {
        name: 'annotate',
        description: t('tool.annotate', { max: LIMITS.organizeItems }),
        parameters: {
          items: { type: 'array', items: { type: 'object' }, required: true, description: t('tool.annotate_items', { max: LIMITS.organizeItems, etypes: ETYPES.join('|'), kinds }) },
        },
      },
    ];
  }

  async execute(name, params = {}) {
    if (this.config.enabled === false) return { error: this.t('tool.disabled') };
    if (!this.enabled) return { error: this.t('tool.off') };
    const p = params && typeof params === 'object' ? params : {};
    const mind = this.mind;
    try {
      await mind.ready();
      await mind.syncIfStale();
      switch (name) {
        case 'search': return { result: this.search(p) };
        case 'actions': return { result: this.actions(p) };
        case 'get': return { result: this.get(p) };
        case 'entity': return { result: this.entity(p) };
        case 'capture': return { result: await this.capture(p) };
        case 'annotate': return { result: await this.annotate(p) };
        default: return { error: this.t('tool.unknown', { name: str(name, 40) }) };
      }
    } catch (error) {
      this.log?.warn?.(`mindmap: tool failed (${error?.code || error?.name || 'error'})`);
      // i18n-keys: err.*
      const code = error?.code && ['readonly', 'busy', 'conflict', 'io', 'unreadable'].includes(error.code) ? error.code : 'generic';
      return { error: this.t(`err.${code}`) };
    }
  }

  get note() {
    return this.t('tool.note');
  }

  locale() {
    try {
      return this.context.i18n?.language?.() || 'en';
    } catch {
      return 'en';
    }
  }

  // --- search ------------------------------------------------------------------

  search(p) {
    const mind = this.mind;
    const query = str(p.query, 500);
    const spec = mind.parse(query, { trailingSpace: true });
    const wantKinds = toList(p.kinds).map((k) => str(k, 20).toLowerCase()).filter((k) => KINDS.includes(k));
    // The search tool finds items; an "actions" reading becomes a kind filter.
    const find = { ...spec, intent: 'find', command: null };
    if (spec.intent === 'actions' || spec.command === 'actions') {
      find.kinds = ['action'];
      find.owner = spec.owner === 'me' && !/\b(?:my|mine|me|i)\b/i.test(query) ? null : spec.owner;
      find.status = null;
    }
    if (wantKinds.length) {
      find.kinds = [...new Set(wantKinds)];
      find.kindBoost = find.kinds.includes('doc') && find.kinds.includes('link') ? 'doc' : null;
    }
    const unresolved = [];
    const entityName = str(p.entity, 120);
    if (entityName) {
      const hit = mind.resolveEntity(entityName.replace(/^[@#]/, ''), null);
      if (hit && !mind.entity(hit.entityId)?.private) {
        find.entities = [...find.entities.filter((e) => e.entityId !== hit.entityId), { entityId: hit.entityId, hard: true, via: 'marker', name: hit.name, type: hit.type }];
      } else {
        unresolved.push(entityName);
      }
    }
    const from = isoDay(p.from);
    const to = isoDay(p.to);
    if (from || to) {
      const start = from ? mind.dayStart(from) : 0;
      const end = to ? mind.dayStart(to) : null;
      find.range = { start, end: end ?? mind.now(), granularity: 'day', span: [0, 0], code: 'tool', field: 'any' };
    } else if (str(p.when, 80)) {
      const range = mind.rangeOf(str(p.when, 80));
      if (range) find.range = range;
    }
    const limit = int(p.limit, LIMITS.searchDefault, 1, LIMITS.searchMax);
    const out = mind.find(find, { forAgent: true, limit });
    const results = [];
    for (const hit of out.hits) {
      const why = this.whyOf(hit, find);
      const record = mind.agentRecord(hit.item, { terms: find.terms, why });
      if (record) results.push(record);
    }
    const scope = this.scopeOf(find, out.relaxed, unresolved);
    return capSize({ scope, results, total: results.length, hiddenPrivate: out.hiddenPrivate || 0, note: this.note }, 'results');
  }

  whyOf(hit, spec) {
    const raw = new Map();
    for (const term of spec.terms || []) if (term?.t && !raw.has(term.t)) raw.set(term.t, term.raw || term.t);
    const out = [];
    for (const term of hit.terms || []) out.push(`term:${raw.get(term) || term}`);
    for (const why of hit.why || []) {
      if (why.code === 'entity' || why.code === 'alias') {
        const entity = this.mind.entity(why.value);
        if (entity && !entity.private && entity.id !== 'me') out.push(`${why.code}:${entity.name}`);
      } else if (why.code === 'kind' || why.code === 'title' || why.code === 'range') {
        out.push(why.code === 'kind' ? `kind:${why.value}` : why.code);
      }
    }
    return [...new Set(out)];
  }

  scopeOf(spec, relaxed, unresolved = []) {
    const mind = this.mind;
    const range = spec.range;
    const entities = [];
    for (const e of spec.entities || []) {
      const entity = mind.entity(e.entityId);
      if (entity && !entity.private && entity.id !== 'me' && !entities.includes(entity.name)) entities.push(entity.name);
    }
    const scope = {
      kinds: spec.kinds?.length ? [...spec.kinds] : null,
      from: range && range.start > 0 ? mind.isoDay(range.start) : null,
      to: range && Number.isFinite(range.end) ? mind.isoDay(range.end) : null,
      rangeLabel: range ? rangeLabel(range, { t: this.t, locale: this.locale(), now: mind.now() }) || null : null,
      entities,
      terms: (spec.terms || []).filter((t) => !t.neg && (t.w ?? 1) >= 1).map((t) => t.raw || t.t),
      relaxed: relaxed?.code ? relaxed.code : null,
    };
    if (relaxed?.range) {
      scope.widenedFrom = mind.isoDay(relaxed.range.start);
      scope.widenedTo = Number.isFinite(relaxed.range.end) ? mind.isoDay(relaxed.range.end) : null;
    }
    const unknown = [...unresolved, ...(spec.unresolved || []).map((u) => u.phrase)].filter(Boolean);
    if (unknown.length) scope.unresolved = [...new Set(unknown)];
    return scope;
  }

  // --- actions -----------------------------------------------------------------------

  actions(p) {
    const mind = this.mind;
    const spec = mind.parse('actions', { trailingSpace: true });
    const status = STATUSES.includes(str(p.status, 20).toLowerCase()) ? str(p.status, 20).toLowerCase() : 'open';
    const assignee = str(p.assignee, 80) || 'me';
    if (/^(?:me|i|myself|mine)$/i.test(assignee)) spec.owner = 'me';
    else if (/^(?:anyone|everyone|all|any)$/i.test(assignee)) spec.owner = 'anyone';
    else {
      const hit = mind.resolveEntity(assignee.replace(/^@/, ''), 'person');
      if (!hit) return { groups: [], total: 0, hiddenPrivate: 0, unresolved: [assignee], suggestions: mind.suggestNames(assignee), note: this.note };
      spec.owner = hit.entityId;
    }
    spec.status = status === 'all' ? 'all' : status;
    const entityName = str(p.entity, 120);
    if (entityName) {
      const hit = mind.resolveEntity(entityName.replace(/^[@#]/, ''), null);
      if (!hit || mind.entity(hit.entityId)?.private) {
        return { groups: [], total: 0, hiddenPrivate: 0, unresolved: [entityName], suggestions: mind.suggestNames(entityName), note: this.note };
      }
      spec.entities.push({ entityId: hit.entityId, hard: true, via: 'marker', name: hit.name, type: hit.type });
    }
    const dueBefore = isoDay(p.due_before);
    if (dueBefore) spec.range = { start: 0, end: mind.dayStart(dueBefore), granularity: 'day', span: [0, 0], code: 'tool', field: 'due' };
    const limit = int(p.limit, LIMITS.actionsDefault, 1, LIMITS.actionsMax);
    const out = mind.actions(spec, { forAgent: true, limit: LIMITS.actionsMax });
    const pick = status === 'open' ? out.open : status === 'done' ? out.done : status === 'suggested' ? out.suggested
      : [...out.open, ...out.suggested, ...out.done];
    const wanted = new Set(pick.slice(0, limit).map((item) => item.id));
    const groups = [];
    let total = 0;
    const placed = new Set();
    for (const group of out.groups) {
      const actions = group.items.filter((item) => wanted.has(item.id) && !placed.has(item.id));
      if (!actions.length) continue;
      for (const item of actions) placed.add(item.id);
      const records = actions.map((item) => this.actionRecord(item)).filter(Boolean);
      total += records.length;
      groups.push({ entity: group.entity && !group.entity.private ? group.entity.name : null, actions: records });
    }
    const rest = pick.filter((item) => wanted.has(item.id) && !placed.has(item.id)).map((item) => this.actionRecord(item)).filter(Boolean);
    if (rest.length) {
      total += rest.length;
      const other = groups.find((g) => g.entity === null);
      if (other) other.actions.push(...rest);
      else groups.push({ entity: null, actions: rest });
    }
    const result = { groups, total, hiddenPrivate: out.hiddenPrivate || 0, note: this.note };
    let size = JSON.stringify(result).length;
    while (size > LIMITS.toolBytes && groups.length) {
      const last = groups[groups.length - 1];
      last.actions.pop();
      result.total -= 1;
      result.truncated = true;
      if (!last.actions.length) groups.pop();
      size = JSON.stringify(result).length;
    }
    return result;
  }

  actionRecord(item) {
    const mind = this.mind;
    if (mind.isHidden(item)) return null;
    const parent = item.parentId ? mind.item(item.parentId) : null;
    return {
      cite: mind.cite(item.id),
      text: mind.agentText(item.title),
      status: mind.actionStatus(item),
      due: Number.isFinite(item.dueAt) ? mind.isoDay(item.dueAt) : null,
      owner: mind.ownerName(item),
      suggested: !!item.suggested && item.status === 'open',
      source: parent && !mind.isHidden(parent) ? { cite: mind.cite(parent.id), title: mind.agentText(parent.title) } : null,
    };
  }

  // --- get / entity ----------------------------------------------------------------------

  get(p) {
    const mind = this.mind;
    const id = mind.stripCite(str(p.id, 80));
    const item = id ? mind.item(id) : null;
    if (!item) {
      const entity = id ? mind.entity(id) : null;
      if (entity && entity.id !== 'me') return entity.private ? { error: 'private', note: this.note } : this.entity({ name: entity.name });
      return { error: 'not_found', note: this.note };
    }
    if (mind.isHidden(item)) return { error: 'private', note: this.note };
    const record = mind.agentRecord(item);
    const out = {
      cite: record.cite,
      kind: record.kind,
      title: record.title,
      text: mind.agentText(item.text, LIMITS.getText, { keepLines: true }),
      summary: item.summary ? mind.agentText(item.summary) : null,
    };
    if (record.url) out.url = record.url;
    if (item.path) out.path = item.path;
    out.created = mind.isoDay(item.createdAt);
    if (Number.isFinite(item.occurredAt)) out.occurred = mind.isoDay(item.occurredAt);
    out.entities = record.entities;
    if (item.kind === 'action') {
      out.status = record.status;
      out.due = record.due ?? null;
      out.owner = record.owner;
    }
    out.actions = mind.childrenOf(item.id)
      .filter((c) => c.kind === 'action' && c.status !== 'dismissed' && !mind.isHidden(c))
      .map((c) => ({ cite: mind.cite(c.id), text: mind.agentText(c.title), status: mind.actionStatus(c), due: Number.isFinite(c.dueAt) ? mind.isoDay(c.dueAt) : null }));
    out.related = mind.related(item.id, 5, { forAgent: true }).map((r) => mind.item(r.id)).filter(Boolean)
      .map((r) => ({ cite: mind.cite(r.id), title: mind.agentText(r.title) }));
    const parent = item.parentId ? mind.item(item.parentId) : null;
    if (parent && !mind.isHidden(parent)) out.parent = { cite: mind.cite(parent.id), title: mind.agentText(parent.title) };
    out.note = this.note;
    // Escaping inflates JSON, so shrink the text until the result fits.
    let max = LIMITS.getText;
    for (let size = JSON.stringify(out).length; size > LIMITS.toolBytes && max > 0; size = JSON.stringify(out).length) {
      max = Math.max(0, max - (size - LIMITS.toolBytes) - 40);
      out.text = mind.agentText(item.text, max, { keepLines: true });
      out.truncated = true;
    }
    while (JSON.stringify(out).length > LIMITS.toolBytes && out.related.length) out.related.pop();
    return out;
  }

  entity(p) {
    const mind = this.mind;
    const name = str(p.name, 120).replace(/^[@#]/, '');
    const hit = name ? mind.resolveEntity(name, null) : null;
    const entity = hit && hit.entityId !== 'me' ? mind.entity(hit.entityId) : null;
    if (!entity) return { error: 'not_found', suggestions: mind.suggestNames(name), note: this.note };
    if (entity.private) return { error: 'private', note: this.note };
    const items = mind.itemsOf(entity.id).filter((item) => !item.archived && !mind.isHidden(item));
    const openActions = items.filter((item) => item.kind === 'action' && item.status === 'open' && !item.suggested).length;
    const recent = [...items].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .filter((item) => !(item.kind === 'action' && item.status === 'dismissed'))
      .slice(0, 8).map((item) => mind.agentRecord(item)).filter(Boolean);
    const related = mind.cooccur(entity.id)
      .map((r) => ({ entity: mind.entity(r.id), weight: r.w }))
      .filter((r) => r.entity && !r.entity.private && r.entity.id !== 'me')
      .slice(0, 8)
      .map((r) => ({ name: r.entity.name, type: r.entity.type, weight: r.weight }));
    return capSize({
      name: entity.name,
      type: entity.type,
      aliases: [...(entity.aliases || [])].slice(0, 20),
      counts: { items: items.length, openActions },
      recent,
      related,
      note: this.note,
    }, 'recent');
  }

  // --- writes ----------------------------------------------------------------------------

  async capture(p) {
    const mind = this.mind;
    const text = typeof p.text === 'string' ? p.text : str(p.text, LIMITS.captureText * 2);
    if (!text.trim() && !str(p.url) && !str(p.path)) return { error: 'empty_text', note: this.note };
    const hint = {};
    if (KINDS.includes(str(p.kind, 20).toLowerCase())) hint.kind = str(p.kind, 20).toLowerCase();
    if (str(p.title)) hint.title = str(p.title, 200);
    if (str(p.url, 2000)) hint.url = str(p.url, 2000);
    if (str(p.path, 1000)) hint.path = str(p.path, 1000);
    if (str(p.summary, 2000)) hint.summary = str(p.summary, 2000);
    const terms = toList(p.terms).map((term) => str(term, 60)).filter(Boolean).slice(0, 20);
    if (terms.length) hint.terms = terms;
    if (p.actions !== undefined) {
      hint.actions = toObjects(p.actions).slice(0, 50).map((a) => ({
        text: str(a.text, 200), quote: str(a.quote, 1000),
        ...(str(a.owner, 80) ? { owner: str(a.owner, 80) } : {}),
        ...(isoDay(a.due) ? { due: isoDay(a.due) } : {}),
      }));
    }
    if (bool(p.private)) hint.private = true;
    const out = await mind.capture(text, { via: 'agent', hint });
    if (out.code) {
      // i18n-keys: err.*
      return { error: out.code === 'readonly' ? this.t('err.readonly') : out.code, note: this.note };
    }
    const item = mind.item(out.itemId);
    if (!item) return { error: 'not_saved', note: this.note };
    const actionIds = [...(item.kind === 'action' ? [item.id] : []), ...out.childIds.filter((id) => mind.item(id)?.kind === 'action')];
    const rejected = (out.rejectedActions || []).map((r) => ({ text: str(r.text, 200), reason: r.reason }));
    const undo = this.t('tool.capture_saved', { cmd: `${mind.trigger} undo` });
    if (mind.isHidden(item)) {
      return { cite: mind.cite(item.id), private: true, actions: actionIds.map((id) => mind.cite(id)), rejected, deduped: out.dedupedInto ? mind.cite(out.dedupedInto) : null, undo, note: this.note };
    }
    return {
      cite: mind.cite(item.id),
      kind: item.kind,
      title: mind.agentText(item.title),
      entities: mind.entityNames(item),
      actions: actionIds.map((id) => mind.cite(id)),
      rejected,
      deduped: out.dedupedInto ? mind.cite(out.dedupedInto) : null,
      undo,
      note: this.note,
    };
  }

  async annotate(p) {
    const mind = this.mind;
    const entries = toObjects(p.items).slice(0, LIMITS.organizeItems).map((entry) => {
      const clean = { id: str(entry.id, 80) };
      if (typeof entry.summary === 'string') clean.summary = str(entry.summary, 1200);
      const terms = toList(entry.terms).map((term) => str(term, 60)).filter(Boolean).slice(0, 20);
      if (terms.length) clean.terms = terms;
      const ents = toObjects(entry.entities).map((e) => ({ name: str(e.name, 80), type: ETYPES.includes(str(e.type, 20)) ? str(e.type, 20) : 'topic' })).filter((e) => e.name);
      if (ents.length) clean.entities = ents.slice(0, 24);
      const actions = toObjects(entry.actions).map((a) => ({
        text: str(a.text, 200), quote: str(a.quote, 1000),
        ...(str(a.owner, 80) ? { owner: str(a.owner, 80) } : {}),
        ...(isoDay(a.due) ? { due: isoDay(a.due) } : {}),
      }));
      if (actions.length) clean.actions = actions.slice(0, 50);
      if (KINDS.includes(str(entry.kind, 20))) clean.kind = str(entry.kind, 20);
      return clean;
    });
    if (!entries.length) return { applied: [], rejected: [], error: 'no_items', note: this.note };
    const out = await mind.annotate(entries);
    if (!out.ok && out.code === 'readonly') return { error: this.t('err.readonly'), note: this.note };
    const cite = (id) => (id ? mind.cite(id) : null);
    return {
      applied: (out.applied || []).map(cite),
      rejected: (out.rejected || []).map((r) => ({ cite: cite(r.id), reason: r.reason, ...(r.text ? { text: r.text } : {}) })),
      note: this.note,
    };
  }
}
