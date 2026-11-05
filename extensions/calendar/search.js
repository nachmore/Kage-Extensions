import { initCache, getEvents } from './cache.js';
import {
    dateChip,
    dayLabel,
    isIsoDate,
    isoToLocalDate,
    localIsoDate,
    supportsDatePicker,
} from './dates.js';

/**
 * Calendar search provider.
 * Runs in the sandbox. Overlay logic lives in widget.js now.
 *
 * On hosts that offer the month-calendar date picker
 * (`context.hostFeatures` includes 'date-picker') it is also the picker's
 * data source: getDateMarkers() answers which days are busy, and
 * onDateSelected() routes a picked day to `cal <date>` — so the day's
 * meetings render through this provider's normal result rows.
 */
export default class CalendarSearchProvider {
    async initialize(context) {
        this._invoke = context.invoke;
        this.log = context.log;
        initCache(context.invoke);
        this._config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        this._locale = context.i18n?.language?.() || undefined;
        // Date labels become host date-picker openers only where the host
        // supports them; older hosts get the plain text they always did.
        this._datePicker = supportsDatePicker(context);
    }

    async onConfigUpdate(config) {
        this._config = config || {};
    }

    destroy() {}

    match(_query) { return []; }

    /**
     * Register trigger words with the host. This is the COMPLETE, authoritative
     * trigger set: the host both (a) shows completion hints for incomplete
     * prefixes (e.g. "cal-ref" → cal-refresh) and (b) gates match()/matchAsync()
     * on it — the extension is only invoked once one of these keywords is
     * committed (exact, or keyword + space). Any trigger matchAsync() answers
     * MUST appear here, or it becomes unreachable. Labels are i18n KEYS,
     * resolved host-side against this extension's catalog.
     */
    getKeywords() {
        // i18n-keys: keyword.calendar.label, keyword.calendar.description, keyword.meetings.label, keyword.meetings.description, keyword.refresh.label, keyword.refresh.description
        return [
            { keyword: 'cal', labelKey: 'keyword.calendar.label', descriptionKey: 'keyword.calendar.description', icon: '📅', acceptsArgs: true },
            { keyword: 'calendar', labelKey: 'keyword.calendar.label', descriptionKey: 'keyword.calendar.description', icon: '📅', acceptsArgs: true },
            { keyword: 'meetings', labelKey: 'keyword.meetings.label', descriptionKey: 'keyword.meetings.description', icon: '📅', acceptsArgs: true },
            { keyword: 'cal-refresh', labelKey: 'keyword.refresh.label', descriptionKey: 'keyword.refresh.description', icon: '🔄', acceptsArgs: false },
        ];
    }

    async matchAsync(query) {
        const q = query.toLowerCase().trim();
        // Longest-first. Regex alternation (used for the strip below) is
        // order-sensitive, not longest-match: with 'cal' first, the input
        // 'calendar' strips to 'endar' and lands in the free-text filter as
        // a bogus search term. Keep this list and the strip regex aligned.
        const triggers = ['calendar', 'meetings', 'cal'];
        const isCalQuery = triggers.some(t => q === t || q.startsWith(t + ' '));
        const isRefresh = q === 'cal-refresh';
        if (!isCalQuery && !isRefresh) return [];

        if (isRefresh) {
            return [{
                id: 'cal:refresh',
                type: 'calendar_refresh',
                label: this.t('result.refresh.label'),
                description: this.t('result.refresh.description'),
                icon: '🔄',
                score: 90,
                data: { action: 'refresh' },
            }];
        }

        const dateArg = q.replace(/^(calendar|meetings|cal)\s*/i, '').trim();
        if (dateArg) {
            const resolved = this._resolveDate(dateArg);
            if (resolved) return this._fetchEventsForDate(resolved);

            const events = await this._fetchEvents();
            const filtered = events.filter(e => {
                const haystack = [e.subject, e.location, e.organizer].filter(Boolean).join(' ').toLowerCase();
                return haystack.includes(dateArg.toLowerCase());
            });
            if (filtered.length === 0) {
                return [{
                    id: 'cal:no-match',
                    type: 'calendar_event',
                    label: this.t('result.no_match.label', { query: dateArg }),
                    description: this.t('result.no_match.description'),
                    icon: '📅',
                    score: 85,
                    data: null,
                }];
            }
            return filtered.slice(0, 8).map(e => this._eventToResult(e));
        }

        const events = await this._fetchEvents();
        if (events.length === 0) {
            return [{
                id: 'cal:no-upcoming',
                type: 'calendar_event',
                label: this.t('result.no_upcoming.label'),
                description: this.t('result.no_upcoming.description', {
                    count: this._config.lookahead_hours || 8,
                }),
                icon: '📅',
                score: 85,
                data: null,
            }];
        }
        return events.slice(0, 8).map(e => this._eventToResult(e));
    }

