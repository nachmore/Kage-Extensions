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

// Generic mascot activity we emit while audio is actually playing. The
// vocabulary is the host's, not ours: 'music' — never 'spotify'. The mascot
// deliberately knows nothing about individual extensions, so anything that
// makes sound emits the same hint. Declared in manifest.json as
// `contributes.mascotActivities`; the host rejects undeclared names.
const MASCOT_ACTIVITY = 'music';

// Floor for the activity lease. The hint is a LEASE that expires (the host
// clamps it to ~15s..10min), so we must re-assert it on every poll that
// still finds playback — that's what keeps a crashed, disabled or hidden
// widget from pinning the mascot forever. The TTL has to comfortably outlive
// the poll interval or the mascot would flicker between ticks; we use 3x the
// refresh cadence, never under this floor (the cadence can be as low as 2s).
const MASCOT_TTL_FLOOR_MS = 20_000;

// How long the bar keeps showing the last track through polls that fail or
// come back empty. Spotify briefly answers 204 / no `item` mid track change,
// and a poll can stall outright; hiding on the first one made the bar vanish
// until the window was reopened. Long enough to ride out a few bad polls,
// short enough that closing Spotify still clears the bar promptly.
const HOLD_LAST_TRACK_MIN_MS = 45_000;

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
        // Optional on older hosts — every call site is optional-chained.
        this._mascot = context.mascot;
        this._lastTrackId = null;
        this._liked = null;
        // Consecutive critical (auth) poll failures. We only surface the
        // "disconnected" affordance once this crosses AUTH_FAIL_THRESHOLD,
        // so a single transient hiccup that happens to classify as auth
        // never flashes the bar. Reset to 0 on any successful poll.
        this._authFailStreak = 0;
        // Last now-playing bar we rendered, re-shown through transient misses.
        this._lastOutput = null;
        this._lastOutputAt = 0;
    }

    /**
     * A poll failed or came back empty: keep showing the last track for a
     * short grace period instead of hiding the bar, then give up.
     */
    _holdLastTrack() {
        const grace = Math.max(HOLD_LAST_TRACK_MIN_MS, this.getRefreshInterval() * 2);
        if (this._lastOutput && Date.now() - this._lastOutputAt <= grace) return this._lastOutput;
        this._lastOutput = null;
        return null;
    }

    /** Definitive "nothing to show" (signed out, bar off, offline): no grace. */
    _hide() {
        this._lastOutput = null;
        return null;
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

    /**
     * Tell the host's mascot whether something musical is happening.
     *
     * `playing === true` re-asserts the lease (called from every poll that
     * finds audio playing, so it never lapses between ticks); anything else
     * releases it immediately. Entirely best-effort: `context.mascot` is
     * absent on older hosts, and a hint is never worth failing a render
     * over — so both the sync and the async failure paths are swallowed.
     */
    _mascotActivity(playing) {
        try {
            const ttlMs = Math.max(MASCOT_TTL_FLOOR_MS, this.getRefreshInterval() * 3);
            const p = playing
                ? this._mascot?.setActivity?.(MASCOT_ACTIVITY, { ttlMs })
                : this._mascot?.clearActivity?.();
            p?.catch?.(() => {});
        } catch {
            /* no mascot, or the host rejected the hint — ignore */
        }
    }

    async render() {
        // Every path that doesn't end in "audio is playing" releases the
        // mascot lease — we only ever hold it while we can see playback.
        if (!this.config.show_now_playing_bar) {
            this._mascotActivity(false);
            return this._hide();
        }
        // Fail fast when the browser knows it's offline — skip the network
        // attempt entirely rather than burning a connect timeout. A false
        // `onLine` (captive portal, VPN flap) just means the api() call
        // below times out via fetchWithTimeout, which is still fast.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this._mascotActivity(false);
            return this._hide();
        }
        if (!(await auth.isConnected())) {
            this._mascotActivity(false);
            return this._hide();
        }

        let state;
        try {
            state = await auth.api('GET', '/me/player');
        } catch (e) {
            this.log?.warn?.('Spotify widget fetch failed: ' + (e?.message || e));
            // We can't see playback any more, so stop claiming it.
            this._mascotActivity(false);
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
                    // Persist the diagnosis so other windows agree with the
                    // bar — most visibly the settings panel, which would
                    // otherwise keep saying "Signed in" off the mere
                    // existence of the (dead) creds blob.
                    auth.markAuthRevoked().catch(() => {});
                    this._lastOutput = null;
                    return this._renderDisconnected();
                }
                // Below threshold: render nothing and let the next poll confirm.
                return null;
            }
            // A network/unknown error is usually momentary: keep the last
            // track up rather than blinking the bar out.
            return this._holdLastTrack();
        }

        // A successful poll means we're connected — clear any failure streak
        // so a later blip starts counting fresh, and retract a persisted
        // revoked marker (e.g. the user reconnected from another surface).
        this._authFailStreak = 0;
        auth.clearAuthRevoked().catch(() => {});

        if (!state || !state.item) {
            // Mid track change Spotify can briefly report nothing playing.
            this._mascotActivity(false);
            return this._holdLastTrack();
        }

        const track = state.item;
        const trackId = track.id;
        const isPlaying = !!state.is_playing;

        // Re-assert (or release) the lease on every poll: held while the
        // track is actually playing, dropped the moment it's paused.
        this._mascotActivity(isPlaying);

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

        const output = {
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
        this._lastOutput = output;
        this._lastOutputAt = Date.now();
        return output;
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
