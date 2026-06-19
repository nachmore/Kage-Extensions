import { initCache, getEvents } from './cache.js';

/**
 * How long the FIRST render (cold cache) will wait on the Outlook query
 * before painting. Only applies when the local snapshot is still empty;
 * once warm, render never waits. Capped well under the host's 10s
 * renderWidget RPC budget (and the Rust side's 9s query kill) so a slow
 * query can't blow the budget — we just paint null and retry next tick.
 */
const COLD_LOAD_WAIT_MS = 3_000;

/**
 * Delay between mount and the first background warm-up fetch.
 *
 * The fetch shells out to PowerShell (Outlook query), so spawning it the
 * instant the widget mounts is dangerous: a host reload re-creates every
 * widget, and a burst of reloads (e.g. several extensions updating at once)
 * would fire one PowerShell per mount in a tight loop. During such a burst a
 * widget mounts and is destroyed within milliseconds, so a short delay means
 * the timer is cancelled before it ever fires — no spawn. It's kept short
 * because a user who just installed the extension will try to use it within
 * a couple of seconds; this only needs to outlast a mount storm, not feel
 * laggy. The render() cold path still fetches immediately when the user is
 * actually looking at the bar.
 */
const MOUNT_WARMUP_DELAY_MS = 2_000;

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
        // Warm the snapshot a couple of seconds after mount (not AT mount) so
        // a reload storm that mounts→destroys this widget rapidly never gets
        // to spawn a PowerShell query — destroy() cancels the timer first.
        // See MOUNT_WARMUP_DELAY_MS. A real mount that survives warms up well
        // before the user opens the launcher.
        this._warmupTimer = setTimeout(() => {
            this._warmupTimer = null;
            this._refreshEventsInBackground();
        }, MOUNT_WARMUP_DELAY_MS);
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
        // Warm path: render instantly from the local snapshot and refresh
        // in the background — never block a paint on the Outlook query.
        //
        // Cold path (snapshot still empty, e.g. the very first render after
        // mount/update): briefly await the in-flight fetch so the first
        // paint isn't empty. Without this the widget would render null,
        // and — because the 60s timer is paused while the floating window
        // is hidden — nothing would repaint it until well after the user
        // opens the launcher, so the bar appeared to never show. The wait
        // is capped far under the host's 10s renderWidget budget; on
        // timeout we fall through to null and the next tick retries.
        const fetchPromise = this._refreshEventsInBackground();
        if (this._events.length === 0 && fetchPromise) {
            await this._raceTimeout(fetchPromise, COLD_LOAD_WAIT_MS);
        }
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

    destroy() {
        // Cancel a pending warm-up so a widget torn down during a reload
        // storm never fires its PowerShell query.
        if (this._warmupTimer) {
            clearTimeout(this._warmupTimer);
            this._warmupTimer = null;
        }
    }

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
        // Return the in-flight promise so render() can optionally await it
        // on a cold cache. When a fetch is already running, hand back the
        // same promise rather than starting a second one.
        if (this._fetchInFlight) return this._inFlightPromise;
        this._fetchInFlight = true;
        const hours = this._config.lookahead_hours || 8;
        this._inFlightPromise = Promise.resolve(getEvents({ hours }))
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
                this._inFlightPromise = null;
            });
        return this._inFlightPromise;
    }

    /** Resolve when `p` settles or after `ms`, whichever comes first.
     *  Never rejects — used to cap how long the cold-cache first paint
     *  waits on the Outlook query. */
    _raceTimeout(p, ms) {
        return Promise.race([
            Promise.resolve(p).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, ms)),
        ]);
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