    execute(result) {
        if (result.type === 'calendar_refresh') {
            this._fetchEvents(true);
            return { type: 'display', value: this.t('result.refresh.executed') };
        }
        const e = result.data;
        if (!e) return null;

        const lines = [`📅 **${e.subject}**`];
        const time = this._formatTimeWithDay(e.start_time);
        const dur = this._formatDuration(e.duration_minutes);
        lines.push(`🕐 ${time}${dur ? ' · ' + dur : ''}`);
        if (e.location) {
            const cleanLoc = this._stripUrlsFromLocation(e.location);
            if (cleanLoc) lines.push(`📍 ${this._formatLocation(cleanLoc)}`);
        }
        if (e.organizer) lines.push(`👤 ${e.organizer}`);
        if (e.online_url) {
            const provider = this._meetingProvider(e.online_url);
            const joinLabel = this.t('result.join_btn');
            lines.push(`🔗 [${joinLabel} ${provider}](${e.online_url})`);
        }
        const info = lines.join('\n');

        // Kick off "open URL" asynchronously via the context invoke —
        // this returns a display action synchronously so the floating
        // window shows the formatted info immediately.
        if (e.online_url && this._invoke) {
            this._invoke('open_url', { url: e.online_url }).catch((err) => {
                this.log?.warn?.('calendar: failed to open meeting URL: ' + (err?.message || err));
            });
        }
        return { type: 'display', value: info };
    }

    /**
     * Custom render for a single search result row. Host sanitizes the
     * returned HTML before injecting. Buttons that should route back
     * must carry `data-ext-action="<id>"`; host wires them to
     * `onResultAction(actionId)`.
     */
    renderCustom(result) {
        // Only real calendar events carry an event object worth laying out.
        // Refresh / no-match / no-upcoming rows set type !== 'calendar_event'
        // (refresh even has a truthy `data: { action }`), so gate on the
        // type — not just `data` presence — or those rows render an event
        // template against undefined fields ("undefined" name,
        // "[Invalid Date] Invalid Date" subtitle).
        const e = result?.type === 'calendar_event' ? result?.data : null;
        if (!e) {
            return {
                html: `<div class="app-icon">${escape(result?.icon || '📅')}</div>
                       <div class="app-info" style="flex:1;">
                           <div class="app-name">${this._labelHtml(result)}</div>
                           <div class="app-description">${escape(result?.description || '')}</div>
                       </div>`,
            };
        }
        const time = this._timeWithDayHtml(e.start_time, { pinDate: result.pinDate === true });
        const dur = this._formatDuration(e.duration_minutes);
        const provider = e.online_url ? this._meetingProvider(e.online_url) : '';
        // Remember the event's URL so onResultAction('join') can open it
        // without the url itself being inlined into click-handlers.
        if (e.online_url) {
            this._lastJoinUrlByResultId = this._lastJoinUrlByResultId || new Map();
            this._lastJoinUrlByResultId.set(result.id, e.online_url);
        }
        const joinLabel = this.t('result.join_btn');
        const joinBtn = e.online_url
            ? `<button data-ext-action="join:${escape(result.id)}" class="extension-bar-btn"
                       style="font-size:11px;padding:2px 8px;" title="${escape(e.online_url)}">${escape(joinLabel)}${provider ? ' ' + escape(provider) : ''}</button>`
            : '';
        const locSuffix = e.location && !/^https?:\/\//i.test(e.location.trim()) ? ' · ' + escape(e.location) : '';
        return {
            html: `<div class="app-icon">📅</div>
                   <div class="app-info" style="flex:1;">
                       <div class="app-name">${escape(e.subject)}</div>
                       <div class="app-description">${time}${dur ? ' · ' + escape(dur) : ''}${provider ? ' · ' + escape(provider) : ''}${locSuffix}</div>
                   </div>
                   ${joinBtn}`,
        };
    }

