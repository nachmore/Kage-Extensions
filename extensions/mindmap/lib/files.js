// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Documents the user adds through Kage's file_text API (Kage
// docs/design/EXTENSION_FILE_TEXT.md §11): checking the host's result,
// deciding what a pick means for the map, the doc title, and the body-level
// keyphrases and passages. Uses lib.text through the injected `lib`
// argument. Pure and deterministic; returns codes, never text.

export const FILE_REF_RE = /^fr1_[A-Za-z0-9_-]{22}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
// The warnings Kage sends today (§3.6). Newer ones are kept as they come.
export const FILE_WARNINGS = Object.freeze([
  'pages_skipped', 'no_text', 'replaced_characters', 'legacy_encoding', 'restricted', 'hidden_text_skipped', 'possible_secret',
]);
export const FILE_LIMITS = Object.freeze({
  maxChars: 1000000, // the host's ceiling for max_chars
  maxInputBytes: 33554432, // 32 MiB: pass support.max_input_bytes when it differs
  name: 255, title: 200, warnings: 32, // scalar values; warning count
  docTitle: 120, // SPEC §7.2
  refs: 8, // fileRefs per item, newest last
  keyphrases: 64, keyphraseChars: 40,
  passages: 3, passageChars: 400, hits: 20000,
});

const EXT_RE = /^[a-z0-9]{1,16}$/;
const FORMAT_RE = /^[a-z][a-z0-9_]{0,15}$/;
const WARNING_RE = /^[a-z][a-z0-9_]{0,47}$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const U32_MAX = 4294967295;
// Never in a cleaned file name: controls and line breaks, or a path (a
// separator, a Windows drive or share). A Linux name may hold a backslash.
const NAME_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const NAME_PATH_RE = /\/|^[A-Za-z]:\\|^\\\\/;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const clampInt = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback);

// Unicode scalar values in s, or -1 when s holds a lone surrogate.
function scalars(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      if (c > 0xdbff || !(d >= 0xdc00 && d <= 0xdfff)) return -1;
      i++;
    }
    n++;
  }
  return n;
}

