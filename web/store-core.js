// Store logic shared by the browser (app.js) and the deploy-time pre-render
// (stage.mjs). Pure functions over catalog data: no DOM, no globals, no side
// effects, so Node can import it to render the same cards into index.html
// that the browser renders later.
//
// Every value that reaches markup goes through escapeHtml(); every color
// that reaches the stylesheet goes through safeColor()/safeGradient(). The
// markup has no style attributes, so it renders the same under a strict
// Content-Security-Policy (style-src 'self'). Catalog entries come from
// reviewed manifests, but the page treats them as untrusted text all the
// same.

export const REPO_URL = 'https://github.com/nachmore/Kage-Extensions';
export const KAGE_URL = 'https://nachmore.github.io/Kage/';

// User-facing capability metadata. Icons and labels mirror
// scripts/host-capabilities.mjs (a test keeps them in step); descriptions
// are the install-prompt text from Kage's ui/js/shared/extension-permissions.js,
// so the detail view says what Kage will say when you install.
export const CAPS = Object.freeze({
    storage: {
        icon: '💾',
        label: 'Storage',
        description: 'Read and write this extension’s own sandboxed data and config.',
    },
    clipboard: {
        icon: '📋',
        label: 'Clipboard',
        description: 'Read your clipboard contents and history.',
    },
    urls: {
        icon: '🔗',
        label: 'Open links',
        description:
            'Open web links (http/https) and a few safe deep links (email, phone, OS settings) in your default handler. Cannot open files or launch other apps.',
    },
    launch: {
        icon: '🚀',
        label: 'Launch apps & open files',
        description:
            'Open arbitrary file paths and launch other apps by name. Files open in their default OS handler, which can run scripts and binaries — only grant this to extensions that genuinely need to start programs.',
    },
    network: {
        icon: '📡',
        label: 'Network access',
        description:
            'Fetch URLs from outside your browser sandbox (e.g. link previews, favicons). Can reach sites your browser would refuse, including internal/intranet pages and sites that block cross-origin requests.',
    },
    oauth: {
        icon: '🔐',
        label: 'OAuth sign-in',
        description:
            'Open a one-shot loopback listener (http://127.0.0.1:<port>/...) so a third-party service like Spotify or GitHub can redirect back with a sign-in code. Only listens on this machine; the port closes as soon as the redirect arrives.',
    },
    filesystem: { icon: '📂', label: 'Filesystem', description: 'Scan folders and search files.' },
    window: {
        icon: '🪟',
        label: 'Kage windows',
        description: 'Resize, move, and adjust Kage’s own windows.',
    },
    windows: {
        icon: '🧿',
        label: 'Open windows',
        description: 'List and focus other apps’ windows.',
    },
    notifications: {
        icon: '🔔',
        label: 'Notifications',
        description: 'Show system notifications.',
    },
    calendar: {
        icon: '📅',
        label: 'Calendar',
        description: 'Read calendar events from your system.',
    },
    session: {
        icon: '💬',
        label: 'Chat sessions',
        description: 'List and read chat sessions with the agent.',
    },
    agent: {
        icon: '🤖',
        label: 'AI agent',
        description: 'Send messages to the AI agent and cancel generations.',
    },
    activity: {
        icon: '📊',
        label: 'Activity',
        description: 'Start/stop the activity tracker and read app-usage statistics.',
    },
    automation: {
        icon: '⚡',
        label: 'Automation',
        description: 'Emit signals that can trigger automations.',
    },
    tts: { icon: '🔈', label: 'Text-to-speech', description: 'Use text-to-speech voices.' },
});

// What each `contributes` key adds to Kage, in display order. Keys missing
// here (`css`) aren't worth a line in the detail view.
export const CONTRIBUTES = Object.freeze({
    searchProvider: { label: 'Launcher results', text: 'Answers in the launcher as you type.' },
    widgets: { label: 'Widgets', text: 'Live panels inside Kage’s windows.' },
    toolProvider: { label: 'Agent tools', text: 'Tools your AI agent can use.' },
    messageFormatters: { label: 'Chat formatting', text: 'Enhances replies in the chat.' },
    toolbarButtons: { label: 'Toolbar buttons', text: 'Buttons in the chat window’s toolbar.' },
    triggerProvider: { label: 'Automation triggers', text: 'Signals that can start your automations.' },
    mascotActivities: { label: 'Cat reactions', text: 'Lets the cat react to what’s going on.' },
    settingsProvider: { label: 'Settings page', text: 'Its own page in Kage’s settings.' },
    themes: { label: 'Colors', text: 'A dark and a light palette for every window.' },
});