    /**
     * Host date picker: which days in [start, end) have events. One
     * get_calendar_busy_days call per visible month; only dates and counts
     * come back (never titles). The host validates and caches the answer;
     * a denied OS permission becomes the picker's "allow access" hint.
     */
    async getDateMarkers(start, end) {
        if (!isIsoDate(start) || !isIsoDate(end) || !this._invoke) {
            return { status: 'error', days: [] };
        }
        try {
            const days = await this._invoke('get_calendar_busy_days', { start, end });
            return { status: 'ok', days: Array.isArray(days) ? days : [] };
        } catch (e) {
            if (e?.key === 'errors.calendar.access_denied') {
                return { status: 'permission_denied', days: [] };
            }
            this.log?.warn?.('calendar: busy-day lookup failed: ' + (e?.message || e));
            return { status: 'error', days: [] };
        }
    }

    /**
     * The user picked a day in the host date picker. Route it to this
     * provider's own date listing, so the day's meetings (or its "No
     * meetings" row) render through the normal result rows.
     */
    onDateSelected(date) {
        return isIsoDate(date) ? { query: `cal ${date}` } : null;
    }

    async onResultAction(actionId) {
        if (actionId?.startsWith('join:')) {
            const resultId = actionId.substring('join:'.length);
            const url = this._lastJoinUrlByResultId?.get(resultId);
            if (url && this._invoke) {
                await this._invoke('open_url', { url });
            }
        }
        return {};
    }

    // --- Helpers ---

    async _fetchEvents(forceRefresh = false) {
        const hours = this._config.lookahead_hours || 8;
        return getEvents({ hours, force: forceRefresh });
    }

