// Leaf module: imports nothing (the host rewrites one level of shared imports).
// The deterministic organizer (SPEC §5 S0–S7): one capture in, one
// Extraction out. Pure: no network, no agent, no clock (time is env.now).
// Other leaves arrive through env.lib = { text, dates, url, entities }.

export const EXTRACTOR_VERSION = 1;

// SPEC §5 S5, English. Multi-word verbs are listed separately.
export const IMPERATIVE_VERBS = new Set((
  'send email mail call phone text message ping ask tell remind review read watch check verify confirm schedule ' +
  'book plan prepare prep draft write update fix file submit share post publish follow chase buy order pay renew ' +
  'cancel sign finish complete start create add remove delete clean organize move research investigate find get ' +
  'return reply respond invite discuss decide approve test deploy ship merge print download upload install ' +
  'register apply'
).split(' '));
export const IMPERATIVE_PHRASES = Object.freeze(['set up', 'look into', 'pick up']);
export const ACTION_HEADING_RE = /^(?:#+\s*)?(action items?|actions|next steps|follow[- ]?ups?|todos?|to-?dos?|tasks|ais?)\s*:?\s*$/i;
export const MEETING_FIRST_RE = /^(meeting|mtg|1:1|1-1|one[- ]on[- ]one|sync|standup|stand-up|retro|retrospective|interview|call)\b/i;
export const MEETING_END_RE = /\b(sync|standup|stand-up|1:1|meeting|retro)\s*:?\s*$/i;
// "call" also starts imperatives ("call the Zebra team"): as a meeting word it
// needs a meeting-ish follower.
const CALL_MEETING_RE = /^call\s*(?:$|[:\-–—]|\s(?:with|w\/|notes?|recap|summary)\b)/i;
// A short first line with a meeting word mid-line: "Launch sync with Sarah
// and Raj", "Offsite planning meeting on Dec 10".
const MEETING_MID_RE = /\b(?:sync|meeting|standup|stand-up|1:1|retro|catch[- ]?up|call)\s+(?:with|w\/|on|for|about|re)\b/i;
const MARKER_RE = /^(?:(?:todo|to\s+do|to-do|action(?:\s+items?)?|ais?|next\s+steps?|follow[- ]?ups?|tasks?)\s*:\s*|(?:todo|to-do)\s+(?=\S))/i;
const REMIND_RE = /^(?:please\s+)?remind\s+me\s+to\s+/i;
const COMMIT_ANY_RE = /\b(?:i|we)\s+(?:really\s+)?(?:need\s+to|have\s+to|must|should|will|am\s+going\s+to|are\s+going\s+to)\b|\b(?:i|we)['’]ll\b|\bi['’]m\s+going\s+to\b|\bwe['’]re\s+going\s+to\b|\bdon['’]?t\s+forget\s+to\b|\bmake\s+sure\s+(?:to|you)\b/i;
const FOLLOW_UP_RE = /^follow[- ]?up\s+(?:with|on)\b/i;
// "Need to call the bank", "gotta renew the domain": a commitment without "I".
export const NEED_RE = /^(?:(?:please|also|and|then|so|still|really)\s+)*(?:need\s+to|have\s+to|gotta|got\s+to|must)\s+(?!(?:i|we|you|he|she|they|it|be)\b)\p{L}[^?]*$/iu;
const ASK_RE = /^ask\s+\p{Lu}[\p{L}'’-]*\s+(?:to|about)\b/u;
const LEADING_PHRASE_RE = /^(?:(?:please|also|and|then|so|still|really)\s+)*(?:(?:i|we)\s+(?:really\s+)?(?:need\s+to|have\s+to|must|should|will|am\s+going\s+to|are\s+going\s+to)|(?:i|we)['’]ll|i['’]m\s+going\s+to|we['’]re\s+going\s+to|don['’]?t\s+forget\s+to|make\s+sure\s+to|remind\s+me\s+to|need\s+to|have\s+to|gotta|got\s+to|must|please)\s+/i;
const DANGLING_RE = /[\s,;:–—-]*(?:\b(?:by|on|before|until|till|for|due|at|no\s+later\s+than)\b[\s,;:]*)*$/i;
const NOT_VERB_FOLLOWER = /^(?:of|is|was|are|were|['’]s)\b/i;
const VALID_KINDS = new Set(['note', 'link', 'doc', 'action', 'meeting']);
const TYPE_RANK = { team: 0, project: 1, org: 2, person: 3, topic: 4, term: 5 };
const MAX_TITLE = 120;
const MAX_ENTITIES = 24;
const MAX_SUMMARY_WORDS = 120;

// ---------------------------------------------------------------- helpers

function capText(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  let cut = max;
  const code = s.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return { text: s.slice(0, cut), truncated: true };
}

function wordCount(lib, s) {
  return lib.text.scanWords(s).length;
}

function startsImperative(s) {
  const v = s.replace(/^(?:please\s+)/i, '').trim();
  const m = /^(\p{L}+)(?:\s+(\p{L}+))?/u.exec(v);
  if (!m) return false;
  const first = m[1].toLowerCase();
  const rest = v.slice(m[1].length);
  if (/^\s*:/.test(rest) || NOT_VERB_FOLLOWER.test(rest.trim())) return false;
  if (IMPERATIVE_VERBS.has(first)) return true;
  return Boolean(m[2]) && IMPERATIVE_PHRASES.includes(`${first} ${m[2].toLowerCase()}`);
}

function isHeading(line) {
  if (line.bullet) return false;
  const t = line.text.trim();
  if (!t) return false;
  return ACTION_HEADING_RE.test(t) || /^#{1,6}\s+\S/.test(t) || (/:\s*$/.test(t) && t.split(/\s+/).length <= 6);
}

function cleanTitle(lib, quote, dueSpan) {
  let t = quote;
  if (dueSpan) t = t.slice(0, dueSpan[0]) + ' ' + t.slice(dueSpan[1]);
  t = lib.text.collapseWs(t);
  for (let guard = 0; guard < 3; guard++) {
    const before = t;
    t = t.replace(MARKER_RE, '').replace(LEADING_PHRASE_RE, '').replace(/^to\s+/i, '').trim();
    if (t === before) break;
  }
  t = t.replace(DANGLING_RE, '').replace(/[\s,;:.!–—-]+$/, '').trim();
  return lib.text.truncate(t || lib.text.collapseWs(quote), MAX_TITLE);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- actions

// Scores one segment (a line or a sentence). → null or
// { confidence, status, owner: null | {key, name, handle} }
// opts.commitText limits the "I'll / I need to" test to the first sentence
// of a longer line, so a later sentence doesn't make the whole line an action.
function scoreSegment(lib, seg, opts) {
  const t = seg.text.trim();
  if (!t) return null;
  if (seg.bullet === 'box' || seg.bullet === 'boxdone') {
    return { confidence: 1, status: seg.bullet === 'boxdone' ? 'done' : 'open', owner: null };
  }
  if (opts.inContext || MARKER_RE.test(t) || REMIND_RE.test(t)) return { confidence: 1, status: 'open', owner: null };
  const cue = lib.entities.ownerCue(t, lib, { verbs: IMPERATIVE_VERBS });
  const ownerOk = Boolean(cue) && opts.ownerAllowed(cue);
  if (ownerOk && cue.handle) return { confidence: 0.8, status: 'open', owner: cue };
  const commitText = opts.commitText ?? t;
  if (COMMIT_ANY_RE.test(commitText) || FOLLOW_UP_RE.test(t) || NEED_RE.test(t)) return { confidence: 0.8, status: 'open', owner: null };
  const imperative = startsImperative(t);
  if (opts.single && imperative && wordCount(lib, t) <= 20) {
    return { confidence: opts.hasDue ? 0.9 : 0.8, status: 'open', owner: null };
  }
  if (ownerOk) return { confidence: 0.6, status: 'open', owner: cue };
  // A to-do list (most lines start with a verb, and it isn't a meeting):
  // its imperative lines are open actions, not suggestions.
  if (opts.lineStart && imperative && opts.todoList) return { confidence: 0.8, status: 'open', owner: null };
  if (ASK_RE.test(t) || (opts.lineStart && imperative)) return { confidence: 0.6, status: 'open', owner: null };
  return null;
}

function ownerRecord(owner) {
  return owner ? { key: owner.key, name: owner.name, ...(owner.entityId ? { entityId: owner.entityId } : {}) } : 'me';
}

function makeAction(lib, ctx, segText, score, segIndex) {
  const quote = segText.trim();
  const due = lib.dates.parseDue(quote, ctx.dateOpts);
  return {
    seg: segIndex,
    text: quote,
    title: cleanTitle(lib, quote, due?.span),
    quote,
    status: score.status,
    confidence: score.confidence,
    suggested: score.confidence < 0.8 && !ctx.autoAccept,
    owner: ownerRecord(score.owner),
    ...(due ? { dueAt: due.at } : {}),
    origin: 'rule',
  };
}

// ---------------------------------------------------------------- input

function normalizeInput(input, env) {
  let text = String(input?.text ?? '').normalize('NFC');
  if (env.trigger) {
    const t = String(env.trigger);
    if (text.toLowerCase().startsWith(t.toLowerCase() + '+')) text = text.slice(t.length + 1);
  }
  text = text.trim();
  let isPrivate = Boolean(input?.hint?.private);
  const bang = /^!(?:\s+|$)/.exec(text);
  if (bang) {
    isPrivate = true;
    text = text.slice(bang[0].length).trim();
  }
  const PRIVATE_TAG = /(^|[^\p{L}\p{N}_&#/])#private\b/giu;
  if (PRIVATE_TAG.test(text)) {
    isPrivate = true;
    text = text.replace(PRIVATE_TAG, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  }
  const capped = capText(text, env.maxText ?? 8000);
  return { text: capped.text, truncated: capped.truncated, private: isPrivate };
}

function cleanHint(lib, hint, via) {
  const out = { titleSource: via === 'agent' ? 'agent' : 'user' };
  if (!hint || typeof hint !== 'object') return out;
  if (VALID_KINDS.has(hint.kind)) out.kind = hint.kind;
  if (typeof hint.title === 'string' && hint.title.trim()) out.title = lib.text.truncate(lib.text.collapseWs(hint.title), MAX_TITLE);
  if (typeof hint.url === 'string' && lib.url.canonicalUrl(hint.url)) out.url = hint.url.trim();
  if (typeof hint.path === 'string' && hint.path.trim()) out.path = hint.path.trim();
  if (typeof hint.summary === 'string' && hint.summary.trim()) {
    const words = lib.text.collapseWs(hint.summary).split(' ');
    out.summary = lib.text.truncate(words.slice(0, MAX_SUMMARY_WORDS).join(' '), 1000);
  }
  if (Array.isArray(hint.terms)) {
    const seen = new Set();
    out.terms = [];
    for (const term of hint.terms) {
      if (typeof term !== 'string') continue;
      const v = lib.text.truncate(lib.text.collapseWs(term), 60);
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      out.terms.push(v);
      if (out.terms.length >= 20) break;
    }
  }
  if (Array.isArray(hint.actions)) out.actions = hint.actions;
  // A page's own title and description (fetched link metadata) can name
  // known entities and propose candidates, but never create a team,
  // project or person by itself ("Company and team OKRs for…").
  if (hint.fetchedTitle === true) out.fetchedTitle = true;
  if (hint.fetchedSummary === true) out.fetchedSummary = true;
  return out;
}

function looksLikeMeeting(first, text) {
  if (/\battendees\s*:/i.test(text)) return true;
  if (first.bullet === 'box' || first.bullet === 'boxdone' || MARKER_RE.test(first.text)) return false;
  const line = first.text.trim();
  const m = MEETING_FIRST_RE.exec(line);
  if (m && (m[1].toLowerCase() !== 'call' || CALL_MEETING_RE.test(line))) return true;
  if (MEETING_END_RE.test(line)) return true;
  // Not a to-do ("schedule a sync with Dana", "need to set up a call with Raj").
  return MEETING_MID_RE.test(line) && line.split(/\s+/).length <= 8
    && !startsImperative(line) && !COMMIT_ANY_RE.test(line) && !NEED_RE.test(line) && !REMIND_RE.test(line);
}

function removeSpans(lib, text, spans) {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + ' ' + out.slice(s.end);
  return lib.text.collapseWs(out);
}

const DUE_BEFORE_RE = /\b(?:by|before|until|till|due|no\s+later\s+than)\s*$/i;
// Phrases that can only mean the past.
const PAST_CODES = new Set(['yesterday', 'days_ago', 'last_weekday']);
// Whole past weeks: a meeting about them ("Retro for last week").
const PAST_WEEK_CODES = new Set(['last_week', 'weeks_ago']);
// A bare weekday or weekend is a past day only with a past-tense cue
// ("met Dana on Thursday"), never on its own ("dentist thu 3pm").
const CUE_CODES = new Set(['weekday', 'this_weekday', 'weekend']);
export const PAST_CUE_RE = /\b(?:met|had|was|were|did|went|saw|talked|spoke|said|discussed|chatted|caught\s+up|called|presented|reviewed|agreed|decided|happened|held|attended|visited)\b/i;
export const FUTURE_CUE_RE = /\b(?:will|won['’]t|going\s+to|gonna|moves?\s+to|moved\s+to|plan(?:s|ned)?\s+to|scheduled|upcoming|next|tomorrow|due|deadline|until)\b|['’]ll\b/i;

// S6: when a note or meeting says it happened, from its first line. Only
// clearly past phrases count (yesterday, N days ago, last <weekday>; whole
// past weeks for meetings; today for meetings); a weekday needs a past-tense
// cue. A month and day without a year count only when the nearest such day
// to the capture is in the past ("Oct 3" said in November), never when it is
// coming up ("the launch moves to Dec 3"), which is never rolled back a year.
function occurredFrom(lib, line, dateOpts, meeting) {
  const today = lib.dates.startOfDay(dateOpts.now);
  const pastCue = PAST_CUE_RE.test(line) && !FUTURE_CUE_RE.test(line);
  let offset = 0;
  for (let guard = 0; guard < 5 && offset < line.length; guard++) {
    const r = lib.dates.parseRange(line.slice(offset), dateOpts);
    if (!r) return undefined;
    const at = offset + r.span[0];
    const said = line.slice(at, offset + r.span[1]);
    offset += r.span[1];
    if (DUE_BEFORE_RE.test(line.slice(0, at)) || !(r.start > 0) || r.start > dateOpts.now) continue;
    let ok = false;
    if (PAST_CODES.has(r.code)) ok = true;
    else if (PAST_WEEK_CODES.has(r.code) || r.code === 'today') ok = meeting;
    else if (CUE_CODES.has(r.code)) ok = pastCue;
    else if (r.code === 'date') {
      if (/\d{4}/.test(said)) ok = true;
      else {
        const next = lib.dates.parseDue(said, dateOpts);
        const ahead = next && next.span[0] === 0 ? next.at - today : Infinity;
        ok = ahead !== 0 && today - r.start < ahead;
      }
    }
    if (!ok) continue;
    if (meeting) return r.start;
    if (r.granularity === 'day' && r.start < today) return r.start;
  }
  return undefined;
}

// ---------------------------------------------------------------- extract

// input = { text, via, source?: {app?, window?}, hint?: {kind?, title?, url?, path?, summary?, terms?, private?, actions?} }
// env   = { lib, now, weekStart, dict, myNames, autoAccept, maxText = 8000, maxChildren = 50, idf?, trigger? }
// → Extraction (ARCHITECTURE §6.1). Same input + same env → deep-equal output.
export function extract(input, env) {
  const lib = env.lib;
  const weekStart = Number.isInteger(env.weekStart) ? env.weekStart : 1;
  const dateOpts = { now: env.now, weekStart };
  const ctx = { dateOpts, autoAccept: Boolean(env.autoAccept) };
  const via = input?.via || 'launcher';
  const { text, truncated, private: isPrivate } = normalizeInput(input, env);
  const hint = cleanHint(lib, input?.hint, via);

  // S1 segment.
  const lines = lib.text.splitLines(text);
  const lineStarts = [];
  {
    let at = 0;
    for (const raw of text.split('\n')) {
      lineStarts.push(at);
      at += raw.length + 1;
    }
  }
  const lineOf = (offset) => {
    let idx = 0;
    for (let i = 0; i < lineStarts.length && lineStarts[i] <= offset; i++) idx = i;
    return idx;
  };
  const nonEmpty = lines.filter((l) => l.text.trim());
  const isDump = nonEmpty.length > 1;
  const firstIdx = lines.findIndex((l) => l.text.trim());
  const first = firstIdx >= 0 ? lines[firstIdx] : null;

  // S2 classify (link → doc → meeting → action → note) and S3 resolve.
  const urls = lib.url.findUrls(text);
  const paths = lib.url.findPaths(text);
  const windowTitle = !text && input?.source?.window ? lib.text.cleanWindowTitle(input.source.window, input.source.app) : '';
  let kind = hint.kind || 'note';
  let url = hint.url;
  let path = hint.path;
  let extra = '';
  if (!hint.kind) {
    if (urls.length === 1 && wordCount(lib, removeSpans(lib, text, [urls[0]])) <= 20) {
      url = url || urls[0].url;
      kind = lib.url.isDocUrl(url) ? 'doc' : 'link';
      extra = removeSpans(lib, text, [urls[0]]);
    } else if (paths.length === 1 && !urls.length && wordCount(lib, removeSpans(lib, text, [paths[0]])) <= 20) {
      kind = 'doc';
      path = path || paths[0].path;
      extra = removeSpans(lib, text, [paths[0]]);
    } else if (!text && windowTitle) {
      kind = 'doc';
    } else if (first && looksLikeMeeting(first, text)) {
      kind = 'meeting';
    }
  } else if (kind === 'link' || kind === 'doc') {
    if (!url && !path && urls.length === 1) url = urls[0].url;
    if (!url && !path && paths.length === 1) path = paths[0].path;
    extra = removeSpans(lib, text, [...urls.filter((u) => u.url === url), ...paths.filter((p) => p.path === path)]);
  }
  const canonical = url ? lib.url.canonicalUrl(url) : null;
  const normPath = path ? lib.url.normalizePath(path) : '';
  const docKey = kind === 'doc' && !url && !path && windowTitle ? String(input.source.app ?? '') + '\u0000' + windowTitle : null;

  // Known entities, "me", and the scan blocks (text, then title/summary hints).
  const myNames = (env.myNames || []).filter((n) => typeof n === 'string' && n.trim());
  const myKeys = new Set(myNames.map((n) => lib.text.normalizeKey(n)).filter(Boolean));
  const baseDict = env.dict || lib.entities.buildDictionary([], lib);
  const known = (key) => lib.entities.lookupKey(baseDict, key);
  const blocks = [];
  if (text) blocks.push({ text, seg: null });
  if (hint.title) blocks.push({ text: hint.title, seg: -1, fetched: !!hint.fetchedTitle });
  if (windowTitle) blocks.push({ text: windowTitle, seg: -1 });
  if (hint.summary) blocks.push({ text: hint.summary, seg: -2, fetched: !!hint.fetchedSummary });

  // S4 explicit mentions.
  const fresh = [];
  blocks.forEach((block, bi) => {
    if (block.fetched) return;
    for (const m of lib.entities.explicitMentions(block.text, lib, { verbs: IMPERATIVE_VERBS })) {
      fresh.push({ ...m, block: bi, seg: block.seg ?? lineOf(m.start), explicit: true });
    }
  });

  // S5 actions. An owner cue creates (or links) a person right away.
  const ownerAllowed = (cue) => myKeys.has(cue.key) || known(cue.key).every((h) => h.type === 'person');
  const resolveOwner = (cue) => {
    if (!cue) return null;
    if (myKeys.has(cue.key)) return null;
    const person = known(cue.key).find((h) => h.type === 'person');
    return person ? { ...cue, name: person.name, entityId: person.entityId } : cue;
  };
  const noteOwner = (owner, seg, start, origin) => {
    if (owner) fresh.push({ type: 'person', name: owner.name, key: owner.key, start, end: start, marker: 'owner', block: 0, seg, explicit: true, origin, ...(owner.entityId ? { entityId: owner.entityId } : {}) });
  };
  const actionFrom = (segText, score, segIndex, start) => {
    const owner = resolveOwner(score.owner);
    noteOwner(owner, segIndex, start + (score.owner?.start ?? 0), 'rule');
    return makeAction(lib, ctx, segText, { ...score, owner }, segIndex);
  };

  const actions = [];
  const rejectedActions = [];
  let self = null;
  const agentActions = Array.isArray(hint.actions);
  if (agentActions) {
    for (const a of hint.actions) {
      const actText = typeof a?.text === 'string' ? lib.text.collapseWs(a.text) : '';
      const quote = typeof a?.quote === 'string' ? a.quote : '';
      if (!actText) {
        rejectedActions.push({ text: String(a?.text ?? ''), reason: 'invalid' });
        continue;
      }
      if (!lib.text.containsQuote(text, quote)) {
        rejectedActions.push({ text: actText, reason: 'quote_not_found' });
        continue;
      }
      let owner = null;
      const ownerName = typeof a.owner === 'string' ? lib.text.collapseWs(a.owner.replace(/^@/, '')) : '';
      if (ownerName && ownerName.toLowerCase() !== 'me') {
        const key = lib.text.normalizeKey(ownerName);
        if (key) owner = resolveOwner({ name: ownerName, key, handle: false });
      }
      let dueAt = null;
      if (typeof a.due === 'string' && a.due.trim()) {
        dueAt = lib.dates.parseIsoDay(a.due.trim().slice(0, 10)) ?? lib.dates.parseDue(a.due, dateOpts)?.at ?? null;
      }
      const at = text.toLowerCase().indexOf(lib.text.collapseWs(quote).toLowerCase());
      const seg = at >= 0 ? lineOf(at) : 0;
      noteOwner(owner, seg, Math.max(0, at), 'agent');
      actions.push({
        seg,
        text: actText,
        title: lib.text.truncate(actText, MAX_TITLE),
        quote: lib.text.collapseWs(quote),
        status: 'open',
        confidence: 0.6,
        suggested: !ctx.autoAccept,
        owner: ownerRecord(owner),
        ...(dueAt !== null ? { dueAt } : {}),
        origin: 'agent',
      });
    }
  }

  if (kind === 'link' || kind === 'doc') {
    // "read later <url>": an imperative note becomes a child action of the link.
    if (!agentActions && extra && (url || path)) {
      const seg = lib.text.splitLines(extra)[0];
      const t = seg.text.trim();
      const imperative = startsImperative(t.replace(MARKER_RE, ''));
      const boxed = seg.bullet === 'box' || seg.bullet === 'boxdone';
      if (t && (imperative || boxed || MARKER_RE.test(t))) {
        const score = { confidence: boxed || !imperative ? 1 : 0.8, status: seg.bullet === 'boxdone' ? 'done' : 'open', owner: null };
        actions.push(actionFrom(t, score, Math.max(0, firstIdx), 0));
      }
    }
  } else if (kind === 'action' && hint.kind === 'action') {
    const t = first ? first.text.trim() : '';
    const score = first
      ? scoreSegment(lib, { text: t, bullet: first.bullet }, { single: true, hasDue: Boolean(lib.dates.parseDue(t, dateOpts)), ownerAllowed })
      : null;
    self = actionFrom(t || text, score || { confidence: 0.8, status: 'open', owner: null }, Math.max(0, firstIdx), lineStarts[Math.max(0, firstIdx)] ?? 0);
    if (via === 'agent') {
      self.origin = 'agent';
      self.suggested = !ctx.autoAccept;
    }
  } else if (!agentActions) {
    const single = !isDump;
    const canSelf = single && !hint.kind && kind === 'note';
    // A dump whose lines (after a heading) mostly start with a verb is a
    // to-do list: "Weekly planning / finish the budget / email Dana …".
    let todoList = false;
    if (isDump && kind !== 'meeting') {
      const body = lines.filter((l, i) => l.text.trim() && i !== firstIdx && !isHeading(l));
      const head = first && !startsImperative(first.text.trim()) ? [] : [first];
      const all = [...head, ...body].filter(Boolean);
      const verbs = all.filter((l) => startsImperative(l.text.trim().replace(MARKER_RE, ''))).length;
      todoList = verbs >= 2 && verbs * 3 >= all.length * 2;
    }
    let inContext = false;
    lines.forEach((line, idx) => {
      const lineText = line.text.trim();
      if (!lineText) {
        inContext = false;
        return;
      }
      if (isHeading(line)) {
        inContext = ACTION_HEADING_RE.test(lineText);
        return;
      }
      const lineAt = line.start;
      const boxed = line.bullet === 'box' || line.bullet === 'boxdone';
      const sentences = boxed ? [{ text: lineText, start: 0 }] : lib.text.splitSentences(lineText);
      const score = scoreSegment(lib, { text: lineText, bullet: line.bullet }, {
        inContext, single, lineStart: isDump, ownerAllowed, todoList,
        hasDue: single && Boolean(lib.dates.parseDue(lineText, dateOpts)),
        commitText: sentences.length > 1 ? sentences[0].text : lineText,
      });
      if (score && canSelf && score.confidence >= 0.8) {
        kind = 'action';
        self = actionFrom(lineText, score, idx, lineAt);
        return;
      }
      // A one-line meeting ("call with Dana tomorrow") isn't also its own action.
      if (score && !(single && kind === 'meeting' && score.confidence < 1)) {
        actions.push(actionFrom(lineText, score, idx, lineAt));
        return;
      }
      if (sentences.length < 2) return;
      sentences.forEach((s) => {
        const sScore = scoreSegment(lib, { text: s.text, bullet: null }, { inContext: false, single: false, lineStart: true, ownerAllowed });
        if (sScore) actions.push(actionFrom(s.text, sScore, idx, lineAt + s.start));
      });
    });
  }

  // F-CAP-3: child links for the URLs inside notes and meetings.
  const links = [];
  if (kind === 'note' || kind === 'meeting') {
    const seen = new Set();
    for (const u of urls) {
      const key = lib.url.canonicalUrl(u.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      links.push({ seg: lineOf(u.start), url: u.url, canonicalUrl: key, isDoc: lib.url.isDocUrl(u.url) });
    }
  }
  actions.sort((a, b) => a.seg - b.seg);
  const room = Math.max(0, env.maxChildren ?? 50);
  const keptActions = actions.slice(0, room);
  const keptLinks = links.slice(0, Math.max(0, room - keptActions.length));

  // S4 dictionary: known entities + this capture's new ones + "me" join one
  // dictionary before any block is scanned (so "Dana" on line 1 links to the
  // person an owner cue creates on line 2).
  const placeholder = (m) => `new:${m.type}:${m.key}`;
  const localEntries = [];
  const resolved = fresh.map((m) => {
    if (m.me || (m.type === 'person' && myKeys.has(m.key))) return { ...m, entityId: 'me', key: 'me', name: 'Me', type: 'person' };
    if (m.entityId) return m;
    const hits = known(m.key);
    const hit = hits.find((h) => h.type === m.type) || hits[0];
    // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
    if (hit) return { ...m, entityId: hit.entityId, name: hit.name, type: hit.type, key: hit.key };
    // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
    localEntries.push({ entityId: placeholder(m), type: m.type, names: [m.name], key: m.key });
    return m;
  });
  if (myNames.length) localEntries.push({ entityId: 'me', type: 'person', names: myNames, key: 'me' });
  const dict = localEntries.length ? lib.entities.extendDictionary(baseDict, localEntries, lib) : baseDict;
  const local = new Map(resolved.filter((m) => !m.entityId).map((m) => [placeholder(m), m]));
  const hits = [];
  blocks.forEach((block, bi) => {
    for (const hit of lib.entities.scanDictionary(dict, lib.text.scanWords(block.text))) {
      const seg = block.seg ?? lineOf(hit.start);
      const fresher = local.get(hit.entityId);
      if (fresher) {
        hits.push({ ...fresher, start: hit.start, end: hit.end, block: bi, seg, explicit: false });
      } else if (!String(hit.entityId).startsWith('new:')) {
        const me = hit.entityId === 'me';
        // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
        hits.push({ entityId: hit.entityId, type: hit.type, name: me ? 'Me' : hit.name, key: me ? 'me' : hit.key, start: hit.start, end: hit.end, block: bi, seg, explicit: false });
      }
    }
  });
  const merged = new Map();
  for (const m of [...resolved, ...hits].sort((a, b) => a.block - b.block || a.start - b.start || (b.explicit ? 1 : 0) - (a.explicit ? 1 : 0))) {
    const id = m.entityId ? 'id:' + m.entityId : `k:${m.type}:${m.key}`;
    const prev = merged.get(id);
    if (prev) {
      prev.explicit = prev.explicit || Boolean(m.explicit);
      if (m.alias && !prev.alias) prev.alias = m.alias;
      if (!prev.segs.includes(m.seg)) prev.segs.push(m.seg);
      continue;
    }
    // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
    merged.set(id, {
      ...(m.entityId ? { entityId: m.entityId } : {}),
      key: m.key,
      name: m.name,
      type: m.type,
      origin: m.origin === 'agent' ? 'agent' : 'rule',
      explicit: Boolean(m.explicit),
      seg: m.seg,
      // Every line that names it (children take the names on their own line).
      segs: [m.seg],
      ...(m.alias ? { alias: m.alias } : {}),
      order: [m.block, m.start],
    });
  }
  const mentions = [...merged.values()]
    .sort((a, b) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || a.order[0] - b.order[0] || a.order[1] - b.order[1] || cmp(a.key, b.key))
    .slice(0, MAX_ENTITIES)
    .map(({ order, ...m }) => m);

  // Implicit candidates: never a key that is already an entity or mentioned.
  const mentionKeys = new Set(mentions.map((m) => m.key));
  const candidates = [];
  const byKey = new Map();
  for (const block of blocks) {
    for (const c of lib.entities.implicitCandidates(block.text, lib)) {
      if (mentionKeys.has(c.key) || myKeys.has(c.key) || known(c.key).length) continue;
      const prev = byKey.get(c.key);
      if (prev) {
        if (c.type === 'person') prev.type = 'person';
        continue;
      }
      // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
      const entry = { key: c.key, display: c.display, type: c.type };
      byKey.set(c.key, entry);
      candidates.push(entry);
    }
  }

  const aliases = [];
  const aliasSeen = new Set();
  for (const block of blocks) {
    for (const a of lib.entities.learnAliases(block.text, lib)) {
      const id = a.longKey + '\u0000' + a.shortKey;
      if (!aliasSeen.has(id)) {
        aliasSeen.add(id);
        aliases.push(a);
      }
    }
  }

  // Title.
  let title;
  let titleSource = 'auto';
  let titleFromText = false;
  if (hint.title) {
    title = hint.title;
    titleSource = hint.titleSource;
  } else if (kind === 'action' && self) {
    title = self.title;
  } else if ((kind === 'link' || kind === 'doc') && url) {
    // "great talk on caching https://…": the user's own words until the
    // page title arrives (titleSource stays 'auto', so it may replace them).
    const own = extra && !actions.length && !agentActions ? lib.text.firstLine(extra.replace(MARKER_RE, ''), MAX_TITLE) : '';
    titleFromText = !!own && lib.text.scanWords(own).length >= 2;
    title = titleFromText ? own : lib.url.urlTitleGuess(url);
  } else if (kind === 'doc' && path) {
    title = lib.url.baseName(path);
  } else if (kind === 'doc' && windowTitle) {
    title = windowTitle;
  } else {
    title = lib.text.firstLine(first ? first.text.replace(/^#{1,6}\s+/, '') : '', MAX_TITLE);
  }
  title = lib.text.truncate(title || '', MAX_TITLE);

  // S6 dates.
  const occurredAt = (kind === 'meeting' || kind === 'note') && first ? occurredFrom(lib, first.text, dateOpts, kind === 'meeting') : undefined;

  // S7 keyphrases (URLs and capture markers left out).
  // A path contributes its file name, not its folders or extension.
  const pathless = paths.length
    ? [...paths].sort((a, b) => b.start - a.start).reduce((s, p) => s.slice(0, p.start) + ' ' + s.slice(p.end), text).split('\n')
    : null;
  const rakeLines = pathless ? [...pathless, ...paths.map((p) => lib.url.baseName(p.path).replace(/\.[a-z0-9]{1,5}$/i, ''))] : lines.map((l) => l.text);
  const rakeSource = [
    ...rakeLines.map((l) => l.replace(MARKER_RE, '')),
    hint.title || '',
    windowTitle.replace(/\.[a-z0-9]{1,5}$/i, ''),
    hint.summary || '',
  ].filter(Boolean).join('. ');
  const rakeText = removeSpans(lib, rakeSource, lib.url.findUrls(rakeSource));
  const keyphrases = lib.text.rake(rakeText, { max: 5, idf: env.idf || (() => 1) }).map((k) => k.phrase);

  return {
    v: EXTRACTOR_VERSION,
    text,
    truncated,
    private: isPrivate,
    kind,
    title,
    titleSource,
    ...(titleFromText ? { titleFromText: true } : {}),
    ...(url ? { url } : {}),
    ...(canonical ? { canonicalUrl: canonical } : {}),
    ...(normPath ? { path: normPath } : {}),
    ...(docKey ? { docKey } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(hint.summary ? { summary: hint.summary } : {}),
    ...(hint.terms ? { terms: hint.terms } : {}),
    mentions,
    candidates,
    aliases,
    keyphrases,
    self,
    actions: keptActions,
    links: keptLinks,
    rejectedActions,
    segments: nonEmpty.length,
    // Action lines past the per-save limit (kept in the text, not made actions).
    droppedActions: actions.length - keptActions.length,
    isDump,
    extra,
    empty: !text && !windowTitle && !url && !path,
  };
}

// What a save would do (the mm+ preview row).
export function previewOf(extraction) {
  const all = [...(extraction.self ? [extraction.self] : []), ...(extraction.actions || [])];
  const dated = all.filter((a) => a.status === 'open' && a.dueAt !== undefined);
  return {
    kind: extraction.kind,
    entityNames: (extraction.mentions || []).map((m) => m.name),
    actionCount: all.length,
    suggestedCount: all.filter((a) => a.suggested).length,
    ...(dated.length ? { nextDue: Math.min(...dated.map((a) => a.dueAt)) } : {}),
    linkCount: (extraction.links || []).length,
    private: Boolean(extraction.private),
    truncated: Boolean(extraction.truncated),
  };
}
