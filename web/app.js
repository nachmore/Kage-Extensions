// Static store browser. Loads the catalog produced by build-catalog.mjs and
// renders cards with a search box + type filter. No framework — keeps the
// Pages bundle tiny and lets CI deploy without a build step beyond cp.

// User-facing capability metadata. Mirrors a subset of Kage's
// `CAPABILITIES` table — we only need icon + short label here, not the
// full install-prompt description, because the website is a browse/
// preview surface and the actual install dialog runs inside Kage with
// the full text. Kept in sync manually with
// scripts/host-capabilities.mjs in this repo (which itself mirrors
// Kage's `extension-permissions.js`); the daily host-sync workflow
// catches drift.
const CAPS = {
    storage: { icon: '💾', label: 'Storage' },
    clipboard: { icon: '📋', label: 'Clipboard' },
    urls: { icon: '🔗', label: 'Open links' },
    launch: { icon: '🚀', label: 'Launch apps & files' },
    network: { icon: '📡', label: 'Network access' },
    oauth: { icon: '🔐', label: 'OAuth sign-in' },
    filesystem: { icon: '📂', label: 'Filesystem' },
    window: { icon: '🪟', label: 'Kage windows' },
    windows: { icon: '🧿', label: 'Open windows' },
    notifications: { icon: '🔔', label: 'Notifications' },
    calendar: { icon: '📅', label: 'Calendar' },
    session: { icon: '💬', label: 'Chat sessions' },
    agent: { icon: '🤖', label: 'AI agent' },
    activity: { icon: '📊', label: 'Activity' },
    automation: { icon: '⚡', label: 'Automation' },
    tts: { icon: '🔈', label: 'Text-to-speech' },
};

const els = {
    search: document.getElementById('search'),
    results: document.getElementById('results'),
    empty: document.getElementById('empty'),
    loading: document.getElementById('loading'),
    generatedAt: document.getElementById('generated-at'),
    template: document.getElementById('card-template'),
    filters: Array.from(document.querySelectorAll('.chip')),
};

const state = {
    items: [],
    filter: 'all',
    query: '',
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[c]);
}

function matches(item) {
    if (state.filter !== 'all' && item.type !== state.filter) return false;
    if (!state.query) return true;
    const haystack = [
        item.id,
        item.name,
        item.description,
        item.author ?? '',
        ...(item.tags ?? []),
    ]
        .join(' ')
        .toLowerCase();
    return state.query.split(/\s+/).every((tok) => haystack.includes(tok));
}

// Build a `kage://install/<id>` URL. The id comes from the catalog
// entry, which is itself constrained at validate-time to
// `^[a-z0-9][a-z0-9_-]{0,63}$`, so encoding is conservative but
// belt-and-suspenders. The host registers itself as the handler for
// `kage:` via tauri-plugin-deep-link; the OS launches Kage (or
// forwards into a running instance) and Kage parses the URL.
function installUrl(id) {
    return `kage://install/${encodeURIComponent(id)}`;
}

function render() {
    const items = state.items.filter(matches);
    els.results.innerHTML = '';
    for (const item of items) {
        const card = els.template.content.firstElementChild.cloneNode(true);
        card.querySelector('.card-icon').textContent = item.icon || '📦';
        card.querySelector('.card-name').textContent = item.name;
        card.querySelector('.card-author').textContent = item.author
            ? `by ${item.author}`
            : '';
        card.querySelector('.card-type').textContent = item.type;
        card.querySelector('.card-desc').textContent = item.description || '';

        const tagList = card.querySelector('.card-tags');
        for (const t of item.tags ?? []) {
            const li = document.createElement('li');
            li.textContent = t;
            tagList.appendChild(li);
        }

        // Capability pills. Themes don't declare permissions; if the
        // array is missing/empty we hide the row so the card stays
        // tight rather than showing a "🔒 No capabilities" badge that
        // duplicates Kage's own settings UI.
        const permList = card.querySelector('.card-perms');
        const perms = Array.isArray(item.permissions) ? item.permissions : [];
        if (perms.length === 0) {
            permList.remove();
        } else {
            for (const p of perms) {
                const meta = CAPS[p];
                const li = document.createElement('li');
                li.className = 'card-perm';
                if (meta) {
                    li.title = `Capability: ${meta.label}`;
                    li.textContent = `${meta.icon} ${meta.label}`;
                } else {
                    // Unknown capability shouldn't normally land here
                    // (validate-manifests.mjs rejects them at PR time),
                    // but if it does we fall back to the raw name so
                    // the user sees something rather than nothing.
                    li.title = `Capability: ${p}`;
                    li.textContent = `❓ ${p}`;
                }
                permList.appendChild(li);
            }
        }

        card.querySelector('.card-version').textContent = `v${item.version}`;

        const installLink = card.querySelector('.card-install');
        installLink.href = installUrl(item.id);
        // Click handler: clear any prior "we tried to launch but
        // nothing happened" state so the user can retry. Most browsers
        // surface their own "open in Kage?" confirmation; if Kage
        // isn't installed the click is a no-op (no error event fires
        // for a custom-scheme handler that doesn't exist), so we lean
        // on the visible `.zip` fallback instead of trying to detect
        // the failure programmatically.
        installLink.addEventListener('click', () => {
            // No-op today; reserved as a hook so we can add telemetry
            // or a "couldn't open Kage?" fallback dialog later.
        });

        const dl = card.querySelector('.card-download');
        dl.href = item.downloadUrl;
        dl.setAttribute('download', '');

        els.results.appendChild(card);
    }
    els.empty.classList.toggle('hidden', items.length > 0);
}

async function load() {
    try {
        const resp = await fetch('./catalog.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`catalog.json: HTTP ${resp.status}`);
        const data = await resp.json();
        state.items = Array.isArray(data.items) ? data.items : [];
        if (data.generatedAt) {
            const d = new Date(data.generatedAt);
            els.generatedAt.textContent = `built ${d.toISOString().split('T')[0]}`;
        }
        els.loading.classList.add('hidden');
        render();
    } catch (e) {
        els.loading.textContent = `Couldn't load catalog: ${escapeHtml(e.message)}`;
    }
}

els.search.addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
});
for (const chip of els.filters) {
    chip.addEventListener('click', () => {
        for (const c of els.filters) c.classList.remove('is-active');
        chip.classList.add('is-active');
        state.filter = chip.dataset.filter;
        render();
    });
}

load();
