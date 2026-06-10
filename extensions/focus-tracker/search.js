/**
 * Focus Tracker search provider — shows activity reports via keyword trigger.
 * Subcommands: focus today, focus week, focus month, focus all
 */

const PERIODS = {
    'today': 'today',
    'week': 'week',
    'month': 'month',
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

        // Auto-start tracker if configured
        if (this.config.auto_start !== false) {
            this._ensureStarted();
        }
    }

    onConfigUpdate(config) {
        this.config = config || {};
        this._cache.clear();
        if (this.config.auto_start !== false && !this._started) {
            this._ensureStarted();
        }
    }

    match(query) {
        const parsed = this._parseQuery(query);
        if (!parsed) return [];

        // Return cached report if available
        const cached = this._cache.get(parsed.period);
        if (cached && Date.now() - cached.time < 10000) {
            return this._formatReport(cached.data, parsed.period);
        }

        // Valid trigger but no cache yet — show placeholder so Enter doesn't send to agent.
        // Period-specific keys read as natural English ("Loading today's report…")
        // instead of splicing the raw period token ("Loading today report…").
        // i18n-keys: result.loading.today, result.loading.week, result.loading.month, result.loading.all
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

        await this._ensureStarted();

        // Check cache (10s TTL)
        const cached = this._cache.get(parsed.period);
        if (cached && Date.now() - cached.time < 10000) {
            return [];
        }

        try {
            const report = await this.invoke('get_activity_report', { period: parsed.period });
            this._cache.set(parsed.period, { data: report, time: Date.now() });

            // Pre-fetch comparison period so it's cached for the AI summary on Enter
            const compPeriod = this._getComparisonPeriod(parsed.period);
            if (compPeriod && !this._cache.has(compPeriod)) {
                this.invoke('get_activity_report', { period: compPeriod }).then(compReport => {
                    this._cache.set(compPeriod, { data: compReport, time: Date.now() });
                }).catch((e) => {
                    this.log?.debug?.(`focus-tracker: comparison pre-fetch for '${compPeriod}' failed: ` + (e?.message || e));
                });
            }

            // Resolve real app logos for the top apps before formatting, so
            // rows render with the actual icon instead of an emoji fallback.
            await this._ensureIcons(report);

            return this._formatReport(report, parsed.period);
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

    _parseQuery(query) {
        const trigger = (this.config.trigger ?? 'focus').trim().toLowerCase();
        const trimmed = query.trim().toLowerCase();

        if (!trigger) return null;
        if (!trimmed.startsWith(trigger)) return null;

        const rest = trimmed.slice(trigger.length).trim();

        // "focus" alone defaults to "today"
        if (!rest) return { period: 'today' };

        // Match period
        for (const [key, value] of Object.entries(PERIODS)) {
            if (rest === key || rest.startsWith(key)) {
                return { period: value };
            }
        }

        return null;
    }

    async _ensureStarted() {
        if (this._started) return;
        try {
            const running = await this.invoke('is_activity_tracker_running');
            if (!running) {
                const interval = this.config.poll_interval || 5;
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

    _formatReport(report, period) {
        const results = [];

        // Summary card
        const totalHrs = (report.total_seconds / 3600).toFixed(1);
        const totalMin = Math.round(report.total_seconds / 60);
        const timeStr = report.total_seconds >= 3600 ? `${totalHrs}h` : `${totalMin}m`;
        const streakMin = Math.round(report.longest_streak_seconds / 60);

        results.push({
            id: `focus-summary-${period}`,
            type: 'focus-tracker',
            label: this.t('result.summary.label', { period: report.period, time: timeStr }),
            description: this.t('result.summary.description', { switches: report.context_switches, streak: streakMin, app: report.longest_streak_app }),
            icon: '📊',
            score: 86,
            data: {
                type: 'summary',
                period: report.period,
                timeStr,
                switches: report.context_switches,
                streakMin,
                streakApp: report.longest_streak_app,
                appCount: report.apps.length,
                report, // full report for display on Enter
                copyText: `${report.period}: ${timeStr} tracked, ${report.context_switches} switches, ${streakMin}m best streak (${report.longest_streak_app})`,
            },
        });

        // Top apps (max 5)
        const showApps = this.config.track_screen_time !== false;
        if (showApps) {
            for (let i = 0; i < Math.min(report.apps.length, 5); i++) {
                const app = report.apps[i];
                const appMin = Math.round(app.seconds / 60);
                const appHrs = (app.seconds / 3600).toFixed(1);
                const appTime = app.seconds >= 3600 ? `${appHrs}h` : `${appMin}m`;
                const pct = app.percentage.toFixed(0);
                results.push({
                    id: `focus-app-${period}-${app.process_name}`,
                    type: 'focus-tracker',
                    label: `${app.display_name}: ${appTime} (${pct}%)`,
                    description: this.t('result.app.description', { count: app.switches_to }),
                    icon: this._iconCache.get(app.process_name.toLowerCase()) || _appEmoji(app.process_name),
                    // Use high base score minus a small fraction per app to maintain order
                    // Sites use the same base minus smaller fractions to stay under their parent
                    score: 85 - (i * 0.01),
                    tooltip: `${app.display_name}: ${appTime} (${pct}%), ${app.switches_to} sessions`,
                    data: {
                        type: 'app-row',
                        name: app.display_name,
                        time: appTime,
                        pct: parseFloat(pct),
                        sessions: app.switches_to,
                        copyText: `${app.display_name}: ${appTime} (${pct}%), ${app.switches_to} sessions`,
                    },
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

        // AI insight suggestion
        if (report.context_switches > 10 && report.apps.length > 2) {
            const topApps = report.apps.slice(0, 3).map(a => a.display_name).join(', ');
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
                        `Context switches: ${report.context_switches}\n` +
                        `Longest focus streak: ${streakMin} minutes (${report.longest_streak_app})\n` +
                        `Top apps: ${report.apps.slice(0, 5).map(a => `${a.display_name}: ${Math.round(a.seconds/60)}m (${a.percentage.toFixed(0)}%)`).join(', ')}\n\n` +
                        `Based on this data, give me 2-3 specific, actionable suggestions to improve my focus and reduce context switching. Be concise.`,
                },
            });
        }

        return results;
    }

    _getComparisonPeriod(period) {
        const map = { 'today': 'week', 'week': 'month', 'month': 'all' };
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
        const totalMin = Math.round(report.total_seconds / 60);
        const timeStr = report.total_seconds >= 3600 ? `${(report.total_seconds/3600).toFixed(1)}h` : `${totalMin}m`;
        const streakMin = Math.round(report.longest_streak_seconds / 60);

        let text = `Total: ${timeStr} tracked, ${report.context_switches} context switches, ${streakMin}m longest streak (${report.longest_streak_app})\n`;
        text += `Apps:\n`;
        for (const app of report.apps.slice(0, 10)) {
            const t = app.seconds >= 3600 ? `${(app.seconds/3600).toFixed(1)}h` : `${Math.round(app.seconds/60)}m`;
            text += `- ${app.display_name}: ${t} (${app.percentage.toFixed(0)}%), ${app.switches_to} sessions\n`;
            if (app.sites) {
                for (const site of app.sites.slice(0, 3)) {
                    const st = site.seconds >= 3600 ? `${(site.seconds/3600).toFixed(1)}h` : `${Math.round(site.seconds/60)}m`;
                    text += `  - ${site.site}: ${st} (${site.percentage.toFixed(0)}% of ${app.display_name})\n`;
                }
            }
        }
        return text;
    }

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
