/**
 * Focus Tracker search provider — shows activity reports via keyword trigger.
 * Subcommands: focus today, focus week, focus month, focus all
 */

import { DEFAULTS } from './defaults.js';

const PERIODS = {
    'today': 'today',
    'week': 'week',
    'month': 'month',
    'year': 'year',
    'all': 'all',
};

export default class FocusTrackerSearchProvider {
    initialize(context) {
        this.config = context.config || {};
        this.invoke = context.invoke;
        this.log = context.log;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        this._cache = new Map();
        this._started = false;
        // process_name (lowercased) -> icon data URI, or null when the host
        // has no icon for it. Persists for the session so the report rows
        // show real app logos instead of the emoji fallback.
        this._iconCache = new Map();

        // Enabled = tracking. There is no separate auto-start toggle: if
        // the extension is on, the host-side tracker runs; the standard
        // extension disable switch is the "stop tracking" affordance
        // (handled in onConfigUpdate — the sandbox stays loaded across a
        // disable, so we get the config change and stop the tracker).
        if (this.config.enabled !== false) {
            this._ensureStarted();
        }
    }

    onConfigUpdate(config) {
        const wasEnabled = this.config?.enabled !== false;
        this.config = config || {};
        this._cache.clear();
        const isEnabled = this.config.enabled !== false;
        if (wasEnabled && !isEnabled) {
            // Extension switched off — stop the host-side poller so
            // "disabled" genuinely means "not tracking". Multi-instance
            // note: every window's instance sends this; stop is
            // idempotent so the duplicates are harmless.
            this._started = false;
            this.invoke('stop_activity_tracker').catch((e) => {
                this.log?.warn?.('focus-tracker: stop failed: ' + (e?.message || e));
            });
        } else if (!wasEnabled && isEnabled) {
            this._ensureStarted();
        }
    }

    /**
     * Trigger set for host-side gating + hints. `focus` alone reports today;
     * `focus week` / `month` / `all` pick a period — hence acceptsArgs. The
     * empty-trigger case can't occur (config default is 'focus' and parsing
     * bails on an empty trigger), but guard anyway. Label is an i18n key.
     */
    getKeywords() {
        // i18n-keys: keyword.focus.label, keyword.focus.description
        const trigger = (this.config.trigger ?? DEFAULTS.trigger).trim().toLowerCase();
        if (!trigger) return [];
        return [
            { keyword: trigger, labelKey: 'keyword.focus.label', descriptionKey: 'keyword.focus.description', icon: '📊', acceptsArgs: true },
        ];
    }

    match(query) {
        const parsed = this._parseQuery(query);
        if (!parsed) return [];

        // "focus " / "focus w" → the period picker, not a report.
        if (parsed.menu) return this._periodMenu(parsed.filter);

        // Return cached report if available
        const cached = this._cache.get(parsed.period);
        if (cached && Date.now() - cached.time < 10000) {
            return this._formatReport(cached.data, parsed.period, parsed);
        }

        // Valid trigger but no cache yet — show placeholder so Enter doesn't send to agent.
        // Period-specific keys read as natural English ("Loading today's report…")
        // instead of splicing the raw period token ("Loading today report…").
        // i18n-keys: result.loading.today, result.loading.week, result.loading.month, result.loading.year, result.loading.all
        const loadingKey = `result.loading.${parsed.period}`;
        return [{
            id: `focus-loading-${parsed.period}`,
            type: 'focus-tracker',
            label: this.t(loadingKey),
            description: this.t('result.loading.description'),
            icon: '📊',
            score: 86,
            data: { type: 'loading', period: parsed.period },
        }];
    }

    async matchAsync(query) {
        const parsed = this._parseQuery(query);
        if (!parsed) return [];

        // Menu is fully served by the sync match() — nothing to fetch.
        if (parsed.menu) return [];

        await this._ensureStarted();

        // Check cache (10s TTL)
        const cached = this._cache.get(parsed.period);
        if (cached && Date.now() - cached.time < 10000) {
            return [];
        }

        try {
            const report = this._withoutUntracked(
                await this.invoke('get_activity_report', { period: parsed.period }));
            this._cache.set(parsed.period, { data: report, time: Date.now() });

            // Pre-fetch comparison period so it's cached for the AI summary on Enter
            const compPeriod = this._getComparisonPeriod(parsed.period);
            if (compPeriod && !this._cache.has(compPeriod)) {
                this.invoke('get_activity_report', { period: compPeriod }).then(compReport => {
                    this._cache.set(compPeriod, { data: this._withoutUntracked(compReport), time: Date.now() });
                }).catch((e) => {
                    this.log?.debug?.(`focus-tracker: comparison pre-fetch for '${compPeriod}' failed: ` + (e?.message || e));
                });
            }

            // Resolve real app logos for the top apps before formatting, so
            // rows render with the actual icon instead of an emoji fallback.
            await this._ensureIcons(report);

            return this._formatReport(report, parsed.period, parsed);
        } catch (e) {
            console.warn('[FocusTracker] Report failed:', e);
            return [{
                id: 'focus-error',
                type: 'focus-tracker',
                label: this.t('result.error.label'),
                description: String(e),
                icon: '📊',
                score: 85,
                data: { type: 'error' },
            }];
        }
    }