    _resolveDate(input) {
        const s = input.toLowerCase().trim();
        const now = new Date();
        // Format in LOCAL time. The arithmetic below (getDay, setDate) is
        // all local, so formatting via toISOString() (which is UTC) would
        // disagree by a day for anyone behind UTC late in the day — e.g.
        // "monday" on a Monday evening in UTC-7 would round-trip to a
        // Tuesday date string.
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        if (s === 'today') return fmt(now);
        if (s === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); return fmt(d); }
        if (s === 'yesterday') { const d = new Date(now); d.setDate(d.getDate() - 1); return fmt(d); }
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const isNext = s.startsWith('next ');
        const dayName = isNext ? s.substring(5) : s;
        const dayIdx = days.indexOf(dayName);
        if (dayIdx !== -1) {
            const today = now.getDay();
            let diff = dayIdx - today;
            if (diff <= 0 || isNext) diff += 7;
            const d = new Date(now); d.setDate(d.getDate() + diff);
            return fmt(d);
        }
        return null;
    }

    async _fetchEventsForDate(dateStr) {
        try {
            const events = await this._invoke('get_calendar_events_for_date', { date: dateStr });
            const label = this._formatDateLabel(dateStr);
            if (!events || events.length === 0) {
                return [{
                    id: 'cal:no-date:' + dateStr,
                    type: 'calendar_event',
                    label: this.t('result.no_date.label', { label }),
                    description: dateStr,
                    icon: '📅',
                    score: 85,
                    data: null,
                    // The day this empty state is for — renderCustom makes
                    // its date a picker opener so the user can keep browsing.
                    dateView: dateStr,
                }];
            }
            // pinDate: a day listing always shows its day (even "Today"),
            // so every row carries a date to reopen the picker from.
            return events.slice(0, 10).map(e => this._eventToResult(e, { pinDate: true }));
        } catch (e) {
            console.warn('[Calendar] Failed to fetch events for date:', e);
            return [];
        }
    }

    _formatDateLabel(dateStr) {
        if (!isIsoDate(dateStr)) return dateStr;
        const d = isoToLocalDate(dateStr);
        const opts = { weekday: 'long', month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        try {
            return d.toLocaleDateString(this._locale, opts);
        } catch {
            return dateStr;
        }
    }

    /**
     * Label HTML for a non-event row. The "No meetings on <day>" empty state
     * gets its day as a date-picker opener; everything else is plain text.
     */
    _labelHtml(result) {
        const day = result?.dateView;
        if (!isIsoDate(day)) return escape(result?.label || '');
        const MARK = '\u0001';
        const shell = escape(this.t('result.no_date.label', { label: MARK }));
        const chip = dateChip(this._datePicker, day, escape(this._formatDateLabel(day)));
        return shell.includes(MARK) ? shell.replace(MARK, chip) : escape(result?.label || '');
    }

    _eventToResult(event, { pinDate = false } = {}) {
        const timeStr = this._formatTimeWithDay(event.start_time, { pinDate });
        const dur = this._formatDuration(event.duration_minutes);
        const provider = event.online_url ? this._meetingProvider(event.online_url) : '';
        const loc = event.location && !/^https?:\/\//i.test(event.location.trim()) ? event.location : '';
        const parts = [timeStr, dur, provider, loc].filter(Boolean);
        const result = {
            id: 'cal:' + (event.id || event.subject + ':' + event.start_time),
            type: 'calendar_event',
            label: event.subject,
            description: parts.join(' · '),
            icon: '📅',
            score: 85,
            data: event,
        };
        if (pinDate) result.pinDate = true;
        return result;
    }

    /** `{ iso, day, time }` for an event start; `day` is "Tomorrow"-style or null for today. */
    _timeParts(isoString, { pinDate = false } = {}) {
        const d = new Date(isoString);
        if (Number.isNaN(d.getTime())) return null;
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const day = dayLabel(this.t, d, new Date(), { locale: this._locale, includeToday: pinDate });
        return { iso: localIsoDate(d), day, time };
    }

    /** "[Tomorrow] 10:00" (plain text; today's events show just the time). */
    _formatTimeWithDay(isoString, opts) {
        const p = this._timeParts(isoString, opts);
        if (!p) return '';
        return p.day ? `[${p.day}] ${p.time}` : p.time;
    }

    /** Same as _formatTimeWithDay, as HTML with the day as a date-picker opener. */
    _timeWithDayHtml(isoString, opts) {
        const p = this._timeParts(isoString, opts);
        if (!p) return '';
        if (!p.day) return escape(p.time);
        return `[${dateChip(this._datePicker, p.iso, escape(p.day))}] ${escape(p.time)}`;
    }

    _formatDuration(minutes) {
        if (!minutes) return '';
        if (minutes < 60) return this.t('result.duration.minutes', { minutes });
        if (minutes < 1440) {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            return m > 0
                ? this.t('result.duration.hours_minutes', { hours: h, minutes: m })
                : this.t('result.duration.hours', { hours: h });
        }
        const days = Math.round(minutes / 1440);
        return days === 1 ? this.t('result.duration.day') : this.t('result.duration.days', { days });
    }

    _meetingProvider(url) {
        if (!url) return '';
        const lower = url.toLowerCase();
        if (lower.includes('zoom.us') || lower.includes('zoom.com')) return 'Zoom';
        if (lower.includes('teams.microsoft') || lower.includes('teams.live')) return 'Teams';
        if (lower.includes('meet.google') || lower.includes('hangouts.google')) return 'Google Meet';
        if (lower.includes('webex') || lower.includes('cisco.com')) return 'Webex';
        if (lower.includes('chime.aws') || lower.includes('chime://')) return 'Chime';
        if (lower.includes('slack.com') || lower.includes('slack://')) return 'Slack';
        if (lower.includes('bluejeans')) return 'BlueJeans';
        if (lower.includes('gotomeeting') || lower.includes('goto.com')) return 'GoTo';
        return 'Meeting';
    }

    _stripUrlsFromLocation(location) {
        if (!location) return '';
        return location
            .replace(/https?:\/\/\S+/gi, '')
            .replace(/[;,]\s*$/, '')
            .replace(/^\s*[;,]\s*/, '')
            .trim();
    }

    _formatLocation(location) {
        if (!location) return '';
        if (/^https?:\/\//i.test(location.trim())) return `[${location}](${location})`;
        const encoded = encodeURIComponent(location);
        return `[${location}](https://www.google.com/maps/search/?api=1&query=${encoded})`;
    }
}

function escape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
