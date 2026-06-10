/**
 * Functional tests for the Weather provider.
 * match() is pure (trigger gating + placeholder/no-location rows). matchAsync()
 * geocodes then fetches a forecast; we route the fetch stub by host so the
 * unit conversion (°C/°F) and result shaping are exercised without network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import WeatherSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = {}, invokes = {} } = {}) {
    const base = { load_extension_data: null, save_extension_data: undefined, ...invokes };
    const { context, log } = makeContext({ config, invokes: base });
    const provider = new WeatherSearchProvider();
    provider.initialize(context);
    return { provider, log };
}

/** Route fetch by host: nominatim → geocode, open-meteo → forecast. */
function stubWeather({ geo = [{ lat: '51.5', lon: '-0.12', display_name: 'London, UK' }], forecast } = {}) {
    const fc = forecast ?? {
        current: { temperature_2m: 20, apparent_temperature: 19, weather_code: 0 },
        daily: {
            time: ['2026-06-10', '2026-06-11', '2026-06-12'],
            weather_code: [0, 3, 61],
            temperature_2m_max: [22, 18, 15],
            temperature_2m_min: [12, 10, 9],
        },
    };
    global.fetch = vi.fn(async (url) => {
        const host = new URL(url).host;
        if (host.includes('nominatim')) return { ok: true, json: async () => geo };
        if (host.includes('open-meteo')) return { ok: true, json: async () => fc };
        throw new Error('unexpected fetch ' + url);
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
});

describe('WeatherSearchProvider — match', () => {
    it('requires the trigger', () => {
        expect(setup().provider.match('hello')).toEqual([]);
    });

    it('asks for a location when none is given or configured', () => {
        const row = setup().provider.match('weather')[0];
        expect(row.data.config).toBe(true);
    });

    it('uses the configured home location for the bare trigger', () => {
        const row = setup({ config: { home_location: 'Paris' } }).provider.match('weather')[0];
        expect(row.data).toMatchObject({ place: 'Paris', pending: true });
    });

    it('returns a pending row for an explicit place', () => {
        const row = setup().provider.match('weather London')[0];
        expect(row.data).toMatchObject({ place: 'London', pending: true });
    });
});

describe('WeatherSearchProvider — matchAsync', () => {
    it('reports current temperature in metric by default', async () => {
        stubWeather();
        const rows = await setup().provider.matchAsync('weather London');
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toContain('20°C');
        expect(rows[0].label).toContain('London');
    });

    it('converts to Fahrenheit when units=imperial', async () => {
        stubWeather();
        const rows = await setup({ config: { units: 'imperial' } }).provider.matchAsync('weather London');
        // 20°C → 68°F
        expect(rows[0].label).toContain('68°F');
    });

    it('returns a miss row when geocoding finds nothing', async () => {
        stubWeather({ geo: [] });
        const rows = await setup().provider.matchAsync('weather Nowhereville');
        expect(rows[0].data.error).toBe('not-found');
    });

    it('logs and returns [] when a fetch fails', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
        const { provider, log } = setup();
        expect(await provider.matchAsync('weather London')).toEqual([]);
        expect(log.warn).toHaveBeenCalled();
    });
});

describe('WeatherSearchProvider — execute', () => {
    it('copies the rendered label + description', async () => {
        stubWeather();
        const { provider } = setup();
        const row = (await provider.matchAsync('weather London'))[0];
        const out = provider.execute(row);
        expect(out.type).toBe('copy');
        expect(out.value).toContain(row.label);
    });

    it('routes config/error rows to a configure action', () => {
        const row = setup().provider.match('weather')[0]; // no-location → config row
        expect(provider_execute(row)).toEqual({ type: 'custom', data: { error: 'configure' } });
    });
});

// Helper for the last test — fresh provider, no network needed.
function provider_execute(row) {
    return setup().provider.execute(row);
}