    execute(result) {
        if (result.data?.type === 'loading') {
            const cached = this._cache.get(result.data.period);
            if (cached) {
                return this._buildPromptAction(cached.data, result.data.period);
            }
            return null;
        }
        if (result.data?.type === 'insight') {
            return { type: 'prompt', value: result.data.prompt };
        }
        if (result.data?.type === 'period-hint' || result.data?.type === 'period-menu') {
            // Swap the input to a period query so the report re-runs —
            // discoverability affordance, not a report row.
            return { type: 'replace_input', value: result.data.input };
        }
        if (result.data?.type === 'summary' && result.data.report) {
            return this._buildPromptAction(result.data.report, result.data.report.period);
        }
        if (result.data?.copyText) {
            return { type: 'copy', value: result.data.copyText };
        }
        return null;
    }

    destroy() {
        this._cache.clear();
        this._iconCache.clear();
    }

    // --- Private ---

    /**
     * Which of the derived measures the user tracks. The host counts
     * switches and streaks from the same foreground-window samples screen
     * time uses, when it builds a report; neither is stored separately.
     * So "off" means this extension never keeps, shows, copies or sends
     * them to the AI. The host's samples stay as they are, so turning one
     * back on shows it for the whole history again.
     */
    _tracking() {
        return {
            switches: this.config.track_switches ?? DEFAULTS.track_switches,
            streaks: this.config.track_streaks ?? DEFAULTS.track_streaks,
        };
    }

    /**
     * A report as the host sent it, minus the measures that aren't tracked,
     * for the cache. Rows and prompts are built from the cache, so what's
     * dropped here can't reach them. onConfigUpdate clears the cache, so a
     * toggle takes effect on the next report.
     */
    _withoutUntracked(report) {
        const { switches, streaks } = this._tracking();
        if (!report || (switches && streaks)) return report;
        const out = { ...report };
        if (!switches) {
            delete out.context_switches;
            out.apps = (report.apps || []).map(({ switches_to: _s, ...app }) => app);
        }
        if (!streaks) {
            delete out.longest_streak_seconds;
            delete out.longest_streak_app;
        }
        return out;
    }

    _parseQuery(query) {
        const trigger = (this.config.trigger ?? DEFAULTS.trigger).trim().toLowerCase();
        const trimmed = query.trim().toLowerCase();

        if (!trigger) return null;
        if (!trimmed.startsWith(trigger)) return null;

        const rest = trimmed.slice(trigger.length).trim();

        if (!rest) {
            // Trailing space after the bare trigger ("focus ") is intent:
            // the user paused to see what can come next. Show the period
            // menu instead of today's report so the options are explicit.
            if (/\s$/.test(query)) return { menu: true, filter: '' };
            // "focus" alone defaults to "today". `explicit: false` lets the
            // formatter append the period-hint row only on the bare trigger.
            return { period: 'today', explicit: false };
        }

        // Complete period token → that report.
        for (const [key, value] of Object.entries(PERIODS)) {
            if (rest === key || rest.startsWith(key)) {
                return { period: value, explicit: true };
            }
        }

        // Partial period prefix ("focus w") → menu filtered to matching
        // periods, completion-style.
        if (Object.keys(PERIODS).some((k) => k.startsWith(rest))) {
            return { menu: true, filter: rest };
        }

        return null;
    }

