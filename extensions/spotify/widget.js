// Spotify now-playing widget — sits in the floating-bottom slot.
//
// Polls /me/player at the user-configured cadence (default 5s) and
// renders a one-line bar with art + title + artist + transport buttons.
// Hidden when nothing is playing or the user isn't signed in (we
// surface settings + connect via the cheat-sheet search shortcut
// instead, so the bar doesn't nag).

import * as auth from './auth.js';

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
        if (!(await auth.isConnected())) return null;

        let state;
        try {
            state = await auth.api('GET', '/me/player');
        } catch (e) {
            this.log?.warn?.('Spotify widget fetch failed: ' + (e?.message || e));
            return null;
        }

        if (!state || !state.item) return null;

        const track = state.item;
        const trackId = track.id;
        const isPlaying = !!state.is_playing;

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

    async onAction(action) {
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
