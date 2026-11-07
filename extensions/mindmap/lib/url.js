// Leaf module: imports nothing (the host rewrites one level of shared imports).
// URL and path detection, canonical dedup keys, doc-likeness (SPEC §5 S3,
// F-CAP-5). Nothing here fetches or opens anything.

export const DOC_EXTENSIONS = Object.freeze(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'key', 'pages', 'numbers', 'md', 'odt', 'ods', 'odp', 'rtf']);
const DOC_EXT = new Set(DOC_EXTENSIONS);
// Extensions that end a path containing spaces ("~/Docs/a b.pdf and more").
const FILE_EXT = new Set([...DOC_EXTENSIONS, 'txt', 'csv', 'json', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'mp4', 'mov', 'mp3', 'wav', 'log', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'ipynb', 'drawio', 'fig', 'sketch', 'eml', 'msg', 'vsdx', 'one', 'epub']);
const DOC_HOST = /^(?:docs|sheets|slides|wiki)\./;
const TRACKING = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i;
const TRAILING = /[.,;:!?'"’”>]+$/;

function trimUrl(raw) {
  let url = raw;
  for (let guard = 0; guard < 8; guard++) {
    const before = url;
    url = url.replace(TRAILING, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      if (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
    }
    if (url === before) break;
  }
  return url;
}

function count(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// http(s) URLs and bare www. hosts. `url` always carries a scheme (https://
// is assumed for bare hosts); `raw` is the text as written.
export function findUrls(text) {
  const str = String(text ?? '');
  const out = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'`“”]+/gi;
  for (const m of str.matchAll(re)) {
    if (m.index > 0 && /[@./\w-]/.test(str[m.index - 1]) && !/^https?:/i.test(m[0])) continue;
    const raw = trimUrl(m[0]);
    if (/^www\.$/i.test(raw) || /^https?:\/\/$/i.test(raw)) continue;
    const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    if (!parseHttp(url)) continue;
    out.push({ url, raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

function parseHttp(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const withScheme = hasScheme ? value : 'https://' + value.replace(/^\/\//, '');
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  // Without a scheme, only something that looks like a host name counts.
  if (!hasScheme && !u.hostname.includes('.')) return null;
  return u;
}

function bareHost(u) {
  return u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

// Scheme-less dedup key: lowercase host without www. or a default port, no
// trailing slash, no fragment (except #/ and #! app routes), no tracking
// parameters, remaining parameters sorted. The original URL is kept for opening.
export function canonicalUrl(url) {
  const u = parseHttp(url);
  if (!u) return null;
  const host = bareHost(u);
  const port = u.port && u.port !== '80' && u.port !== '443' ? ':' + u.port : '';
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '/') path = '';
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k));
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  const hash = /^#[/!]/.test(u.hash) ? u.hash : '';
  return host + port + path + query + hash;
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function isDocUrl(url) {
  const u = parseHttp(url);
  if (!u) return false;
  if (DOC_HOST.test(bareHost(u))) return true;
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  if (/(?:^|\/)wiki(?:\/|$)/i.test(path)) return true;
  return DOC_EXT.has(extOf(path.replace(/\/+$/, '')));
}

export function urlHost(url) {
  const u = parseHttp(url);
  return u ? bareHost(u) : null;
}

export function urlTitleGuess(url) {
  const u = parseHttp(url);
  if (!u) return '';
  const host = bareHost(u);
  const segments = u.pathname.split('/').filter(Boolean);
  let last = segments.length ? segments[segments.length - 1] : '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep the encoded segment
  }
  return last ? `${host} › ${last}` : host;
}

// ---------------------------------------------------------------- paths

const PATH_STARTS = [
  { style: 'fileurl', re: /\bfile:\/\/[^\s<>"']+/gi },
  { style: 'unc', re: /(?<![\w\\])\\\\[\w.$-]+\\[^\s<>"'|?*]*/g },
  { style: 'win', re: /(?<![\w])[a-z]:[\\/][^<>"'|?*\n]*/gi },
  { style: 'home', re: /(?<![\w~/])~[\\/][^<>"'|?*\n]*/g },
  { style: 'posix', re: /(?<![\w~:./\\-])\/[\w.@%+-][^<>"'|?*\n]*/g },
];

// A path may contain spaces only when it reaches a known file extension:
// cut it at the first one, else at the first whitespace.
function pathExtent(candidate) {
  const firstSpace = candidate.search(/\s/);
  if (firstSpace < 0) return trimPath(candidate);
  const re = /\.([a-z0-9]{1,8})(?=$|[\s,;:!?)'"\].])/gi;
  for (const m of candidate.matchAll(re)) {
    if (FILE_EXT.has(m[1].toLowerCase())) return candidate.slice(0, m.index + m[0].length);
  }
  return trimPath(candidate.slice(0, firstSpace));
}

function trimPath(p) {
  return p.replace(/[.,;:!?)\]'"]+$/, '');
}

function overlaps(spans, start, end) {
  return spans.some((s) => start < s.end && end > s.start);
}

export function findPaths(text) {
  const str = String(text ?? '');
  const taken = findUrls(str).map(({ start, end }) => ({ start, end }));
  const out = [];
  for (const { style, re } of PATH_STARTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str))) {
      const path = style === 'fileurl' ? trimPath(m[0]) : pathExtent(m[0]);
      const start = m.index;
      const end = start + path.length;
      // Resume right after the kept part: a path cut at its extension may be
      // followed by another path on the same line.
      re.lastIndex = Math.max(end, start + 1);
      if (!path || overlaps(taken, start, end)) continue;
      if (style === 'posix' && !validPosix(path)) continue;
      if ((style === 'win' || style === 'home') && path.length < 4) continue;
      taken.push({ start, end });
      out.push({ path, start, end, style });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// "/x/y" or "/x.pdf" counts; a lone "/" or "/word" (as in "w/ /s") doesn't.
function validPosix(p) {
  const segments = p.split('/').filter(Boolean);
  if (!segments.length) return false;
  return segments.length >= 2 || FILE_EXT.has(extOf(segments[0]));
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function normalizePath(p) {
  let v = String(p ?? '').trim();
  if (!v) return '';
  let windows = false;
  if (/^file:\/\//i.test(v)) {
    const rest = v.replace(/^file:\/\//i, '');
    const slash = rest.indexOf('/');
    const host = slash < 0 ? rest : rest.slice(0, slash);
    const pathPart = decodeSafe(slash < 0 ? '' : rest.slice(slash));
    if (host && host.toLowerCase() !== 'localhost') {
      v = '\\\\' + host + pathPart.replace(/\//g, '\\');
      windows = true;
    } else if (/^\/[a-z]:/i.test(pathPart)) {
      v = pathPart.slice(1).replace(/\//g, '\\');
      windows = true;
    } else {
      v = pathPart || '/';
    }
  } else if (/^[a-z]:[\\/]/i.test(v) || v.startsWith('\\\\')) {
    windows = true;
    v = v.replace(/\//g, '\\');
  }
  if (windows) {
    const unc = v.startsWith('\\\\');
    v = (unc ? '\\\\' : '') + v.slice(unc ? 2 : 0).replace(/\\{2,}/g, '\\');
    if (v.length > 3 || unc) v = v.replace(/\\+$/, '');
    return v.toLowerCase();
  }
  v = v.replace(/\/{2,}/g, '/');
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v;
}

export function baseName(p) {
  const v = String(p ?? '').replace(/^file:\/\//i, '');
  const trimmed = v.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return decodeSafe(parts[parts.length - 1] || trimmed);
}

// A document extension, or a directory (no extension / trailing separator).
export function isDocPath(p) {
  const v = String(p ?? '').trim();
  if (!v) return false;
  if (/[\\/]$/.test(v)) return true;
  const ext = extOf(baseName(v));
  return !ext || DOC_EXT.has(ext);
}
