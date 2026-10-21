/**
 * Link Preview message formatter (sandboxed).
 *
 * Finds URL anchor tags in the rendered message HTML, fetches OG / Twitter
 * Card / favicon metadata via `fetch_link_metadata` (guarded by the
 * `network` capability), and inserts a card after each. Cards render
 * three ways depending on what came back:
 *
 *   - **Hero card** — has an `og:image` we trust. Image goes top, with
 *     domain + title + description below. This is the shape users
 *     expect from Slack / Discord / Notion link unfurls.
 *   - **Compact card** — favicon-only fallback when no hero image is
 *     available. Single row, like the previous version.
 *   - **Fallback card** — metadata fetch failed or returned nothing.
 *     Renders with the parsed domain and a colour-derived initial so
 *     the user still gets a consistent visual; we never silently skip
 *     a card now.
 *
 * Progressive loading: on hosts with `context.formatter`, links whose
 * metadata isn't back within a moment get a **loading card** (domain +
 * shimmer) and the formatter asks the host to re-run it once the fetch
 * lands. `format()` is therefore idempotent: it upgrades loading cards
 * in place and never inserts a second card for a link. Older hosts get
 * the original behaviour (await every fetch, then render).
 *
 * Sandbox boundary: we operate in a DOMParser-owned document, return
 * the resulting HTML, and let the host sanitiser approve every tag and
 * attribute. The card structure uses tags + attrs the sanitiser
 * already permits (`A`, `IMG`, `SPAN`, `class`, `style: background`,
 * `src` validated against http(s) or a raster data URI). Cards are
 * found again on a later pass by their `href` — the sanitiser drops
 * `data-*` attributes.
 */

