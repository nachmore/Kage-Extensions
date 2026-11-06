// The store browser. Loads catalog.json (built by scripts/build-catalog.mjs)
// and store-extras.json (written by web/stage.mjs), then wires up search,
// categories, the themes' dark/light preview and the detail dialog. No
// framework and no build step: CI copies these files next to the catalog.
//
// The deployed index.html already has every card in it (stage.mjs renders
// them with the same functions), so this script only re-renders when the
// search, the category or the catalog changes. Without it the page still
// lists everything, with working install and download links.
//
// URL: ?q=<search>&cat=<category>&ext=<id> (all optional) is kept in sync
// with history.replaceState, so a link reopens the same view or dialog.

import {
    applyFilters,
    buildQuery,
    cardHtml,
    cardId,
    categoryChipsHtml,
    detailHtml,
    escapeHtml,
    extraFromManifest,
    formatDate,
    parseQuery,
    plural,
    summaryText,
} from './store-core.js';

export async function start({ doc = document, win = window, fetchImpl = win.fetch?.bind(win) } = {}) {
    const $ = (sel) => doc.querySelector(sel);
    const els = {
        form: $('[data-search-form]'),
        search: $('#search'),
        summary: $('#summary'),
        counts: $('[data-counts]'),
        chips: $('[data-chips]'),
        filterbar: $('[data-filterbar]'),
        results: $('[data-results]'),
        empty: $('#empty'),
        emptyDetail: $('[data-empty-detail]'),
        themes: $('[data-theme-results]'),
        themeEmpty: $('#theme-empty'),
        generatedAt: $('#generated-at'),
        dialog: $('#details'),
        dialogBody: $('[data-dlg-body]'),
        nav: $('[data-nav]'),
    };
    if (!els.results) return null;

    const reduce = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const fromUrl = parseQuery(win.location.search);
    const state = { items: [], extras: {}, q: fromUrl.q, cat: fromUrl.cat, ext: null };
    const byId = () => new Map(state.items.map((i) => [i.id, i]));
    let lastTrigger = null;
    const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    // The controls are live from the start, but until the catalog is in,
    // they only record what was asked for; it's applied once it loads.
    let loaded = false;
    let pending = null; // { id, trigger } of a Details press during the load

    // Text typed before this ran wins over the URL's ?q=.
    if (els.search) {
        if (els.search.value) state.q = els.search.value;
        else els.search.value = state.q;
    }

    // ─── rendering ────────────────────────────────────────────────────

    // Show exactly `items`, in order, reusing the cards already there (the
    // pre-render, or the last search) so typing doesn't rebuild or flash
    // them and focus inside a card survives. Only cards that weren't shown
    // before animate in. A card is reused only for the same version.
    const tpl = doc.createElement('template');
    function reconcile(container, items, animate) {
        const old = new Map();
        for (const n of [...container.children]) {
            if (n.dataset?.id) old.set(n.dataset.id, n);
            else n.remove(); // "Loading…", an old error
        }
        const keep = new Set();
        let prev = null;
        let fresh = 0;
        for (const item of items) {
            let node = old.get(item.id);
            if (node && node.dataset.v !== String(item.version)) node = null;
            if (!node) {
                tpl.innerHTML = cardHtml(item, state.extras[item.id]);
                node = tpl.content.firstElementChild;
                if (animate && !reduce) {
                    node.classList.add('is-new');
                    node.style.setProperty('--i', String(Math.min(fresh, 12)));
                    node.addEventListener('animationend', () => node.classList.remove('is-new'), { once: true });
                }
                fresh++;
            }
            keep.add(node);
            const at = prev ? prev.nextSibling : container.firstChild;
            if (node !== at) container.insertBefore(node, at);
            prev = node;
        }
        for (const n of old.values()) if (!keep.has(n)) n.remove();
    }

    function render({ fresh = true } = {}) {
        const r = applyFilters(state.items, { q: state.q, cat: state.cat }, state.extras);
        state.cat = r.cat;

        reconcile(els.results, r.extensions, fresh);
        if (els.themes) reconcile(els.themes, r.themes, fresh);
        updateChips(r.counts, r.cat);

        const none = r.extensions.length === 0;
        if (els.empty) els.empty.hidden = !none;
        if (els.emptyDetail) {
            els.emptyDetail.textContent = state.q.trim()
                ? r.themes.length
                    ? `But ${plural(r.themes.length, 'theme')} ${r.themes.length === 1 ? 'does' : 'do'}, below.`
                    : 'Try another word, or a different category.'
                : 'Try a different category.';
        }
        if (els.themeEmpty) els.themeEmpty.hidden = r.themes.length > 0;
        if (els.summary) els.summary.textContent = summaryText(r, state.q);
        if (els.counts) {
            els.counts.textContent = `${plural(r.totals.extensions, 'extension')} · ${plural(r.totals.themes, 'theme')}`;
        }
        els.form?.classList.toggle('has-query', !!state.q);
        doc.dispatchEvent(
            new win.CustomEvent('kage:search', {
                detail: {
                    query: state.q,
                    count: r.extensions.length + r.themes.length,
                },
            })
        );
        return r;
    }

    // The chip set is fixed, so after the first fill they're updated in
    // place: a pressed chip keeps focus.
    function updateChips(counts, active) {
        if (!els.chips) return;
        if (!els.chips.querySelector('[data-cat]')) {
            els.chips.innerHTML = categoryChipsHtml(counts, active);
            return;
        }
        let refocus = false;
        for (const chip of els.chips.querySelectorAll('[data-cat]')) {
            const id = chip.dataset.cat;
            const n = counts[id] ?? 0;
            const hide = n === 0 && id !== active;
            chip.setAttribute('aria-pressed', String(id === active));
            if (hide && chip === doc.activeElement) refocus = true;
            chip.hidden = hide;
            const badge = chip.querySelector('.chip__n');
            if (badge) badge.textContent = String(n);
        }
        // Clearing an empty category hides its chip: focus moves to the one
        // that's now pressed instead of falling to the page.
        if (refocus) els.chips.querySelector(`[data-cat="${active}"]`)?.focus();
    }

    let urlTimer = 0;
    function syncUrl(now = false) {
        const apply = () => {
            const url = `${win.location.pathname}${buildQuery(state)}${win.location.hash}`;
            try {
                win.history.replaceState(null, '', url);
            } catch {
                // file:// or a sandboxed frame: the view still works.
            }
        };
        win.clearTimeout(urlTimer);
        if (now) apply();
        else urlTimer = win.setTimeout(apply, 350);
    }

    // ─── loading ──────────────────────────────────────────────────────

    async function getJson(url, init) {
        const resp = await fetchImpl(url, init);
        if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
        return resp.json();
    }

    const prerendered = !!els.results.querySelector(':scope > [data-id]');
    wireSearch();
    wireChrome();
    const [catalog, extras] = await Promise.allSettled([
        getJson('./catalog.json', { cache: 'no-store' }),
        getJson('./store-extras.json'),
    ]);

    if (extras.status === 'fulfilled' && extras.value?.items && typeof extras.value.items === 'object') {
        state.extras = extras.value.items;
    }

    if (catalog.status === 'rejected') {
        // Searching needs the catalog. Keep whatever the page already shows
        // (the pre-rendered cards still install and download) and hide the
        // controls that can't work.
        const msg = catalog.reason?.message ?? String(catalog.reason);
        doc.documentElement.classList.add('no-catalog');
        if (prerendered) {
            if (els.summary) {
                els.summary.textContent = 'Couldn’t refresh the catalog, so this is the list the page was built with.';
            }
        } else {
            els.results.innerHTML = `<p class="loading is-error">Couldn’t load the catalog: ${escapeHtml(msg)}</p>`;
            if (els.themes) els.themes.innerHTML = '';
            if (els.summary) els.summary.textContent = 'Couldn’t load the catalog.';
        }
        return { state, render };
    }

    const data = catalog.value ?? {};
    state.items = (Array.isArray(data.items) ? data.items : []).filter(
        (i) => i && typeof i.id === 'string' && typeof i.name === 'string'
    );
    const built = formatDate(data.generatedAt);
    if (built && els.generatedAt) els.generatedAt.textContent = `Catalog built ${built}`;

    // Anything typed while the catalog was loading.
    if (els.search) state.q = els.search.value;
    loaded = true;
    // The first render keeps the pre-rendered cards (same ids and versions).
    render({ fresh: false });
    if (state.q || state.cat !== 'all') syncUrl(true);

    if (pending && byId().has(pending.id)) {
        openDetails(pending.id, pending.trigger);
    } else if (fromUrl.ext && byId().has(fromUrl.ext)) {
        openDetails(fromUrl.ext, null);
    } else if (new URLSearchParams(win.location.search).has('ext')) {
        // Unknown or malformed id: drop it from the address.
        syncUrl(true);
    } else if (fromUrl.type === 'theme' && !state.q) {
        doc.getElementById('themes')?.scrollIntoView?.({ block: 'start' });
    }

    // ─── detail dialog ────────────────────────────────────────────────

    async function openDetails(id, trigger) {
        const item = byId().get(id);
        if (!item || !els.dialog || !els.dialogBody) return;
        lastTrigger = trigger;
        state.ext = id;
        let extra = state.extras[id];
        els.dialogBody.innerHTML = detailHtml(item, extra);
        if (!els.dialog.open) {
            if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
            else els.dialog.setAttribute('open', '');
        }
        els.dialog.querySelector('.dlg__inner')?.scrollTo?.(0, 0);
        els.dialog.querySelector('[data-close]')?.focus();
        syncUrl(true);

        // No store-extras.json (a local preview, say): the manifest in
        // detail/<id>.json says what the extension adds.
        if (!extra?.contributes && typeof item.detailUrl === 'string' && /^detail\/[a-z0-9_-]+\.json$/.test(item.detailUrl)) {
            try {
                const detail = await getJson(`./${item.detailUrl}`);
                extra = { ...extraFromManifest(detail.manifest), ...(extra ?? {}) };
                state.extras[id] = extra;
                if (state.ext === id && els.dialog.open) els.dialogBody.innerHTML = detailHtml(item, extra);
            } catch {
                // The dialog already shows everything the catalog has.
            }
        }
    }

    function closeDetails() {
        if (!els.dialog) return;
        if (els.dialog.open) {
            if (typeof els.dialog.close === 'function') els.dialog.close();
            else {
                els.dialog.removeAttribute('open');
                onClosed();
            }
        }
    }

    function onClosed() {
        state.ext = null;
        syncUrl(true);
        const t = lastTrigger;
        lastTrigger = null;
        // The card may have been re-rendered while the dialog was open.
        const id = t?.dataset?.details;
        const target = t?.isConnected ? t : id && SAFE_ID.test(id) ? doc.querySelector(`[data-details="${id}"]`) : null;
        target?.focus?.();
    }

    // ─── events ───────────────────────────────────────────────────────

    function wireSearch() {
        els.search?.addEventListener('input', () => {
            state.q = els.search.value;
            if (!loaded) return;
            render();
            syncUrl();
        });

        els.search?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && els.search.value) {
                e.preventDefault();
                els.search.value = '';
                state.q = '';
                if (!loaded) return;
                render();
                syncUrl(true);
            }
        });

        els.form?.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!loaded) return;
            syncUrl(true);
            const target = els.results.querySelector(':scope > [data-id]') ? doc.getElementById('browse') : doc.getElementById('themes');
            target?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
            // Phones: put the keyboard away so the results are visible.
            if (win.matchMedia?.('(pointer: coarse)').matches) els.search.blur();
        });

        els.chips?.addEventListener('click', (e) => {
            const chip = e.target instanceof win.Element ? e.target.closest('[data-cat]') : null;
            if (!chip) return;
            const cat = chip.dataset.cat;
            // Pressing the active category again goes back to All.
            state.cat = cat === state.cat && cat !== 'all' ? 'all' : cat;
            if (!loaded) {
                for (const c of els.chips.querySelectorAll('[data-cat]')) {
                    c.setAttribute('aria-pressed', String(c.dataset.cat === state.cat));
                }
                return;
            }
            render();
            syncUrl(true);
        });

        doc.querySelector('[data-clear]')?.addEventListener('click', () => {
            state.q = '';
            state.cat = 'all';
            if (els.search) els.search.value = '';
            if (loaded) {
                render();
                syncUrl(true);
            }
            els.search?.focus();
        });

        doc.addEventListener('click', (e) => {
            if (!(e.target instanceof win.Element)) return;
            const btn = e.target.closest('[data-details]');
            if (btn) {
                if (loaded) openDetails(btn.dataset.details, btn);
                else pending = { id: btn.dataset.details, trigger: btn };
                return;
            }
            // In-page links to a card (#ext-<id>, the hero demo's "Powered
            // by") open its details instead of jumping.
            const a = e.target.closest('a[href^="#ext-"]');
            if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                const id = a.getAttribute('href').slice(5);
                if (byId().has(id)) {
                    e.preventDefault();
                    openDetails(id, a);
                }
            }
        });

        if (els.dialog) {
            els.dialog.addEventListener('close', onClosed);
            // A press that starts on the backdrop closes the dialog; a text
            // selection dragged out of the panel (click lands on the
            // <dialog> too) doesn't.
            let downOnBackdrop = false;
            els.dialog.addEventListener('pointerdown', (e) => {
                downOnBackdrop = e.target === els.dialog;
            });
            els.dialog.addEventListener('click', (e) => {
                if (e.target === els.dialog) {
                    if (downOnBackdrop || e.detail === 0) closeDetails();
                } else if (e.target instanceof win.Element && e.target.closest('[data-close]')) closeDetails();
                downOnBackdrop = false;
            });
        }
    }

    // Works with or without the catalog.
    function wireChrome() {
        for (const btn of doc.querySelectorAll('[data-mode-pick]')) {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.modePick === 'light' ? 'light' : 'dark';
                const apply = () => {
                    els.themes?.setAttribute('data-mode', mode);
                    for (const b of doc.querySelectorAll('[data-mode-pick]')) {
                        b.setAttribute('aria-pressed', String(b === btn));
                    }
                };
                if (!reduce && typeof doc.startViewTransition === 'function') doc.startViewTransition(apply);
                else apply();
            });
        }

        doc.querySelector('[data-search-jump]')?.addEventListener('click', jumpToSearch);

        // The nav grows a search button once the search box scrolls away,
        // and the category bar gets a backdrop once it sticks under the nav.
        if ('IntersectionObserver' in win) {
            if (els.form && els.nav) {
                new win.IntersectionObserver(
                    ([en]) => els.nav.classList.toggle('has-search', !en.isIntersecting && en.boundingClientRect.top < 0),
                    { threshold: 0 }
                ).observe(els.form);
            }
            if (els.filterbar) {
                const sentinel = doc.createElement('div');
                sentinel.setAttribute('aria-hidden', 'true');
                els.filterbar.before(sentinel);
                const navH = els.nav?.offsetHeight || 64;
                new win.IntersectionObserver(
                    ([en]) => els.filterbar.classList.toggle('is-stuck', !en.isIntersecting && en.boundingClientRect.top < navH + 8),
                    { rootMargin: `-${navH + 7}px 0px 0px 0px`, threshold: 0 }
                ).observe(sentinel);
            }
        }
    }

    function jumpToSearch() {
        if (!els.search) return;
        els.search.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        els.search.focus({ preventScroll: true });
        els.search.select();
    }

    return { state, render, openDetails, closeDetails, cardId };
}

// If this throws, hide the controls it would have run (style.css,
// .store-failed); the pre-rendered cards keep working on their own.
export const ready =
    typeof document !== 'undefined' && !globalThis.__KAGE_STORE_NO_AUTOSTART__
        ? start().catch((e) => {
              document.documentElement.classList.add('store-failed');
              console.error('Kage store:', e);
              return null;
          })
        : Promise.resolve(null);