// Scalar offsets (ascending, ≤ the scalar length) → offsets into the JS string.
function unitOffsets(s, starts) {
  const out = new Array(starts.length);
  let k = 0;
  let scalar = 0;
  for (let i = 0; k < starts.length; scalar++) {
    while (k < starts.length && starts[k] === scalar) out[k++] = i;
    if (i >= s.length) break;
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return out;
}

function checkPages(raw, chars) {
  let pages;
  if (raw.pages != null) {
    const p = raw.pages;
    if (!isRecord(p) || !isCount(p.count) || !isCount(p.read) || p.read > p.count || p.count > U32_MAX) return { code: 'bad_pages' };
    pages = { count: p.count, read: p.read };
  }
  let starts;
  if (raw.page_starts != null) {
    const list = raw.page_starts;
    if (!pages || !Array.isArray(list) || list.length > pages.read) return { code: 'bad_page_starts' };
    for (let i = 0; i < list.length; i++) {
      if (!isCount(list[i]) || list[i] > chars || (i && list[i] < list[i - 1])) return { code: 'bad_page_starts' };
    }
    starts = list;
  }
  return { pages, starts };
}

function checkWarnings(list) {
  if (!Array.isArray(list) || list.length > FILE_LIMITS.warnings) return null;
  const out = [];
  for (const w of list) {
    if (typeof w !== 'string' || !WARNING_RE.test(w)) return null;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * Check what `pick_file_text` returned (§3.6, §11.3) before anything is
 * stored. opts: { maxChars: what was asked, maxBytes, formats: what was
 * asked }. → { ok: true, file } with camelCase fields (absent optional ones
 * omitted; `pageStarts` are offsets into the JS string), or { ok: false, code }.
 * Unknown fields are dropped.
 */
export function validateFileText(raw, opts = {}) {
  const fail = (code) => ({ ok: false, code });
  if (!isRecord(raw)) return fail('not_object');
  const { name, extension, format, size, text, chars } = raw;
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || NAME_CONTROL_RE.test(name) || NAME_PATH_RE.test(name)) return fail('bad_name');
  const nameChars = scalars(name);
  if (nameChars < 0 || nameChars > FILE_LIMITS.name) return fail('bad_name');
  if (typeof extension !== 'string' || !EXT_RE.test(extension)) return fail('bad_ext');
  const asked = Array.isArray(opts.formats) && opts.formats.length ? opts.formats : null;
  if (typeof format !== 'string' || !FORMAT_RE.test(format) || (asked && !asked.includes(format))) return fail('bad_format');
  const maxBytes = isCount(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : FILE_LIMITS.maxInputBytes;
  if (!isCount(size) || size > maxBytes) return fail('bad_size');
  if (raw.modified_at != null && !Number.isSafeInteger(raw.modified_at)) return fail('bad_modified');
  if (raw.title != null) {
    const titleChars = typeof raw.title === 'string' ? scalars(raw.title) : -1;
    if (titleChars < 0 || titleChars > FILE_LIMITS.title) return fail('bad_title');
  }
  const limit = isCount(opts.maxChars) && opts.maxChars > 0 ? Math.min(opts.maxChars, FILE_LIMITS.maxChars) : FILE_LIMITS.maxChars;
  if (typeof text !== 'string') return fail('bad_text');
  if (text.length > limit * 2) return fail('too_long');
  const counted = scalars(text);
  if (counted < 0) return fail('bad_text');
  if (!isCount(chars) || chars !== counted) return fail('bad_chars');
  if (chars > limit) return fail('too_long');
  if (typeof raw.truncated !== 'boolean') return fail('bad_truncated');
  const total = raw.total_chars;
  if (total != null && (!isCount(total) || total < chars || total > U32_MAX)) return fail('bad_total');
  const paged = checkPages(raw, chars);
  if (paged.code) return fail(paged.code);
  const warnings = checkWarnings(raw.warnings);
  if (!warnings) return fail('bad_warnings');
  if (typeof raw.sha256 !== 'string' || !HEX64_RE.test(raw.sha256)) return fail('bad_hash');
  if (typeof raw.file_ref !== 'string' || !FILE_REF_RE.test(raw.file_ref)) return fail('bad_ref');

  const file = { name, ext: extension, format, size };
  if (raw.modified_at != null) file.modifiedAt = raw.modified_at;
  if (raw.title != null) file.title = raw.title;
  file.text = text;
  file.chars = chars;
  file.truncated = raw.truncated;
  if (total != null) file.totalChars = total;
  if (paged.pages) file.pages = paged.pages;
  if (paged.starts) file.pageStarts = text.length === chars ? paged.starts.slice() : unitOffsets(text, paged.starts);
  file.warnings = warnings;
  file.sha256 = raw.sha256.toLowerCase();
  file.fileRef = raw.file_ref;
  return { ok: true, file };
}

// ---------------------------------------------------------------------------
// Dedupe (§11.4)

function itemList(items) {
  const out = [];
  if (!items) return out;
  for (const item of items instanceof Map ? items.values() : items) {
    if (isRecord(item) && typeof item.id === 'string') out.push(item);
  }
  return out;
}

const hasRef = (item, ref) => Array.isArray(item.fileRefs) && item.fileRefs.includes(ref);
const shaOf = (item) => (isRecord(item.file) && typeof item.file.sha256 === 'string' ? item.file.sha256.toLowerCase() : '');

// The lowest id that passes: ids sort by creation time, so the oldest item.
function oldest(list, test) {
  let best = null;
  for (const item of list) if (test(item) && (!best || item.id < best.id)) best = item;
  return best;
}

/**
 * What a picked file means for the map. items: the items (array, Map or any
 * iterable); file: validateFileText's `file`. opts.targetId: the doc whose
 * "Update from file…" the user chose.
 * → { case: 'same' | 'update' | 'copy' | 'new', itemId? }, first match wins:
 *   same   (S) an item has this fileRef and this sha256: no write;
 *   update (U) an item has this fileRef and another sha256: re-read it;
 *   copy   (C) an item has this sha256: add the fileRef to it;
 *   new    (N) otherwise.
 * With a targetId that is still there, the user's choice decides: the target
 * is re-read, unless its stored file has this sha256, chars and truncated
 * (then 'same', or 'copy' when it lacks the fileRef). A target that is gone
 * falls back to the rules above.
 */
export function dedupeDecision(items, file, { targetId } = {}) {
  const list = itemList(items);
  const sha = typeof file?.sha256 === 'string' && HEX64_RE.test(file.sha256) ? file.sha256.toLowerCase() : '';
  const ref = typeof file?.fileRef === 'string' && FILE_REF_RE.test(file.fileRef) ? file.fileRef : '';
  const target = targetId ? list.find((item) => item.id === targetId) : null;
  if (target) {
    const stored = isRecord(target.file) ? target.file : {};
    const unchanged = !!sha && shaOf(target) === sha && stored.chars === file?.chars && !!stored.truncated === !!file?.truncated;
    if (!unchanged) return { case: 'update', itemId: target.id };
    return { case: ref && !hasRef(target, ref) ? 'copy' : 'same', itemId: target.id };
  }
  if (ref) {
    const same = sha ? oldest(list, (item) => hasRef(item, ref) && shaOf(item) === sha) : null;
    if (same) return { case: 'same', itemId: same.id };
    const changed = oldest(list, (item) => hasRef(item, ref));
    if (changed) return { case: 'update', itemId: changed.id };
  }
  const copy = sha ? oldest(list, (item) => shaOf(item) === sha) : null;
  if (copy) return { case: 'copy', itemId: copy.id };
  return { case: 'new' };
}

/** fileRefs with `ref` added as the newest; the oldest drop past `max`. A new array. */
export function addRef(refs, ref, max = FILE_LIMITS.refs) {
  const valid = typeof ref === 'string' && FILE_REF_RE.test(ref);
  const out = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    if (typeof r === 'string' && FILE_REF_RE.test(r) && r !== ref && !out.includes(r)) out.push(r);
  }
  if (valid) out.push(ref);
  const cap = clampInt(max, 1, 64, FILE_LIMITS.refs);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

// ---------------------------------------------------------------------------
// Title (§11.4)

// Office's PDF printer titles a document "Microsoft Word - <file name>".
const GENERATOR_PREFIX_RE = /^microsoft\s+(?:word|powerpoint|excel)\s+-\s+/i;
// Titles an app fills in by itself.
export const GENERIC_TITLE_RE = /^(?:untitled(?:[\s_-]*(?:document|presentation|spreadsheet|\d+))*|(?:new\s+)?(?:word\s+)?document\s*\d*|(?:powerpoint\s+)?presentation\s*\d*|slide\s*\d+|book\s*\d*|title|no\s+title|none|null|undefined|n\/a)$/i;
const FILE_LIKE_RE = /\.(?:docx?|dotx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|html?|odt|odp|pages|key|numbers|tex|ps)$/i;
const PATH_LIKE_RE = /^(?:[a-z]:[\\/]|[\\/]|~[\\/]|file:)|\\/i;

function nameStem(name) {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && /^[A-Za-z0-9]{1,16}$/.test(name.slice(dot + 1))) return name.slice(0, dot).trim();
  return name;
}

/**
 * The doc's title: the document's own title when it's usable (not empty, not
 * the file name, not an app's default), else the file name without its
 * extension. file: validateFileText's `file`. → { title, titleSource: 'meta' | 'auto' }.
 */
export function docTitle(file, lib) {
  const name = lib.text.collapseWs(typeof file?.name === 'string' ? file.name : '');
  const stem = nameStem(name) || name;
  const meta = lib.text.collapseWs(typeof file?.title === 'string' ? file.title : '').replace(GENERATOR_PREFIX_RE, '').trim();
  const lower = meta.toLowerCase();
  const usable = /[\p{L}\p{N}]/u.test(meta) && lower !== name.toLowerCase() && lower !== stem.toLowerCase()
    && !GENERIC_TITLE_RE.test(meta) && !FILE_LIKE_RE.test(meta) && !PATH_LIKE_RE.test(meta);
  if (usable) return { title: lib.text.truncate(meta, FILE_LIMITS.docTitle), titleSource: 'meta' };
  return { title: lib.text.truncate(stem, FILE_LIMITS.docTitle), titleSource: 'auto' };
}

// ---------------------------------------------------------------------------
// Keyphrases from the whole body (§11.5)

const HEADING_RE = /^#{1,6}(?:[ \t]|$)/;
// Lines Kage writes for structure, not content: an untitled slide's
// "## Slide 3" and the "Notes:" label before speaker notes.
const STRUCTURE_RE = /^(?:#{1,6}[ \t]+)?(?:slide[ \t]+\d+|notes:?)[ \t]*$/i;
const NUMBER_RE = /^[\p{N}.,]+$/u;
const LINE_START_RE = /[#SsNn]/;

// The lines that don't weigh 1, in order: { start, end, weight } (headings
// 2, structure lines 0).
function weightedLines(str) {
  const out = [];
  for (let at = 0; at < str.length;) {
    let end = str.indexOf('\n', at);
    if (end < 0) end = str.length;
    if (LINE_START_RE.test(str[at] || '')) {
      const line = str.slice(at, end);
      if (STRUCTURE_RE.test(line)) out.push({ start: at, end, weight: 0 });
      else if (HEADING_RE.test(line)) out.push({ start: at, end, weight: 2 });
    }
    at = end + 1;
  }
  return out;
}

// True when `form` tokenizes back to exactly `term`, so the index that
// re-tokenizes item.keyphrases finds the same term.
function tokenizesTo(lib, form, term) {
  const terms = lib.text.tokenize(form);
  return terms.length === 1 && terms[0] === term;
}

/**
 * The body's most frequent terms (lib.text.tokenize rules, stop words,
 * numbers and one-letter terms left out), heading terms counting double.
 * Ties go to the term seen first. Each comes back in a form that tokenizes
 * back to its term (the first spelling seen, or the term itself).
 */
export function bodyKeyphrases(text, lib, { max = FILE_LIMITS.keyphrases } = {}) {
  const str = typeof text === 'string' ? text : '';
  const limit = clampInt(max, 0, 256, FILE_LIMITS.keyphrases);
  if (!str || !limit) return [];
  const lines = weightedLines(str);
  const stats = new Map();
  let line = 0;
  for (const word of lib.text.scanWords(str)) {
    while (line < lines.length && lines[line].end <= word.start) line++;
    const weight = line < lines.length && lines[line].start <= word.start ? lines[line].weight : 1;
    if (!weight || !word.norm || lib.text.STOPWORDS.has(word.norm)) continue;
    const term = lib.text.wordTerm(word);
    if (term.length < 2 || term.length > FILE_LIMITS.keyphraseChars || NUMBER_RE.test(term)) continue;
    const stat = stats.get(term);
    if (stat) stat.weight += weight;
    else stats.set(term, { weight, first: stats.size, form: word.norm });
  }
  const ranked = [...stats].sort((a, b) => b[1].weight - a[1].weight || a[1].first - b[1].first);
  const out = [];
  for (const [term, stat] of ranked) {
    const form = tokenizesTo(lib, stat.form, term) ? stat.form : tokenizesTo(lib, term, term) ? term : '';
    if (form) out.push(form);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passages (§11.6, §11.7)

const BLOCK = 4096;
const ELLIPSIS = '\u2026';
const SPACE_RE = /\s/;

// Query terms → [{ t, prefix, root }]: tokenize() output or QuerySpec terms
// ({ t, prefix?, neg? }; negated ones are left out).
function wantedTerms(terms) {
  const byTerm = new Map();
  for (const term of Array.isArray(terms) ? terms : []) {
    const t = typeof term === 'string' ? term : isRecord(term) && !term.neg && typeof term.t === 'string' ? term.t : '';
    if (!t) continue;
    const prefix = isRecord(term) && term.prefix === true;
    const known = byTerm.get(t);
    if (known) known.prefix ||= prefix;
    // A word matching t always has t without its last letter in its folded
    // spelling (the stemmer only changes the end), so `root` can rule a
    // block out before it's scanned.
    else byTerm.set(t, { t, prefix, root: t.length > 1 ? t.slice(0, -1) : t });
  }
  return [...byTerm.values()];
}

// The spelling wordNorm() sees, for the root test: marks stripped, lower
// case, apostrophes and the dots inside dotted acronyms dropped.
function fold(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/['\u2019]/g, '').replace(/(?<=\p{L})\.(?=\p{L})/gu, '');
}

// The next block end after `at`: a line break, else a space, inside BLOCK.
function blockEnd(str, at) {
  const hard = at + BLOCK;
  if (hard >= str.length) return str.length;
  const nl = str.lastIndexOf('\n', hard - 1);
  if (nl > at) return nl + 1;
  const sp = Math.max(str.lastIndexOf(' ', hard - 1), str.lastIndexOf('\t', hard - 1));
  if (sp > at) return sp + 1;
  const c = str.charCodeAt(hard - 1);
  return c >= 0xd800 && c <= 0xdbff ? hard - 1 : hard;
}

function findHits(str, want, lib) {
  const hits = [];
  for (let at = 0; at < str.length && hits.length < FILE_LIMITS.hits;) {
    const end = blockEnd(str, at);
    const block = str.slice(at, end);
    const folded = fold(block);
    if (want.some((w) => folded.includes(w.root))) {
      for (const word of lib.text.scanWords(block)) {
        if (!word.norm) continue;
        const term = lib.text.wordTerm(word);
        const k = want.findIndex((w) => term === w.t || word.norm === w.t || (w.prefix && (term.startsWith(w.t) || word.norm.startsWith(w.t))));
        if (k >= 0) hits.push({ start: at + word.start, end: at + word.end, k });
        if (hits.length >= FILE_LIMITS.hits) break;
      }
    }
    at = end;
  }
  return hits;
}

// A window of at most `inner` units around [a, b), cut at spaces and never
// inside a surrogate pair.
function windowAround(str, a, b, inner) {
  const room = Math.max(0, inner - (b - a));
  let end = Math.min(str.length, Math.max(0, a - Math.floor(room / 2)) + inner);
  let start = Math.max(0, end - inner);
  if (start > 0) {
    for (let i = start; i < a; i++) if (SPACE_RE.test(str[i])) { start = i + 1; break; }
  }
  if (end < str.length) {
    for (let i = end - 1; i >= b; i--) if (SPACE_RE.test(str[i])) { end = i; break; }
  }
  if (start > 0 && /[\udc00-\udfff]/.test(str[start] || '')) start++;
  if (end < str.length && /[\udc00-\udfff]/.test(str[end] || '')) end--;
  return { start, end };
}

function pageAt(pageStarts, offset) {
  let lo = 0;
  let hi = pageStarts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageStarts[mid] <= offset) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found + 1;
}

/**
 * Up to `max` passages of at most `chars` characters (ellipses included)
 * where the most distinct query terms meet, best first, not overlapping.
 * terms: tokenize() output or QuerySpec terms. opts.pageStarts: offsets
 * into `text` where each page starts (validateFileText's `pageStarts`),
 * which adds a 1-based `page`.
 * → [{ text, start, end, page? }] (start/end: offsets into `text`).
 */
export function findPassages(text, terms, lib, { max = FILE_LIMITS.passages, chars = FILE_LIMITS.passageChars, pageStarts } = {}) {
  const str = typeof text === 'string' ? text : '';
  const want = wantedTerms(terms);
  const count = clampInt(max, 0, 10, FILE_LIMITS.passages);
  if (!str || !want.length || !count) return [];
  const inner = clampInt(chars, 40, 4000, FILE_LIMITS.passageChars) - 2;
  const hits = findHits(str, want, lib);
  if (!hits.length) return [];

  // Every hit anchors a window running `inner` units on; score it by the
  // distinct terms it holds, then by its hits.
  const seen = new Array(want.length).fill(0);
  const windows = [];
  let distinct = 0;
  for (let i = 0, j = 0; i < hits.length; i++) {
    if (j === i && seen[hits[j++].k]++ === 0) distinct++;
    while (j < hits.length && hits[j].end - hits[i].start <= inner) if (seen[hits[j++].k]++ === 0) distinct++;
    windows.push({ i, last: j - 1, distinct, n: j - i });
    if (--seen[hits[i].k] === 0) distinct--;
  }
  windows.sort((x, y) => y.distinct - x.distinct || y.n - x.n || x.i - y.i);

  const out = [];
  const starts = Array.isArray(pageStarts) && pageStarts.length ? pageStarts : null;
  for (const w of windows) {
    const a = hits[w.i].start;
    const b = Math.min(hits[w.last].end, a + inner);
    if (out.some((p) => a < p.end && p.start < b)) continue;
    let { start, end } = windowAround(str, a, b, inner);
    // Earlier passages lie wholly before a or after b: trim the context to
    // meet them at their edges (spaces, so no word is cut).
    for (const p of out) {
      if (p.end <= a && p.end > start) start = p.end;
      if (p.start >= b && p.start < end) end = p.start;
    }
    const body = str.slice(start, end).replace(/\s+/g, ' ').trim();
    const passage = { text: (start > 0 ? ELLIPSIS : '') + body + (end < str.length ? ELLIPSIS : ''), start, end };
    if (starts) {
      const page = pageAt(starts, a);
      if (page) passage.page = page;
    }
    out.push(passage);
    if (out.length >= count) break;
  }
  return out;
}