const MAX_URL_LENGTH = 2048;
const DESC_TRUNCATE_AT = 140;
// How long a pass waits for metadata before falling back to a loading
// card. Cache hits and fast sites land inside it, so they never flash.
const FAST_PATH_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default class LinkPreviewFormatter {
    initialize(context) {
        this.config = context.config || {};
        this.invoke = context.invoke;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        // In-memory cache for the duration of this sandbox lifetime. The
        // disk cache lives in the host (behind `fetch_link_metadata`) and
        // is shared across windows / restarts. Holds only settled results;
        // in-flight fetches live in `_inflight`.
        this._metaCache = new Map();
        this._inflight = new Map();
        const formatter = context.formatter;
        this._requestReformat =
            typeof formatter?.requestReformat === 'function'
                ? () => formatter.requestReformat()
                : null;
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    /**
     * Host contract: return a replacement HTML string, or null to leave
     * the existing HTML unchanged.
     */
    async format(html, context) {
        if (!this.config?.enabled) return null;
        // Streaming chunks contain URLs mid-write; resolving against
        // them is wasteful and produces flicker. Wait for the final
        // pass.
        if (context?.streaming) return null;

        const maxPreviews = Number(this.config?.max_previews) || 5;
        const showImages = this.config?.show_images !== false;

        const doc = new DOMParser().parseFromString(
            `<!doctype html><body>${html}</body>`,
            'text/html'
        );
        const body = doc.body;
        if (!body) return null;

        // Collect candidate links once. Skip anchors that are clearly
        // structural (tool sources, code blocks, or already-rendered
        // cards from a previous format pass).
        const hrefs = [];
        const seen = new Set();
        const anchors = body.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!/^https?:/i.test(href)) continue;
            if (href.length > MAX_URL_LENGTH) continue;
            if (seen.has(href)) continue;
            if (
                a.closest(
                    '.tool-sources, .source-chip, .source-bubble, .code-block-wrapper, .link-preview-card'
                )
            )
                continue;
            seen.add(href);
            hrefs.push({ href, anchor: a });
            if (hrefs.length >= maxPreviews) break;
        }
        if (hrefs.length === 0) return null;

        const pending = hrefs
            .filter((h) => !this._metaCache.has(h.href))
            .map((h) => this._getMeta(h.href));
        if (pending.length > 0) {
            // allSettled, not all — one slow / failing URL shouldn't block
            // sibling cards. Failed fetches still get a fallback card.
            const all = Promise.allSettled(pending);
            if (this._requestReformat) {
                await Promise.race([all, sleep(FAST_PATH_MS)]);
                // Anything still loading re-runs us when it lands; the
                // host coalesces the requests.
                if (hrefs.some((h) => !this._metaCache.has(h.href))) {
                    all.then(() => this._requestReformat());
                }
            } else {
                await all;
            }
        }

        // Cards from a previous pass, by link. Re-runs see the message's
        // current HTML, loading cards included.
        const existing = new Map();
        for (const card of body.querySelectorAll('a.link-preview-card[href]')) {
            existing.set(card.getAttribute('href'), card);
        }

        let changed = false;
        for (const { href, anchor } of hrefs) {
            const resolved = this._metaCache.has(href);
            const card = resolved
                ? this._buildCardHtml(href, this._metaCache.get(href), doc, { showImages })
                : this._buildLoadingCardHtml(href, doc);
            const current = existing.get(href);
            if (current) {
                if (resolved && current.classList.contains('link-preview-card-loading')) {
                    current.replaceWith(card);
                    changed = true;
                }
                continue;
            }
            const insertAfter = anchor.closest('p, li, div') || anchor;
            if (insertAfter.parentNode) {
                insertAfter.parentNode.insertBefore(card, insertAfter.nextSibling);
                changed = true;
            }
        }

        return changed ? body.innerHTML : null;
    }

    destroy() {
        this._metaCache.clear();
        this._inflight.clear();
    }

    // --- Internals ---

    /** Settled metadata for `url`; concurrent callers share one fetch. */
    _getMeta(url) {
        if (this._metaCache.has(url)) return Promise.resolve(this._metaCache.get(url));
        if (this._inflight.has(url)) return this._inflight.get(url);
        const p = Promise.resolve()
            .then(() => this.invoke('fetch_link_metadata', { url }))
            .then((meta) => meta || null)
            // Network / sandbox / permission failure — cache the null
            // so we don't retry on every re-format pass within this
            // session. The disk cache (host-side) will pick the URL up
            // again on a fresh session.
            .catch(() => null)
            .then((meta) => {
                this._metaCache.set(url, meta);
                this._inflight.delete(url);
                return meta;
            });
        this._inflight.set(url, p);
        return p;
    }

    _domainOf(href) {
        try {
            return new URL(href).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }

    /**
     * Placeholder while metadata loads: the real header (initial +
     * domain) over shimmering title / description bars, so the card
     * doesn't jump when the content arrives.
     */
    _buildLoadingCardHtml(href, doc) {
        const domain = this._domainOf(href);
        const card = doc.createElement('a');
        card.className = 'link-preview-card link-preview-card-loading';
        card.setAttribute('href', href);
        card.setAttribute('title', href);
        card.setAttribute(
            'aria-label',
            this.t('card.loading_aria_label', { domain: domain || href })
        );

        const header = doc.createElement('span');
        header.className = 'link-preview-header';
        const iconWrap = doc.createElement('span');
        iconWrap.className = 'link-preview-icon';
        iconWrap.setAttribute(
            'style',
            `background: hsl(${this._hashToHue(domain || href)}, 55%, 45%)`
        );
        iconWrap.textContent = (domain.charAt(0) || '?').toUpperCase();
        header.appendChild(iconWrap);
        const dom = doc.createElement('span');
        dom.className = 'link-preview-domain';
        dom.textContent = domain || href;
        header.appendChild(dom);
        card.appendChild(header);

        for (const cls of [
            'link-preview-skeleton',
            'link-preview-skeleton link-preview-skeleton-short',
        ]) {
            const bar = doc.createElement('span');
            bar.className = cls;
            card.appendChild(bar);
        }
        return card;
    }

    /**
     * Build a card. `meta` may be null (fallback shape) or partial
     * (compact shape if no hero image). All three shapes share the
     * same outer `<a class="link-preview-card">` so the host CSS can
     * style + size them consistently.
     */
    _buildCardHtml(href, meta, doc, opts = {}) {
        const domain = this._domainOf(href);
        const title = meta?.title || domain || href;
        const description = meta?.description || '';
        const favicon = meta?.favicon || '';
        const image = (opts.showImages !== false && meta?.image) || '';
        const hue = this._hashToHue(domain || href);
        const isHero = !!image;

        const card = doc.createElement('a');
        card.className = isHero
            ? 'link-preview-card link-preview-card-hero'
            : meta
              ? 'link-preview-card'
              : 'link-preview-card link-preview-card-fallback';
        card.setAttribute('href', href);
        card.setAttribute('title', href);
        // Mark the card up as a link to a preview so screen readers
        // describe what the user is about to follow. The default link
        // text would just be the URL.
        card.setAttribute('aria-label', this.t('card.aria_label', { title }));

        if (isHero) {
            const heroWrap = doc.createElement('span');
            heroWrap.className = 'link-preview-hero';
            const heroImg = doc.createElement('img');
            heroImg.setAttribute('src', image);
            heroImg.setAttribute('class', 'link-preview-hero-img');
            heroImg.setAttribute('alt', '');
            heroImg.setAttribute('loading', 'lazy');
            heroWrap.appendChild(heroImg);
            card.appendChild(heroWrap);
        }

        // Header row: favicon (or coloured initial) + domain on the right.
        const header = doc.createElement('span');
        header.className = 'link-preview-header';

        const iconWrap = doc.createElement('span');
        iconWrap.className = 'link-preview-icon';
        // data: favicons come from the host's internal-site proxy (the
        // webview can't authenticate to those hosts itself).
        if (favicon && /^(https?:|data:image\/)/i.test(favicon)) {
            const img = doc.createElement('img');
            img.setAttribute('src', favicon);
            img.setAttribute('class', 'link-preview-favicon');
            img.setAttribute('width', '20');
            img.setAttribute('height', '20');
            img.setAttribute('alt', '');
            img.setAttribute('loading', 'lazy');
            iconWrap.appendChild(img);
        } else {
            iconWrap.setAttribute('style', `background: hsl(${hue}, 55%, 45%)`);
            iconWrap.textContent = (domain.charAt(0) || '?').toUpperCase();
        }
        header.appendChild(iconWrap);

        const dom = doc.createElement('span');
        dom.className = 'link-preview-domain';
        dom.textContent = domain || href;
        header.appendChild(dom);
        card.appendChild(header);

        const t = doc.createElement('span');
        t.className = 'link-preview-title';
        t.textContent = title;
        card.appendChild(t);

        if (description) {
            const d = doc.createElement('span');
            d.className = 'link-preview-desc';
            d.textContent =
                description.length > DESC_TRUNCATE_AT
                    ? description.substring(0, DESC_TRUNCATE_AT - 1) + '…'
                    : description;
            card.appendChild(d);
        }

        return card;
    }

    _hashToHue(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash) % 360;
    }
}
