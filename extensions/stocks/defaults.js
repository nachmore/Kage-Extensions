/**
 * Compatibility defaults for older hosts. These equal manifest.config.
 * Once the minimum supported Kage includes 'config.manifest_defaults',
 * this file, the control defaults, and the config fallbacks can go.
 */
export const DEFAULTS = Object.freeze({
  provider: 'finnhub',
  watchlist: 'AAPL MSFT NVDA',
  refresh_seconds: 300,
  show_watchlist: true,
  agent_tools: false,
});

// Operational bounds, not additional settings defaults.
export const MIN_REFRESH_SECONDS = 60;
export const MAX_REFRESH_SECONDS = 3600;
export const MAX_PER_MINUTE = 40;

export function refreshSeconds(config = {}) {
  const n = Number(config.refresh_seconds ?? DEFAULTS.refresh_seconds);
  return Number.isFinite(n)
    ? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, n))
    : DEFAULTS.refresh_seconds;
}