    /**
     * The period picker shown for `focus ` (trailing space) and partial
     * period text (`focus w`). One row per period, spelled as the exact
     * query to type; Enter completes the input via replace_input, which
     * re-runs the search and loads that report.
     */
    _periodMenu(filter) {
        const trigger = (this.config.trigger ?? DEFAULTS.trigger).trim().toLowerCase();
        const periods = Object.keys(PERIODS).filter((p) => !filter || p.startsWith(filter));
        // i18n-keys: result.menu.today, result.menu.week, result.menu.month, result.menu.year, result.menu.all
        return periods.map((p, i) => ({
            id: `focus-menu-${p}`,
            type: 'focus-tracker',
            label: `${trigger} ${p}`,
            description: this.t(`result.menu.${p}`),
            icon: '📅',
            score: 88 - i * 0.01,
            data: { type: 'period-menu', input: `${trigger} ${p}` },
        }));
    }

    async _ensureStarted() {
        if (this._started) return;
        try {
            const running = await this.invoke('is_activity_tracker_running');
            if (!running) {
                const interval = this.config.poll_interval || DEFAULTS.poll_interval;
                await this.invoke('start_activity_tracker', { pollInterval: interval });
            }
            this._started = true;
        } catch (e) {
            console.warn('[FocusTracker] Failed to start tracker:', e);
        }
    }

    // Resolve real app logos for the report's top apps via the host's
    // by-process-name icon lookup, caching each result (including misses)
    // for the session. get_app_icon returns raw base64, so we normalise to
    // a data URI — the floating renderer only treats `icon` as an image
    // when it starts with "data:".
    async _ensureIcons(report) {
        const names = [];
        for (const app of (report.apps || []).slice(0, 5)) {
            const key = app.process_name.toLowerCase();
            if (!this._iconCache.has(key)) names.push(key);
        }
        if (names.length === 0) return;
        await Promise.all(names.map(async (key) => {
            try {
                const icon = await this.invoke('get_app_icon', { processName: key });
                if (icon) {
                    this._iconCache.set(key, icon.startsWith('data:') ? icon : 'data:image/png;base64,' + icon);
                } else {
                    this._iconCache.set(key, null);
                }
            } catch (e) {
                console.warn('[FocusTracker] Icon fetch failed for ' + key + ':', e);
                this._iconCache.set(key, null);
            }
        }));
    }

