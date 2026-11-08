// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Local-time calendar arithmetic and the English temporal grammar (SPEC §8.3).
// Days are always computed with Date's calendar fields, never +86400000, so
// DST changes don't shift day boundaries. Time comes in as `now`.

export const MONTHS = Object.freeze([
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'], ['june', 'jun'],
  ['july', 'jul'], ['august', 'aug'], ['september', 'sep', 'sept'], ['october', 'oct'], ['november', 'nov'],
  ['december', 'dec'],
]);
// Indexed by Date#getDay() (0 = Sunday).
export const WEEKDAYS = Object.freeze([
  ['sunday'], ['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'], ['thursday', 'thu', 'thur', 'thurs'],
  ['friday', 'fri'], ['saturday'],
]);
export const NUMBER_WORDS = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
});
const WEEK_START_SETTINGS = Object.freeze({ sun: 0, mon: 1, sat: 6 });

const byLength = (a, b) => b.length - a.length || (a < b ? -1 : 1);
const MONTH_ALT = MONTHS.flat().sort(byLength).join('|');
const WEEKDAY_ALT = WEEKDAYS.flat().sort(byLength).join('|');
const MONTH_INDEX = new Map(MONTHS.flatMap((names, i) => names.map((n) => [n, i])));
const WEEKDAY_INDEX = new Map(WEEKDAYS.flatMap((names, i) => names.map((n) => [n, i])));
const NUM = '(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few)';
const POSS = "(?:['\\u2019]s)?";
const WD = `(${WEEKDAY_ALT})\\.?`;
const MON = `(${MONTH_ALT})\\.?`;
const ORD = '(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s+(\\d{4}))?';

// ---------------------------------------------------------------- calendar

export function resolveWeekStart(setting, language) {
  if (typeof setting === 'number' && Number.isInteger(setting) && setting >= 0 && setting <= 6) return setting;
  if (Object.hasOwn(WEEK_START_SETTINGS, setting)) return WEEK_START_SETTINGS[setting];
  try {
    const locale = new Intl.Locale(language || 'en');
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    const first = info?.firstDay;
    if (Number.isInteger(first) && first >= 1 && first <= 7) return first % 7;
  } catch {
    // Unknown locale or no week data: fall through to Monday.
  }
  return 1;
}

export function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function addDays(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
}

export function startOfWeek(ms, weekStart = 1) {
  const day = startOfDay(ms);
  const diff = (new Date(day).getDay() - weekStart + 7) % 7;
  return addDays(day, -diff);
}

