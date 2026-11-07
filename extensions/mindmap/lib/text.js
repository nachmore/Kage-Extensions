// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Language-neutral text primitives plus the English lexicons they need.
// Every function is pure and deterministic.

export const STOPWORDS = new Set((
  'a about above after again against all also am an and any are aren arent as at be because been before being ' +
  'below between both but by can cant could couldnt did didnt do does doesnt doing dont down during each few ' +
  'for from further had hadnt has hasnt have havent having he hed hell her here hers herself hes him himself his ' +
  'how hows i id ill im ive if in into is isnt it its itself just lets me more most mustnt my myself no nor not ' +
  'now of off on once only or other ought our ours ourselves out over own same shant she shed shell shes should ' +
  'shouldnt so some such than that thats the their theirs them themselves then there theres these they theyd ' +
  'theyll theyre theyve this those through to too under until up very was wasnt we wed well were weve werent ' +
  'what whats when whens where wheres which while who whos whom why whys will with wont would wouldnt you youd ' +
  'youll youre youve your yours yourself yourselves us via per etc yet still really maybe please'
).split(' '));

// Uppercase words that look like acronyms but are never entities (SPEC §5 S4).
export const ACRONYM_STOPLIST = new Set((
  'I A OK AM PM TODO FYI ASAP URL URLS PDF PDFS API APIS PR PRS EOD EOW EOM COB ETA TBD TBA TBC ' +
  'Q1 Q2 Q3 Q4 H1 H2 US USA UK EU IT HR CEO CTO CFO COO CIO VP SVP EVP AI ML ID IDS FAQ ' +
  'HTML CSS JS JSON XML HTTP HTTPS WWW PS RE FW FWD CC BCC AKA ETC IE EG NB NA OOO PTO WFH ' +
  'IMO IMHO BTW TLDR LOL OMG THX TY PLS PDT PST EST EDT CET CEST UTC GMT ' +
  'DOC DOCX PPT PPTX XLS XLSX CSV TXT MD PNG JPG JPEG GIF SVG ZIP SMS MMS TV PC MAC OS ' +
  'MON TUE WED THU FRI SAT SUN JAN FEB MAR APR MAY JUN JUL AUG SEP SEPT OCT NOV DEC ' +
  'NO YES AND OR THE OF TO IN ON AT BY FOR'
).split(' '));

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const JOINERS = new Set(["'", '\u2019', '.']);
const DOTTED_ACRONYM = /^(?:\p{L}\.)+\p{L}\.?$/u;