    _formatReport(report, period, parsed = null) {
        const results = [];
        const tracking = this._tracking();

        // Summary card
        const totalHrs = (report.total_seconds / 3600).toFixed(1);
        const totalMin = Math.round(report.total_seconds / 60);
        const timeStr = report.total_seconds >= 3600 ? `${totalHrs}h` : `${totalMin}m`;
        const switches = report.context_switches ?? 0;
        const streakMin = Math.round((report.longest_streak_seconds ?? 0) / 60);
        const streakApp = report.longest_streak_app ?? '';

        // i18n-keys: result.summary.description, result.summary.description_switches, result.summary.description_streak, result.summary.description_plain
        const summaryKey = tracking.switches && tracking.streaks ? 'result.summary.description'
            : tracking.switches ? 'result.summary.description_switches'
            : tracking.streaks ? 'result.summary.description_streak'
            : 'result.summary.description_plain';
        const copyParts = [`${report.period}: ${timeStr} tracked`];
        if (tracking.switches) copyParts.push(`${switches} switches`);
        if (tracking.streaks) copyParts.push(`${streakMin}m best streak (${streakApp})`);

        const summaryData = {
            type: 'summary',
            period: report.period,
            timeStr,
            appCount: report.apps.length,
            report, // full report for display on Enter
            copyText: copyParts.join(', '),
        };
        if (tracking.switches) summaryData.switches = switches;
        if (tracking.streaks) Object.assign(summaryData, { streakMin, streakApp });

        results.push({
            id: `focus-summary-${period}`,
            type: 'focus-tracker',
            label: this.t('result.summary.label', { period: report.period, time: timeStr }),
            description: this.t(summaryKey, { switches, streak: streakMin, app: streakApp }),
            icon: '📊',
            score: 86,
            data: summaryData,
        });

        // Per-month rollup (year / all-time): one compact line per month,
        // newest first. When present it REPLACES the flat app table —
        // a long range reads as a handful of month summaries, not a wall
        // of app rows (top apps for the whole range are still in the
        // summary card's data and the AI prompt).
        const months = Array.isArray(report.months) ? report.months : [];
        if (months.length > 0) {
            const newestFirst = [...months].reverse();
            for (let i = 0; i < newestFirst.length; i++) {
                const m = newestFirst[i];
                const mTime = _fmtSecs(m.total_seconds);
                const tops = (m.top_apps || [])
                    .map((a) => `${a.display_name} ${a.percentage.toFixed(0)}%`)
                    .join(' · ');
                results.push({
                    id: `focus-month-${period}-${m.month}`,
                    type: 'focus-tracker',
                    label: `${m.label}: ${mTime}`,
                    description: tops || this.t('result.month.no_apps'),
                    icon: '🗓️',
                    score: 85 - i * 0.01,
                    tooltip: `${m.label}: ${mTime} — ${tops}`,
                    data: {
                        type: 'month-row',
                        month: m.month,
                        copyText: `${m.label}: ${mTime} (${tops})`,
                    },
                });
            }
        }

        // Top apps (max 5) — skipped when the month rollup rendered; the
        // flat table would just repeat what the month lines already say.
        const showApps = months.length === 0 && (this.config.track_screen_time ?? DEFAULTS.track_screen_time);
        if (showApps) {
            for (let i = 0; i < Math.min(report.apps.length, 5); i++) {
                const app = report.apps[i];
                const appMin = Math.round(app.seconds / 60);
                const appHrs = (app.seconds / 3600).toFixed(1);
                const appTime = app.seconds >= 3600 ? `${appHrs}h` : `${appMin}m`;
                const pct = app.percentage.toFixed(0);
                // Sessions = how often you switched to the app: a switch count.
                const sessions = tracking.switches ? `, ${app.switches_to ?? 0} sessions` : '';
                const appData = {
                    type: 'app-row',
                    name: app.display_name,
                    time: appTime,
                    pct: parseFloat(pct),
                    copyText: `${app.display_name}: ${appTime} (${pct}%)${sessions}`,
                };
                if (tracking.switches) appData.sessions = app.switches_to ?? 0;
                results.push({
                    id: `focus-app-${period}-${app.process_name}`,
                    type: 'focus-tracker',
                    label: `${app.display_name}: ${appTime} (${pct}%)`,
                    description: tracking.switches
                        ? this.t('result.app.description', { count: app.switches_to ?? 0 })
                        : '',
                    icon: this._iconCache.get(app.process_name.toLowerCase()) || _appEmoji(app.process_name),
                    // Use high base score minus a small fraction per app to maintain order
                    // Sites use the same base minus smaller fractions to stay under their parent
                    score: 85 - (i * 0.01),
                    tooltip: `${app.display_name}: ${appTime} (${pct}%)${sessions}`,
                    data: appData,
                });

                // Browser site breakdown
                if (app.sites && app.sites.length > 0) {
                    for (let j = 0; j < Math.min(app.sites.length, 5); j++) {
                        const site = app.sites[j];
                        const siteMin = Math.round(site.seconds / 60);
                        const siteTime = site.seconds >= 3600 ? `${(site.seconds / 3600).toFixed(1)}h` : `${siteMin}m`;
                        const sitePct = site.percentage.toFixed(0);
                        results.push({
                            id: `focus-site-${period}-${app.process_name}-${j}`,
                            type: 'focus-tracker',
                            label: `  ${site.site}: ${siteTime}`,
                            description: this.t('result.site.description', { pct: sitePct, app: app.display_name }),
                            icon: '🌐',
                            score: 85 - (i * 0.01) - ((j + 1) * 0.001),
                            tooltip: `${site.site}: ${siteTime} (${sitePct}% of ${app.display_name})`,
                            data: {
                                type: 'site-row',
                                site: site.site,
                                parentApp: app.display_name,
                                time: siteTime,
                                pct: parseFloat(sitePct),
                                copyText: `${site.site}: ${siteTime} (${sitePct}% of ${app.display_name})`,
                            },
                        });
                    }
                }
            }
        }

        // AI insight suggestion — offered when you switch a lot, so only
        // while switches are counted. (The summary row's Enter still asks
        // the AI about the report.)
        if (tracking.switches && switches > 10 && report.apps.length > 2) {
            results.push({
                id: `focus-insight-${period}`,
                type: 'focus-tracker',
                label: this.t('result.insight.label'),
                description: this.t('result.insight.description'),
                icon: '💡',
                score: 80,
                data: {
                    type: 'insight',
                    prompt: `Here's my app usage for ${report.period.toLowerCase()}:\n\n` +
                        `Total tracked time: ${timeStr}\n` +
                        `Context switches: ${switches}\n` +
                        (tracking.streaks ? `Longest focus streak: ${streakMin} minutes (${streakApp})\n` : '') +
                        `Top apps: ${report.apps.slice(0, 5).map(a => `${a.display_name}: ${Math.round(a.seconds/60)}m (${a.percentage.toFixed(0)}%)`).join(', ')}\n\n` +
                        `Based on this data, give me 2-3 specific, actionable suggestions to improve my focus and reduce context switching. Be concise.`,
                },
            });
        }

        // Period-hint row: on the bare trigger, surface the other periods
        // so users discover `focus week` / `month` / `year` / `all` without
        // reading docs. Enter swaps the input to the period so the report
        // re-runs (`replace_input`), same as typing it. Lowest score in the
        // group so it renders at the bottom of the block.
        if (parsed && parsed.explicit === false) {
            const trigger = (this.config.trigger ?? DEFAULTS.trigger).trim().toLowerCase();
            const others = Object.keys(PERIODS).filter((p) => p !== period);
            results.push({
                id: 'focus-period-hint',
                type: 'focus-tracker',
                label: this.t('result.periods.label'),
                description: others.map((p) => `${trigger} ${p}`).join(' · '),
                icon: '📅',
                score: 79,
                data: { type: 'period-hint', input: `${trigger} week` },
            });
        }

        return results;
    }