export function startOfMonth(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

export function addMonths(ms, n) {
  const d = new Date(ms);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const day = Math.min(d.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(target.getFullYear(), target.getMonth(), day, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
}

export function startOfQuarter(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % 3), 1).getTime();
}

export function startOfYear(ms) {
  return new Date(new Date(ms).getFullYear(), 0, 1).getTime();
}

const pad = (n, len = 2) => String(n).padStart(len, '0');

export function toIsoDay(ms) {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDay(year, month, day) {
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return d.getTime();
}

export function parseIsoDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return localDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function utcMonthKey(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}`;
}

// ---------------------------------------------------------------- helpers

function numberOf(word) {
  const w = String(word).toLowerCase().replace(/\s+of$/, '').replace(/^a\s+/, '').trim();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

function context(opts) {
  const now = Number(opts?.now);
  if (!Number.isFinite(now)) throw new TypeError('dates: `now` (ms) is required');
  const weekStart = Number.isInteger(opts?.weekStart) ? opts.weekStart : 1;
  const today = startOfDay(now);
  return { now, weekStart, today, dow: new Date(today).getDay(), week: startOfWeek(now, weekStart) };
}

const range = (start, end, granularity, code, extra) => ({ start, end, granularity, code, ...extra });
const dayRange = (start, code) => range(start, addDays(start, 1), 'day', code);

function monthDay(monthWord, dayWord, yearWord) {
  const month = MONTH_INDEX.get(String(monthWord).toLowerCase());
  const day = Number(dayWord);
  if (month === undefined || !(day >= 1 && day <= 31)) return null;
  return { month, day, year: yearWord ? Number(yearWord) : null };
}

// Earliest match wins; at the same start, the longest.
function findFirst(text, rules, ctx) {
  let best = null;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const r = rule.fn(m, ctx, text);
      if (!r) continue;
      const i = m.index;
      const j = m.index + (r.len ?? m[0].length);
      if (!best || i < best.span[0] || (i === best.span[0] && j > best.span[1])) {
        const { len, ...rest } = r;
        best = { ...rest, span: [i, j] };
      }
      break;
    }
  }
  return best;
}

// Parse a nested expression that must start right at `offset` (after "since ").
function anchored(text, offset, rules, ctx) {
  const tail = text.slice(offset);
  const found = findFirst(tail, rules, ctx);
  return found && found.span[0] === 0 ? found : null;
}

// ---------------------------------------------------------------- ranges

function pastDate(md, ctx) {
  if (md.year) return localDay(md.year, md.month, md.day);
  const year = new Date(ctx.today).getFullYear();
  const thisYear = localDay(year, md.month, md.day);
  if (thisYear !== null && thisYear <= ctx.today) return thisYear;
  return localDay(year - 1, md.month, md.day);
}

function weekend(ctx, previous) {
  let sat;
  if (ctx.dow === 6) sat = ctx.today;
  else if (ctx.dow === 0) sat = addDays(ctx.today, -1);
  else sat = addDays(ctx.today, -((ctx.dow + 1) % 7));
  if (previous && (ctx.dow === 6 || ctx.dow === 0)) sat = addDays(sat, -7);
  return range(sat, addDays(sat, 2), 'span', 'weekend');
}

function clipNow(r, ctx) {
  return r.end > ctx.now && r.start <= ctx.now ? { ...r, end: ctx.now } : r;
}

function rolling(n, unit, ctx) {
  if (!(n >= 1)) return null;
  let start;
  if (unit.startsWith('day')) start = startOfDay(addDays(ctx.now, -n));
  else if (unit.startsWith('week')) start = startOfDay(addDays(ctx.now, -7 * n));
  else if (unit.startsWith('month')) start = startOfDay(addMonths(ctx.now, -n));
  else start = startOfDay(addMonths(ctx.now, -12 * n));
  return range(start, ctx.now, 'span', 'past_' + unit.replace(/s$/, '') + 's', { n });
}

function period(which, unit, ctx) {
  const shift = which === 'last' || which === 'previous' ? -1 : which === 'next' ? 1 : 0;
  const code = `${shift < 0 ? 'last' : shift > 0 ? 'next' : 'this'}_${unit}`;
  if (unit === 'week') {
    const start = addDays(ctx.week, 7 * shift);
    return range(start, addDays(start, 7), 'week', code);
  }
  if (unit === 'month') {
    const start = addMonths(startOfMonth(ctx.now), shift);
    return range(start, addMonths(start, 1), 'month', code);
  }
  if (unit === 'quarter') {
    const start = addMonths(startOfQuarter(ctx.now), 3 * shift);
    return range(start, addMonths(start, 3), 'quarter', code);
  }
  const start = addMonths(startOfYear(ctx.now), 12 * shift);
  return range(start, addMonths(start, 12), 'year', code);
}

const BASE_RANGE_RULES = [
  { re: /\b(?:today|tonight|this\s+(?:morning|afternoon|evening))(?:['’]s)?\b/gi, fn: (m, ctx) => dayRange(ctx.today, 'today') },
  { re: /\b(?:yesterday|last\s+night)(?:['’]s)?\b/gi, fn: (m, ctx) => dayRange(addDays(ctx.today, -1), 'yesterday') },
  { re: /\bearlier\s+this\s+week\b/gi, fn: (m, ctx) => range(ctx.week, ctx.today, 'span', 'earlier_this_week') },
  {
    re: new RegExp(`\\b(?:in\\s+|over\\s+|during\\s+)?(?:the\\s+)?(?:past|last|previous)\\s+${NUM}\\s+(days?|weeks?|months?|years?)\\b`, 'gi'),
    fn: (m, ctx) => rolling(numberOf(m[1]), m[2].toLowerCase(), ctx),
  },
  { re: /\b(?:in\s+|over\s+|during\s+)?the\s+(?:past|last)\s+(day|week|month|year)\b/gi, fn: (m, ctx) => rolling(1, m[1].toLowerCase(), ctx) },
  { re: /\b(?:in\s+|over\s+|during\s+)?(?:this\s+)?past\s+(day|week|month|year)\b/gi, fn: (m, ctx) => rolling(1, m[1].toLowerCase(), ctx) },
  {
    re: new RegExp(`\\b(this|last|previous|next|the\\s+current)\\s+(week|month|quarter|year)${POSS}\\b`, 'gi'),
    fn: (m, ctx) => period(m[1].toLowerCase().replace(/^the\s+current$/, 'this'), m[2].toLowerCase(), ctx),
  },
  {
    re: /\b(?:(this|last)\s+weekend|over\s+the\s+weekend|the\s+weekend)\b/gi,
    fn: (m, ctx) => weekend(ctx, (m[1] || '').toLowerCase() === 'last'),
  },
  {
    re: new RegExp(`\\b${NUM}\\s+(days?|weeks?|months?)\\s+ago\\b`, 'gi'),
    fn: (m, ctx) => {
      const n = numberOf(m[1]);
      if (!(n >= 1)) return null;
      const unit = m[2].toLowerCase();
      if (unit.startsWith('day')) return dayRange(addDays(ctx.today, -n), 'days_ago');
      if (unit.startsWith('week')) {
        const start = addDays(ctx.week, -7 * n);
        return range(start, addDays(start, 7), 'week', 'weeks_ago', { n });
      }
      const start = addMonths(startOfMonth(ctx.now), -n);
      return range(start, addMonths(start, 1), 'month', 'months_ago', { n });
    },
  },
  {
    re: new RegExp(`\\blast\\s+${WD}(?:['\\u2019]s)?\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      const diff = ((ctx.dow - wd + 7) % 7) || 7;
      return dayRange(addDays(ctx.today, -diff), 'last_weekday');
    },
  },
  {
    re: new RegExp(`\\bthis\\s+${WD}(?:['\\u2019]s)?\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      return dayRange(addDays(ctx.week, (wd - ctx.weekStart + 7) % 7), 'this_weekday');
    },
  },
  {
    re: new RegExp(`\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?${MON}\\s+(\\d{1,2})${ORD}${YEAR}\\b`, 'gi'),
    fn: (m, ctx) => {
      const md = monthDay(m[2], m[3], m[4]);
      const at = md && pastDate(md, ctx);
      return at === null || at === undefined ? null : dayRange(at, 'date');
    },
  },
  {
    re: new RegExp(`\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MON}${YEAR}\\b`, 'gi'),
    fn: (m, ctx) => {
      const md = monthDay(m[3], m[2], m[4]);
      const at = md && pastDate(md, ctx);
      return at === null || at === undefined ? null : dayRange(at, 'date');
    },
  },
  {
    re: /\b(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})\b/g,
    fn: (m) => {
      let a = parseIsoDay(m[1]);
      let b = parseIsoDay(m[2]);
      if (a === null || b === null) return null;
      if (b < a) [a, b] = [b, a];
      return range(a, addDays(b, 1), 'span', 'iso_range');
    },
  },
  { re: /(?<![\w.])\.\.(\d{4}-\d{2}-\d{2})\b/g, fn: (m) => { const b = parseIsoDay(m[1]); return b === null ? null : range(0, addDays(b, 1), 'span', 'before'); } },
  { re: /\b(\d{4}-\d{2}-\d{2})\.\.(?![\w.])/g, fn: (m, ctx) => { const a = parseIsoDay(m[1]); return a === null ? null : range(a, ctx.now, 'span', 'since'); } },
  { re: /\b(\d{4}-\d{2}-\d{2})\b/g, fn: (m) => { const a = parseIsoDay(m[1]); return a === null ? null : dayRange(a, 'date'); } },
  {
    re: new RegExp(`\\b(?:in|during|for)\\s+${MON}(?:\\s+(\\d{4}))?\\b`, 'gi'),
    fn: (m, ctx) => {
      const month = MONTH_INDEX.get(m[1].toLowerCase());
      const now = new Date(ctx.now);
      let year = m[2] ? Number(m[2]) : now.getFullYear();
      if (!m[2] && month > now.getMonth()) year -= 1;
      const start = localDay(year, month, 1);
      return clipNow(range(start, addMonths(start, 1), 'month', 'month'), ctx);
    },
  },
  {
    re: new RegExp(`\\b${MON}\\s+(\\d{4})\\b`, 'gi'),
    fn: (m, ctx) => {
      const start = localDay(Number(m[2]), MONTH_INDEX.get(m[1].toLowerCase()), 1);
      return clipNow(range(start, addMonths(start, 1), 'month', 'month'), ctx);
    },
  },
  {
    re: new RegExp(`\\blast\\s+${MON}\\b`, 'gi'),
    fn: (m, ctx) => {
      const month = MONTH_INDEX.get(m[1].toLowerCase());
      const now = new Date(ctx.now);
      const year = month >= now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
      const start = localDay(year, month, 1);
      return range(start, addMonths(start, 1), 'month', 'month');
    },
  },
  {
    re: /\bq([1-4])(?:\s+(\d{4}))?\b/gi,
    fn: (m, ctx) => {
      const q = Number(m[1]) - 1;
      const now = new Date(ctx.now);
      let year = m[2] ? Number(m[2]) : now.getFullYear();
      let start = localDay(year, q * 3, 1);
      if (!m[2] && start > ctx.now) start = localDay((year -= 1), q * 3, 1);
      return clipNow(range(start, addMonths(start, 3), 'quarter', 'quarter'), ctx);
    },
  },
  {
    re: new RegExp(`\\b(?:on\\s+)?${WD}(?:['\\u2019]s)?\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      return dayRange(addDays(ctx.today, -((ctx.dow - wd + 7) % 7)), 'weekday');
    },
  },
];

const RANGE_RULES = [
  ...BASE_RANGE_RULES,
  {
    re: /\b(since|before|after)\s+/gi,
    fn: (m, ctx, text) => {
      const inner = anchored(text, m.index + m[0].length, BASE_RANGE_RULES, ctx);
      if (!inner) return null;
      const len = m[0].length + inner.span[1];
      const word = m[1].toLowerCase();
      if (word === 'since') return range(inner.start, ctx.now, 'span', 'since', { len });
      if (word === 'after') return range(inner.end, ctx.now, 'span', 'after', { len });
      return range(0, inner.start, 'span', 'before', { len });
    },
  },
];

// First temporal expression in `text` (past-biased), or null.
// → { start, end (exclusive), granularity, span: [i, j], code }
export function parseRange(text, opts) {
  const ctx = context(opts);
  const str = String(text ?? '');
  if (!str.trim()) return null;
  return findFirst(str, RANGE_RULES, ctx);
}

// ---------------------------------------------------------------- due dates

function futureDate(md, ctx) {
  if (md.year) return localDay(md.year, md.month, md.day);
  const year = new Date(ctx.today).getFullYear();
  const thisYear = localDay(year, md.month, md.day);
  if (thisYear !== null && thisYear >= ctx.today) return thisYear;
  return localDay(year + 1, md.month, md.day);
}

const due = (at, code) => (at === null || at === undefined ? null : { at, code });

const BASE_DUE_RULES = [
  { re: /\b(?:today|tonight|eod|end\s+of\s+(?:the\s+)?day|cob|close\s+of\s+business)\b/gi, fn: (m, ctx) => due(ctx.today, 'today') },
  { re: /\b(?:tomorrow|tmrw|tmr)\b/gi, fn: (m, ctx) => due(addDays(ctx.today, 1), 'tomorrow') },
  {
    re: /\b(?:eow|end\s+of\s+(?:the\s+)?week)\b/gi,
    fn: (m, ctx) => {
      const delta = ctx.dow === 6 ? 6 : ctx.dow === 0 ? 5 : 5 - ctx.dow;
      return due(addDays(ctx.today, delta), 'eow');
    },
  },
  {
    re: /\b(?:eom|end\s+of\s+(?:the\s+)?month)\b/gi,
    fn: (m, ctx) => {
      const d = new Date(ctx.today);
      return due(localDay(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth())), 'eom');
    },
  },
  {
    re: new RegExp(`\\bnext\\s+${WD}\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      return due(addDays(ctx.week, 7 + ((wd - ctx.weekStart + 7) % 7)), 'next_weekday');
    },
  },
  { re: /\bnext\s+week\b/gi, fn: (m, ctx) => due(addDays(ctx.week, 7), 'next_week') },
  { re: /\bnext\s+month\b/gi, fn: (m, ctx) => due(addMonths(startOfMonth(ctx.now), 1), 'next_month') },
  {
    re: new RegExp(`\\bthis\\s+${WD}\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      let at = addDays(ctx.week, (wd - ctx.weekStart + 7) % 7);
      if (at < ctx.today) at = addDays(at, 7);
      return due(at, 'this_weekday');
    },
  },
  {
    re: new RegExp(`\\bin\\s+${NUM}\\s+(days?|weeks?|months?)\\b`, 'gi'),
    fn: (m, ctx) => {
      const n = numberOf(m[1]);
      if (!(n >= 1)) return null;
      const unit = m[2].toLowerCase();
      if (unit.startsWith('day')) return due(addDays(ctx.today, n), 'in_days');
      if (unit.startsWith('week')) return due(addDays(ctx.today, 7 * n), 'in_weeks');
      return due(startOfDay(addMonths(ctx.today, n)), 'in_months');
    },
  },
  {
    re: new RegExp(`\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?${MON}\\s+(\\d{1,2})${ORD}${YEAR}\\b`, 'gi'),
    fn: (m, ctx) => { const md = monthDay(m[2], m[3], m[4]); return md && due(futureDate(md, ctx), 'date'); },
  },
  {
    re: new RegExp(`\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MON}${YEAR}\\b`, 'gi'),
    fn: (m, ctx) => { const md = monthDay(m[3], m[2], m[4]); return md && due(futureDate(md, ctx), 'date'); },
  },
  { re: /\b(\d{4}-\d{2}-\d{2})\b/g, fn: (m) => due(parseIsoDay(m[1]), 'date') },
  {
    // "pay rent on the 1st": the next such day of the month, today included.
    re: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi,
    fn: (m, ctx) => {
      const day = Number(m[1]);
      if (!(day >= 1 && day <= 31)) return null;
      const d = new Date(ctx.today);
      for (let k = 0; k < 13; k++) {
        const month = d.getMonth() + k;
        const at = localDay(d.getFullYear() + Math.floor(month / 12), month % 12, day);
        if (at !== null && at >= ctx.today) return due(at, 'month_day');
      }
      return null;
    },
  },
  {
    re: new RegExp(`\\b${WD}(?:['\\u2019]s)?\\b`, 'gi'),
    fn: (m, ctx) => {
      const wd = WEEKDAY_INDEX.get(m[1].toLowerCase());
      return due(addDays(ctx.today, ((wd - ctx.dow + 7) % 7) || 7), 'weekday');
    },
  },
];

const DUE_RULES = [
  ...BASE_DUE_RULES,
  {
    re: /\b(?:by|before|due(?:\s+(?:by|on|before))?|until|till|no\s+later\s+than|on|for)\s+/gi,
    fn: (m, ctx, text) => {
      const inner = anchored(text, m.index + m[0].length, BASE_DUE_RULES, ctx);
      return inner ? { at: inner.at, code: inner.code, len: m[0].length + inner.span[1] } : null;
    },
  },
];

// First due phrase in `text` (future-biased): { at (local start of day), span, code } | null.
export function parseDue(text, opts) {
  const ctx = context(opts);
  const str = String(text ?? '');
  if (!str.trim()) return null;
  return findFirst(str, DUE_RULES, ctx);
}
