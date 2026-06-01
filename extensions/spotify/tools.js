// Spotify tool provider — exposes "what am I listening to" + control to
// the LLM agent. Lets the user say things like "queue up some chillhop"
// in chat and have it actually happen, without leaving Kage.

import * as auth from './auth.js';

export default class SpotifyToolProvider {
    initialize(context) {
        auth.init(context);
        this.invoke = context.invoke;
        this.config = context.config || {};
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    getTools() {
        return [
            {
                name: 'spotify_now_playing',
                description:
                    'Get what is currently playing on the user\'s Spotify (track, artists, album, ' +
                    'progress, device, like-state). Returns null if nothing is playing.',
                parameters: {},
            },
            {
                name: 'spotify_play_search',
                description:
                    'Search Spotify and start playing the top track match on the active device. ' +
                    'Returns the track that started playing.',
                parameters: {
                    query: { type: 'string', description: 'Track / artist / phrase to search for' },
                },
            },
            {
                name: 'spotify_queue_search',
                description:
                    'Search Spotify and add the top track match to the current queue. Returns the queued track.',
                parameters: {
                    query: { type: 'string', description: 'Track / artist / phrase to search for' },
                },
            },
            {
                name: 'spotify_like_current',
                description: 'Save the currently-playing track to the user\'s library.',
                parameters: {},
            },
            {
                name: 'spotify_unlike_current',
                description: 'Remove the currently-playing track from the user\'s library.',
                parameters: {},
            },
            {
                name: 'spotify_pause',
                description: 'Pause playback on the active device.',
                parameters: {},
            },
            {
                name: 'spotify_resume',
                description: 'Resume playback on the active device.',
                parameters: {},
            },
            {
                name: 'spotify_skip_next',
                description: 'Skip to the next track.',
                parameters: {},
            },
            {
                name: 'spotify_skip_prev',
                description: 'Go to the previous track.',
                parameters: {},
            },
            {
                name: 'spotify_set_volume',
                description: 'Set the active device volume to a percent 0..100.',
                parameters: {
                    percent: { type: 'number', description: 'Volume percent, 0 to 100' },
                },
            },
            {
                name: 'spotify_list_playlists',
                description: 'List the user\'s playlists (id, name, owner, track count).',
                parameters: {},
            },
            {
                name: 'spotify_play_playlist',
                description: 'Play a playlist whose name matches the given query (case-insensitive).',
                parameters: {
                    query: { type: 'string', description: 'Playlist name (substring match)' },
                },
            },
            {
                name: 'spotify_list_devices',
                description:
                    "List the user's Spotify Connect devices (phone, speaker, browser, etc.). " +
                    'Useful when a play/pause/skip command fails with "no active device" — call ' +
                    'this to see what is online, then ask the user which to target.',
                parameters: {},
            },
        ];
    }

    async execute(toolName, params) {
        try {
            if (!(await auth.isConnected())) {
                return { error: 'Spotify is not connected. Tell the user to open the extension settings and click Connect.' };
            }
            const r = await this._dispatch(toolName, params || {});
            return { result: r };
        } catch (e) {
            return { error: e?.message || String(e) };
        }
    }

    async _dispatch(name, p) {
        switch (name) {
            case 'spotify_now_playing': {
                const s = await auth.api('GET', '/me/player');
                if (!s || !s.item) return null;
                let liked = null;
                try {
                    const arr = await auth.api('GET', `/me/tracks/contains?ids=${s.item.id}`);
                    liked = Array.isArray(arr) ? !!arr[0] : null;
                } catch {}
                return {
                    is_playing: !!s.is_playing,
                    progress_ms: s.progress_ms,
                    track: {
                        id: s.item.id,
                        name: s.item.name,
                        artists: (s.item.artists || []).map((a) => a.name),
                        album: s.item.album?.name,
                        duration_ms: s.item.duration_ms,
                        url: s.item.external_urls?.spotify,
                        liked,
                    },
                    device: s.device
                        ? {
                              name: s.device.name,
                              type: s.device.type,
                              volume_percent: s.device.volume_percent,
                          }
                        : null,
                };
            }
            case 'spotify_play_search': {
                const q = String(p.query || '').trim();
                if (!q) throw new Error('query is required');
                const search = await auth.api(
                    'GET',
                    `/search?type=track&limit=1&q=${encodeURIComponent(q)}`
                );
                const track = search?.tracks?.items?.[0];
                if (!track) throw new Error(`No Spotify match for "${q}".`);
                await auth.playerApi(
                    'PUT',
                    '/me/player/play',
                    { body: { uris: [track.uri] } },
                    { willStartPlaying: true }
                );
                return { id: track.id, name: track.name, artists: track.artists.map((a) => a.name) };
            }
            case 'spotify_queue_search': {
                const q = String(p.query || '').trim();
                if (!q) throw new Error('query is required');
                const search = await auth.api(
                    'GET',
                    `/search?type=track&limit=1&q=${encodeURIComponent(q)}`
                );
                const track = search?.tracks?.items?.[0];
                if (!track) throw new Error(`No Spotify match for "${q}".`);
                await auth.playerApi(
                    'POST',
                    `/me/player/queue?uri=${encodeURIComponent(track.uri)}`,
                    undefined,
                    { willStartPlaying: false }
                );
                return { id: track.id, name: track.name, artists: track.artists.map((a) => a.name) };
            }
            case 'spotify_like_current':
            case 'spotify_unlike_current': {
                const state = await auth.api('GET', '/me/player');
                const trackId = state?.item?.id;
                if (!trackId) throw new Error('Nothing is playing.');
                const want = name === 'spotify_like_current';
                await auth.api(want ? 'PUT' : 'DELETE', `/me/tracks?ids=${trackId}`);
                return { liked: want, track_id: trackId };
            }
            case 'spotify_pause':
                await auth.playerApi('PUT', '/me/player/pause', undefined, {
                    willStartPlaying: false,
                });
                return { ok: true };
            case 'spotify_resume':
                await auth.playerApi('PUT', '/me/player/play', undefined, {
                    willStartPlaying: true,
                });
                return { ok: true };
            case 'spotify_skip_next':
                await auth.playerApi('POST', '/me/player/next');
                return { ok: true };
            case 'spotify_skip_prev':
                await auth.playerApi('POST', '/me/player/previous');
                return { ok: true };
            case 'spotify_set_volume': {
                const n = Number(p.percent);
                if (!Number.isFinite(n) || n < 0 || n > 100) {
                    throw new Error('percent must be 0..100');
                }
                await auth.playerApi(
                    'PUT',
                    `/me/player/volume?volume_percent=${Math.round(n)}`,
                    undefined,
                    { willStartPlaying: false }
                );
                return { ok: true, percent: Math.round(n) };
            }
            case 'spotify_list_playlists': {
                const lists = await auth.api('GET', '/me/playlists?limit=50');
                return (lists?.items || []).map((p) => ({
                    id: p.id,
                    name: p.name,
                    owner: p.owner?.display_name,
                    track_count: p.tracks?.total,
                    public: !!p.public,
                }));
            }
            case 'spotify_play_playlist': {
                const lower = String(p.query || '').trim().toLowerCase();
                if (!lower) throw new Error('query is required');
                const lists = await auth.api('GET', '/me/playlists?limit=50');
                const candidates = (lists?.items || []).filter((pl) =>
                    pl.name.toLowerCase().includes(lower)
                );
                if (candidates.length === 0) throw new Error(`No playlist matching "${p.query}".`);
                const exact = candidates.find((pl) => pl.name.toLowerCase() === lower);
                const target = exact || candidates[0];
                await auth.playerApi(
                    'PUT',
                    '/me/player/play',
                    { body: { context_uri: target.uri } },
                    { willStartPlaying: true }
                );
                return { id: target.id, name: target.name };
            }
            case 'spotify_list_devices': {
                return await auth.listDevices();
            }
        }
        throw new Error(`Unknown Spotify tool: ${name}`);
    }
}
