/* Kage Extension Store: page behaviour that isn't the catalog.
 *
 * - scroll reveals (IntersectionObserver). This runs first, and the CSS has
 *   a failsafe that shows everything if this script never gets this far
 *   (see .reveal-ready in style.css).
 * - nav state, scroll progress, hero parallax (scroll + pointer), pointer
 *   spotlights on cards, the mobile menu, Mac key labels
 * - the cat on the search box: eyes follow the pointer, blinks, a happy
 *   face on hover, a jump with hearts on click, and reactions to the
 *   search (app.js fires `kage:search`)
 * - the footer cat, which wakes and waves
 *
 * One rAF loop does the scroll and pointer work; listeners are passive and
 * only schedule it. Everything written per frame is a transform. With
 * prefers-reduced-motion: no parallax, gaze, blinks or jumps.
 */
(() => {
    const doc = document.documentElement;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(pointer: fine)').matches;
    const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

    // boot.js marks the page as scripted before it's drawn. If it didn't
    // run (but this did), do it now, so the controls that need JavaScript
    // aren't left hidden.
    if (!doc.classList.contains('js')) {
        doc.classList.remove('no-js');
        doc.classList.add('js');
        const n = navigator;
        const p = (n.userAgentData && n.userAgentData.platform) || n.platform || '';
        doc.dataset.os = /mac/i.test(p) && n.maxTouchPoints < 2 ? 'mac' : /win/i.test(p) ? 'windows' : 'other';
    }

    // ─── reveals ──────────────────────────────────────────────────────

    const reveals = $$('.reveal');

    // Until <html> has .reveal-ready, a CSS animation shows every .reveal
    // 2.5 s after it's first styled. If this script got here after that,
    // keep everything shown instead of hiding it again.
    function failsafeFired() {
        if (performance.now() < 2400) return false;
        return !!reveals[0] && getComputedStyle(reveals[0]).opacity === '1';
    }

    if (reduce || !('IntersectionObserver' in window) || failsafeFired()) {
        for (const el of reveals) el.classList.add('is-in');
    } else {
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    e.target.classList.add('is-in');
                    io.unobserve(e.target);
                }
            },
            { rootMargin: '0px 0px -8% 0px', threshold: 0 }
        );
        for (const el of reveals) io.observe(el);
    }
    // Cancels the failsafe: from here on the observer owns the reveals.
    doc.classList.add('reveal-ready');

    if (doc.dataset.os === 'mac') {
        for (const el of $$('[data-mac]')) el.textContent = el.dataset.mac;
    }

    // ─── scroll + pointer loop ────────────────────────────────────────

    const nav = document.querySelector('[data-nav]');
    const bar = document.querySelector('.progress span');
    const hero = document.querySelector('.hero');
    // data-depth: how far a layer lags the page on scroll (bigger = farther);
    // data-px: how far it follows the pointer (bigger = nearer). Walking
    // from the nearest layer out, no layer follows the pointer more than a
    // nearer one, so the two cues always agree.
    const layers = reduce
        ? []
        : $$('.sky [data-depth]')
              .map((el) => ({
                  el,
                  depth: Number(el.dataset.depth) * (fine ? 1 : 0.6),
                  px: fine ? Number(el.dataset.px || 0) : 0,
              }))
              .sort((a, b) => a.depth - b.depth);
    let cap = Number.POSITIVE_INFINITY;
    for (const l of layers) {
        l.px = Math.min(l.px, cap);
        cap = l.px;
    }

    let vh = window.innerHeight;
    let docH = doc.scrollHeight;
    let heroH = hero ? hero.offsetHeight : 0;
    const pointer = { x: 0, y: 0, cx: 0, cy: 0 };
    let raf = 0;
    let solid = null;

    function measure() {
        vh = window.innerHeight;
        docH = doc.scrollHeight;
        heroH = hero ? hero.offsetHeight : 0;
    }

    function frame() {
        raf = 0;
        const sy = window.scrollY;
        const isSolid = sy > 16;
        if (isSolid !== solid) {
            solid = isSolid;
            nav?.classList.toggle('is-solid', isSolid);
        }
        if (bar) bar.style.transform = `scaleX(${Math.min(1, sy / Math.max(1, docH - vh)).toFixed(4)})`;

        let again = false;
        if (layers.length) {
            pointer.cx += (pointer.x - pointer.cx) * 0.08;
            pointer.cy += (pointer.y - pointer.cy) * 0.08;
            again = Math.abs(pointer.x - pointer.cx) > 0.002 || Math.abs(pointer.y - pointer.cy) > 0.002;
            if (sy < heroH + 50) {
                for (const l of layers) {
                    const x = -pointer.cx * l.px;
                    const y = sy * l.depth - pointer.cy * l.px;
                    l.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
                }
            }
        }
        if (again) schedule();
    }

    function schedule() {
        if (!raf) raf = requestAnimationFrame(frame);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener(
        'resize',
        () => {
            measure();
            schedule();
        },
        { passive: true }
    );
    if (fine && layers.length) {
        window.addEventListener(
            'pointermove',
            (e) => {
                if (window.scrollY > heroH) return;
                pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
                pointer.y = (e.clientY / vh) * 2 - 1;
                schedule();
            },
            { passive: true }
        );
    }
    if ('ResizeObserver' in window) {
        new ResizeObserver(() => {
            measure();
            schedule();
        }).observe(document.body);
    }
    measure();
    frame();

    // ─── card spotlights ──────────────────────────────────────────────

    // Delegated, because app.js re-renders the cards.
    if (fine) {
        let spotRaf = 0;
        let pt = null;
        document.addEventListener(
            'pointermove',
            (e) => {
                pt = e;
                if (spotRaf) return;
                spotRaf = requestAnimationFrame(() => {
                    spotRaf = 0;
                    const el = pt.target instanceof Element ? pt.target.closest('[data-spot]') : null;
                    if (!el) return;
                    const r = el.getBoundingClientRect();
                    el.style.setProperty('--mx', `${(pt.clientX - r.left).toFixed(0)}px`);
                    el.style.setProperty('--my', `${(pt.clientY - r.top).toFixed(0)}px`);
                });
            },
            { passive: true }
        );
    }

    // ─── mobile menu ──────────────────────────────────────────────────

    // A <details> sheet: close it when a link in it is chosen, on Escape
    // (focus goes back to its button) and on a press anywhere outside it.
    const menu = document.querySelector('.nav__menu');
    if (menu) {
        const summary = menu.querySelector('summary');
        menu.addEventListener('click', (e) => {
            if (e.target instanceof Element && e.target.closest('.nav__sheet a')) menu.open = false;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !menu.open) return;
            const hadFocus = menu.contains(document.activeElement);
            menu.open = false;
            if (hadFocus) summary?.focus();
        });
        document.addEventListener(
            'pointerdown',
            (e) => {
                if (menu.open && !menu.contains(e.target)) menu.open = false;
            },
            { passive: true }
        );
    }

    // ─── the cat on the search box ────────────────────────────────────

    const peek = document.querySelector('[data-cat]');
    if (peek) initPeek(peek);

    function initPeek(el) {
        const tilt = el.querySelector('.cat__tilt');
        const input = document.getElementById('search');
        // The irises are drawn looking inward (the cross-eyed rest pose).
        // Looking at something, each pupil first centres on its own eye, then
        // moves from there; the clip-path keeps it inside.
        const num = (node, attr) => Number(node?.getAttribute(attr)) || 0;
        const eyes = $$('.cat__eye', el)
            .map((eye) => {
                const white = eye.querySelector('.cat__white');
                const iris = eye.querySelector('.cat__iris');
                return {
                    pupil: eye.querySelector('.cat__pupil'),
                    dx: num(white, 'cx') - num(iris, 'cx'),
                    dy: num(white, 'cy') - num(iris, 'cy'),
                };
            })
            .filter((e) => e.pupil);
        const MAX_X = 6;
        const MAX_Y = 4;
        const TILT = 1.4;
        const aim = { x: 0, y: 0, active: false };
        const cur = { x: 0, y: 0, e: 0 };
        const target = { x: 0, y: 0, e: 0 };
        let rect = null;
        let onScreen = !('IntersectionObserver' in window);
        let lastPointer = 0;
        let frameId = 0;
        let happyTimer = 0;
        let moodTimer = 0;

        const box = () => {
            if (!rect) rect = el.getBoundingClientRect();
            return rect;
        };

        function lookAt(px, py) {
            const r = box();
            const dx = px - (r.left + r.width / 2);
            const dy = py - (r.top + r.height * 0.36);
            const dist = Math.hypot(dx, dy) || 1;
            const reach = Math.min(1, dist / 240);
            target.x = (dx / dist) * MAX_X * reach;
            target.y = (dy / dist) * MAX_Y * reach;
            target.e = 1;
        }

        function step() {
            frameId = 0;
            if (!onScreen) return;
            if (aim.active) lookAt(aim.x, aim.y);
            cur.x += (target.x - cur.x) * 0.18;
            cur.y += (target.y - cur.y) * 0.18;
            cur.e += (target.e - cur.e) * 0.18;
            for (const { pupil, dx, dy } of eyes) {
                pupil.style.transform = `translate(${(cur.e * dx + cur.x).toFixed(2)}px, ${(cur.e * dy + cur.y).toFixed(2)}px)`;
            }
            if (tilt) tilt.style.transform = `rotate(${(cur.x * TILT).toFixed(2)}deg)`;
            if (
                Math.abs(target.x - cur.x) > 0.01 ||
                Math.abs(target.y - cur.y) > 0.01 ||
                Math.abs(target.e - cur.e) > 0.005
            ) {
                frameId = requestAnimationFrame(step);
            }
        }

        function kick() {
            if (!frameId && onScreen && !reduce) frameId = requestAnimationFrame(step);
        }

        function rest() {
            target.x = 0;
            target.y = 0;
            target.e = 0;
            kick();
        }

        if ('IntersectionObserver' in window) {
            new IntersectionObserver(
                (entries) => {
                    onScreen = entries[entries.length - 1].isIntersecting;
                    rect = null;
                    if (!onScreen) {
                        cancelAnimationFrame(frameId);
                        frameId = 0;
                    } else kick();
                },
                { rootMargin: '80px 0px' }
            ).observe(el);
        }

        if (!reduce) {
            const invalidate = () => {
                rect = null;
            };
            window.addEventListener('scroll', invalidate, { passive: true });
            window.addEventListener('resize', invalidate, { passive: true });
            window.addEventListener(
                'pointermove',
                (e) => {
                    if (!onScreen) return;
                    aim.x = e.clientX;
                    aim.y = e.clientY;
                    aim.active = true;
                    lastPointer = performance.now();
                    kick();
                },
                { passive: true }
            );
            document.addEventListener(
                'pointerleave',
                () => {
                    aim.active = false;
                    rest();
                },
                { passive: true }
            );
            // Pointer quiet for a while: drift back to the rest pose.
            setInterval(() => {
                if (performance.now() - lastPointer > 3500 && aim.active && document.activeElement !== input) {
                    aim.active = false;
                    rest();
                }
            }, 2000);

            const blink = () => {
                el.classList.add('is-blink');
                setTimeout(() => el.classList.remove('is-blink'), 130);
            };
            const scheduleBlink = () =>
                setTimeout(
                    () => {
                        if (!document.hidden && onScreen) {
                            blink();
                            if (Math.random() < 0.2) setTimeout(blink, 260);
                        }
                        scheduleBlink();
                    },
                    2200 + Math.random() * 4200
                );
            scheduleBlink();
        }

        const happy = (on) => el.classList.toggle('is-happy', on);
        el.addEventListener('pointerenter', (e) => {
            if (e.pointerType === 'mouse') happy(true);
        });
        el.addEventListener('pointerleave', () => happy(false));
        el.addEventListener('focus', () => happy(true));
        el.addEventListener('blur', () => happy(false));

        const HEART =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4h2c.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';

        el.addEventListener('click', () => {
            happy(true);
            clearTimeout(happyTimer);
            happyTimer = setTimeout(() => {
                if (!el.matches(':hover')) happy(false);
            }, 1100);
            if (reduce) return;
            el.classList.remove('is-jump');
            void el.offsetWidth;
            el.classList.add('is-jump');
            for (let i = 0; i < 4; i++) {
                const h = document.createElement('span');
                h.className = 'heart';
                h.innerHTML = HEART;
                h.style.left = `${30 + Math.random() * 40}%`;
                h.style.setProperty('--hx', `${(Math.random() * 2 - 1) * 40}px`);
                h.style.setProperty('--hr', `${(Math.random() * 2 - 1) * 30}deg`);
                h.style.animationDelay = `${i * 90}ms`;
                if (i % 2) h.style.color = '#f687b3';
                h.addEventListener('animationend', () => h.remove(), { once: true });
                el.appendChild(h);
            }
        });
        el.addEventListener('animationend', (e) => {
            if (e.animationName === 'cat-jump') el.classList.remove('is-jump');
        });

        // The search: perk up and watch the text while you type, duck when
        // nothing matches, smile when you clear it.
        if (input) {
            input.addEventListener('focus', () => {
                el.classList.add('is-curious');
                if (!reduce && onScreen) {
                    const r = input.getBoundingClientRect();
                    aim.active = false;
                    lookAt(r.left + r.width * 0.25, r.top + r.height / 2);
                    kick();
                }
            });
            input.addEventListener('blur', () => {
                if (!input.value) el.classList.remove('is-curious');
            });
        }
        let lastQuery = '';
        document.addEventListener('kage:search', (e) => {
            const { query, count } = e.detail || {};
            const q = String(query || '').trim();
            clearTimeout(moodTimer);
            el.classList.toggle('is-shy', !!q && count === 0);
            if (!q) {
                el.classList.toggle('is-curious', document.activeElement === input);
                if (lastQuery) {
                    happy(true);
                    moodTimer = setTimeout(() => {
                        if (!el.matches(':hover') && document.activeElement !== el) happy(false);
                    }, 700);
                }
            } else if (!reduce && onScreen && input && document.activeElement === input) {
                // Follow the end of the text, roughly.
                const r = input.getBoundingClientRect();
                const along = Math.min(0.9, 0.12 + q.length * 0.03);
                aim.active = false;
                lookAt(r.left + r.width * along, r.top + r.height / 2);
                kick();
            }
            lastQuery = q;
        });
    }

    // ─── the footer cat ───────────────────────────────────────────────

    const sleepy = document.querySelector('[data-sleepy]');
    if (sleepy) {
        const frames = $$('.sleepy__wave img', sleepy);
        let timer = 0;
        let n = 0;
        let stopAt = 0;
        const show = (i) =>
            frames.forEach((f, k) => {
                if (k === i) f.setAttribute('data-on', '');
                else f.removeAttribute('data-on');
            });
        const sleep = () => {
            clearInterval(timer);
            timer = 0;
            sleepy.classList.remove('is-awake');
            show(-1);
        };
        const wake = (ms) => {
            stopAt = Math.max(stopAt, performance.now() + ms);
            if (timer) return;
            sleepy.classList.add('is-awake');
            n = 0;
            show(n);
            if (reduce) return;
            timer = setInterval(() => {
                n = (n + 1) % frames.length;
                show(n);
                if (performance.now() > stopAt && !sleepy.matches(':hover') && document.activeElement !== sleepy) sleep();
            }, 220);
        };
        sleepy.addEventListener('pointerenter', () => wake(1600));
        sleepy.addEventListener('focus', () => wake(1600));
        sleepy.addEventListener('click', () => wake(2600));
        sleepy.addEventListener('pointerleave', () => {
            stopAt = Math.min(stopAt, performance.now() + 500);
            if (reduce) sleep();
        });
        sleepy.addEventListener('blur', () => {
            if (reduce) sleep();
        });
    }
})();
