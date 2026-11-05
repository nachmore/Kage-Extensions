/**
 * Day labels + host date-picker affordances (dates.js).
 */

import { describe, it, expect } from 'vitest';
import {
    dateChip,
    dayDiff,
    dayLabel,
    isIsoDate,
    localIsoDate,
    supportsDatePicker,
} from './dates.js';

const t = (k) => ({ 'day.today': 'Today', 'day.tomorrow': 'Tomorrow', 'day.yesterday': 'Yesterday' })[k] || k;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

describe('supportsDatePicker', () => {
    it('is false on older hosts (no hostFeatures)', () => {
        expect(supportsDatePicker({})).toBe(false);
        expect(supportsDatePicker(undefined)).toBe(false);
        expect(supportsDatePicker({ hostFeatures: [] })).toBe(false);
    });

    it("is true when the host offers 'date-picker'", () => {
        expect(supportsDatePicker({ hostFeatures: ['date-picker'] })).toBe(true);
    });
});

describe('localIsoDate / isIsoDate', () => {
    it('formats in local time, not UTC', () => {
        // 23:30 local is still the same local day whatever the offset.
        expect(localIsoDate(at(2026, 11, 5, 23))).toBe('2026-11-05');
        expect(localIsoDate(at(2026, 1, 1, 0))).toBe('2026-01-01');
    });

    it('accepts only real calendar dates', () => {
        expect(isIsoDate('2028-02-29')).toBe(true);
        expect(isIsoDate('2027-02-29')).toBe(false);
        expect(isIsoDate('2026-13-01')).toBe(false);
        expect(isIsoDate('2026-1-01')).toBe(false);
        expect(isIsoDate('2026-01-01"><img src=x>')).toBe(false);
        expect(isIsoDate(null)).toBe(false);
    });
});

describe('dayDiff', () => {
    it('counts calendar days regardless of the time of day', () => {
        expect(dayDiff(at(2026, 11, 6, 0), at(2026, 11, 5, 23))).toBe(1);
        expect(dayDiff(at(2026, 11, 5, 1), at(2026, 11, 5, 23))).toBe(0);
        expect(dayDiff(at(2026, 11, 4, 23), at(2026, 11, 5, 0))).toBe(-1);
    });

    it('is not thrown off by a DST change in between', () => {
        // Spans the US/EU March and October/November shifts.
        expect(dayDiff(at(2026, 3, 30), at(2026, 3, 27))).toBe(3);
        expect(dayDiff(at(2026, 11, 2), at(2026, 10, 30))).toBe(3);
    });
});

describe('dayLabel', () => {
    const now = at(2026, 11, 4, 9); // a Wednesday

    it('says nothing for today unless asked', () => {
        expect(dayLabel(t, at(2026, 11, 4, 15), now)).toBeNull();
        expect(dayLabel(t, at(2026, 11, 4, 15), now, { includeToday: true })).toBe('Today');
    });

    it('names tomorrow and yesterday', () => {
        expect(dayLabel(t, at(2026, 11, 5), now)).toBe('Tomorrow');
        expect(dayLabel(t, at(2026, 11, 3), now)).toBe('Yesterday');
    });

    it('uses the weekday within the coming week', () => {
        expect(dayLabel(t, at(2026, 11, 6), now, { locale: 'en-US' })).toBe('Friday');
        expect(dayLabel(t, at(2026, 11, 10), now, { locale: 'en-US' })).toBe('Tuesday');
    });

    it('uses a short date beyond that (and in the past), with the year only when it differs', () => {
        expect(dayLabel(t, at(2026, 11, 26), now, { locale: 'en-US' })).toBe('Thu, Nov 26');
        expect(dayLabel(t, at(2026, 10, 20), now, { locale: 'en-US' })).toBe('Tue, Oct 20');
        expect(dayLabel(t, at(2027, 1, 7), now, { locale: 'en-US' })).toBe('Thu, Jan 7, 2027');
    });

    it('dates are Gregorian even where the locale defaults to another calendar', () => {
        // fa defaults to the Persian calendar (Nov 26 2026 = 5 Azar 1405);
        // the host picker these labels open is Gregorian.
        const fa = dayLabel(t, at(2026, 11, 26), now, { locale: 'fa' });
        const gregorian = at(2026, 11, 26).toLocaleDateString('fa', {
            calendar: 'gregory',
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });
        expect(fa).toBe(gregorian);
        expect(fa).toContain('۲۶');
    });
});

describe('dateChip', () => {
    it('wraps the label in a host date opener when supported', () => {
        expect(dateChip(true, '2026-11-26', '[Thu]')).toBe(
            '<button type="button" data-kage-date="2026-11-26">[Thu]</button>'
        );
    });

    it('leaves plain text on older hosts', () => {
        expect(dateChip(false, '2026-11-26', '[Thu]')).toBe('[Thu]');
    });

    it('never emits an attribute from a malformed date', () => {
        expect(dateChip(true, '2026-11-26" onclick="x', 'x')).toBe('x');
    });
});
