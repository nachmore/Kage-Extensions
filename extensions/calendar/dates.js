/**
 * Day labels + host date-picker affordances, shared by the search provider
 * (search.js) and the next-meeting bar (widget.js).
 *
 * Newer Kage hosts offer a month-calendar popup to calendar-capable
 * extensions: wrap a date label in `<button data-kage-date="YYYY-MM-DD">`
 * and the host turns it into an opener (styling, aria, click handling — the
 * popup itself is host UI). Hosts that don't offer it leave
 * `context.hostFeatures` undefined; then we emit plain text, exactly as
 * before, so the extension keeps working on older hosts.
 */

export const DATE_PICKER_FEATURE = 'date-picker';

/** True when this host renders `data-kage-date` buttons as date-picker openers. */
export function supportsDatePicker(context) {
    return Array.isArray(context?.hostFeatures) && context.hostFeatures.includes(DATE_PICKER_FEATURE);
}

/** `YYYY-MM-DD` of a Date in LOCAL time (toISOString() is UTC — off by a day near midnight). */
export function localIsoDate(d) {
    const y = String(d.getFullYear()).padStart(4, '0');
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Strict `YYYY-MM-DD` that is also a real calendar date. */
export function isIsoDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Local-noon Date for an ISO day (noon dodges DST-gap midnights). */
export function isoToLocalDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
}

/** Whole calendar days from `now`'s date to `date`'s date (local, DST-safe). */
export function dayDiff(date, now) {
    const a = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    return Math.round((a - b) / 86_400_000);
}

/**
 * Human label for the day `date` falls on, relative to `now`:
 *   today → null (or "Today" with `includeToday`), ±1 → Tomorrow/Yesterday,
 *   the next 6 days → weekday name, anything else → a short date
 *   ("Thu, Nov 26"; with the year when it isn't this year).
 * Browsing arbitrary days through the date picker makes a bare weekday
 * ambiguous, hence the date for everything past the coming week.
 */
export function dayLabel(t, date, now, { locale, includeToday = false } = {}) {
    const diff = dayDiff(date, now);
    if (diff === 0) return includeToday ? t('day.today') : null;
    if (diff === 1) return t('day.tomorrow');
    if (diff === -1) return t('day.yesterday');
    if (diff > 1 && diff < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString(locale, opts);
}

/**
 * `labelHtml` (ALREADY ESCAPED) as a host date-picker opener for `iso`, or
 * unchanged when the host doesn't offer the picker.
 */
export function dateChip(enabled, iso, labelHtml) {
    if (!enabled || !isIsoDate(iso)) return labelHtml;
    return `<button type="button" data-kage-date="${iso}">${labelHtml}</button>`;
}
