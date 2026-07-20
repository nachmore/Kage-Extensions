// Spotify now-playing widget — sits in the floating-bottom slot.
//
// Polls /me/player at the user-configured cadence (default 5s) and
// renders a one-line bar with art + title + artist + transport buttons.
// Hidden when nothing is playing or the user isn't signed in (we
// surface settings + connect via the cheat-sheet search shortcut
// instead, so the bar doesn't nag).

import * as auth from './auth.js';

// How many consecutive auth-classified poll failures before the widget
// shows the "disconnected — reconnect" affordance. >1 so a lone blip that
// happens to look like an auth error never flashes the bar; at the default
// 15s cadence, 2 means the bar appears ~30s after a genuine revocation.
const AUTH_FAIL_THRESHOLD = 2;

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[c]);
}

export default class SpotifyNowPlayingWidget {
    initialize(context) {
        auth.init(context);
        this.invoke = context.invoke;
        this.log = context.log;
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        this._lastTrackId = null;
        this._liked = null;
        // Consecutive critical (auth) poll failures. We only surface the
        // "disconnected" affordance once this crosses AUTH_FAIL_THRESHOLD,
        // so a single transient hiccup that happens to classify as auth
        // never flashes the bar. Reset to 0 on any successful poll.
        this._authFailStreak = 0;
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    getRefreshInterval() {
        if (!this.config.show_now_playing_bar) return 0;
        const s = Number(this.config.refresh_seconds);
        // Default 15s — a balance between "feels live" and "doesn't
        // hammer Spotify's rate limit." Spotify doesn't publish exact
        // numbers, but the per-app sliding window kicks in around the
        // 100/min mark for the current-playback endpoints; at the
        // previous 5s default, a single user idling Kage for an hour
        // would have spent ~720 of those just on the widget. 15s
        // halves that to ~240, leaving headroom for the actual
        // user-driven calls. Lower if you want snappier track-change
        // updates; the floor is 2s.
        return Number.isFinite(s) && s >= 2 ? s * 1000 : 15000;
    }

    async render() {
        if (!this.config.show_now_playing_bar) return null;
        // Fail fast when the browser knows it's offline — skip the network
        // attempt entirely rather than burning a connect timeout. A false
        // `onLine` (captive portal, VPN flap) just means the api() call
        // below times out via fetchWithTimeout, which is still fast.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
        if (!(await auth.isConnected())) return null;

        let state;
        try {
            state = await auth.api('GET', '/me/player');
        } catch (e) {
            this.log?.warn?.('Spotify widget fetch failed: ' + (e?.message || e));
            // Only a *critical* auth failure (revoked/expired token) warrants
            // an affordance — and only after it repeats, so a transient blip
            // never flashes the bar. Network/unknown errors are left silent:
            // they're usually momentary, and true offline is covered by the
            // host's own connectivity bar (we also short-circuit on
            // navigator.onLine above), so a Spotify-specific banner would
            // double up.
            if (auth.classifyError(e) === 'auth') {
                this._authFailStreak += 1;
                if (this._authFailStreak >= AUTH_FAIL_THRESHOLD) {
                    return this._renderDisconnected();
                }
            }
            // Below threshold, or a non-critical error: render nothing and
            // wait for the next poll to confirm.
            return null;
        }

        // A successful poll means we're connected — clear any failure streak
        // so a later blip starts counting fresh.
        this._authFailStreak = 0;

        if (!state || !state.item) return null;

        const track = state.item;
        const trackId = track.id;
        const isPlaying = !!state.is_playing;

        // A search command (e.g. `sp like`) mutated state we render since the
        // last paint. Drop the per-track like cache so the block below re-reads
        // it — otherwise a like/unlike issued from the launcher wouldn't flip
        // the heart until the track changed. `_lastTrackId` is cleared too so
        // the trackId comparison always re-fetches even for the same track.
        if (auth.consumeStateDirty()) {
            this._lastTrackId = null;
            this._liked = null;
        }

        // Like-state: cache per-track to avoid a per-tick check call
        // when nothing's changed.
        if (trackId !== this._lastTrackId) {
            this._lastTrackId = trackId;
            this._liked = null;
            try {
                const arr = await auth.api('GET', `/me/tracks/contains?ids=${trackId}`);
                this._liked = Array.isArray(arr) ? !!arr[0] : null;
            } catch {
                this._liked = null;
            }
        }

        const artists = (track.artists || []).map((a) => a.name).join(', ');
        const albumArt = track?.album?.images?.find((i) => i.height && i.height <= 64)?.url
            || track?.album?.images?.[0]?.url
            || '';
        const title = track.name || '';

        const playPauseLabel = isPlaying ? '⏸' : '▶';
        const playPauseAction = isPlaying ? 'pause' : 'play';
        const likeLabel = this._liked ? '♥' : '♡';
        const likeAction = this._liked ? 'unlike' : 'like';
        const likeTitle = this._liked ? this.t('widget.like.remove_tooltip') : this.t('widget.like.add_tooltip');
        const playPauseTitle = isPlaying ? this.t('widget.pause_tooltip') : this.t('widget.resume_tooltip');
        const prevTitle = this.t('widget.previous_tooltip');
        const nextTitle = this.t('widget.next_tooltip');

        const html = `
            <span class="extension-bar-icon spotify-art">
                ${albumArt ? `<img src="${escapeHtml(albumArt)}" alt="" class="spotify-art-img" />` : '🎧'}
            </span>
            <span class="extension-bar-text spotify-text">
                <span class="spotify-track">${escapeHtml(title)}</span>
                <span class="spotify-artist">${escapeHtml(artists)}</span>
            </span>
            <div class="extension-bar-controls spotify-controls">
                <button data-ext-action="prev" class="extension-bar-btn" title="${escapeHtml(prevTitle)}">⏮</button>
                <button data-ext-action="${playPauseAction}" class="extension-bar-btn" title="${escapeHtml(playPauseTitle)}">${playPauseLabel}</button>
                <button data-ext-action="next" class="extension-bar-btn" title="${escapeHtml(nextTitle)}">⏭</button>
                <button data-ext-action="${likeAction}" class="extension-bar-btn spotify-like ${this._liked ? 'is-liked' : ''}" title="${escapeHtml(likeTitle)}">${likeLabel}</button>
            </div>
        `;

        return {
            className: 'extension-bar spotify-bar',
            html,
            actions: [
                { id: 'prev', rpc: 'prev' },
                { id: 'play', rpc: 'play' },
                { id: 'pause', rpc: 'pause' },
                { id: 'next', rpc: 'next' },
                { id: 'like', rpc: 'like' },
                { id: 'unlike', rpc: 'unlike' },
            ],
        };
    }

    /**
     * The "disconnected — reconnect" bar. Shown only after repeated auth
     * failures (see render()'s catch). Deliberately minimal: an icon, a
     * short message, and a refresh-glyph button (localized "Reconnect"
     * lives in the tooltip — text overflows the square bar buttons).
     */
    _renderDisconnected() {
        const msg = this.t('widget.disconnected.message');
        const reconnect = this.t('widget.disconnected.reconnect');
        const html = `
            <span class="extension-bar-icon spotify-art spotify-art-warn">⚠️</span>
            <span class="extension-bar-text spotify-text">
                <span class="spotify-track">${escapeHtml(msg)}</span>
            </span>
            <div class="extension-bar-controls spotify-controls">
                <button data-ext-action="reconnect" class="extension-bar-btn spotify-reconnect" title="${escapeHtml(reconnect)}">↻</button>
            </div>
        `;
        return {
            className: 'extension-bar spotify-bar spotify-bar-disconnected',
            html,
            actions: [{ id: 'reconnect', rpc: 'reconnect' }],
        };
    }

    async onAction(action) {
        // Reconnect drives the browser OAuth + loopback flow, which can take
        // far longer than the host's 10s widget-RPC timeout (the user has to
        // consent in a browser tab). Fire-and-forget so this RPC returns
        // immediately; the next successful poll clears the failure streak and
        // swaps the disconnected bar back to the now-playing view.
        if (action === 'reconnect') {
            auth.startSignIn().catch((e) => {
                this.log?.warn?.('Spotify reconnect failed: ' + (e?.message || e));
            });
            return { rerender: false };
        }
        try {
            switch (action) {
                case 'prev':
                    await auth.playerApi('POST', '/me/player/previous');
                    break;
                case 'next':
                    await auth.playerApi('POST', '/me/player/next');
                    break;
                case 'play':
                    await auth.playerApi('PUT', '/me/player/play', undefined, {
                        willStartPlaying: true,
                    });
                    break;
                case 'pause':
                    await auth.playerApi('PUT', '/me/player/pause', undefined, {
                        willStartPlaying: false,
                    });
                    break;
                case 'like':
                case 'unlike': {
                    if (!this._lastTrackId) break;
                    const path = `/me/tracks?ids=${this._lastTrackId}`;
                    // like/unlike doesn't need a device — operates on
                    // the user's library, not on a player.
                    await auth.api(action === 'like' ? 'PUT' : 'DELETE', path);
                    this._liked = action === 'like';
                    break;
                }
            }
        } catch (e) {
            this.log?.warn?.('Spotify widget action failed: ' + (e?.message || e));
        }
        // Spotify's player API is eventually consistent — give the
        // service a beat to commit before we re-render, otherwise the
        // first poll after pause/play may still show the previous state.
        await new Promise((r) => setTimeout(r, 250));
        return { rerender: true };
    }
}