let segmenter;
let segmenterChecked = false;
function getSegmenter() {
  if (!segmenterChecked) {
    segmenterChecked = true;
    try {
      segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('und', { granularity: 'word' })
        : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

// Test hook: force the regex fallback (null) or restore Intl.Segmenter (undefined).
export function _setSegmenterForTests(value) {
  segmenterChecked = value !== undefined;
  segmenter = value === undefined ? undefined : value;
}

function charClass(ch) {
  if (ch === undefined) return null;
  if (DIGIT.test(ch)) return 'N';
  if (LETTER.test(ch)) return 'L';
  return null;
}

// The shared word rule: runs of letters/digits/marks; an apostrophe or a
// period joins two letters or two digits ("don't", "M.T.C.S", "3.5").
// Both the Segmenter path and the fallback pass through it, so ASCII text
// yields identical words either way.
function scanRuns(s, offset, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (!WORD_CHAR.test(s[i])) { i++; continue; }
    const start = i;
    i++;
    while (i < n) {
      const ch = s[i];
      if (WORD_CHAR.test(ch)) { i++; continue; }
      if (JOINERS.has(ch)) {
        const prev = charClass(s[i - 1]);
        const next = charClass(s[i + 1]);
        if (prev && prev === next) { i += 2; continue; }
      }
      break;
    }
    pushWord(s.slice(start, i), offset + start, out);
  }
}

// A period inside a word only survives in numbers ("3.5") and dotted
// acronyms ("M.T.C.S"); "node.js" and "notes.pdf" become separate words.
function pushWord(raw, start, out) {
  if (raw.includes('.') && LETTER.test(raw) && !DOTTED_ACRONYM.test(raw)) {
    let at = 0;
    for (const part of raw.split('.')) {
      if (part) pushWord(part, start + at, out);
      at += part.length + 1;
    }
    return;
  }
  out.push(makeWord(raw, start));
}

function stripMarks(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function wordNorm(raw) {
  let v = stripMarks(raw).toLowerCase();
  v = v.replace(/['\u2019]s$/u, '');
  v = v.replace(/['\u2019]/gu, '');
  if (/\p{L}/u.test(v)) v = v.replace(/\./g, '');
  return v;
}

function isAcronymShape(raw) {
  const base = raw.replace(/['\u2019]s$/u, '');
  if (DOTTED_ACRONYM.test(base)) return /^(?:\p{Lu}\.)+\p{Lu}\.?$/u.test(base);
  const core = /^(\p{Lu}[\p{Lu}\p{N}]*?)s?$/u.exec(base);
  if (!core || base.length > 9) return false;
  const letters = (base.match(/\p{Lu}/gu) || []).length;
  return letters >= 2 && !/\p{Ll}/u.test(base.replace(/s$/u, ''));
}

function makeWord(raw, start) {
  return {
    raw,
    norm: wordNorm(raw),
    start,
    end: start + raw.length,
    caps: UPPER.test(raw[0]),
    acronym: isAcronymShape(raw),
  };
}

export function scanWords(s) {
  const str = String(s ?? '');
  const out = [];
  const seg = getSegmenter();
  if (!seg) {
    scanRuns(str, 0, out);
    return out;
  }
  for (const part of seg.segment(str)) {
    if (!part.isWordLike) continue;
    scanRuns(part.segment, part.index, out);
  }
  return out;
}

export function normalizeKey(s) {
  let v = String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
  v = v.replace(/(?:\p{L}\.){2,}/gu, (m) => m.replace(/\./g, ''));
  v = v.replace(/['\u2019]s\b/gu, '');
  v = v.replace(/['\u2019&]/gu, '');
  v = v.toLowerCase();
  v = v.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return v.trim().replace(/\s+/g, ' ');
}

export function stem(norm) {
  const w = String(norm ?? '');
  if (w.length < 5 || /\d/.test(w)) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(?:sses|xes|zzes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// One indexable form per word: acronym plurals fold ("MTCSs" → "mtcs"),
// possessives and dots drop, then the light stemmer runs.
export function wordTerm(word, { stemming = true } = {}) {
  let v = word.norm;
  if (word.acronym && /\p{Lu}s$/u.test(word.raw)) v = v.slice(0, -1);
  return stemming ? stem(v) : v;
}

export function tokenize(s, { stop = false, stemming = true } = {}) {
  const out = [];
  for (const word of scanWords(s)) {
    if (!word.norm) continue;
    if (stop && STOPWORDS.has(word.norm)) continue;
    const v = wordTerm(word, { stemming });
    if (v) out.push(v);
  }
  return out;
}

const BULLET_RE = /^(\s*)(?:([-*\u2022\u00b7\u25e6\u25aa\u2013\u2014+])\s+|(\d{1,3})[.)]\s+)?(?:\[( |x|X)\]\s*)?/u;

export function splitLines(s) {
  const str = String(s ?? '');
  const out = [];
  let offset = 0;
  for (const line of str.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    const m = BULLET_RE.exec(clean);
    const indent = m[1].replace(/\t/g, '  ').length;
    let bullet = null;
    if (m[4] !== undefined) bullet = m[4] === ' ' ? 'box' : 'boxdone';
    else if (m[2]) bullet = m[2] === '*' ? 'star' : m[2] === '-' || m[2] === '+' || m[2] === '\u2013' || m[2] === '\u2014' ? 'dash' : 'dot';
    else if (m[3]) bullet = 'num';
    const markerLen = bullet ? m[0].length : m[1].length;
    const rest = clean.slice(markerLen);
    const text = rest.trimEnd();
    out.push({ text, start: offset + markerLen, bullet, indent });
    offset += line.length + 1;
  }
  return out;
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'approx', 'dept', 'est', 'fig', 'no']);

export function splitSentences(s) {
  const str = String(s ?? '');
  const out = [];
  const push = (from, to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(str[a])) a++;
    while (b > a && /\s/.test(str[b - 1])) b--;
    if (b > a) out.push({ text: str.slice(a, b), start: a, end: b });
  };
  let from = 0;
  const re = /([.!?]+)(["'\u201d\u2019)\]]*)(\s+)|\n+/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[0][0] === '\n') {
      push(from, m.index);
      from = m.index + m[0].length;
      continue;
    }
    const before = str.slice(from, m.index);
    const lastWord = (/([\p{L}.]+)$/u.exec(before) || [])[1] || '';
    const next = str[m.index + m[0].length];
    if (m[1] === '.' && (ABBREVIATIONS.has(lastWord.toLowerCase()) || /^(?:\p{L}\.)+\p{L}$/u.test(lastWord) || /^\p{L}$/u.test(lastWord))) continue;
    if (next !== undefined && /\p{Ll}/u.test(next)) continue;
    const end = m.index + m[1].length + m[2].length;
    push(from, end);
    from = end;
  }
  push(from, str.length);
  return out;
}

// RAKE: candidate phrases split at stop words and punctuation; a word scores
// degree / frequency × idf, a phrase the sum of its words.
export function rake(text, { max = 5, idf = () => 1 } = {}) {
  const str = String(text ?? '');
  const phrases = [];
  let current = [];
  let lastEnd = -1;
  const flush = () => {
    if (current.length <= 4) {
      if (current.length) phrases.push(current);
    } else {
      for (let i = 0; i < current.length; i += 3) phrases.push(current.slice(i, i + 3));
    }
    current = [];
  };
  for (const word of scanWords(str)) {
    const gap = lastEnd < 0 ? '' : str.slice(lastEnd, word.start);
    if (lastEnd >= 0 && /[^\s]/.test(gap.replace(/['\u2019-]/g, ''))) flush();
    lastEnd = word.end;
    const norm = word.norm;
    if (!norm || STOPWORDS.has(norm) || norm.length < 2 || /^\d+$/.test(norm)) {
      flush();
      continue;
    }
    current.push(word);
  }
  flush();
  const freq = new Map();
  const degree = new Map();
  for (const phrase of phrases) {
    for (const word of phrase) {
      const t = wordTerm(word);
      freq.set(t, (freq.get(t) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + phrase.length);
    }
  }
  const scores = new Map();
  for (const phrase of phrases) {
    const key = phrase.map((w) => w.norm).join(' ');
    if (scores.has(key)) continue;
    let score = 0;
    for (const word of phrase) {
      const t = wordTerm(word);
      const weight = Number(idf(t));
      score += (degree.get(t) / freq.get(t)) * (Number.isFinite(weight) ? weight : 1);
    }
    scores.set(key, score);
  }
  return [...scores]
    .map(([phrase, score]) => ({ phrase, score: Math.round(score * 1e6) / 1e6 }))
    .sort((a, b) => b.score - a.score || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0))
    .slice(0, Math.max(0, max));
}

export function collapseWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function codePoints(s) {
  return Array.from(String(s ?? ''));
}

export function truncate(s, n) {
  const str = String(s ?? '');
  if (!(n > 0)) return '';
  const chars = codePoints(str);
  if (chars.length <= n) return str;
  return chars.slice(0, Math.max(0, n - 1)).join('').trimEnd() + '\u2026';
}

export function firstLine(s, max = 80) {
  for (const line of String(s ?? '').split('\n')) {
    const v = collapseWs(line);
    if (v) return truncate(v, max);
  }
  return '';
}

function termMatcher(terms) {
  const exact = new Set();
  const prefixes = [];
  for (const term of terms || []) {
    if (!term) continue;
    if (typeof term === 'string') exact.add(term);
    else if (typeof term.t === 'string' && !term.neg) {
      if (term.prefix) prefixes.push(term.t);
      else exact.add(term.t);
    }
  }
  return (word) => {
    const t = wordTerm(word);
    if (exact.has(t) || exact.has(word.norm)) return true;
    return prefixes.some((p) => t.startsWith(p) || word.norm.startsWith(p));
  };
}

// A window of `max` characters around the first word matching a term
// (terms are tokenize() output, or QuerySpec terms), with ellipses.
export function snippet(text, terms, { max = 200 } = {}) {
  const flat = collapseWs(text);
  if (!flat) return '';
  const limit = Math.max(10, max);
  if (flat.length <= limit) return flat;
  const matches = termMatcher(terms);
  const hit = scanWords(flat).find(matches);
  if (!hit) return truncate(flat, limit);
  const room = limit - (hit.end - hit.start);
  let start = Math.max(0, hit.start - Math.floor(room / 2));
  let end = Math.min(flat.length, start + limit);
  start = Math.max(0, end - limit);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < hit.start) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > hit.end) end = space;
  }
  return (start > 0 ? '\u2026' : '') + flat.slice(start, end).trim() + (end < flat.length ? '\u2026' : '');
}

function quoteForm(s) {
  return collapseWs(String(s ?? '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')).toLowerCase();
}

export function containsQuote(haystack, quote) {
  const q = quoteForm(quote);
  if (!q) return false;
  return quoteForm(haystack).includes(q);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export function escapeMd(s) {
  return String(s ?? '').replace(/[<>]/g, '').replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&');
}

// Window-title suffixes that are always app names, whatever app reported them.
const APP_SUFFIXES = [
  'Microsoft Word', 'Word', 'Microsoft Excel', 'Excel', 'Microsoft PowerPoint', 'PowerPoint', 'Microsoft OneNote',
  'OneNote', 'Microsoft Outlook', 'Microsoft Teams', 'Google Docs', 'Google Sheets', 'Google Slides', 'Google Drive',
  'Google Chrome', 'Chromium', 'Microsoft Edge', 'Mozilla Firefox', 'Visual Studio Code', 'Notepad', 'Notepad++',
  'TextEdit', 'Adobe Acrobat Reader', 'Adobe Acrobat', 'Acrobat Reader', 'Sublime Text', 'LibreOffice Writer',
  'LibreOffice Calc', 'LibreOffice Impress', 'Foxit Reader', 'Dropbox Paper',
];
// Short names that are also ordinary words: stripped only when the reported
// app name contains them ("Q3 - Numbers" stays as it is in Word).
const APP_SUFFIXES_GATED = [
  'Outlook', 'Teams', 'Chrome', 'Edge', 'Firefox', 'Safari', 'Brave', 'Opera', 'Vivaldi', 'Arc', 'Code', 'Preview',
  'Pages', 'Numbers', 'Keynote', 'Notion', 'Obsidian', 'Confluence', 'Slack', 'Zoom', 'Figma', 'Evernote', 'Bear',
  'Typora', 'LibreOffice',
];
const BROWSERS = /^(?:Google Chrome|Chrome|Chromium|Microsoft Edge|Edge|Mozilla Firefox|Firefox|Safari|Brave|Opera|Vivaldi|Arc)$/i;
const PROFILE_SEGMENT = /^(?:Personal|Work|Profile \d+|Default)$/i;
const TITLE_MARKERS_END = [
  /\s*[-\u2013\u2014]\s*Edited$/i, /\s*[\u2022\u25cf]\s*Unsaved$/i, /\s*\((?:Read-Only|Read Only|Protected View)\)$/i,
  /\s*\[(?:Compatibility Mode|Read-Only)\]$/i, /\s*[-\u2013\u2014]\s*(?:Saved|AutoRecovered|Saved to this PC)$/i,
  /\s+and \d+ more (?:pages?|tabs?)$/i, /\s*[-\u2013\u2014]\s*Audio playing$/i, /\s*[-\u2013\u2014]\s*Page \d+ of \d+$/i,
];
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "MTCS rollout plan.docx - Word" → "MTCS rollout plan.docx". Returns '' when
// nothing but an app name is left, so no item is ever titled with it.
export function cleanWindowTitle(title, app) {
  let t = String(title ?? '').replace(INVISIBLE, '').trim();
  const appName = String(app ?? '').replace(INVISIBLE, '').trim();
  const names = new Set(APP_SUFFIXES);
  const appLower = appName.toLowerCase();
  for (const name of APP_SUFFIXES_GATED) {
    if (appLower && appLower.split(/\s+/).includes(name.toLowerCase())) names.add(name);
  }
  if (appName) {
    names.add(appName);
    const last = appName.split(/\s+/).pop();
    if (last && last.length > 2) names.add(last);
  }
  const sorted = [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const sep = '\\s+[-\u2013\u2014|]\\s+';
  for (let guard = 0; guard < 6; guard++) {
    const before = t;
    t = t.replace(/^[\u25cf\u2022*]\s*/u, '');
    for (const re of TITLE_MARKERS_END) t = t.replace(re, '');
    let stripped = null;
    for (const name of sorted) {
      const re = new RegExp(sep + escapeRe(name) + '$', 'i');
      if (re.test(t)) {
        t = t.replace(re, '');
        stripped = name;
        break;
      }
    }
    if (stripped && BROWSERS.test(stripped)) {
      const parts = t.split(new RegExp(sep));
      if (parts.length > 1 && PROFILE_SEGMENT.test(parts[parts.length - 1].trim())) {
        t = t.slice(0, t.length - parts[parts.length - 1].length).replace(new RegExp(sep + '$'), '');
      }
    }
    t = t.trim();
    if (t === before) break;
  }
  if (!t) return '';
  const lower = t.toLowerCase();
  if (lower === appLower || [...names, ...APP_SUFFIXES_GATED].some((name) => name.toLowerCase() === lower)) return '';
  return t;
}
