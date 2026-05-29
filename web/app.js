// Static store browser. Loads the catalog produced by build-catalog.mjs and
// renders cards with a search box + type filter. No framework — keeps the
// Pages bundle tiny and lets CI deploy without a build step beyond cp.

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
        card.querySelector('.card-version').textContent = `v${item.version}`;
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
