import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MONTHS, WEEKDAYS, addDays, addMonths, parseDue, parseIsoDay, parseRange, resolveWeekStart, startOfDay, startOfMonth,
  startOfQuarter, startOfWeek, startOfYear, toIsoDay, utcMonthKey,
} from './dates.js';

// Fixture clock: Fri 2026-11-06 10:00 local. Built inside tests (never at
// module load) so the TZ-switched suite gets local dates in its own zone.
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = () => at(2026, 11, 6, 10);
const iso = (ms) => toIsoDay(ms);
// "a..b" with b inclusive (the end is exclusive internally).
const days = (r) => r && `${iso(r.start)}..${iso(r.end - 1)}`;
const rangeOf = (text, weekStart = 1, now = NOW()) => parseRange(text, { now, weekStart });
const dueOf = (text, weekStart = 1, now = NOW()) => {
  const d = parseDue(text, { now, weekStart });
  return d && iso(d.at);
};

function suite(label) {
  describe(`${label}: calendar helpers`, () => {
    it('does calendar arithmetic across the DST change', () => {
      const oct31 = at(2026, 10, 31, 10);
      expect(iso(addDays(oct31, 1))).toBe('2026-11-01');
      expect(iso(addDays(oct31, 2))).toBe('2026-11-02');
      expect(new Date(addDays(oct31, 2)).getHours()).toBe(10);
      expect(startOfDay(at(2026, 11, 1, 23, 59))).toBe(at(2026, 11, 1));
      expect(startOfWeek(NOW(), 1)).toBe(at(2026, 11, 2));
      expect(startOfWeek(NOW(), 0)).toBe(at(2026, 11, 1));
      expect(startOfWeek(NOW(), 6)).toBe(at(2026, 10, 31));
      expect(startOfMonth(NOW())).toBe(at(2026, 11, 1));
      expect(startOfQuarter(NOW())).toBe(at(2026, 10, 1));
      expect(startOfYear(NOW())).toBe(at(2026, 1, 1));
      expect(iso(addMonths(at(2026, 1, 31), 1))).toBe('2026-02-28');
      expect(iso(addMonths(at(2026, 11, 6), -12))).toBe('2025-11-06');
    });

    it('ISO days round-trip in local time; shard keys are UTC months', () => {
      expect(iso(NOW())).toBe('2026-11-06');
      expect(parseIsoDay('2026-10-26')).toBe(at(2026, 10, 26));
      expect(parseIsoDay('2026-02-30')).toBeNull();
      expect(parseIsoDay('26-10-2026')).toBeNull();
      expect(parseIsoDay(null)).toBeNull();
      expect(utcMonthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe('2026-10');
      expect(utcMonthKey(Date.UTC(2026, 10, 1, 0, 30))).toBe('2026-11');
    });
  });

  describe(`${label}: parseRange (past-biased)`, () => {
    it('"last week" is the previous calendar week for Monday and Sunday starts', () => {
      const mon = rangeOf('last week', 1);
      expect(mon.start).toBe(at(2026, 10, 26));
      expect(mon.end).toBe(at(2026, 11, 2));
      expect(mon).toMatchObject({ granularity: 'week', code: 'last_week', span: [0, 9] });
      const sun = rangeOf('last week', 0);
      expect(sun.start).toBe(at(2026, 10, 25));
      expect(sun.end).toBe(at(2026, 11, 1));
    });

    const cases = [
      // phrase, weekStart Monday, weekStart Sunday
      ['today', '2026-11-06..2026-11-06', '2026-11-06..2026-11-06'],
      ['yesterday', '2026-11-05..2026-11-05', '2026-11-05..2026-11-05'],
      ['this week', '2026-11-02..2026-11-08', '2026-11-01..2026-11-07'],
      ['next week', '2026-11-09..2026-11-15', '2026-11-08..2026-11-14'],
      ['past 7 days', '2026-10-30..2026-11-06', '2026-10-30..2026-11-06'],
      ['last 7 days', '2026-10-30..2026-11-06', '2026-10-30..2026-11-06'],
      ['past week', '2026-10-30..2026-11-06', '2026-10-30..2026-11-06'],
      ['past 2 weeks', '2026-10-23..2026-11-06', '2026-10-23..2026-11-06'],
      ['earlier this week', '2026-11-02..2026-11-05', '2026-11-01..2026-11-05'],
      ['this month', '2026-11-01..2026-11-30', '2026-11-01..2026-11-30'],
      ['last month', '2026-10-01..2026-10-31', '2026-10-01..2026-10-31'],
      ['this quarter', '2026-10-01..2026-12-31', '2026-10-01..2026-12-31'],
      ['last quarter', '2026-07-01..2026-09-30', '2026-07-01..2026-09-30'],
      ['this year', '2026-01-01..2026-12-31', '2026-01-01..2026-12-31'],
      ['last year', '2025-01-01..2025-12-31', '2025-01-01..2025-12-31'],
      ['last friday', '2026-10-30..2026-10-30', '2026-10-30..2026-10-30'],
      ['last monday', '2026-11-02..2026-11-02', '2026-11-02..2026-11-02'],
      ['on friday', '2026-11-06..2026-11-06', '2026-11-06..2026-11-06'],
      ['tuesday', '2026-11-03..2026-11-03', '2026-11-03..2026-11-03'],
      ['3 days ago', '2026-11-03..2026-11-03', '2026-11-03..2026-11-03'],
      ['two weeks ago', '2026-10-19..2026-10-25', '2026-10-18..2026-10-24'],
      ['since monday', '2026-11-02..2026-11-06', '2026-11-02..2026-11-06'],
      ['since Oct 26', '2026-10-26..2026-11-06', '2026-10-26..2026-11-06'],
      ['in october', '2026-10-01..2026-10-31', '2026-10-01..2026-10-31'],
      ['in december', '2025-12-01..2025-12-31', '2025-12-01..2025-12-31'],
      ['in march 2026', '2026-03-01..2026-03-31', '2026-03-01..2026-03-31'],
      ['Oct 26', '2026-10-26..2026-10-26', '2026-10-26..2026-10-26'],
      ['26 October', '2026-10-26..2026-10-26', '2026-10-26..2026-10-26'],
      ['Mon, Oct 26', '2026-10-26..2026-10-26', '2026-10-26..2026-10-26'],
      ['Dec 25', '2025-12-25..2025-12-25', '2025-12-25..2025-12-25'],
      ['2026-10-26', '2026-10-26..2026-10-26', '2026-10-26..2026-10-26'],
      ['2026-10-26..2026-11-01', '2026-10-26..2026-11-01', '2026-10-26..2026-11-01'],
      ['Q3', '2026-07-01..2026-09-30', '2026-07-01..2026-09-30'],
      ['Q1 2025', '2025-01-01..2025-03-31', '2025-01-01..2025-03-31'],
      ['this weekend', '2026-10-31..2026-11-01', '2026-10-31..2026-11-01'],
      ['last weekend', '2026-10-31..2026-11-01', '2026-10-31..2026-11-01'],
      ['over the weekend', '2026-10-31..2026-11-01', '2026-10-31..2026-11-01'],
    ];
    it.each(cases)('%s', (phrase, mon, sun) => {
      expect(days(rangeOf(phrase, 1)), 'Monday start').toBe(mon);
      expect(days(rangeOf(phrase, 0)), 'Sunday start').toBe(sun);
    });

    it('"in <current month>" and "Q4" are not in the future: they end now', () => {
      const nov = rangeOf('in november');
      expect(nov.start).toBe(at(2026, 11, 1));
      expect(nov.end).toBe(NOW());
      const q4 = rangeOf('Q4');
      expect(q4.start).toBe(at(2026, 10, 1));
      expect(q4.end).toBe(NOW());
      expect(q4.granularity).toBe('quarter');
      expect(days(rangeOf('Q1'))).toBe('2026-01-01..2026-03-31');
    });

    it('since, before and open ISO ranges', () => {
      const since = rangeOf('since yesterday');
      expect(since.start).toBe(at(2026, 11, 5));
      expect(since.end).toBe(NOW());
      const before = rangeOf('before Oct 26');
      expect(before.start).toBe(0);
      expect(before.end).toBe(at(2026, 10, 26));
      expect(rangeOf('..2026-10-25').end).toBe(at(2026, 10, 26));
      expect(rangeOf('2026-10-01..').start).toBe(at(2026, 10, 1));
    });

    it('YYYY-MM-DD..YYYY-MM-DD is inclusive of both days', () => {
      const r = rangeOf('2026-10-26..2026-11-01');
      expect(r.start).toBe(at(2026, 10, 26));
      expect(r.end).toBe(at(2026, 11, 2));
    });

    it('a weekday on that weekday is today; "last <weekday>" is strictly before today', () => {
      expect(days(rangeOf('friday'))).toBe('2026-11-06..2026-11-06');
      expect(days(rangeOf('last friday'))).toBe('2026-10-30..2026-10-30');
    });

    it('"recently" is not a range, and unknown text is null', () => {
      expect(rangeOf('recently')).toBeNull();
      expect(rangeOf('mtcs design review')).toBeNull();
      expect(rangeOf('')).toBeNull();
      expect(rangeOf('I sat down in the sun')).toBeNull();
      expect(rangeOf('may I ask')).toBeNull();
    });

    it('finds the first expression and its span removes the phrase cleanly', () => {
      const q = 'remind me which doc spoke about mtcs last week';
      const r = rangeOf(q);
      expect(r.code).toBe('last_week');
      expect(q.slice(0, r.span[0]) + q.slice(r.span[1])).toBe('remind me which doc spoke about mtcs ');
      const q2 = "notes from yesterday's sync";
      const r2 = rangeOf(q2);
      expect((q2.slice(0, r2.span[0]) + q2.slice(r2.span[1])).replace(/\s+/g, ' ').trim()).toBe('notes from sync');
      const q3 = 'docs since monday about bingo';
      const r3 = rangeOf(q3);
      expect(q3.slice(r3.span[0], r3.span[1])).toBe('since monday');
    });

    it('requires `now`', () => {
      expect(() => parseRange('today', {})).toThrow(TypeError);
    });
  });

  describe(`${label}: parseDue (future-biased)`, () => {
    const cases = [
      // phrase, weekStart Monday, weekStart Sunday
      ['by friday', '2026-11-13', '2026-11-13'],
      ['friday', '2026-11-13', '2026-11-13'],
      ['on monday', '2026-11-09', '2026-11-09'],
      ['due tuesday', '2026-11-10', '2026-11-10'],
      ['this friday', '2026-11-06', '2026-11-06'],
      ['next friday', '2026-11-13', '2026-11-13'],
      ['next monday', '2026-11-09', '2026-11-09'],
      ['today', '2026-11-06', '2026-11-06'],
      ['tonight', '2026-11-06', '2026-11-06'],
      ['by EOD', '2026-11-06', '2026-11-06'],
      ['end of day', '2026-11-06', '2026-11-06'],
      ['COB', '2026-11-06', '2026-11-06'],
      ['tomorrow', '2026-11-07', '2026-11-07'],
      ['EOW', '2026-11-06', '2026-11-06'],
      ['end of the week', '2026-11-06', '2026-11-06'],
      ['next week', '2026-11-09', '2026-11-08'],
      ['end of month', '2026-11-30', '2026-11-30'],
      ['in 3 days', '2026-11-09', '2026-11-09'],
      ['in two weeks', '2026-11-20', '2026-11-20'],
      ['Nov 20', '2026-11-20', '2026-11-20'],
      ['20 November', '2026-11-20', '2026-11-20'],
      ['Oct 1', '2027-10-01', '2027-10-01'],
      ['Nov 6', '2026-11-06', '2026-11-06'],
      ['2026-12-01', '2026-12-01', '2026-12-01'],
      ['no later than Dec 3', '2026-12-03', '2026-12-03'],
      ['until thursday', '2026-11-12', '2026-11-12'],
      ['before 2026-11-30', '2026-11-30', '2026-11-30'],
    ];
    it.each(cases)('%s', (phrase, mon, sun) => {
      expect(dueOf(phrase, 1), 'Monday start').toBe(mon);
      expect(dueOf(phrase, 0), 'Sunday start').toBe(sun);
    });

    it('"Friday" said on a Friday means next Friday (AT-3)', () => {
      const fri = at(2026, 10, 30, 16);
      const d = parseDue('Send MTCS numbers to Dana by Friday', { now: fri, weekStart: 1 });
      expect(d.at).toBe(at(2026, 11, 6));
      expect(d.span).toEqual([26, 35]);
      expect(d.at).toBe(startOfDay(d.at));
    });

    it('EOW on a weekend is next Friday', () => {
      expect(dueOf('EOW', 1, at(2026, 11, 7, 9))).toBe('2026-11-13');
      expect(dueOf('end of week', 1, at(2026, 11, 8, 9))).toBe('2026-11-13');
      expect(dueOf('eow', 1, at(2026, 11, 2, 9))).toBe('2026-11-06');
    });

    it('never parses numeric m/d and ignores text without a due phrase', () => {
      expect(parseDue('call Bob 11/12', { now: NOW(), weekStart: 1 })).toBeNull();
      expect(parseDue('email the bingo team about the demo date', { now: NOW(), weekStart: 1 })).toBeNull();
      expect(parseDue('by the way', { now: NOW(), weekStart: 1 })).toBeNull();
    });

    it('a due phrase span covers its preposition', () => {
      const s = 'prep slides for tomorrow please';
      const d = parseDue(s, { now: NOW(), weekStart: 1 });
      expect(s.slice(d.span[0], d.span[1])).toBe('for tomorrow');
    });
  });
}

describe('resolveWeekStart', () => {
  it('maps the setting and falls back to the locale, then Monday', () => {
    expect(resolveWeekStart('mon', 'en')).toBe(1);
    expect(resolveWeekStart('sun', 'en')).toBe(0);
    expect(resolveWeekStart('sat', 'en')).toBe(6);
    expect(resolveWeekStart('auto', 'en-GB')).toBe(1);
    expect(resolveWeekStart('auto', 'de')).toBe(1);
    expect(resolveWeekStart('auto', '!!not a locale!!')).toBe(1);
    expect([0, 1, 6]).toContain(resolveWeekStart('auto', 'en-US'));
  });

  it('exports the English lexicons', () => {
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[9][0]).toBe('october');
    expect(WEEKDAYS[5][0]).toBe('friday');
  });
});

suite('local zone');

describe('America/New_York (DST ends Sun 2026-11-01)', () => {
  let saved;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it('runs in the switched zone', () => {
    expect(new Date(2026, 9, 26).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 10, 2).getTimezoneOffset()).toBe(300);
  });

  it('"last week" spans 7 calendar days (7 × 24 h + 1 h)', () => {
    const r = rangeOf('last week');
    expect(r.start).toBe(at(2026, 10, 26));
    expect(r.end).toBe(at(2026, 11, 2));
    expect(r.end - r.start).toBe(7 * 86_400_000 + 3_600_000);
  });

  suite('America/New_York');
});