    _getComparisonPeriod(period) {
        const map = { 'today': 'week', 'week': 'month', 'month': 'year', 'year': 'all' };
        return map[period] || null;
    }

    _buildPromptAction(report, period) {
        const compPeriod = this._getComparisonPeriod(period);
        const compCached = compPeriod ? this._cache.get(compPeriod) : null;

        let prompt = `Here is my focus/activity tracking data. Please give me a brief summary of what's going on, and 2-3 actionable recommendations.\n\n`;
        prompt += `## ${report.period} Report\n`;
        prompt += this._formatReportForPrompt(report);

        if (compCached) {
            const compLabel = compPeriod === 'all' ? 'All Time' : compPeriod.charAt(0).toUpperCase() + compPeriod.slice(1);
            prompt += `\n## ${compLabel} Report (for context)\n`;
            prompt += this._formatReportForPrompt(compCached.data);
            prompt += `\nCompare my ${report.period.toLowerCase()} to the ${compLabel.toLowerCase()} data — are things trending better or worse? What stands out?\n`;
        }

        prompt += `\nBe concise and specific. Focus on patterns, not just restating numbers.`;
        return { type: 'prompt', value: prompt };
    }

    _formatReportForPrompt(report) {
        const tracking = this._tracking();
        const timeStr = _fmtSecs(report.total_seconds);
        const streakMin = Math.round((report.longest_streak_seconds ?? 0) / 60);

        const totals = [`${timeStr} tracked`];
        if (tracking.switches) totals.push(`${report.context_switches ?? 0} context switches`);
        if (tracking.streaks) totals.push(`${streakMin}m longest streak (${report.longest_streak_app ?? ''})`);
        let text = `Total: ${totals.join(', ')}\n`;

        // Month breakdown for multi-month ranges (year / all). Compact:
        // one line per month with the total + top 3 apps so the LLM can
        // identify trends without drowning in per-app rows.
        const months = Array.isArray(report.months) ? report.months : [];
        if (months.length > 0) {
            text += `\nMonthly:\n`;
            for (const m of months) {
                const tops = (m.top_apps || [])
                    .map((a) => `${a.display_name} ${a.percentage.toFixed(0)}%`)
                    .join(', ');
                text += `- ${m.label}: ${_fmtSecs(m.total_seconds)} (${tops})\n`;
            }
        }

        text += `\nTop apps (overall):\n`;
        for (const app of report.apps.slice(0, 10)) {
            const t = _fmtSecs(app.seconds);
            const sessions = tracking.switches ? `, ${app.switches_to ?? 0} sessions` : '';
            text += `- ${app.display_name}: ${t} (${app.percentage.toFixed(0)}%)${sessions}\n`;
            if (app.sites) {
                for (const site of app.sites.slice(0, 3)) {
                    const st = _fmtSecs(site.seconds);
                    text += `  - ${site.site}: ${st} (${site.percentage.toFixed(0)}% of ${app.display_name})\n`;
                }
            }
        }
        return text;
    }

}

function _fmtSecs(s) {
    return s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`;
}

function _appEmoji(processName) {
    const map = {
        'code': '💻', 'chrome': '🌐', 'firefox': '🦊', 'msedge': '🌐',
        'slack': '💬', 'teams': '💬', 'discord': '💬', 'outlook': '📧',
        'explorer': '📁', 'windowsterminal': '⬛', 'spotify': '🎵',
        'winword': '📝', 'excel': '📊', 'powerpnt': '📽️', 'notepad': '📝',
    };
    return map[processName.toLowerCase()] || '🪟';
}
