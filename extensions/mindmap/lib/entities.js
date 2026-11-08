// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Entity detection (SPEC §5 S4). Uses lib.text (and lib.url / lib.dates when
// the caller's bag has them) through the injected `lib` argument.

// Stop words that never name a team or project (SPEC §5 S4).
export const TEAM_STOP = new Set(['the', 'my', 'our', 'a', 'whole', 'entire', 'this', 'that', 'your', 'their', 'new', 'old', 'same', 'other', 'every', 'each', 'which', 'what']);
const PROJECT_STOP = new Set([...TEAM_STOP, 'side', 'pet', 'big', 'small', 'huge', 'current', 'next', 'last', 'first', 'main', 'personal', 'another', 'any', 'some', 'his', 'her', 'its', 'one', 'school', 'group', 'class']);
// Words after "team"/"project" that are ordinary nouns, not names ("Team Meeting").
const GROUP_NOUNS = new Set(['meeting', 'meetings', 'sync', 'standup', 'lunch', 'dinner', 'offsite', 'call', 'update', 'updates', 'notes', 'event', 'outing', 'retro', 'review', 'plan', 'plans', 'planning', 'goals', 'members', 'member', 'lead', 'leads', 'building', 'channel', 'chat', 'page', 'wiki', 'status', 'kickoff', 'manager', 'management', 'timeline', 'budget', 'roadmap', 'board', 'space', 'site', 'folder', 'doc', 'docs', 'sheet', 'deck', 'charter', 'scope', 'brief', 'week', 'day', 'today']);
// Person cues before a name (SPEC §5 S4): "with Dana", "ask Dana", "cc Dana".
const PERSON_CUE_BEFORE = new Set(['with', 'ask', 'ping', 'email', 'call', 'tell', 'cc', 'thank', 'thanks', 'met', 'meet']);
// Sentence-start words that are never an action owner ("Remember to …").
export const NOT_NAMES = new Set((
  'remember need needs try tries want wants going plan plans have has had got decide decided agreed agree continue ' +
  'start started forget like love hope expect time nothing something someone somebody everyone everybody anyone ' +
  'anybody nobody team they he she it we you i who how what when where why important note reminder goal goals ok okay ' +
  'yes no also then still just back next last first today tomorrow tonight yesterday ready happy hard easy good nice ' +
  'due up down way welcome thanks according prior compared similar related subject trip ability access reply response ' +
  'answer question idea ideas things steps step priority priorities focus aim intent hard plus monday tuesday ' +
  'wednesday thursday friday saturday sunday january february march april may june july august september october ' +
  'november december'
).split(' '));
const DETERMINERS = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'their', 'this', 'that', 'these', 'those', 'his', 'her', 'its', 'some', 'any', 'all', 'no', 'every', 'each']);
const LEAD_MARKER = /^\s*(?:(?:todo|to-?do|action(?:\s+items?)?|ais?|next\s+steps?|follow[- ]?ups?|tasks?)\s*:\s*)?/i;
const TYPE_RANK = { team: 0, project: 1, org: 2, person: 3, topic: 4, term: 5 };

// ---------------------------------------------------------------- helpers

function maskSpans(text, spans) {
  if (!spans.length) return text;
  const chars = text.split('');
  for (const { start, end } of spans) for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
  return chars.join('');
}

function maskUrls(text, lib) {
  const spans = lib.url?.findUrls ? lib.url.findUrls(text) : [];
  return maskSpans(text, spans);
}

const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

function titleWord(w) {
  return /^\p{Ll}/u.test(w) ? w[0].toUpperCase() + w.slice(1) : w;
}

function displayName(raw) {
  return raw.split(/[\s._-]+/).filter(Boolean).map(titleWord).join(' ');
}

function handleName(handle) {
  return displayName(handle.replace(/\d+$/, '') || handle);
}

function gapIsSpace(text, a, b) {
  return /^[ \t]+$/.test(text.slice(a.end, b.start));
}

function isStop(word, lib, extra) {
  return lib.text.STOPWORDS.has(word.norm) || (extra && extra.has(word.norm)) || /^\d+$/.test(word.norm);
}