// Browse categories. An extension belongs to every category whose words
// appear in its tags, its id or its name, so new extensions sort themselves
// as long as they're tagged sensibly. `agent` and `online` are computed
// from what the extension declares instead (see categoriesFor).
export const CATEGORIES = Object.freeze([
    {
        id: 'productivity',
        label: 'Productivity',
        icon: '✅',
        words: [
            'productivity', 'tasks', 'todo', 'todos', 'reminders', 'organizer', 'timer',
            'stopwatch', 'pomodoro', 'focus', 'calendar', 'meetings', 'snippets',
            'templates', 'bookmarks', 'shortcuts', 'window', 'windows',
        ],
    },
    {
        id: 'answers',
        label: 'Quick answers',
        icon: '⚡',
        words: [
            'math', 'calculator', 'units', 'convert', 'currency', 'money', 'fx', 'exchange',
            'finance', 'stocks', 'weather', 'forecast', 'dictionary', 'definitions',
            'spelling', 'words', 'emoji', 'unicode', 'password', 'passphrase',
        ],
    },
    {
        id: 'developer',
        label: 'Developer',
        icon: '🛠️',
        words: [
            'developer', 'code', 'github', 'repos', 'json', 'uuid', 'base64', 'hash', 'color',
            'hex', 'rgb', 'design', 'sample', 'template', 'starter',
        ],
    },
    { id: 'agent', label: 'Agent tools', icon: '🤖', words: [] },
    { id: 'online', label: 'Online', icon: '🌐', words: [] },
]);

// Extensions that talk to a web service, and which. Anything that declares
// `network` or `oauth`, or whose code makes web requests (stage.mjs checks
// at deploy time), is Online even without a note here; the note just says
// to whom.
export const ONLINE_NOTES = Object.freeze({
    currency: 'Gets exchange rates from frankfurter.dev.',
    dictionary: 'Looks words up at FreeDictionaryAPI.com, with spelling suggestions from Datamuse.',
    github: 'Searches GitHub’s API.',
    'link-preview': 'Fetches the pages that replies link to.',
    spotify: 'Talks to Spotify for your account.',
    weather: 'Gets forecasts from open-meteo.com and finds places with OpenStreetMap.',
});

// Something to type in the launcher, for the cards and the detail view.
// `null` means the extension works on its own (no typing needed). Ids not
// listed fall back to the manifest's `trigger` setting, if it has one.
export const EXAMPLES = Object.freeze({
    bookmarks: 'bm docs',
    calendar: 'cal',
    'color-picker': '#38b2ac',
    currency: '100 usd to eur',
    'dev-tools': 'uuid',
    dictionary: 'dict serendipity',
    emoji: ':fire',
    'focus-tracker': 'focus',
    github: 'gh tauri',
    'hello-world': 'hello',
    'link-preview': null,
    math: '12 km to mi',
    password: 'pw',
    snippets: 'snip',
    spotify: 'sp',
    timer: 'timer 5m',
    todos: 'todo',
    weather: 'weather lisbon',
    'window-walker': 'w notes',
});

// What Kage's setup installs. Mirrors Kage's ui/extensions/recommended.json.
export const SETUP_PICKS = Object.freeze(
    new Set([
        'math', 'calendar', 'window-walker', 'todos', 'timer', 'dev-tools', 'dictionary',
        'color-picker', 'link-preview', 'focus-tracker', 'nord-theme', 'sunset-theme',
        'kiro-ish-theme',
    ])
);

// ─── text ─────────────────────────────────────────────────────────────

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const esc = escapeHtml;

