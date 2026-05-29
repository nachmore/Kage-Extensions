// Spotify search provider — adds inline shortcuts to the floating window.
//
// Triggers (where `sp` is the configurable trigger word):
//   sp                -> show now-playing summary
//   sp play <query>   -> play first track matching query
//   sp queue <query>  -> queue first track matching query
//   sp like           -> like current track
//   sp unlike         -> unlike current track
//   sp next / sp prev -> skip
//   sp pause / sp play  -> toggle playback
//   sp vol <0-100>    -> set volume on active device
//   sp device <name>  -> transfer playback to a device by name
//   sp playlist <q>   -> open / play a playlist whose name matches
//
// Most actions return immediately and refresh the now-playing widget on
// the next tick — keeping each search row a single round-trip keeps
// the input feeling responsive.

import * as auth from './auth.js';

const ICON = '🎧';

export default class SpotifySearchProvider {
    initialize(context) {
        auth.init(context);
        this.invoke = context.invoke;
        this.log = context.log;
        this.config = context.config || {};
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    match(query) {
        const trigger = (this.config.trigger || 'sp').toLowerCase();
        const trimmed = query.trim();
        if (!trimmed) return [];
        const lower = trimmed.toLowerCase();
        if (!lower.startsWith(trigger)) return [];
        // Bare trigger, or trigger followed by space + rest.
        const rest = trimmed.slice(trigger.length).trim();
        const restLower = rest.toLowerCase();

        if (rest === '') {
            return [
                this._row('now', 'Spotify · Now playing', 'Show what\'s currently playing', 95),
                this._row(
                    'help',
                    'Spotify · Commands',
                    'play, queue, like, unlike, next, prev, vol, device, playlist',
                    80
                ),
            ];
        }

        // Verb-prefix dispatch.
        const [verb, ...argsParts] = rest.split(/\s+/);
        const arg = argsParts.join(' ').trim();
        const verbLower = verb.toLowerCase();

        switch (verbLower) {
            case 'now':
                return [this._row('now', 'Spotify · Now playing', 'Show what\'s currently playing', 95)];
            case 'play':
                return arg
                    ? [this._row(`play:${arg}`, `Spotify · Play "${arg}"`, 'Search Spotify and play the top result', 90)]
                    : [this._row('play', 'Spotify · Resume', 'Resume playback on the active device', 90)];
            case 'pause':
                return [this._row('pause', 'Spotify · Pause', 'Pause the active device', 90)];
            case 'queue':
                if (!arg) return [];
                return [this._row(`queue:${arg}`, `Spotify · Queue "${arg}"`, 'Add the top result to your queue', 88)];
            case 'like':
                return [this._row('like', 'Spotify · Like current track', 'Add to your saved tracks', 90)];
            case 'unlike':
                return [this._row('unlike', 'Spotify · Unlike current track', 'Remove from your saved tracks', 90)];
            case 'next':
                return [this._row('next', 'Spotify · Next track', '', 88)];
            case 'prev':
            case 'previous':
                return [this._row('prev', 'Spotify · Previous track', '', 88)];
            case 'vol':
            case 'volume': {
                const n = parseInt(arg, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100) {
                    return [this._row(`vol:${n}`, `Spotify · Set volume to ${n}%`, '', 88)];
                }
                return [];
            }
            case 'device':
                if (!arg) return [];
                return [this._row(`device:${arg}`, `Spotify · Transfer to device "${arg}"`, '', 85)];
            case 'playlist':
                if (!arg) return [];
                return [
                    this._row(`playlist:${arg}`, `Spotify · Play playlist "${arg}"`, 'Match by name', 85),
                ];
            case 'connect':
                return [this._row('connect', 'Spotify · Connect…', 'Sign in via the browser', 95)];
            case 'sign-out':
            case 'signout':
            case 'disconnect':
                return [this._row('disconnect', 'Spotify · Sign out', 'Forget your tokens', 80)];
            default: {
                // Treat the rest as a free-form play query.
                return [
                    this._row(
                        `play:${rest}`,
                        `Spotify · Play "${rest}"`,
                        'Search Spotify and play the top result',
                        82
                    ),
                ];
            }
        }
    }

    _row(id, label, description, score) {
        return {
            id: `spotify:${id}`,
            type: 'spotify',
            label,
            description,
            icon: ICON,
            score,
            data: { id },
        };
    }

    async execute(result) {
        const id = result?.data?.id || '';
        try {
            await this._dispatch(id);
        } catch (e) {
            this.log?.warn?.('Spotify action failed: ' + (e?.message || e));
            return {
                type: 'custom',
                data: { error: e?.message || String(e) },
            };
        }
        return { type: 'custom', data: { ok: true } };
    }

    async _dispatch(id) {
        if (id === 'connect') {
            await auth.startSignIn();
            return;
        }
        if (id === 'disconnect') {
            await auth.clearAll();
            return;
        }
        if (id === 'help') {
            // Surface the built-in cheat-sheet via the chat as a normal
            // search-row execute would.
            return;
        }

        if (!(await auth.isConnected())) {
            throw new Error('Not signed in to Spotify. Type "sp connect" to sign in.');
        }

        if (id === 'now') {
            // The widget already polls; nothing to do here. We return
            // success and the next refresh shows current state.
            return;
        }
        if (id === 'play') return await auth.api('PUT', '/me/player/play');
        if (id === 'pause') return await auth.api('PUT', '/me/player/pause');
        if (id === 'next') return await auth.api('POST', '/me/player/next');
        if (id === 'prev') return await auth.api('POST', '/me/player/previous');
        if (id === 'like') return await this._toggleLike(true);
        if (id === 'unlike') return await this._toggleLike(false);
        if (id.startsWith('vol:')) {
            const n = parseInt(id.slice(4), 10);
            return await auth.api('PUT', `/me/player/volume?volume_percent=${n}`);
        }
        if (id.startsWith('play:')) {
            const q = id.slice(5);
            return await this._playSearch(q, false);
        }
        if (id.startsWith('queue:')) {
            const q = id.slice(6);
            return await this._playSearch(q, true);
        }
        if (id.startsWith('device:')) {
            const name = id.slice(7);
            return await this._transferToDevice(name);
        }
        if (id.startsWith('playlist:')) {
            const name = id.slice(9);
            return await this._playPlaylist(name);
        }
    }

    async _toggleLike(want) {
        const state = await auth.api('GET', '/me/player');
        const trackId = state?.item?.id;
        if (!trackId) throw new Error('Nothing is playing right now.');
        const path = `/me/tracks?ids=${trackId}`;
        await auth.api(want ? 'PUT' : 'DELETE', path);
    }

    async _playSearch(query, queueOnly) {
        const search = await auth.api(
            'GET',
            `/search?type=track&limit=1&q=${encodeURIComponent(query)}`
        );
        const track = search?.tracks?.items?.[0];
        if (!track) throw new Error(`No Spotify match for "${query}".`);
        if (queueOnly) {
            await auth.api('POST', `/me/player/queue?uri=${encodeURIComponent(track.uri)}`);
        } else {
            await auth.api('PUT', '/me/player/play', {
                body: { uris: [track.uri] },
            });
        }
    }

    async _transferToDevice(name) {
        const list = await auth.api('GET', '/me/player/devices');
        const target = (list?.devices || []).find(
            (d) => d.name.toLowerCase() === name.toLowerCase()
        );
        if (!target) throw new Error(`No Spotify device named "${name}".`);
        await auth.api('PUT', '/me/player', {
            body: { device_ids: [target.id], play: true },
        });
    }

    async _playPlaylist(name) {
        const lower = name.toLowerCase();
        // Fetch up to 50 of the user's playlists and pick the closest
        // case-insensitive name match.
        const lists = await auth.api('GET', '/me/playlists?limit=50');
        const candidates = (lists?.items || []).filter((p) =>
            p.name.toLowerCase().includes(lower)
        );
        if (candidates.length === 0) {
            throw new Error(`No playlist matching "${name}".`);
        }
        // Prefer exact case-insensitive matches if present.
        const exact = candidates.find((p) => p.name.toLowerCase() === lower);
        const target = exact || candidates[0];
        await auth.api('PUT', '/me/player/play', {
            body: { context_uri: target.uri },
        });
    }
}