function hasPossessive(word) {
  return /['’]s$/i.test(word.raw);
}

function capsLike(word) {
  return word.caps || word.acronym;
}

function lineStartIndices(text, words) {
  // Index of the first word on each line, so "<name> team" never reaches back
  // across a line break or a sentence end.
  const starts = new Set();
  for (let i = 0; i < words.length; i++) {
    if (i === 0) { starts.add(i); continue; }
    const gap = text.slice(words[i - 1].end, words[i].start);
    if (/[\n.!?:;]/.test(gap)) starts.add(i);
  }
  return starts;
}

function calendarWords(lib) {
  const months = lib.dates?.MONTHS ? lib.dates.MONTHS.map((n) => n[0]) : [];
  const days = lib.dates?.WEEKDAYS ? lib.dates.WEEKDAYS.map((n) => n[0]) : [];
  return new Set([...months, ...days]);
}

// ---------------------------------------------------------------- dictionary

function dictRecords(entries, lib) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || !entry.entityId) continue;
    const names = (entry.names || []).filter((n) => typeof n === 'string' && n.trim());
    if (!names.length) continue;
    const canonical = names[0];
    const key = entry.key || lib.text.normalizeKey(canonical);
    for (const name of names) {
      const words = lib.text.scanWords(name);
      const seq = words.map((w) => lib.text.wordTerm(w)).filter(Boolean);
      if (!seq.length) continue;
      if (seq.length === 1 && lib.text.STOPWORDS.has(words[0].norm)) continue;
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      out.push({ seq, entityId: entry.entityId, type: entry.type || 'term', name: canonical, key, alias: lib.text.normalizeKey(name) });
    }
  }
  return out;
}

function compareRecords(a, b) {
  return b.seq.length - a.seq.length
    || (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)
    || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);
}

function addRecords(byFirst, byKey, records) {
  const touched = new Set();
  for (const rec of records) {
    const first = rec.seq[0];
    const bucket = byFirst.get(first) || [];
    if (bucket.some((r) => r.entityId === rec.entityId && r.seq.join(' ') === rec.seq.join(' '))) continue;
    bucket.push(rec);
    byFirst.set(first, bucket);
    touched.add(first);
    for (const k of new Set([rec.key, rec.alias])) {
      const list = byKey.get(k) || [];
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      if (!list.some((r) => r.entityId === rec.entityId)) list.push({ entityId: rec.entityId, type: rec.type, name: rec.name, key: rec.key });
      byKey.set(k, list);
    }
  }
  for (const first of touched) byFirst.get(first).sort(compareRecords);
}

// entries: [{entityId, type, names: string[], key?}] (names[0] is the display
// name, the rest are aliases) → Dict for scanDictionary.
export function buildDictionary(entries, lib) {
  const byFirst = new Map();
  const byKey = new Map();
  addRecords(byFirst, byKey, dictRecords(entries, lib));
  return { byFirst, byKey, keyOf: (word) => lib.text.wordTerm(word) };
}

// A new Dict with extra entries; the original is not modified.
export function extendDictionary(dict, entries, lib) {
  const byFirst = new Map();
  for (const [k, v] of dict?.byFirst || []) byFirst.set(k, [...v]);
  const byKey = new Map();
  for (const [k, v] of dict?.byKey || []) byKey.set(k, [...v]);
  addRecords(byFirst, byKey, dictRecords(entries, lib));
  return { byFirst, byKey, keyOf: dict?.keyOf || ((word) => lib.text.wordTerm(word)) };
}

// Entities known under a normalized key (name or alias): [{entityId, type, name, key}].
export function lookupKey(dict, key) {
  return dict?.byKey?.get(key) || [];
}

