// Weather — current conditions + 3-day forecast.
//
// Geocoding: nominatim.openstreetmap.org (free, no key, requires a UA header)
// Forecast:  api.open-meteo.com (free, no key, no usage limits for personal use)
//
// Geocodes are cached on disk (extension-data/geocode_cache.json) so
// repeated queries don't hammer Nominatim. Forecasts are cached for
// 10 minutes.

const GEO_CACHE_KEY = 'geocode_cache';
const FCAST_CACHE_KEY = 'forecast_cache';
const FCAST_TTL_MS = 10 * 60 * 1000;
const UA = 'Kage Weather Extension (https://github.com/nachmore/Kage-Extensions)';

const WMO_ICONS = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌧️',
    61: '🌦️', 63: '🌧️', 65: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '❄️',
    80: '🌦️', 81: '🌧️', 82: '⛈️',
    95: '⛈️', 96: '⛈️', 99: '⛈️',
};

export default class WeatherSearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.log = context.log;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        this._memCache = new Map();
    }
    // i18n-keys: wmo.*
    _wmo(code) {
        const known = WMO_ICONS[code];
        // Dynamic lookup against `wmo.<numeric WMO code>` keys in
        // _locales/en/messages.json. The CI i18n-checker doesn't see
        // these as referenced (template literal beats the static
        // analyzer), so the hint comment above whitelists every
        // `wmo.*` key as in-use.
        return {
            icon: known || '🌡️',
            label: known ? this.t(`wmo.${code}`) : this.t('wmo.unknown'),
        };
    }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const trigger = (this.config.trigger || 'weather').toLowerCase();
        const trimmed = query.trim();
        if (!trimmed.toLowerCase().startsWith(trigger)) return [];
        const rest = trimmed.slice(trigger.length).trim();
        const place = rest || (this.config.home_location || '').trim();
        if (!place) {
            return [{
                id: 'weather:no-location',
                type: 'weather',
                label: this.t('result.no_location.label'),
                description: this.t('result.no_location.description'),
                icon: '🌤️',
                score: 80,
                data: { config: true },
            }];
        }
        return [{
            id: `weather:${place}`,
            type: 'weather',
            label: this.t('result.lookup.label', { place }),
            description: this.t('result.lookup.description'),
            icon: '🌤️',
            score: 90,
            data: { place, pending: true },
        }];
    }

    async matchAsync(query) {
        const trigger = (this.config.trigger || 'weather').toLowerCase();
        const trimmed = query.trim();
        if (!trimmed.toLowerCase().startsWith(trigger)) return [];
        const rest = trimmed.slice(trigger.length).trim();
        const place = rest || (this.config.home_location || '').trim();
        if (!place) return [];

        try {
            const geo = await this._geocode(place);
            if (!geo) {
                return [{
                    id: `weather:${place}:miss`,
                    type: 'weather',
                    label: this.t('result.lookup.label', { place }),
                    description: this.t('result.miss.description'),
                    icon: '❓',
                    score: 80,
                    data: { error: 'not-found' },
                }];
            }
            const fcast = await this._forecast(geo);
            const units = this.config.units || 'metric';
            const tempUnit = units === 'imperial' ? '°F' : '°C';
            const cur = fcast.current;
            const code = cur.weather_code;
            const desc = this._wmo(code);
            const temp = units === 'imperial' ? cToF(cur.temperature_2m) : cur.temperature_2m;
            const feels = units === 'imperial' ? cToF(cur.apparent_temperature) : cur.apparent_temperature;

            const dailyRows = (fcast.daily?.time || []).slice(0, 3).map((day, i) => {
                const dCode = fcast.daily.weather_code[i];
                const dDesc = this._wmo(dCode);
                const hi = units === 'imperial' ? cToF(fcast.daily.temperature_2m_max[i]) : fcast.daily.temperature_2m_max[i];
                const lo = units === 'imperial' ? cToF(fcast.daily.temperature_2m_min[i]) : fcast.daily.temperature_2m_min[i];
                const dayName = i === 0 ? this.t('result.day.today') : new Date(day).toLocaleDateString(undefined, { weekday: 'short' });
                return `${dDesc.icon} ${dayName} ${Math.round(hi)}/${Math.round(lo)}${tempUnit}`;
            });

            const label = `${desc.icon} ${Math.round(temp)}${tempUnit} · ${desc.label} · ${geo.display}`;
            const description = `${this.t('result.feels_like', { temp: Math.round(feels), unit: tempUnit })} · ${dailyRows.join(' · ')}`;
            return [{
                id: `weather:${place}`,
                type: 'weather',
                label,
                description,
                icon: desc.icon,
                score: 95,
                data: { label, description, place, geo, fcast },
            }];
        } catch (e) {
            this.log?.warn?.('Weather lookup failed: ' + (e?.message || e));
            return [];
        }
    }

    execute(result) {
        if (result?.data?.error || result?.data?.config) {
            return { type: 'custom', data: { error: 'configure' } };
        }
        const text = `${result.label}\n${result.description}`;
        return { type: 'copy', value: text };
    }

    async _geocode(place) {
        const key = place.toLowerCase();
        if (this._memCache.has(key)) return this._memCache.get(key);
        const cached = await this._readCache(GEO_CACHE_KEY);
        if (cached && cached[key]) {
            this._memCache.set(key, cached[key]);
            return cached[key];
        }
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
        const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`Geocode HTTP ${resp.status}`);
        const arr = await resp.json();
        if (!Array.isArray(arr) || arr.length === 0) {
            this._memCache.set(key, null);
            return null;
        }
        const r = arr[0];
        const geo = {
            lat: parseFloat(r.lat),
            lon: parseFloat(r.lon),
            display: r.display_name?.split(',').slice(0, 2).join(',').trim() || place,
        };
        this._memCache.set(key, geo);
        const next = { ...(cached || {}), [key]: geo };
        await this._writeCache(GEO_CACHE_KEY, next);
        return geo;
    }

    async _forecast(geo) {
        const cacheKey = `${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}`;
        const cached = await this._readCache(FCAST_CACHE_KEY);
        if (cached && cached[cacheKey] && cached[cacheKey].ts > Date.now() - FCAST_TTL_MS) {
            return cached[cacheKey].data;
        }
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
            `&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m` +
            `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
            `&forecast_days=3&timezone=auto`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Forecast HTTP ${resp.status}`);
        const data = await resp.json();
        const next = { ...(cached || {}), [cacheKey]: { ts: Date.now(), data } };
        await this._writeCache(FCAST_CACHE_KEY, next);
        return data;
    }

    async _readCache(key) {
        try {
            const raw = await this.invoke('load_extension_data', { key });
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    async _writeCache(key, data) {
        try {
            await this.invoke('save_extension_data', { key, data: JSON.stringify(data) });
        } catch {}
    }
}

function cToF(c) { return c * 9 / 5 + 32; }