export function tokenize(query) {
    return String(query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

export function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

export function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// YYYY-MM-DD in UTC, or '' for anything that isn't a date.
export function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// ─── links ────────────────────────────────────────────────────────────

// `kage://install/<id>`. Ids are constrained at validate time to
// ^[a-z0-9][a-z0-9_-]{0,63}$; the encoding is belt and braces. Kage
// registers itself for `kage:` (tauri-plugin-deep-link): the OS launches it,
// or forwards to the running instance, and Kage offers the install.
export function installUrl(id) {
    return `kage://install/${encodeURIComponent(id)}`;
}

// The catalog's download link, but only if it's the relative
// `packages/<file>.zip` the build writes. Anything else (an absolute or
// javascript: URL) is dropped rather than linked.
export function safeDownloadUrl(url) {
    return typeof url === 'string' && /^packages\/[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$/.test(url)
        ? url
        : null;
}

export function sourceUrl(extra) {
    const path = extra?.path;
    return typeof path === 'string' && /^(extensions|themes)\/[A-Za-z0-9._-]+$/.test(path)
        ? `${REPO_URL}/tree/main/${path}`
        : null;
}

// ─── colors ───────────────────────────────────────────────────────────

const COLOR_RE =
    /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(,\s*(0|1|0?\.\d+|\d{1,3}%)\s*)?\))$/i;

export function safeColor(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return COLOR_RE.test(v) ? v : null;
}

// linear-gradient(<angle>deg, <color> [<pct>%], …) and nothing fancier.
export function safeGradient(value) {
    if (typeof value !== 'string') return null;
    const m = /^linear-gradient\(\s*(\d{1,3})deg\s*,(.+)\)$/i.exec(value.trim());
    if (!m) return null;
    const stops = m[2].split(/,(?![^(]*\))/).map((s) => s.trim());
    if (stops.length < 2) return null;
    const out = [];
    for (const stop of stops) {
        const sm = /^(.+?)(\s+(\d{1,3}(\.\d+)?)%)?$/.exec(stop);
        const color = sm && safeColor(sm[1]);
        if (!color) return null;
        out.push(sm[3] !== undefined ? `${color} ${sm[3]}%` : color);
    }
    return `linear-gradient(${m[1]}deg, ${out.join(', ')})`;
}

// A theme's `kage-*` color map → the handful of values a preview needs.
export function paletteFromColors(colors) {
    if (!colors || typeof colors !== 'object') return null;
    const pick = (k) => safeColor(colors[`kage-${k}`]);
    const accent = pick('accent');
    const bg = pick('bg');
    if (!accent || !bg) return null;
    const p = {
        accent,
        bg,
        elevated: pick('bg-elevated') || bg,
        input: pick('bg-input') || pick('bg-elevated') || bg,
        border: pick('border') || accent,
        text: pick('text') || '#e2e8f0',
        bright: pick('text-bright') || pick('text') || '#f7fafc',
        muted: pick('text-muted') || pick('text') || '#a0aec0',
        outline: pick('mascot-outline') || accent,
        invert: String(colors['kage-mascot-invert'] ?? '0') === '1' ? '1' : '0',
        gradient: safeGradient(colors['kage-gradient']) || `linear-gradient(135deg, ${accent}, ${accent})`,
    };
    return p;
}

// ─── classification ───────────────────────────────────────────────────

// What a manifest says about itself, in the shape store-extras.json uses.
// stage.mjs adds `path` and `online` (from the source tree) and `palette`
// (from a theme's color files).
export function extraFromManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return {};
    const contributes =
        manifest.contributes && typeof manifest.contributes === 'object'
            ? Object.keys(manifest.contributes).filter((k) => k in CONTRIBUTES)
            : [];
    const mascot = Array.isArray(manifest.contributes?.mascotActivities)
        ? manifest.contributes.mascotActivities.filter((a) => typeof a === 'string')
        : [];
    const trigger = manifest.config?.trigger?.default;
    return {
        contributes,
        mascot,
        trigger: typeof trigger === 'string' && trigger.trim() ? trigger.trim() : null,
    };
}

export function permissionsOf(item) {
    return Array.isArray(item?.permissions) ? item.permissions.filter((p) => typeof p === 'string') : [];
}

export function isOnline(item, extra) {
    if (extra?.online === true) return true;
    if (Object.hasOwn(ONLINE_NOTES, item?.id)) return true;
    const perms = permissionsOf(item);
    return perms.includes('network') || perms.includes('oauth');
}

export function onlineNote(item) {
    return Object.hasOwn(ONLINE_NOTES, item?.id) ? ONLINE_NOTES[item.id] : null;
}