// Longest match at word boundaries, case-insensitive, no overlaps.
export function scanDictionary(dict, words) {
  if (!dict?.byFirst?.size || !words?.length) return [];
  const keys = words.map(dict.keyOf);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const bucket = dict.byFirst.get(keys[i]);
    let match = null;
    if (bucket) {
      for (const rec of bucket) {
        const len = rec.seq.length;
        if (i + len > words.length) continue;
        let ok = true;
        for (let k = 1; k < len; k++) if (keys[i + k] !== rec.seq[k]) { ok = false; break; }
        if (ok) { match = rec; break; }
      }
    }
    if (match) {
      const len = match.seq.length;
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      out.push({ entityId: match.entityId, type: match.type, start: words[i].start, end: words[i + len - 1].end, key: match.key, name: match.name });
      i += len;
    } else {
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- explicit

function groupMentions(text, words, lib, opts) {
  const out = [];
  const starts = lineStartIndices(text, words);
  const verbs = opts.verbs || new Set();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const norm = w.norm;
    if (norm !== 'team' && norm !== 'project') continue;
    const type = norm;
    const stop = type === 'team' ? TEAM_STOP : PROJECT_STOP;
    // "<name> team" / "<name> project": one or two words before it.
    const w1 = words[i - 1];
    if (w1 && !starts.has(i) && gapIsSpace(text, w1, w) && !isStop(w1, lib, stop) && !hasPossessive(w1) && !verbs.has(w1.norm)) {
      const parts = [w1];
      const w2 = words[i - 2];
      // A line's first word is often a verb in sentence case ("Ping bingo
      // team"), so it only joins a name that is capitalized too.
      const w2First = starts.has(i - 2);
      if (w2 && !starts.has(i - 1) && gapIsSpace(text, w2, w1) && !isStop(w2, lib, stop) && !hasPossessive(w2) && !verbs.has(w2.norm)
        && (w2First ? capsLike(w1) && capsLike(w2) : capsLike(w1) === capsLike(w2) || (capsLike(w2) && !capsLike(w1)))) {
        parts.unshift(w2);
      }
      const name = parts.map((p) => titleWord(p.raw)).join(' ');
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      out.push({ type, name, key: lib.text.normalizeKey(name), start: parts[0].start, end: w.end, marker: type });
      continue;
    }
    // "team Zebra" / "project Atlas": only a capitalized name counts, never
    // a plural acronym ("team OKRs", "team KPIs" are things, not a name).
    const n1 = words[i + 1];
    if (n1 && !starts.has(i + 1) && gapIsSpace(text, w, n1) && capsLike(n1) && !isStop(n1, lib) && !GROUP_NOUNS.has(n1.norm)
      && !/^\p{Lu}{2,}s$/u.test(n1.raw)) {
      const parts = [n1];
      const n2 = words[i + 2];
      if (n2 && !starts.has(i + 2) && gapIsSpace(text, n1, n2) && capsLike(n2) && !isStop(n2, lib) && !GROUP_NOUNS.has(n2.norm)) parts.push(n2);
      const name = parts.map((p) => p.raw.replace(/['’]s$/i, '')).join(' ');
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      out.push({ type, name, key: lib.text.normalizeKey(name), start: w.start, end: parts[parts.length - 1].end, marker: type });
    }
  }
  return out;
}

// #tag → topic, @name → person (@me → me), "<name> team" / "team <Name>" →
// team, "project <Name>" / "<name> project" → project, email → person.
// → [{type, name, key, start, end, marker, alias?, me?}] in text order.
export function explicitMentions(text, lib, opts = {}) {
  const str = String(text ?? '');
  const out = [];
  const masked = maskUrls(str, lib);
  const emailSpans = [];
  for (const m of masked.matchAll(EMAIL_RE)) {
    const email = m[0];
    const local = email.slice(0, email.indexOf('@'));
    const name = displayName(local.replace(/\+.*$/, '').replace(/\d+$/, '')) || local;
    out.push({ type: 'person', name, key: lib.text.normalizeKey(name), start: m.index, end: m.index + email.length, marker: 'email', alias: email.toLowerCase() });
    emailSpans.push({ start: m.index, end: m.index + email.length });
  }
  const clean = maskSpans(masked, emailSpans);
  for (const m of clean.matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}])/gu)) {
    const handle = m[1];
    if (handle.toLowerCase() === 'me') {
      out.push({ type: 'person', name: 'Me', key: 'me', start: m.index, end: m.index + m[0].length, marker: '@', me: true });
      continue;
    }
    const name = handleName(handle);
    out.push({ type: 'person', name, key: lib.text.normalizeKey(name), start: m.index, end: m.index + m[0].length, marker: '@' });
  }
  for (const m of clean.matchAll(/(?<![\p{L}\p{N}_&#/])#([\p{L}][\p{L}\p{N}_-]*[\p{L}\p{N}]|[\p{L}])/gu)) {
    const tag = m[1];
    if (tag.toLowerCase() === 'private') continue;
    out.push({ type: 'topic', name: tag, key: lib.text.normalizeKey(tag), start: m.index, end: m.index + m[0].length, marker: '#' });
  }
  out.push(...groupMentions(clean, lib.text.scanWords(clean), lib, opts));
  return out.filter((e) => e.key).sort((a, b) => a.start - b.start || b.end - a.end);
}

// ---------------------------------------------------------------- implicit

function shouty(line) {
  const letters = line.replace(/[^\p{L}]/gu, '');
  const words = line.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
  if (letters.length < 8 || words.length < 3) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length > 0.7;
}

function atSentenceStart(text, index) {
  const before = text.slice(0, index).replace(/[ \t]+$/, '');
  if (!before) return true;
  const last = before[before.length - 1];
  if (/[\n.!?:;]/.test(last)) return true;
  // A bullet or checkbox marker at the start of the line.
  const lineStart = before.lastIndexOf('\n') + 1;
  return /^\s*(?:[-*•+]|\d+[.)]|\[[ xX]\])(?:\s*\[[ xX]\])?$/.test(before.slice(lineStart));
}

function personCue(text, start, end) {
  const before = /([\p{L}]+)\s+$/u.exec(text.slice(Math.max(0, start - 24), start));
  if (before && PERSON_CUE_BEFORE.has(before[1].toLowerCase())) return true;
  const after = text.slice(end, end + 40);
  if (/^\s+(?:said|says)\b/i.test(after)) return true;
  const to = /^\s+to\s+(\p{Ll}+)/u.exec(after);
  return Boolean(to && !DETERMINERS.has(to[1]));
}

// Counted, never created directly: acronyms, dotted acronyms, CamelCase,
// capitalized runs of 2–3 words not at a sentence start, and single
// capitalized names right after a person cue ("with Dana").
// → [{key, display, type: 'term'|'person', start, end}] in text order, one per key.
export function implicitCandidates(text, lib, { stoplist } = {}) {
  const stop = stoplist || lib.text.ACRONYM_STOPLIST;
  const masked = maskUrls(String(text ?? ''), lib).replace(EMAIL_RE, (m) => ' '.repeat(m.length));
  const calendar = calendarWords(lib);
  const found = [];
  const lines = [];
  let offset = 0;
  for (const line of masked.split('\n')) {
    lines.push({ start: offset, end: offset + line.length, shouty: shouty(line) });
    offset += line.length + 1;
  }
  const lineOf = (i) => lines.find((l) => i >= l.start && i <= l.end);
  const add = (display, start, end, type) => {
    const key = lib.text.normalizeKey(display);
    if (!key || key === 'me' || lib.text.STOPWORDS.has(key)) return;
    // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
    found.push({ key, display, type, start, end });
  };

  for (const m of masked.matchAll(/\b[A-Z][A-Z0-9&]{1,7}s?\b/g)) {
    if (lineOf(m.index)?.shouty) continue;
    if (m.index > 0 && /[.\p{L}\p{N}]/u.test(masked[m.index - 1])) continue;
    let base = m[0];
    if (/[A-Z0-9]s$/.test(base)) base = base.slice(0, -1);
    if ((base.match(/[A-Z]/g) || []).length < 2 || stop.has(base) || stop.has(base.replace(/&/g, ''))) continue;
    add(base, m.index, m.index + m[0].length, 'term');
  }
  for (const m of masked.matchAll(/(?<![\p{L}.])(?:[A-Z]\.){2,}/gu)) {
    const base = m[0].replace(/\./g, '');
    if (stop.has(base)) continue;
    add(base, m.index, m.index + m[0].length, 'term');
  }
  for (const m of masked.matchAll(/\b(?:[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g)) {
    add(m[0], m.index, m.index + m[0].length, 'term');
  }
  for (const m of masked.matchAll(/\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3}\b/g)) {
    // A run that starts a sentence loses its first word ("Met Dana Smith").
    let parts = m[0].split(/[ \t]+/);
    let start = m.index;
    if (atSentenceStart(masked, start)) {
      start += m[0].indexOf(parts[1], parts[0].length);
      parts = parts.slice(1);
    }
    if (parts.length < 2 || parts.length > 3) continue;
    if (parts.some((p) => lib.text.STOPWORDS.has(p.toLowerCase()) || calendar.has(p.toLowerCase()))) continue;
    const display = parts.join(' ');
    const end = m.index + m[0].length;
    add(display, start, end, personCue(masked, start, end) ? 'person' : 'term');
  }
  for (const m of masked.matchAll(/\b[A-Z][a-z]{1,}\b/g)) {
    const word = m[0].toLowerCase();
    if (lib.text.STOPWORDS.has(word) || calendar.has(word) || NOT_NAMES.has(word)) continue;
    const end = m.index + m[0].length;
    // At a sentence start capitalization says nothing; only "Dana said" counts.
    const cue = atSentenceStart(masked, m.index) ? /^\s+(?:said|says)\b/i.test(masked.slice(end, end + 12)) : personCue(masked, m.index, end);
    if (cue) add(m[0], m.index, end, 'person');
  }

  // Longer spans first at the same start; a span overlapping an accepted one
  // is dropped, and a repeated key only upgrades the type to person.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const byKey = new Map();
  const accepted = [];
  for (const c of found) {
    const prev = byKey.get(c.key);
    if (prev) {
      if (c.type === 'person') prev.type = 'person';
      continue;
    }
    if (accepted.some((x) => c.start < x.end && c.end > x.start)) continue;
    const entry = { ...c };
    byKey.set(c.key, entry);
    accepted.push(entry);
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- owners

// "<Name> to/will <verb>" or "@x to/will <verb>" at the start of a segment
// (after an optional "TODO:"-style marker). → {name, key, start, end, handle} | null
export function ownerCue(segment, lib, opts = {}) {
  const str = String(segment ?? '');
  const lead = LEAD_MARKER.exec(str)[0].length;
  const rest = str.slice(lead);
  const m = /^(@[\p{L}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|\p{Lu}[\p{L}'’-]*(?:[ \t]+\p{Lu}[\p{L}'’-]*)?)[ \t]+(?:to|will|is going to|is to)[ \t]+(\p{L}+)/u.exec(rest);
  if (!m) return null;
  const verb = m[2];
  if (!/^\p{Ll}/u.test(verb) || DETERMINERS.has(verb) || (lib.text.STOPWORDS.has(verb) && !['do', 'be', 'have', 'get'].includes(verb))) return null;
  const rawName = m[1];
  const handle = rawName.startsWith('@');
  const name = handle ? handleName(rawName.slice(1)) : rawName;
  const words = name.split(/\s+/);
  const verbs = opts.verbs || new Set();
  for (const w of words) {
    const lower = w.toLowerCase().replace(/['’]s$/, '');
    if (lib.text.STOPWORDS.has(lower) || NOT_NAMES.has(lower) || verbs.has(lower) || lower === 'me') return null;
  }
  if (!handle && /['’]/.test(name)) return null;
  const key = lib.text.normalizeKey(name);
  if (!key) return null;
  return { name, key, start: lead, end: lead + rawName.length, handle };
}

// ---------------------------------------------------------------- aliases

function initialsOf(words, lib) {
  const all = words.map((w) => w.norm[0]).join('');
  const content = words.filter((w) => !lib.text.STOPWORDS.has(w.norm)).map((w) => w.norm[0]).join('');
  return { all, content };
}

// "Quarterly Planning Review (QPR)" and "QPR (Quarterly Planning Review)":
// the long form's word initials must spell the short form (simplified
// Schwartz–Hearst). → [{long, longKey, short, shortKey}]
export function learnAliases(text, lib) {
  const str = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (longWords, short) => {
    const long = str.slice(longWords[0].start, longWords[longWords.length - 1].end);
    const entry = { long, longKey: lib.text.normalizeKey(long), short, shortKey: lib.text.normalizeKey(short) };
    const id = entry.longKey + '\u0000' + entry.shortKey;
    if (!seen.has(id) && entry.longKey && entry.shortKey && entry.longKey !== entry.shortKey) {
      seen.add(id);
      out.push(entry);
    }
  };
  const match = (words, letters) => {
    for (let k = 1; k <= Math.min(words.length, letters.length + 3); k++) {
      const tail = words.slice(-k);
      if (tail[0].norm[0] !== letters[0] || lib.text.STOPWORDS.has(tail[0].norm)) continue;
      const { all, content } = initialsOf(tail, lib);
      if (all === letters || content === letters) return tail;
    }
    return null;
  };
  for (const m of str.matchAll(/\(([A-Z][A-Za-z0-9&]{1,9})\)/g)) {
    const short = m[1];
    const letters = short.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (letters.length < 2) continue;
    const before = str.slice(0, m.index);
    const lineStart = Math.max(before.lastIndexOf('\n'), before.search(/[.!?;:][^.!?;:]*$/)) + 1;
    const words = lib.text.scanWords(str.slice(lineStart, m.index)).map((w) => ({ ...w, start: w.start + lineStart, end: w.end + lineStart }));
    const tail = words.length ? match(words, letters) : null;
    if (tail) push(tail, short);
  }
  for (const m of str.matchAll(/\b([A-Z][A-Z0-9&]{1,9})\s*\(([^()\n]{3,80})\)/g)) {
    const short = m[1];
    const letters = short.replace(/[^A-Za-z]/g, '').toLowerCase();
    const inner = m.index + m[0].indexOf('(') + 1;
    const words = lib.text.scanWords(m[2]).map((w) => ({ ...w, start: w.start + inner, end: w.end + inner }));
    if (letters.length < 2 || !words.length) continue;
    const { all, content } = initialsOf(words, lib);
    if ((all === letters || content === letters) && words[0].norm[0] === letters[0]) push(words, short);
  }
  return out;
}

// ---------------------------------------------------------------- promotion

// Counts implicit candidates per distinct item. Mutates `candidates`
// (Map<key, Candidate>); bumping the same (key, itemId) twice counts once.
// → { promote: [{key, display, type, itemIds}] } for every found key at or
// above the threshold, sorted by key (the caller creates the entity and
// drops the candidate).
export function bumpCandidates(candidates, found, itemId, now, { threshold = 2, rejected = new Set() } = {}) {
  const distinct = new Map();
  for (const c of found || []) {
    if (!c?.key) continue;
    const prev = distinct.get(c.key);
    if (!prev) distinct.set(c.key, { key: c.key, display: c.display || c.key, type: c.type === 'person' ? 'person' : 'term' });
    else if (c.type === 'person') prev.type = 'person';
  }
  const promote = [];
  for (const c of distinct.values()) {
    if (rejected.has(c.key)) continue;
    let entry = candidates.get(c.key);
    if (!entry) {
      // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
      entry = { key: c.key, display: c.display, type: c.type, n: 0, firstSeen: now, sample: [] };
      candidates.set(c.key, entry);
    }
    if (c.type === 'person' && entry.type !== 'person') entry.type = 'person';
    if (!entry.sample.includes(itemId)) {
      entry.n += 1;
      if (entry.sample.length < 5) entry.sample.push(itemId);
    }
    // kage-sensitive-data: not-sensitive — reviewed: an entity/candidate record, not a settings control
    if (entry.n >= threshold) promote.push({ key: entry.key, display: entry.display, type: entry.type, itemIds: [...entry.sample] });
  }
  promote.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { promote };
}

// 'Oren, ON, oren@example.com' → ['Oren', 'ON', 'oren@example.com']
export function parseNameList(setting) {
  const out = [];
  const seen = new Set();
  for (const part of String(setting ?? '').split(/[,;\n]/)) {
    const name = part.trim().replace(/^@/, '');
    if (!name) continue;
    const id = name.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}
