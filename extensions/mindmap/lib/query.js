// Leaf module: imports nothing (the host rewrites one level of shared imports).
// One query parser for the launcher (`mm …`), the agent tools and `mm?`
// pre-retrieval (SPEC §8.1). English grammar; the filter syntax is
// language-neutral. Uses lib.text, lib.dates and lib.entities via `lib`.

export const COMMANDS = Object.freeze({
  map: 'map', actions: 'actions', todos: 'actions', tasks: 'actions', review: 'review', recent: 'recent',
  undo: 'undo', help: 'help', organize: 'organize', merge: 'merge', forget: 'forget', rename: 'rename',
});

export const KIND_WORDS = Object.freeze({
  doc: ['doc', 'docs', 'document', 'documents', 'file', 'files', 'pdf', 'pdfs', 'deck', 'decks', 'slide', 'slides', 'spec', 'specs', 'sheet', 'sheets', 'spreadsheet', 'spreadsheets', 'paper', 'papers', 'write-up', 'write-ups', 'writeup', 'writeups'],
  link: ['link', 'links', 'article', 'articles', 'page', 'pages', 'site', 'sites', 'website', 'websites', 'url', 'urls', 'bookmark', 'bookmarks', 'post', 'posts', 'video', 'videos'],
  note: ['note', 'notes', 'thought', 'thoughts', 'idea', 'ideas', 'memo', 'memos'],
  actions: ['action items', 'action item', 'action', 'actions', 'todo', 'todos', 'to-do', 'to-dos', 'task', 'tasks', 'follow-up', 'follow-ups', 'followup', 'followups'],
  meeting: ['meeting', 'meetings', 'sync', 'syncs', '1:1', '1:1s', 'standup', 'standups', 'stand-up', 'stand-ups', 'call', 'calls'],
});

export const STATUS_WORDS = Object.freeze({
  open: ['open', 'pending', 'outstanding', 'remaining', 'unfinished'],
  done: ['done', 'completed', 'finished', 'closed'],
  overdue: ['overdue', 'late'],
  suggested: ['suggested', 'suggestions'],
});

export const FILLER = Object.freeze([
  'remind me', 'can you', 'could you', 'please', 'show me', 'tell me', 'find me', 'give me', 'get me', 'find', 'search for',
  'search', 'look up', 'lookup', 'show', 'list', 'which', "what's", 'whats', 'what', 'where', 'when', 'who', 'is', 'are',
  'was', 'were', 'did', 'do', 'does', 'have', 'has', 'had', 'spoke about', 'talked about', 'talk about', 'wrote about',
  'was about', 'is about', 'about', 'mentioned', 'mentions', 'mentioning', 'regarding', 'related to', 'concerning',
  'the', 'a', 'an', 'that', 'any', 'all', 'from', 'with', 'for', 'of', 'on', 'in', 'to', 'and',
]);

export const MINE_WORDS = Object.freeze(['my', 'mine', 'i', 'me', 'myself']);
export const RECENCY_WORDS = Object.freeze(['recently', 'lately', 'recent']);

