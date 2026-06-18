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
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    match(query) {
        const trigger = (this.config.trigger || 'sp').toLowerCase();
        const trimmed = query.trim();
        if (!trimmed) return [];
        const lower = trimmed.toLowerCase();
        // Whole-word trigger only: the bare trigger, or the trigger
        // followed by a space + rest. A bare `startsWith(trigger)` also
        // fires on longer words that merely begin with it — e.g. with the
        // default `sp` trigger, "spotify" strips to "otify" and surfaces a
        // bogus "play otify" row. Gate on the word boundary instead.
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const rest = trimmed.slice(trigger.length).trim();
        const restLower = rest.toLowerCase();

        if (rest === '') {
            return [
                this._row('now', this.t('result.now.label'), this.t('result.now.description'), 95),
                this._row('help', this.t('result.help.label'), this.t('result.help.description'), 80),
            ];
        }

        // Verb-prefix dispatch.
        const [verb, ...argsParts] = rest.split(/\s+/);
        const arg = argsParts.join(' ').trim();
        const verbLower = verb.toLowerCase();

        switch (verbLower) {
            case 'now':
                return [this._row('now', this.t('result.now.label'), this.t('result.now.description'), 95)];
            case 'play':
                return arg
                    ? [this._row(`play:${arg}`, this.t('result.play_query.label', { query: arg }), this.t('result.play_query.description'), 90)]
                    : [this._row('play', this.t('result.resume.label'), this.t('result.resume.description'), 90)];
            case 'pause':
                return [this._row('pause', this.t('result.pause.label'), this.t('result.pause.description'), 90)];
            case 'queue':
                if (!arg) return [];
                return [this._row(`queue:${arg}`, this.t('result.queue.label', { query: arg }), this.t('result.queue.description'), 88)];
            case 'like':
                return [this._row('like', this.t('result.like.label'), this.t('result.like.description'), 90)];
            case 'unlike':
                return [this._row('unlike', this.t('result.unlike.label'), this.t('result.unlike.description'), 90)];
            case 'next':
                return [this._row('next', this.t('result.next.label'), '', 88)];
            case 'prev':
            case 'previous':
                return [this._row('prev', this.t('result.prev.label'), '', 88)];
            case 'vol':
            case 'volume': {
                const n = parseInt(arg, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100) {
                    return [this._row(`vol:${n}`, this.t('result.volume.label', { percent: n }), '', 88)];
                }
                return [];
            }
            case 'device':
                if (!arg) {
                    // Bare `sp device` — show a "Loading…" row that
                    // matchAsync replaces with one row per available
                    // Spotify Connect target. Selecting a row
                    // transfers playback and saves the choice as the
                    // preferred device for future commands.
                    return [
                        this._row(
                            'device:__loading',
                            this.t('result.device.list.loading_label'),
                            this.t('result.device.list.loading_description'),
                            90
                        ),
                    ];
                }
                return [this._row(`device:${arg}`, this.t('result.device.label', { name: arg }), '', 85)];
            case 'playlist':
                if (!arg) return [];
                return [
                    this._row(`playlist:${arg}`, this.t('result.playlist.label', { name: arg }), this.t('result.playlist.description'), 85),
                ];
            case 'connect':
                return [this._row('connect', this.t('result.connect.label'), this.t('result.connect.description'), 95)];
            case 'sign-out':
            case 'signout':
            case 'disconnect':
                return [this._row('disconnect', this.t('result.disconnect.label'), this.t('result.disconnect.description'), 80)];
            default: {
                // Treat the rest as a free-form play query.
                return [
                    this._row(
                        `play:${rest}`,
                        this.t('result.play_query.label', { query: rest }),
                        this.t('result.play_query.description'),
                        82
                    ),
                ];
            }
        }
    }

    /**
     * Async match — runs after `match()` and replaces rows whose data
     * carries `pending: true`. Used for `sp device` (no arg) to pull
     * the live device list from Spotify.
     */
    async matchAsync(query) {
        const trigger = (this.config.trigger || 'sp').toLowerCase();
        const trimmed = query.trim();
        const lower = trimmed.toLowerCase();
        // Whole-word trigger only — see match() for why a bare prefix
        // check mis-fires on words like "spotify".
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const rest = trimmed.slice(trigger.length).trim();
        const [verb, ...restParts] = rest.split(/\s+/);
        if (verb.toLowerCase() !== 'device') return [];
        if (restParts.length > 0) return []; // user typed a name; fall back to sync match

        if (!(await auth.isConnected())) return [];

        let devices;
        try {
            devices = await auth.listDevices();
        } catch (e) {
            this.log?.warn?.('Spotify device list failed: ' + (e?.message || e));
            return [
                this._row(
                    'device:__error',
                    this.t('error.device_list_failed'),
                    '',
                    70,
                    { miss: true }
                ),
            ];
        }
        if (!devices.length) {
            return [
                this._row(
                    'device:__none',
                    this.t('result.device.list.none_label'),
                    this.t('result.device.list.none_description'),
                    70,
                    { miss: true }
                ),
            ];
        }

        const pref = await auth.getPreferredDevice();
        // Sort: active device first (Spotify says is_active=true for
        // the currently-streaming target), then preferred device,
        // then everything else by name.
        devices.sort((a, b) => {
            if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
            const aPref = pref && a.id === pref.id;
            const bPref = pref && b.id === pref.id;
            if (aPref !== bPref) return aPref ? -1 : 1;
            return (a.name || '').localeCompare(b.name || '');
        });
        return devices.map((d, i) => {
            const isActive = !!d.is_active;
            const isPref = pref && d.id === pref.id;
            const detail = [d.type || '', isActive ? this.t('result.device.list.active') : null, isPref ? this.t('result.device.list.preferred') : null]
                .filter(Boolean)
                .join(' · ');
            return this._row(
                `device-id:${d.id}`,
                this.t('result.device.list.row_label', { name: d.name }),
                detail,
                90 - i,
                { deviceId: d.id, deviceName: d.name }
            );
        });
    }

    _row(id, label, description, score, extraData) {
        return {
            id: `spotify:${id}`,
            type: 'spotify',
            label,
            description,
            icon: ICON,
            score,
            data: { id, ...(extraData || {}) },
        };
    }

    async execute(result) {
        const id = result?.data?.id || '';
        // device-id rows carry the actual id in data.deviceId — let the
        // dispatch read it directly so we don't have to re-parse the
        // id string. Same for the pending placeholders.
        if (id === 'device:__loading' || id === 'device:__error' || id === 'device:__none') {
            return;
        }
        if (id.startsWith('device-id:')) {
            const data = result?.data || {};
            return await this._activateDevice(data.deviceId, data.deviceName);
        }
        try {
            await this._dispatch(id);
        } catch (e) {
            // Multiple-devices is a special case: the user wants to
            // pick, not read an error message. Re-route them into the
            // device picker by replacing the launcher input with the
            // bare `device` trigger. The picker's matchAsync then
            // streams in a row per device. Once they pick, the
            // device is saved as preferred and the next attempt at
            // the original command works without prompting again.
            if (e?.code === 'multiple_devices') {
                const trigger = (this.config.trigger || 'sp').toLowerCase();
                return { type: 'replace_input', value: `${trigger} device ` };
            }
            const wrapped = this._wrapPlayerError(e);
            this.log?.warn?.('Spotify action failed: ' + (wrapped?.message || wrapped));
            return {
                type: 'custom',
                data: { error: wrapped?.message || String(wrapped) },
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
            throw new Error(this.t('error.not_signed_in'));
        }

        if (id === 'now') {
            // The widget already polls; nothing to do here. We return
            // success and the next refresh shows current state.
            return;
        }
        // Errors propagate up to `execute()`, which routes
        // multiple_devices into the device picker via replace_input
        // and wraps everything else with `_wrapPlayerError` for a
        // friendly localised message. Keeping the try/catch here
        // would just funnel through the same logic less cleanly.
        if (id === 'play')
            return await auth.playerApi('PUT', '/me/player/play', undefined, {
                willStartPlaying: true,
            });
        if (id === 'pause')
            return await auth.playerApi('PUT', '/me/player/pause', undefined, {
                willStartPlaying: false,
            });
        if (id === 'next') return await auth.playerApi('POST', '/me/player/next');
        if (id === 'prev') return await auth.playerApi('POST', '/me/player/previous');
        if (id === 'like') return await this._toggleLike(true);
        if (id === 'unlike') return await this._toggleLike(false);
        if (id.startsWith('vol:')) {
            const n = parseInt(id.slice(4), 10);
            return await auth.playerApi(
                'PUT',
                `/me/player/volume?volume_percent=${n}`,
                undefined,
                { willStartPlaying: false }
            );
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

    _wrapPlayerError(e) {
        const code = e?.code;
        if (code === 'no_devices') return new Error(this.t('error.no_devices'));
        if (code === 'multiple_devices') {
            // Spell out the available device names so the user can
            // pick one without having to memorise/spell it from
            // their phone or speakers' label. Comma-separated, max
            // ~3 names so the floating window doesn't grow on a
            // multi-device household.
            const names = (e.devices || [])
                .map((d) => d.name)
                .slice(0, 3)
                .join(', ');
            return new Error(this.t('error.pick_device', { names }));
        }
        if (code === 'device_unavailable') {
            const name = e?.lastDevice?.name || '';
            return new Error(this.t('error.device_offline', { name }));
        }
        if (code === 'no_active_device') return new Error(this.t('error.no_active_device'));
        if (e?.reason === 'PREMIUM_REQUIRED')
            return new Error(this.t('error.premium_required'));
        return e;
    }

    async _toggleLike(want) {
        const state = await auth.api('GET', '/me/player');
        const trackId = state?.item?.id;
        if (!trackId) throw new Error(this.t('error.nothing_playing'));
        const path = `/me/tracks?ids=${trackId}`;
        await auth.api(want ? 'PUT' : 'DELETE', path);
    }

    async _playSearch(query, queueOnly) {
        const search = await auth.api(
            'GET',
            `/search?type=track&limit=1&q=${encodeURIComponent(query)}`
        );
        const track = search?.tracks?.items?.[0];
        if (!track) throw new Error(this.t('error.no_match', { query }));
        if (queueOnly) {
            await auth.playerApi(
                'POST',
                `/me/player/queue?uri=${encodeURIComponent(track.uri)}`,
                undefined,
                // Queue doesn't actually start playback if the device
                // is paused; we still want the device awake for the
                // queue to land somewhere visible.
                { willStartPlaying: false }
            );
        } else {
            await auth.playerApi(
                'PUT',
                '/me/player/play',
                { body: { uris: [track.uri] } },
                { willStartPlaying: true }
            );
        }
    }

    async _transferToDevice(name) {
        const devices = await auth.listDevices();
        const target = devices.find((d) => d.name.toLowerCase() === name.toLowerCase());
        if (!target) throw new Error(this.t('error.no_device', { name }));
        await auth.api('PUT', '/me/player', {
            body: { device_ids: [target.id], play: true },
        });
        // Remember the explicit choice so the next no-active-device
        // recovery uses this device automatically.
        await auth.setPreferredDevice(target);
    }

    /**
     * Direct activation by device id, used by the device-picker rows
     * matchAsync produces. We don't try to start playback here —
     * `play: false` keeps a paused queue paused after the transfer
     * — because the picker is itself the user's "wake up this
     * device" gesture, separate from the next play command they'll
     * issue. The picker's whole point is to make subsequent
     * commands route correctly without surprise.
     */
    async _activateDevice(deviceId, deviceName) {
        if (!deviceId) return;
        await auth.api('PUT', '/me/player', {
            body: { device_ids: [deviceId], play: false },
        });
        await auth.setPreferredDevice({ id: deviceId, name: deviceName || '' });
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
            throw new Error(this.t('error.no_playlist', { name }));
        }
        // Prefer exact case-insensitive matches if present.
        const exact = candidates.find((p) => p.name.toLowerCase() === lower);
        const target = exact || candidates[0];
        await auth.playerApi(
            'PUT',
            '/me/player/play',
            { body: { context_uri: target.uri } },
            { willStartPlaying: true }
        );
    }
}