// Something to type, or null. Returns { query } or { auto: true }.
export function exampleFor(item, extra) {
    if (Object.hasOwn(EXAMPLES, item?.id)) {
        const q = EXAMPLES[item.id];
        return q === null ? { auto: true } : { query: q };
    }
    return extra?.trigger ? { query: extra.trigger } : null;
}

function wordsOf(item) {
    const words = new Set();
    for (const t of Array.isArray(item?.tags) ? item.tags : []) {
        for (const w of String(t).toLowerCase().split(/[\s-]+/)) if (w) words.add(w);
    }
    for (const w of String(item?.id ?? '').toLowerCase().split(/[-_]+/)) if (w) words.add(w);
    for (const w of String(item?.name ?? '').toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
    return words;
}

export function categoriesFor(item, extra) {
    if (item?.type !== 'extension') return [];
    const words = wordsOf(item);
    const out = [];
    for (const c of CATEGORIES) {
        if (c.id === 'agent') {
            if (extra?.contributes?.includes('toolProvider')) out.push(c.id);
        } else if (c.id === 'online') {
            if (isOnline(item, extra)) out.push(c.id);
        } else if (c.words.some((w) => words.has(w))) {
            out.push(c.id);
        }
    }
    return out;
}

function haystack(item, extra) {
    const caps = permissionsOf(item).map((p) => CAPS[p]?.label ?? p);
    const cats = categoriesFor(item, extra).map((id) => CATEGORIES.find((c) => c.id === id)?.label);
    const ex = exampleFor(item, extra);
    return [
        item.id,
        item.name,
        item.description,
        item.author ?? '',
        item.type,
        ...(Array.isArray(item.tags) ? item.tags : []),
        ...caps,
        ...cats,
        ex?.query ?? '',
        extra?.trigger ?? '',
    ]
        .join(' ')
        .toLowerCase();
}

export function matchesQuery(item, tokens, extra) {
    if (!tokens.length) return true;
    const hay = haystack(item, extra);
    return tokens.every((t) => hay.includes(t));
}

function byName(a, b) {
    return String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
}

// The whole browse state in one call: which extensions and themes to show,
// and how many extensions each category chip would show for this query.
export function applyFilters(items, { q = '', cat = 'all' } = {}, extras = {}) {
    const tokens = tokenize(q);
    const list = Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string') : [];
    const exts = list.filter((i) => i.type === 'extension').sort(byName);
    const themes = list.filter((i) => i.type === 'theme').sort(byName);
    const hit = (i) => matchesQuery(i, tokens, extras[i.id]);
    const matching = exts.filter(hit);
    const counts = { all: matching.length };
    for (const c of CATEGORIES) {
        counts[c.id] = matching.filter((i) => categoriesFor(i, extras[i.id]).includes(c.id)).length;
    }
    const known = cat === 'all' || CATEGORIES.some((c) => c.id === cat);
    const active = known ? cat : 'all';
    return {
        cat: active,
        tokens,
        extensions:
            active === 'all'
                ? matching
                : matching.filter((i) => categoriesFor(i, extras[i.id]).includes(active)),
        themes: themes.filter(hit),
        totals: { extensions: exts.length, themes: themes.length },
        counts,
    };
}

// One sentence for the live region under the search box. A category only
// narrows the extensions; the search narrows both.
export function summaryText(result, q = '') {
    const { extensions, themes, totals, cat } = result;
    const query = String(q).trim();
    const catLabel = cat !== 'all' ? CATEGORIES.find((c) => c.id === cat)?.label : null;
    const quoted = `“${query}”`;
    if (!query && !catLabel) {
        return `${plural(totals.extensions, 'extension')} and ${plural(totals.themes, 'theme')}, all sandboxed.`;
    }
    if (!query) {
        return extensions.length ? `${plural(extensions.length, 'extension')} in ${catLabel}.` : `Nothing in ${catLabel}.`;
    }
    if (!extensions.length && !themes.length) {
        return catLabel ? `Nothing in ${catLabel} for ${quoted}.` : `Nothing found for ${quoted}.`;
    }
    const exts = `${plural(extensions.length, 'extension')}${catLabel ? ` in ${catLabel}` : ''}`;
    return `${exts} and ${plural(themes.length, 'theme')} for ${quoted}.`;
}

// ─── URL state ────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ?q=<search>&cat=<category>&ext=<id> (all optional). `type=theme` from an
// older link jumps to the themes.
export function parseQuery(search) {
    const p = new URLSearchParams(search || '');
    const q = (p.get('q') ?? '').slice(0, 200);
    const catRaw = p.get('cat') ?? 'all';
    const cat = catRaw === 'all' || CATEGORIES.some((c) => c.id === catRaw) ? catRaw : 'all';
    const extRaw = p.get('ext') ?? '';
    const ext = ID_RE.test(extRaw) ? extRaw : null;
    const type = p.get('type') === 'theme' ? 'theme' : p.get('type') === 'extension' ? 'extension' : null;
    return { q, cat, ext, type };
}

export function buildQuery({ q = '', cat = 'all', ext = null } = {}) {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (cat && cat !== 'all') p.set('cat', cat);
    if (ext) p.set('ext', ext);
    const s = p.toString();
    return s ? `?${s}` : '';
}

// ─── markup ───────────────────────────────────────────────────────────

const ico = (name, cls = '') =>
    `<svg class="ico${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function capMeta(p) {
    return CAPS[p] ?? { icon: '❓', label: p, description: 'A capability this page doesn’t know about yet.' };
}

function badgesHtml(item, extra) {
    const out = [];
    if (isOnline(item, extra)) {
        out.push(
            `<span class="badge badge--online" title="Talks to a web service">Online</span>`
        );
    }
    if (SETUP_PICKS.has(item.id)) {
        out.push(
            `<span class="badge badge--setup" title="Kage’s setup installs this one">Setup<span class="sr-only"> pick</span></span>`
        );
    }
    return out.length ? `<span class="badges">${out.join('')}</span>` : '';
}

function permsHtml(item) {
    const perms = permissionsOf(item);
    if (!perms.length) {
        return `<p class="perms perms--none" title="It doesn’t ask for any capabilities">${ico('shield')}No extra access</p>`;
    }
    const lis = perms
        .map((p) => {
            const m = capMeta(p);
            return `<li class="perm" title="${esc(m.description)}"><span aria-hidden="true">${esc(m.icon)}</span> ${esc(m.label)}</li>`;
        })
        .join('');
    return `<ul class="perms" aria-label="Access it asks for">${lis}</ul>`;
}

function actionsHtml(item, { details = true } = {}) {
    const name = esc(item.name);
    const dl = safeDownloadUrl(item.downloadUrl);
    const size = formatSize(item.size);
    return [
        `<div class="actions">`,
        `<a class="btn btn--primary btn--sm" href="${esc(installUrl(item.id))}" title="Open Kage and start the install with the permission prompt">${ico('download')}<span>Install in Kage</span><span class="sr-only">: ${name}</span></a>`,
        dl
            ? `<a class="btn btn--ghost btn--sm btn--zip" href="${esc(dl)}" download title="The extension’s .zip, to read or keep${size ? ` (${esc(size)})` : ''}">.zip<span class="sr-only"> download: ${name}${size ? `, ${esc(size)}` : ''}</span></a>`
            : '',
        details
            ? `<button type="button" class="link-btn needs-js" data-details="${esc(item.id)}" aria-haspopup="dialog">Details<span class="sr-only">: ${name}</span>${ico('arrow')}</button>`
            : '',
        `</div>`,
    ].join('');
}

function tryHtml(item, extra) {
    const ex = exampleFor(item, extra);
    if (!ex) return '';
    if (ex.auto) {
        return `<p class="try try--auto">${ico('sparkle')}Works on its own in chat replies</p>`;
    }
    return `<p class="try"><span class="sr-only">Try typing </span><code>${esc(ex.query)}</code></p>`;
}

export function cardId(id) {
    return `ext-${id}`;
}

export function extensionCardHtml(item, extra) {
    const id = esc(item.id);
    const icon = esc(item.icon || '📦');
    const by = item.author ? `by ${esc(item.author)} · ` : '';
    return [
        `<article class="card ext-card" data-spot data-id="${id}" data-v="${esc(item.version)}" id="${esc(cardId(item.id))}" aria-labelledby="${esc(cardId(item.id))}-name">`,
        `<div class="ext-card__head">`,
        `<span class="ext-card__icon" aria-hidden="true">${icon}</span>`,
        `<div class="ext-card__title"><h3 class="ext-card__name" id="${esc(cardId(item.id))}-name">${esc(item.name)}</h3>`,
        `<p class="ext-card__by">${by}<span class="ver">v${esc(item.version)}</span></p></div>`,
        badgesHtml(item, extra),
        `</div>`,
        `<p class="ext-card__desc">${esc(item.description || '')}</p>`,
        tryHtml(item, extra),
        permsHtml(item),
        actionsHtml(item),
        `</article>`,
    ].join('');
}

// A theme preview's custom properties: --d-* for its dark palette, --l-*
// for its light one, as [name, value] pairs of validated colors. A theme
// without a light palette previews its dark one in both modes; one without
// any gets nothing, and style.css falls back to Kage Dark / Kage Light
// (ui/css/shared-kage-tokens.css).
export function paletteVars(palette) {
    const dark = palette?.dark;
    if (!dark || typeof dark !== 'object') return [];
    const light = palette.light && typeof palette.light === 'object' ? palette.light : dark;
    const vars = [];
    for (const [mode, p] of [
        ['d', dark],
        ['l', light],
    ]) {
        for (const k of ['accent', 'bg', 'elevated', 'input', 'border', 'text', 'bright', 'muted', 'outline']) {
            const c = safeColor(p[k]);
            if (c) vars.push([`--${mode}-${k}`, c]);
        }
        const g = safeGradient(p.gradient);
        if (g) vars.push([`--${mode}-grad`, g]);
        vars.push([`--${mode}-invert`, p.invert === '1' ? '1' : '0']);
    }
    return vars;
}

// One rule per theme with a palette, keyed on the card's data-id, for
// stage.mjs to write into style.css: the previews get their colors from the
// stylesheet, never from a style attribute.
export function paletteCss(items, extras = {}) {
    const rules = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (item?.type !== 'theme' || typeof item.id !== 'string' || !ID_RE.test(item.id)) continue;
        const vars = paletteVars(extras[item.id]?.palette);
        if (!vars.length) continue;
        rules.push(`.theme-card[data-id="${item.id}"] {\n${vars.map(([k, v]) => `    ${k}: ${v};`).join('\n')}\n}`);
    }
    return rules.join('\n');
}

export function themeCardHtml(item, extra) {
    const id = esc(item.id);
    const palette = extra?.palette;
    const swatches = ['accent', 'bg', 'elevated', 'text', 'muted']
        .map((k) => `<span class="sw sw--${k}"></span>`)
        .join('');
    return [
        `<article class="card theme-card${palette ? '' : ' theme-card--plain'}" data-spot data-id="${id}" data-v="${esc(item.version)}" id="${esc(cardId(item.id))}" aria-labelledby="${esc(cardId(item.id))}-name">`,
        `<div class="tp" aria-hidden="true">`,
        `<div class="tp__strip"><img src="assets/mascot/kage-icon.svg" width="30" height="24" alt="" loading="lazy" decoding="async"></div>`,
        `<div class="tp__body">`,
        `<div class="tp__input"><span>${esc(String(item.name).toLowerCase())}</span><i class="tp__caret"></i></div>`,
        `<div class="tp__row tp__row--sel"><span class="tp__ico">${esc(item.icon || '🎨')}</span><span class="tp__text"><b>${esc(item.name)}</b><small>Theme · v${esc(item.version)}</small></span><span class="tp__chip">Apply</span></div>`,
        `<div class="tp__row"><span class="tp__ico">💬</span><span class="tp__text"><b>Ask the agent</b><small>Enter</small></span></div>`,
        `</div>`,
        `</div>`,
        `<div class="theme-card__body">`,
        `<div class="theme-card__head"><h3 class="ext-card__name" id="${esc(cardId(item.id))}-name"><span aria-hidden="true">${esc(item.icon || '🎨')}</span> ${esc(item.name)}</h3>${badgesHtml(item, extra)}</div>`,
        `<p class="ext-card__desc">${esc(item.description || '')}</p>`,
        palette ? `<div class="swatches" aria-hidden="true">${swatches}</div>` : '',
        actionsHtml(item),
        `</div>`,
        `</article>`,
    ].join('');
}

export function cardHtml(item, extra) {
    return item.type === 'theme' ? themeCardHtml(item, extra) : extensionCardHtml(item, extra);
}

export function categoryChipsHtml(counts, active = 'all') {
    const chip = (id, label, icon, n) =>
        `<button type="button" class="chip" data-cat="${esc(id)}" aria-pressed="${id === active}"${n === 0 && id !== active ? ' hidden' : ''}>${icon ? `<span aria-hidden="true">${esc(icon)}</span>` : ''}${esc(label)}<span class="chip__n">${n}</span></button>`;
    return [chip('all', 'All', '', counts.all ?? 0), ...CATEGORIES.map((c) => chip(c.id, c.label, c.icon, counts[c.id] ?? 0))].join('');
}

// The detail dialog's body. `extra` may be missing (no store-extras.json);
// the manifest from detail/<id>.json fills in what it can.
export function detailHtml(item, extra) {
    const isTheme = item.type === 'theme';
    const perms = permissionsOf(item);
    const size = formatSize(item.size);
    const updated = formatDate(item.updatedAt);
    const meta = [item.author ? `by ${esc(item.author)}` : '', size ? esc(size) : '', updated ? `updated ${esc(updated)}` : '']
        .filter(Boolean)
        .join(' · ');
    const ex = exampleFor(item, extra);
    const adds = (extra?.contributes ?? [])
        .filter((k) => CONTRIBUTES[k])
        .map((k) => {
            const c = CONTRIBUTES[k];
            const more =
                k === 'mascotActivities' && extra?.mascot?.length
                    ? ` (${extra.mascot.map(esc).join(', ')})`
                    : '';
            return `<li><b>${esc(c.label)}</b><span>${esc(c.text.replace(/\.$/, ''))}${more}.</span></li>`;
        })
        .join('');
    const access = perms.length
        ? `<ul class="access">${perms
              .map((p) => {
                  const m = capMeta(p);
                  return `<li><span class="access__icon" aria-hidden="true">${esc(m.icon)}</span><span><b>${esc(m.label)}</b><span>${esc(m.description)}</span></span></li>`;
              })
              .join('')}</ul>`
        : `<p class="access-none">${ico('shield')}<span>${
              isTheme
                  ? 'None. A theme is colors only; it runs no code.'
                  : 'None. It doesn’t ask for any capabilities.'
          }</span></p>`;
    const online = isOnline(item, extra)
        ? `<p class="online-note"><span class="badge badge--online">Online</span><span>${esc(onlineNote(item) ?? 'Talks to a web service.')}</span></p>`
        : '';
    const src = sourceUrl(extra);
    const tryBlock = ex
        ? ex.auto
            ? `<div class="dlg__try"><span class="dlg__try-k">In Kage</span><span class="dlg__try-q dlg__try-q--auto">${ico('sparkle')}Works on its own in chat replies</span></div>`
            : `<div class="dlg__try"><span class="dlg__try-k">Try</span><code class="dlg__try-q">${esc(ex.query)}</code></div>`
        : '';
    return [
        `<div class="dlg__head">`,
        `<span class="dlg__icon" aria-hidden="true">${esc(item.icon || '📦')}</span>`,
        `<div class="dlg__title"><p class="eyebrow">${isTheme ? 'Theme' : 'Extension'} · v${esc(item.version)}</p><h2 id="dlg-title">${esc(item.name)}</h2>${meta ? `<p class="dlg__meta">${meta}</p>` : ''}</div>`,
        `</div>`,
        `<p class="dlg__desc">${esc(item.description || '')}</p>`,
        tryBlock,
        adds ? `<section class="dlg__sec" aria-labelledby="dlg-adds"><h3 id="dlg-adds">What it adds</h3><ul class="adds">${adds}</ul></section>` : '',
        `<section class="dlg__sec" aria-labelledby="dlg-access"><h3 id="dlg-access">Access it asks for</h3>${access}${online}</section>`,
        `<div class="sandbox-note"><img src="assets/mascot/kage-house-peeking.svg" width="64" height="56" alt="" loading="lazy" decoding="async"><p><strong>It runs in a sandbox.</strong> Kage checks every request an extension makes to Kage against the access it declared, and you see this list again in Kage before you install. An update can’t give itself more access than you approved. Extensions can still reach web services from the sandbox; the Online badge marks the ones that do.</p></div>`,
        `<div class="dlg__actions">${actionsHtml(item, { details: false })}${
            src
                ? `<a class="link-btn" href="${esc(src)}">View source${ico('external')}<span class="sr-only">: ${esc(item.name)} on GitHub</span></a>`
                : ''
        }</div>`,
    ].join('');
}