const VALID_KINDS = ['doc', 'link', 'note', 'meeting', 'action'];
const KIND_ALIASES = { doc: 'doc', docs: 'doc', document: 'doc', documents: 'doc', link: 'link', links: 'link', note: 'note', notes: 'note', meeting: 'meeting', meetings: 'meeting', action: 'action', actions: 'action', todo: 'action', todos: 'action' };
const STATUS_FILTERS = new Set(['open', 'done', 'suggested', 'overdue', 'all']);
const GROUP_STOP = new Set(['the', 'my', 'our', 'a', 'whole', 'entire', 'this', 'that', 'your', 'their', 'new', 'old', 'same', 'other', 'every', 'each', 'which', 'what', 'for', 'about', 'with', 'on', 'from']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordsRe(list) {
  const alt = [...list].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map((w) => escapeRe(w).replace(/\\? /g, '\\s+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_'’:-])(?:${alt})(?![\\p{L}\\p{N}_'’-]|:\\d)`, 'giu');
}

const KIND_RES = Object.fromEntries(Object.entries(KIND_WORDS).map(([k, v]) => [k, wordsRe(v)]));
const STATUS_RES = Object.fromEntries(Object.entries(STATUS_WORDS).map(([k, v]) => [k, wordsRe(v)]));
const FILLER_RE = wordsRe(FILLER);
const MINE_RE = wordsRe(MINE_WORDS);
const RECENCY_RE = wordsRe(RECENCY_WORDS);
const NAME = "@?[\\p{L}][\\p{L}\\p{N}'’.&-]*";

// A working copy of the input in which consumed spans are blanked with
// spaces, so every later step keeps the original offsets.
function makeWork(raw) {
  let rest = raw;
  return {
    get rest() { return rest; },
    blank(start, end) {
      if (end > start) rest = rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end);
    },
  };
}

function day(lib, ms) {
  return lib.dates.toIsoDay(ms);
}

function rangeSyntax(lib, r) {
  const last = day(lib, r.end - 1);
  if (r.start <= 0) return '..' + last;
  const first = day(lib, r.start);
  return first === last ? first : `${first}..${last}`;
}

function slug(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

// "due friday" is future-biased; "due by X" includes everything before X.
function dueRange(lib, phraseText, mode, dateOpts) {
  const r = lib.dates.parseRange(phraseText, dateOpts);
  if (!r) return null;
  let { start, end } = r;
  if (r.granularity === 'day') {
    const d = lib.dates.parseDue(phraseText.slice(r.span[0]), dateOpts);
    if (d && d.span[0] === 0) {
      start = d.at;
      end = lib.dates.addDays(d.at, 1);
    }
  }
  if (mode === 'by') start = 0;
  else if (mode === 'before') {
    end = start;
    start = 0;
  }
  return { ...r, start, end, field: 'due' };
}

function filterRange(lib, value, field, dateOpts) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const text = /\d{4}-\d{2}-\d{2}/.test(v) ? v : v.replace(/[-_]/g, ' ');
  if (field === 'due') {
    const r = dueRange(lib, text, null, dateOpts);
    return r ? { ...r, span: [0, 0] } : null;
  }
  const r = lib.dates.parseRange(text, dateOpts);
  return r ? { ...r, span: [0, 0], field: 'any' } : null;
}

// input: the text after the trigger. env = { lib, now, weekStart, resolveEntity(phrase, typeHint) →
// {entityId, name, type} | null, dict, trailingSpace } → QuerySpec (ARCHITECTURE §6.4).
export function parseQuery(input, env) {
  const lib = env.lib;
  const raw = String(input ?? '');
  const dateOpts = { now: env.now, weekStart: Number.isInteger(env.weekStart) ? env.weekStart : 1 };
  const trailingSpace = typeof env.trailingSpace === 'boolean' ? env.trailingSpace : /\s$/.test(raw);
  const resolve = (phrase, type) => {
    const p = String(phrase ?? '').trim();
    if (!p || typeof env.resolveEntity !== 'function') return null;
    const hit = env.resolveEntity(p, type ?? null);
    return hit && hit.entityId ? hit : null;
  };
  const names = new Map();
  const work = makeWork(raw);

  const spec = {
    raw,
    command: null,
    args: '',
    intent: 'find',
    kinds: null,
    kindBoost: null,
    range: null,
    recency: false,
    status: null,
    owner: null,
    entities: [],
    unresolved: [],
    terms: [],
    phrases: [],
    includePrivate: false,
    privateOnly: false,
    chips: [],
    syntax: '',
  };
  if (!raw.trim()) {
    spec.intent = 'home';
    return spec;
  }

  const kinds = new Set();
  let boostDoc = false;
  let actionsIntent = false;
  let explicitOwner = false;
  let markerMe = false;
  const addEntity = (hit, hard, via) => {
    names.set(hit.entityId, hit.name);
    const prev = spec.entities.find((e) => e.entityId === hit.entityId);
    if (prev) {
      if (hard && !prev.hard) Object.assign(prev, { hard: true, via });
      return;
    }
    spec.entities.push({ entityId: hit.entityId, hard, via, name: hit.name, type: hit.type });
  };

  // 1. Command: the first token.
  const head = /^\s*(\S+)/.exec(raw);
  const cmd = head && COMMANDS[head[1].toLowerCase()];
  if (cmd) {
    spec.command = cmd;
    spec.args = raw.slice(head[0].length).trim();
    work.blank(head.index, head[0].length);
    if (cmd === 'actions') actionsIntent = true;
  }

  // 2. Filter syntax (wins over everything the grammar infers).
  for (const m of work.rest.matchAll(/"([^"]+)"|“([^”]+)”/g)) {
    const phrase = lib.text.collapseWs(m[1] ?? m[2]);
    if (phrase) spec.phrases.push(phrase);
    work.blank(m.index, m.index + m[0].length);
  }
  let filterRangeSet = false;
  for (const m of work.rest.matchAll(/(?<!\S)(kind|when|due|is|owner):(\S*)/gi)) {
    const key = m[1].toLowerCase();
    const value = m[2].replace(/[,.;]+$/, (s) => (key === 'kind' ? '' : s));
    work.blank(m.index, m.index + m[0].length);
    if (key === 'kind') {
      for (const v of value.toLowerCase().split(',')) if (KIND_ALIASES[v]) kinds.add(KIND_ALIASES[v]);
    } else if (key === 'when' || key === 'due') {
      const r = filterRange(lib, value, key === 'due' ? 'due' : 'any', dateOpts);
      if (r) {
        spec.range = r;
        filterRangeSet = true;
        if (key === 'due') actionsIntent = true;
      }
    } else if (key === 'is') {
      const v = value.toLowerCase();
      if (v === 'private') {
        spec.privateOnly = true;
        spec.includePrivate = true;
      } else if (STATUS_FILTERS.has(v)) {
        spec.status = v;
        actionsIntent = true;
      }
    } else if (key === 'owner') {
      const v = value.toLowerCase();
      if (v === 'me' || v === 'mine') spec.owner = 'me';
      else if (v === 'anyone' || v === 'all' || v === 'everyone') spec.owner = 'anyone';
      else if (v) {
        const hit = resolve(value.replace(/-/g, ' '), 'person');
        if (hit) {
          spec.owner = hit.entityId;
          names.set(hit.entityId, hit.name);
        } else {
          spec.unresolved.push({ phrase: value, type: 'person' });
        }
      }
      if (spec.owner) {
        explicitOwner = true;
        actionsIntent = true;
      }
    }
  }
  for (const m of work.rest.matchAll(/(?<!\S)-([\p{L}][\p{L}\p{N}_'’-]*)/gu)) {
    work.blank(m.index, m.index + m[0].length);
    for (const w of lib.text.scanWords(m[1])) spec.terms.push({ t: lib.text.wordTerm(w), w: 1, neg: true, raw: w.raw });
  }
  for (const m of work.rest.matchAll(/(?<![\p{L}\p{N}_])([@#])([^\s,;!?()"]+)/gu)) {
    const value = m[2].replace(/[.:]+$/, '');
    work.blank(m.index, m.index + m[0].length);
    if (!value) continue;
    if (m[1] === '#' && value.toLowerCase() === 'private') {
      spec.privateOnly = true;
      spec.includePrivate = true;
      continue;
    }
    if (m[1] === '@' && value.toLowerCase() === 'me') {
      markerMe = true;
      continue;
    }
    const hit = resolve(value.replace(/[-_]/g, ' '), null) || (value.includes('-') ? resolve(value, null) : null);
    if (hit) addEntity(hit, true, 'marker');
    else {
      spec.unresolved.push({ phrase: value.replace(/[-_]/g, ' '), type: m[1] === '#' ? 'topic' : null });
      for (const w of lib.text.scanWords(value)) spec.terms.push({ t: lib.text.wordTerm(w), w: 1, raw: w.raw });
    }
  }
  if (kinds.size) spec.kinds = VALID_KINDS.filter((k) => kinds.has(k));

  // 3. Time (a preceding "due" / "due by" makes it a due range).
  const range = lib.dates.parseRange(work.rest, dateOpts);
  if (range) {
    const before = work.rest.slice(0, range.span[0]);
    const due = /\bdue(?:\s+(by|before|on|until))?\s*$/i.exec(before);
    let r;
    let from = range.span[0];
    if (due) {
      from = due.index;
      const mode = due[1] ? (due[1].toLowerCase() === 'on' ? null : due[1].toLowerCase() === 'before' ? 'before' : 'by') : null;
      r = dueRange(lib, work.rest.slice(range.span[0], range.span[1]), mode, dateOpts);
      actionsIntent = true;
    } else {
      r = { ...range, field: 'any' };
    }
    if (r && !filterRangeSet) spec.range = { ...r, span: [from, range.span[1]] };
    work.blank(from, range.span[1]);
  }
  for (const m of work.rest.matchAll(RECENCY_RE)) {
    spec.recency = true;
    work.blank(m.index, m.index + m[0].length);
  }

  // 4. Kind words.
  for (const [kind, re] of Object.entries(KIND_RES)) {
    for (const m of work.rest.matchAll(re)) {
      work.blank(m.index, m.index + m[0].length);
      if (kind === 'actions') actionsIntent = true;
      else if (kind === 'doc') {
        boostDoc = true;
        kinds.add('doc');
        kinds.add('link');
      } else {
        kinds.add(kind);
      }
    }
  }
  if (kinds.size && !spec.kinds) spec.kinds = VALID_KINDS.filter((k) => kinds.has(k));
  else if (kinds.size) spec.kinds = VALID_KINDS.filter((k) => kinds.has(k) || spec.kinds.includes(k));
  if (/\b(?:overdue|suggested|suggestions)\b/i.test(work.rest)) actionsIntent = true;

  // 7a. "<name> team|project" phrases (before "for <Name>", so "for the
  // bingo team" is read as the team): a hard filter, or `unresolved`.
  const groupRe = new RegExp(`(?:\\b(for|about|with|on|from)\\s+)?(?:(?:the|my|our)\\s+)?(${NAME})(?:\\s+(${NAME}))?\\s+(team|project)s?\\b`, 'giud');
  for (const m of [...work.rest.matchAll(groupRe)]) {
    const type = m[4].toLowerCase();
    const w1 = m[2];
    const w2 = m[3];
    const usable = (w) => w && !GROUP_STOP.has(w.toLowerCase()) && !lib.text.STOPWORDS.has(w.toLowerCase());
    let hit = null;
    let nameSpan = null;
    if (usable(w1) && usable(w2)) {
      hit = resolve(`${w1} ${w2}`, type);
      nameSpan = [m.indices[2][0], m.indices[3][1]];
    }
    if (!hit && usable(w2 || w1)) {
      nameSpan = m.indices[w2 ? 3 : 2];
      hit = resolve(raw.slice(nameSpan[0], nameSpan[1]), type);
    }
    if (!nameSpan) continue;
    const end = m.index + m[0].length;
    if (hit) {
      addEntity(hit, true, 'phrase');
      work.blank(m.index, end);
    } else {
      spec.unresolved.push({ phrase: raw.slice(nameSpan[0], nameSpan[1]).replace(/^@/, ''), type });
      work.blank(m.index, nameSpan[0]);
      work.blank(nameSpan[1], end);
    }
  }

  // 5. Assignee.
  const personOf = (phrase) => {
    const hit = resolve(phrase, 'person');
    return hit && hit.type === 'person' ? hit : null;
  };
  const assign = (hit) => {
    if (actionsIntent && !explicitOwner) {
      spec.owner = hit.entityId;
      names.set(hit.entityId, hit.name);
      explicitOwner = true;
    } else {
      addEntity(hit, true, 'phrase');
    }
  };
  for (const m of [...work.rest.matchAll(new RegExp(`\\bassigned\\s+to\\s+(${NAME})(?:\\s+(${NAME}))?`, 'giud'))]) {
    const two = m[2] ? personOf(`${m[1]} ${m[2]}`) : null;
    const hit = two || personOf(m[1]);
    if (hit) {
      assign(hit);
      work.blank(m.index, two ? m.indices[2][1] : m.indices[1][1]);
    } else {
      spec.unresolved.push({ phrase: m[1].replace(/^@/, ''), type: 'person' });
      work.blank(m.index, m.indices[1][0]);
    }
    actionsIntent = true;
  }
  for (const m of [...work.rest.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${NAME})['’]s(?![\\p{L}\\p{N}])`, 'giu'))]) {
    const word = m[1].toLowerCase();
    if (lib.text.STOPWORDS.has(word) || lib.text.STOPWORDS.has(word + 's')) continue;
    const hit = personOf(m[1]);
    if (!hit) continue;
    assign(hit);
    work.blank(m.index, m.index + m[0].length);
  }
  for (const m of [...work.rest.matchAll(new RegExp(`\\bfor\\s+(?:the\\s+)?(${NAME})(?:\\s+(${NAME}))?`, 'giud'))]) {
    if (lib.text.STOPWORDS.has(m[1].toLowerCase())) continue;
    const two = m[2] ? resolve(`${m[1]} ${m[2]}`, 'person') : null;
    const hit = two || resolve(m[1], 'person');
    if (!hit) continue;
    const end = two ? m.indices[2][1] : m.indices[1][1];
    if (hit.type === 'person') assign(hit);
    else if (actionsIntent) addEntity(hit, true, 'phrase');
    else continue;
    work.blank(m.index, end);
  }
  if (actionsIntent) {
    for (const m of work.rest.matchAll(MINE_RE)) {
      if (!explicitOwner) {
        spec.owner = 'me';
        explicitOwner = true;
      }
      work.blank(m.index, m.index + m[0].length);
    }
  }
  if (markerMe) {
    if (actionsIntent && !spec.owner) {
      spec.owner = 'me';
      explicitOwner = true;
    } else {
      const hit = resolve('me', 'person') || { entityId: 'me', name: 'Me', type: 'person' };
      addEntity(hit, true, 'marker');
    }
  }

  // 6. Status words (only for actions, so "done" in a doc search stays a word).
  if (actionsIntent) {
    for (const [status, re] of Object.entries(STATUS_RES)) {
      for (const m of work.rest.matchAll(re)) {
        if (!spec.status) spec.status = status;
        work.blank(m.index, m.index + m[0].length);
      }
    }
  }

  // 7b. Dictionary hits in what's left: soft boosts, the words stay terms.
  const softSpans = [];
  if (env.dict) {
    for (const hit of lib.entities.scanDictionary(env.dict, lib.text.scanWords(work.rest))) {
      if (spec.entities.some((e) => e.entityId === hit.entityId)) continue;
      addEntity({ entityId: hit.entityId, name: hit.name, type: hit.type }, false, 'dict');
      softSpans.push({ start: hit.start, end: hit.end, entityId: hit.entityId });
    }
  }

  // 8. Filler.
  for (const m of work.rest.matchAll(FILLER_RE)) work.blank(m.index, m.index + m[0].length);

  // 9. Terms. The last one matches by prefix while the user is still typing.
  const seen = new Set(spec.terms.map((t) => (t.neg ? '-' : '') + t.t));
  const words = lib.text.scanWords(work.rest).filter((w) => w.norm && !lib.text.STOPWORDS.has(w.norm));
  const termWords = [];
  for (const w of words) {
    const t = lib.text.wordTerm(w);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const term = { t, w: 1, raw: w.raw };
    spec.terms.push(term);
    termWords.push({ term, word: w });
  }
  const last = termWords[termWords.length - 1];
  if (last && !trailingSpace && last.word.end === raw.length) last.term.prefix = true;
  for (const phrase of spec.phrases) {
    for (const w of lib.text.scanWords(phrase)) {
      const t = lib.text.wordTerm(w);
      if (!t || seen.has(t) || lib.text.STOPWORDS.has(w.norm)) continue;
      seen.add(t);
      spec.terms.push({ t, w: 1, raw: w.raw, phrase: true });
    }
  }

  // Intent, defaults and chips.
  if (spec.command) spec.intent = spec.command === 'actions' ? 'actions' : 'command';
  else if (actionsIntent) spec.intent = 'actions';
  else {
    const positive = termWords.map((x) => x.word);
    const hard = spec.entities.filter((e) => e.hard);
    const structured = spec.kinds || spec.range || spec.status || spec.owner || spec.phrases.length || spec.privateOnly
      || spec.recency || spec.terms.some((t) => t.neg) || spec.unresolved.length;
    if (!structured && hard.length === 1 && !positive.length) spec.intent = 'entity';
    else if (!structured && !hard.length && positive.length) {
      const ids = new Set();
      const covered = positive.every((w) => softSpans.some((s) => {
        if (w.start >= s.start && w.end <= s.end) {
          ids.add(s.entityId);
          return true;
        }
        return false;
      }));
      // "mm bingo": the whole query is one entity's name → its entity page.
      if (covered && ids.size === 1) {
        spec.intent = 'entity';
        const entity = spec.entities.find((e) => ids.has(e.entityId));
        if (entity) entity.hard = true;
        const covers = new Set(termWords.map((x) => x.term));
        spec.terms = spec.terms.filter((t) => !covers.has(t));
      }
    }
  }
  if (spec.intent === 'actions') {
    if (!spec.owner) spec.owner = 'me';
    if (!spec.status) spec.status = 'open';
  }
  const docLink = spec.kinds?.length === 2 && spec.kinds.includes('doc') && spec.kinds.includes('link');
  spec.kindBoost = docLink || (boostDoc && spec.kinds?.includes('doc')) ? 'doc' : null;

  if (spec.kinds) spec.chips.push({ type: 'kinds', value: spec.kinds });
  if (spec.range) spec.chips.push({ type: 'range', value: spec.range });
  if (spec.owner && (spec.intent === 'actions' || explicitOwner)) spec.chips.push({ type: 'owner', value: spec.owner });
  for (const e of spec.entities) if (e.hard) spec.chips.push({ type: 'entity', value: e.entityId });
  for (const u of spec.unresolved) spec.chips.push({ type: 'unresolved', value: u });
  if (spec.status) spec.chips.push({ type: 'status', value: spec.status });
  const shown = spec.terms.filter((t) => !t.neg && !t.phrase).map((t) => t.raw);
  if (shown.length) spec.chips.push({ type: 'terms', value: shown });

  spec.syntax = toSyntax(spec, { nameOf: (id) => names.get(id) ?? env.nameOf?.(id) ?? id, lib });
  return spec;
}

// Canonical filter syntax for "Enter to refine". Parsing the result gives the
// same syntax again. The defaults of the actions intent (owner:me, is:open)
// are left out.
export function toSyntax(spec, { nameOf = (id) => id, lib } = {}) {
  const parts = [];
  if (spec.command && spec.command !== 'actions') parts.push(spec.command);
  else if (spec.intent === 'actions' || spec.command === 'actions') parts.push('actions');
  if (spec.kinds?.length) parts.push('kind:' + VALID_KINDS.filter((k) => spec.kinds.includes(k)).join(','));
  if (spec.range && lib) parts.push((spec.range.field === 'due' ? 'due:' : 'when:') + rangeSyntax(lib, spec.range));
  for (const e of spec.entities || []) if (e.hard) parts.push('@' + slug(nameOf(e.entityId) ?? e.name ?? e.entityId));
  const actions = spec.intent === 'actions';
  if (spec.owner && !(actions && spec.owner === 'me')) {
    parts.push('owner:' + (spec.owner === 'me' || spec.owner === 'anyone' ? spec.owner : slug(nameOf(spec.owner) ?? spec.owner)));
  }
  if (spec.status && !(actions && spec.status === 'open')) parts.push('is:' + spec.status);
  if (spec.privateOnly) parts.push('is:private');
  if (spec.recency) parts.push('recently');
  for (const p of spec.phrases || []) parts.push(`"${p}"`);
  for (const t of spec.terms || []) if (!t.neg && !t.phrase) parts.push(t.raw ?? t.t);
  for (const t of spec.terms || []) if (t.neg) parts.push('-' + (t.raw ?? t.t));
  return parts.join(' ');
}
