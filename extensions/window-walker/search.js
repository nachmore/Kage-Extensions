/**
 * Window Walker search provider.
 * Type the trigger (default "w ") to list open windows, then filter by typing.
 * Selecting a window brings it to the foreground.
 *
 * Icons are fetched once per window-list refresh and cached in a bounded LRU.
 * The first invocation pays ~100-200ms for icon extraction; subsequent calls
 * within the 500ms window-list cache hit the icon cache and return instantly.
 */

import { DEFAULTS } from './defaults.js';

const ICON_CACHE_MAX = 64;

export default class WindowWalkerSearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        // Hosts with 'windows.minimized' flag each list_open_windows entry
        // with `minimized`. Older hosts don't say, so hide_minimized can't
        // apply there and every listed window is shown, as before.
        this._hostFlagsMinimized = Array.isArray(context.hostFeatures)
            && context.hostFeatures.includes('windows.minimized');
        this._cache = null;
        this._cacheTime = 0;
        // Bounded LRU icon cache: Map preserves insertion order, we evict oldest.
        this._iconCache = new Map();
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    /**
     * Trigger set for host-side gating. The configured trigger carries a
     * trailing space by default ('w '); we register the trimmed word so the
     * host's whole-word gate ('w' exact or 'w ' + args) matches the same
     * queries matchAsync() handles. A single-char trigger never produces a
     * completion hint (its only strict prefix is the empty query), so this is
     * purely a per-keystroke gate. Label is an i18n key.
     */
    getKeywords() {
        // i18n-keys: keyword.w.label, keyword.w.description
        const trigger = (this.config.trigger || DEFAULTS.trigger).trim().toLowerCase();
        if (!trigger) return [];
        return [
            { keyword: trigger, labelKey: 'keyword.w.label', descriptionKey: 'keyword.w.description', icon: '🪟', acceptsArgs: true },
        ];
    }

    match(_query) {
        // All work is async (needs IPC to list windows)
        return [];
    }

    async matchAsync(query) {
        const trigger = this.config.trigger || DEFAULTS.trigger;
        const lower = query.toLowerCase();

        // Must start with the trigger
        if (!lower.startsWith(trigger.toLowerCase())) return [];

        const filter = query.substring(trigger.length).toLowerCase().trim();

        // Fetch window list (cache for 500ms to avoid hammering on each keystroke)
        const now = Date.now();
        if (!this._cache || now - this._cacheTime > 500) {
            try {
                this._cache = await this.invoke('list_open_windows');
                this._cacheTime = now;
                // Fetch icons for any handles not already in our cache
                await this._fetchMissingIcons();
            } catch (e) {
                console.warn('[WindowWalker] Failed to list windows:', e);
                return [];
            }
        }

        let windows = this._listedWindows();
        if (windows.length === 0) return [];

        // Filter by title or process name
        if (filter) {
            windows = windows.filter(w =>
                w.title.toLowerCase().includes(filter) ||
                w.process_name.toLowerCase().includes(filter)
            );
        }

        return windows.map((w, i) => {
            const cachedIcon = this._iconCache.get(w.handle);
            let icon = '🪟';
            if ((this.config.show_icons ?? DEFAULTS.show_icons) && cachedIcon) {
                icon = cachedIcon;
            }
            // Hide description if it's the same as the title (common when
            // Screen Recording isn't granted — title falls back to process name)
            const description = w.process_name === w.title ? '' : w.process_name;
            return {
                id: 'window:' + w.handle,
                type: 'window',
                label: w.title,
                description,
                icon,
                score: 95 - i,
                data: { handle: w.handle, process_name: w.process_name },
            };
        });
    }

    /**
     * The cached window list, without minimized windows when the user hides
     * them and the host says which those are. On macOS without the
     * Accessibility permission the host leaves minimized windows out of the
     * list itself, whatever this setting says.
     */
    _listedWindows() {
        const windows = Array.isArray(this._cache) ? this._cache : [];
        const hide = this._hostFlagsMinimized
            && (this.config.hide_minimized ?? DEFAULTS.hide_minimized);
        return hide ? windows.filter((w) => w.minimized !== true) : windows;
    }

    /** Fetch icons for handles in the current window list that aren't cached yet. */
    async _fetchMissingIcons() {
        if (!this._cache) return;

        const missing = [];
        for (const w of this._listedWindows()) {
            if (!this._iconCache.has(w.handle)) {
                missing.push(w.handle);
            }
        }
        if (missing.length === 0) return;

        try {
            const iconMap = await this.invoke('get_window_icons', { pids: missing });
            if (iconMap && typeof iconMap === 'object') {
                for (const [handle, icon] of Object.entries(iconMap)) {
                    const handleNum = Number(handle);
                    const dataUri = icon.startsWith('data:') ? icon : 'data:image/png;base64,' + icon;
                    this._iconCacheSet(handleNum, dataUri);
                }
            }
        } catch (e) {
            console.warn('[WindowWalker] Failed to fetch icons:', e);
        }
    }

    /** Set an icon in the bounded cache, evicting oldest if at capacity. */
    _iconCacheSet(handle, icon) {
        if (this._iconCache.has(handle)) {
            // Move to end (most recent)
            this._iconCache.delete(handle);
        } else if (this._iconCache.size >= ICON_CACHE_MAX) {
            // Evict oldest (first key in Map iteration order)
            const oldest = this._iconCache.keys().next().value;
            this._iconCache.delete(oldest);
        }
        this._iconCache.set(handle, icon);
    }

    execute(result) {
        if (result.data?.handle != null) {
            this.invoke('focus_open_window', { handle: result.data.handle });
        }
        return null; // no copy/display action — the Rust side hides the window
    }

    destroy() {
        this._cache = null;
        this._iconCache.clear();
    }
}
