// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Compatibility defaults for older hosts. These equal manifest.config, and
// `npm run check:defaults` keeps the two (and every settings control's
// `default`) in step. Once the minimum supported Kage includes
// 'config.manifest_defaults', the control defaults and the `?? DEFAULTS.x`
// fallbacks can go.
export const DEFAULTS = Object.freeze({
  my_names: '',
  week_start: 'auto',
  fetch_link_titles: true,
  record_source_window: true,
  new_items_private: false,
  auto_accept_inferred: false,
  agent_tools: true,
  agent_snippet_chars: 280,
  trigger: 'mm',
});

// Operational bounds (SPEC §7.2, §11, §12), not settings.
export const LIMITS = Object.freeze({
  snippetMin: 80,
  snippetMax: 600,
  searchDefault: 8,
  searchMax: 20,
  actionsDefault: 30,
  actionsMax: 50,
  askRecords: 8,
  organizeItems: 15,
  organizeChars: 600,
  organizeVocabulary: 50,
  toolBytes: 8000,
  getText: 4000,
  captureText: 8000,
  launcherSnippet: 90,
  recentRows: 10,
  findRows: 8,
  formatterWaitMs: 1500,
  syncMaxAgeMs: 1500,
  toolTimeoutMs: 15000,
});

export const WEEK_STARTS = Object.freeze(['auto', 'mon', 'sun', 'sat']);
export const TRIGGER_RE = /^[a-z][a-z0-9]{0,9}$/;

/** The configured trigger word, or the default when the stored one is unusable. */
export function triggerOf(config = {}) {
  const raw = String(config.trigger ?? DEFAULTS.trigger).trim().toLowerCase();
  return TRIGGER_RE.test(raw) ? raw : DEFAULTS.trigger;
}

/** Snippet length for agent payloads, clamped to the settings bounds. */
export function snippetChars(config = {}) {
  const n = Number(config.agent_snippet_chars ?? DEFAULTS.agent_snippet_chars);
  if (!Number.isFinite(n)) return DEFAULTS.agent_snippet_chars;
  return Math.min(LIMITS.snippetMax, Math.max(LIMITS.snippetMin, Math.round(n)));
}
