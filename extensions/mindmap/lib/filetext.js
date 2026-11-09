// Leaf module: imports nothing (the host rewrites one level of shared imports).
// The words for a document the user added from a file (Kage
// docs/design/EXTENSION_FILE_TEXT.md §11.9): its size, what adding it did,
// and why it wasn't added. Shared by the cards (view.js), the launcher's
// response line (search.js), the settings status (settings.js) and the
// explorer's toast (explorer.js). Strings come from the injected `t`.

const ONE_LINE_RE = /\s+/g;
const ERROR_CODES = new Set(['storage_full', 'bad_result', 'unavailable', 'not_file']);
const KNOWN_ERRORS = new Set(['readonly', 'busy', 'conflict', 'io', 'unreadable', 'not_found']);
const TOO_LARGE_KEY = 'errors.file_text.too_large';

const oneLine = (value) => String(value ?? '').replace(ONE_LINE_RE, ' ').trim();

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function fmtNum(n, locale) {
  return safe(() => Number(n || 0).toLocaleString(locale || 'en'), String(n || 0));
}

function listOf(parts, locale) {
  return safe(() => new Intl.ListFormat(locale || 'en', { type: 'conjunction' }).format(parts), parts.join(', '));
}

// "Mon, Oct 26" (with the year when it isn't this year's), as view.js shows days.
function day(ms, locale, now) {
  if (!Number.isFinite(ms)) return '';
  const year = new Date(ms).getFullYear() !== new Date(Number.isFinite(now) ? now : Date.now()).getFullYear();
  const opts = { calendar: 'gregory', weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) };
  return safe(() => new Intl.DateTimeFormat(locale || 'en', opts).format(ms), new Date(ms).toISOString().slice(0, 10));
}

/** "48,211 characters", or "12 pages, 48,211 characters", for a file ({ pages, chars }). */
export function fileSize(file, { t, locale = 'en' } = {}) {
  const chars = t('files.chars', { count: Number(file?.chars) || 0, chars: fmtNum(file?.chars, locale) });
  const pages = Number(file?.pages?.count) || 0;
  return pages ? t('files.pages_chars', { count: pages, chars }) : chars;
}

/**
 * The lines that describe adding a document (mind.js FileResult, or an op
 * card's `doc`): the headline, then what it found, then notes (the first N
 * characters were kept, no text, pages skipped, private because it may hold
 * a password or key). opts.fmtDay(ms, locale, { now }) formats the day a
 * doc was added; without it, a short Intl date. → string[]
 */
export function fileLines(info, { t, locale = 'en', now, fmtDay } = {}) {
  if (!info?.file) return [];
  const file = info.file;
  const name = oneLine(file.name) || oneLine(info.title) || '…';
  const title = oneLine(info.title) || name;
  const out = [];
  switch (info.case) {
    case 'new': out.push(t('files.card.added', { name, size: fileSize(file, { t, locale }) })); break;
    case 'update': out.push(t('files.card.updated', { name, size: fileSize(file, { t, locale }) })); break;
    case 'copy': out.push(t('files.card.copy_of', { title })); break;
    case 'unchanged': out.push(t('files.card.unchanged', { title })); break;
    case 'same': {
      const date = typeof fmtDay === 'function' ? safe(() => fmtDay(info.addedAt, locale, { now }), '') : day(info.addedAt, locale, now);
      out.push(t('files.card.same', { date }));
      break;
    }
    default: return out;
  }
  if (info.case !== 'new' && info.case !== 'update') return out;
  const f = info.found;
  if (f) {
    const parts = [];
    if (f.people) parts.push(t('files.found.people', { n: f.people }));
    if (f.teams) parts.push(t('files.found.teams', { n: f.teams }));
    if (f.projects) parts.push(t('files.found.projects', { n: f.projects }));
    if (f.topics) parts.push(t('files.found.topics', { n: f.topics }));
    if (f.actions) parts.push(t('files.found.actions', { n: f.actions }));
    if (parts.length) out.push(t('files.card.found', { list: listOf(parts, locale) }));
  }
  const warnings = Array.isArray(file.warnings) ? file.warnings : [];
  if (warnings.includes('no_text')) out.push(t('files.card.no_text'));
  else if (file.truncated) out.push(t('files.card.truncated', { n: fmtNum(file.chars, locale) }));
  if (warnings.includes('pages_skipped') && file.pages?.read) out.push(t('files.card.pages_skipped', { n: fmtNum(file.pages.read, locale) }));
  if (info.secret && info.private) out.push(info.keptLocal ? `${t('files.card.secret')} ${t('files.card.text_kept_local')}` : t('files.card.secret'));
  return out;
}

/**
 * Why a document wasn't added, in the user's words, or '' when there is
 * nothing to say (the user closed the dialog or chose "Not now"). out =
 * mind.addFile's { ok: false, code, message?, key? }; Kage's own message is
 * already in the user's language.
 */
export function fileErrorText(out, { t } = {}) {
  const code = out?.code;
  if (!code || code === 'cancelled') return '';
  if (code === 'host') {
    const message = oneLine(out.message) || t('err.generic');
    return out.key === TOO_LARGE_KEY ? `${message} ${t('files.error.too_large_hint')}` : message;
  }
  // i18n-keys: files.error.storage_full, files.error.bad_result, files.error.unavailable, files.error.not_file
  if (ERROR_CODES.has(code)) return t(`files.error.${code}`);
  if (code === 'bad_file') return t('files.error.bad_result');
  // i18n-keys: err.readonly, err.busy, err.conflict, err.io, err.unreadable, err.not_found
  return KNOWN_ERRORS.has(code) ? t(`err.${code}`) : t('err.generic');
}
