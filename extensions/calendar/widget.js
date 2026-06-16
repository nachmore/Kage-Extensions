import { initCache, getEvents } from './cache.js';

/**
 * Calendar next-meeting overlay widget.
 * Mounts into the floating-bottom slot. Re-renders every 60 seconds.
 */
export default class CalendarNextMeetingWidget {
    initialize(context) {
        this._invoke = context.invoke;
        initCache(context.invoke);
        this._config = context.config || {};
        this._dismissedIds = new Set();
        this._cachedEvent = null;
        this._cachedConcurrent = 1;
        // Local snapshot of events. render() computes the "next meeting"
        // purely from this — it never awaits a fetch. A background refresh
        // (fire-and-forget, see _refreshEventsInBackground) keeps it warm.
        // This is the original design: query periodically, render
        // instantly. Blocking render on the Outlook query is what let a
        // slow query (killed at 9s by the Rust side) blow the host's 10s
        // renderWidget RPC budget and freeze the bar on stale content.
        this._events = [];
        this._fetchInFlight = false;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        // Warm the snapshot immediately so the bar can appear on the first
        // render tick rather than waiting a full refresh interval.
        this._refreshEventsInBackground();
    }

    onConfigUpdate(config) {
        this._config = config || {};
    }

    getRefreshInterval() {
        // Poll once a minute so the "in Nm" countdown stays fresh.
        return this._config.show_overlay !== false ? 60_000 : 0;
    }

    async render() {
        if (this._config.show_overlay === false) return null;
        // Kick off a background refresh if the cache boundary has passed,
        // then render immediately from the local snapshot — never await
        // the fetch. The fetch result lands in this._events and shows up
        // on the next tick.
        this._refreshEventsInBackground();
        this._recomputeNextEvent();
        const event = this._cachedEvent;
        if (!event) return null;

        const concurrent = this._cachedConcurrent;
        const start = new Date(event.start_time);
        const now = new Date();
        const diffMin = Math.round((start - now) / 60000);
        const dayPrefix = this._dayPrefix(start, now);

        let timeLabel;
        if (diffMin <= 0) {
            timeLabel = this.t('widget.now');
        } else if (diffMin < 60 && !dayPrefix) {
            timeLabel = this.t('widget.in_minutes', { minutes: diffMin });
        } else {
            const time = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            timeLabel = dayPrefix ? `${dayPrefix} ${time}` : time;
        }

        const concurrentHtml = concurrent > 1
            ? `<span style="font-size:10px;opacity:0.7;margin-left:4px;">${escape(this.t('widget.concurrent_more', { count: concurrent - 1 }))}</span>`
            : '';
        const joinLabel = this.t('result.join_btn');
        const joinHtml = event.online_url
            ? `<button data-ext-action="join" class="extension-bar-btn cal-join-btn"
                       style="font-size:11px;padding:2px 10px;" title="${escape(event.online_url)}">${escape(joinLabel)}</button>`
            : '';

        return {
            className: 'extension-bar',
            html: `
                <span class="extension-bar-icon">📅</span>
                <span class="extension-bar-text" style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    <strong>[${escape(timeLabel)}]</strong> ${escape(event.subject)}${concurrentHtml}
                </span>
                <div class="extension-bar-controls">
                    ${joinHtml}
                    <button data-ext-action="dismiss" class="extension-bar-btn"
                            style="font-size:11px;padding:1px 4px;" title="${escape(this.t('widget.dismiss_title'))}">✕</button>
                </div>
            `,
            actions: [
                { id: 'join', rpc: 'join' },
                { id: 'dismiss', rpc: 'dismiss' },
            ],
        };
    }

    async onAction(actionId) {
        if (actionId === 'join') {
            const e = this._cachedEvent;
            if (e?.online_url && this._invoke) {
                await this._invoke('open_url', { url: e.online_url });
            }
            return {};
        }
        if (actionId === 'dismiss') {
            const e = this._cachedEvent;
            if (e) this._dismissedIds.add(e.id);
            this._cachedEvent = null;
            // Recompute from the local snapshot (no fetch) so the host's
            // immediate re-render moves to the next event.
            this._recomputeNextEvent();
            return { rerender: true };
        }
        return {};
    }

    destroy() {}

    // --- Internals ---

    /**
     * Refresh the local event snapshot from the shared cache, off the
     * render path. `getEvents` only hits Outlook when the cache boundary
     * (~:25/:55) has passed; otherwise it returns the cached array
     * cheaply. Fire-and-forget: we never await this from render(), so a
     * slow Outlook query can't stall a paint. A single in-flight guard
     * keeps overlapping ticks from stacking fetches.
     */
    _refreshEventsInBackground() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;
        const hours = this._config.lookahead_hours || 8;
        Promise.resolve(getEvents({ hours }))
            .then((events) => {
                if (Array.isArray(events)) this._events = events;
            })
            .catch(() => {
                // Keep the previous snapshot on failure — better a slightly
                // stale list than an empty bar. The host-side staleness
                // guard clears genuinely old content if this keeps failing.
            })
            .finally(() => {
                this._fetchInFlight = false;
            });
    }

    /**
     * Recompute the "next meeting" from the local snapshot. Pure and
     * synchronous — safe to call from render() and onAction() without
     * awaiting anything.
     */
    _recomputeNextEvent() {
        const hours = this._config.lookahead_hours || 8;
        const events = this._events;
        const now = new Date();
        const cutoff = new Date(now.getTime() + hours * 3600_000);

        const upcoming = events.filter(e => {
            if (e.all_day) return false;
            if (this._dismissedIds.has(e.id)) return false;
            const start = new Date(e.start_time);
            const end = new Date(start.getTime() + (e.duration_minutes || 30) * 60000);
            return end > now && start <= cutoff;
        });

        if (upcoming.length === 0) {
            this._cachedEvent = null;
            this._cachedConcurrent = 1;
            return;
        }

        const inProgress = upcoming.filter(e => new Date(e.start_time) <= now);
        inProgress.sort((a, b) => (b.online_url ? 1 : 0) - (a.online_url ? 1 : 0));
        const future = upcoming.filter(e => new Date(e.start_time) > now);

        let next;
        if (inProgress.length > 0 && future.length > 0) {
            const minsUntilNext = (new Date(future[0].start_time) - now) / 60000;
            next = minsUntilNext <= 10 ? future[0] : inProgress[0];
        } else if (inProgress.length > 0) {
            next = inProgress[0];
        } else {
            next = upcoming[0];
        }

        const nextStart = new Date(next.start_time);
        const concurrent = upcoming.filter(e => {
            const s = new Date(e.start_time);
            return Math.abs(s - nextStart) < 15 * 60000;
        }).length;

        this._cachedEvent = next;
        this._cachedConcurrent = concurrent;
    }

    _dayPrefix(eventDate, now) {
        const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
        const eventDay = new Date(eventDate); eventDay.setHours(0,0,0,0);
        const diffDays = Math.round((eventDay - todayStart) / 86400000);
        if (diffDays === 0) return null;
        if (diffDays === 1) return '[Tomorrow]';
        return '[' + eventDate.toLocaleDateString(undefined, { weekday: 'long' }) + ']';
    }
}

function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
