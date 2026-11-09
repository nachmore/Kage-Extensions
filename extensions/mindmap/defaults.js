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
  doc_max_chars: '200000',
  background_organize: false,
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
  // Documents the user picks (Kage EXTENSION_FILE_TEXT §11).
  bodyBudget: 64 * 1024 * 1024,
  bodyWarnRatio: 0.9,
  bodyCache: 8,
  docTextPage: 10000,
  rowPassageChars: 160,
  toolPassages: 3,
  toolPassageChars: 400,
  toolBodyLoads: 5,
  // Background organizing (Kage EXTENSION_AGENT_CALLS §11.2): a batch 60 s
  // after the last capture and every 10 minutes while loaded; a rate or
  // pause refusal without a time waits 15 minutes; the background's undo
  // snapshots keep at most 64 KB of the 256 KB journal (older batches lose
  // Undo organizing first, so they never push out the user's own undo).
  organizeDebounceMs: 60_000,
  organizeEveryMs: 10 * 60_000,
  organizeWaitMs: 15 * 60_000,
  organizeUndoBytes: 64 * 1024,
  organizeToolWarnMs: 24 * 60 * 60_000,
});

export const WEEK_STARTS = Object.freeze(['auto', 'mon', 'sun', 'sat']);
// "Keep up to … characters of each file" (manifest config.doc_max_chars.enum).
// Strings, because a settings select stores its value as a string.
export const DOC_MAX_CHARS = Object.freeze(['50000', '200000', '1000000']);

/** The configured document character limit as a number (one of DOC_MAX_CHARS). */
export function docMaxChars(config = {}) {
  const raw = String(config.doc_max_chars ?? DEFAULTS.doc_max_chars).trim();
  return Number(DOC_MAX_CHARS.includes(raw) ? raw : DEFAULTS.doc_max_chars);
}

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
