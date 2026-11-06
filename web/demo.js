/* Kage Extension Store: the launcher in the hero.
 *
 * Types an example query, then shows what the extension answers, and moves
 * on to the next every few seconds. The markup is the first scene, finished,
 * so without this script (or with reduced motion) there's still a complete
 * picture. The chips jump to an example and hold it; the button pauses and
 * plays the cycle (WCAG 2.2.2). Nothing runs while the launcher is off
 * screen or the tab is hidden.
 *
 * The answers are illustrations: real queries for real extensions, but the
 * weather and the password are made up.
 */
(() => {
    const root = document.querySelector('[data-lm]');
    if (!root) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const SCENES = [
        {
            q: '12 km to mi',
            id: 'math',
            name: 'Math Calculator',
            icon: '🧮',
            rows: [{ icon: '🧮', title: '= 7.46 mi', sub: 'Math Calculator' }],
        },
        {
            q: '#38b2ac',
            id: 'color-picker',
            name: 'Color Picker',
            icon: '🎨',
            rows: [{ swatch: '#38b2ac', title: 'rgb(56, 178, 172)', sub: 'hsl(177, 52%, 46%)', mono: true }],
        },
        {
            q: ':fire',
            id: 'emoji',
            name: 'Emoji Picker',
            icon: '😀',
            rows: [
                { icon: '🔥', title: ':fire:', sub: 'lit' },
                { icon: '🚒', title: ':fire-truck:', sub: 'Emoji Picker' },
            ],
        },
        {
            q: 'weather lisbon',
            id: 'weather',
            name: 'Weather',
            icon: '🌤️',
            rows: [
                { icon: '⛅', title: 'Lisbon · 21°', sub: 'Partly cloudy · H 23° L 15°' },
                { icon: '🌦️', title: 'Tomorrow · 19°', sub: 'Showers later · H 20° L 14°' },
            ],
        },
        {
            q: 'pw',
            id: 'password',
            name: 'Password Generator',
            icon: '🔐',
            rows: [{ icon: '🔐', title: 'k7#Rq2!vLp9$Xw4m&Tz8', sub: '20 characters', mono: true }],
        },
        {
            q: 'timer 25m',
            id: 'timer',
            name: 'Timer & Stopwatch',
            icon: '⏱️',
            rows: [{ icon: '⏱️', title: 'Start a 25:00 timer', sub: 'Timer & Stopwatch' }],
        },
    ];

    const query = root.querySelector('[data-lm-query]');
    const rows = root.querySelector('[data-lm-rows]');
    const poses = [...root.querySelectorAll('[data-pose]')];
    const via = document.querySelector('[data-lm-via]');
    const viaIcon = document.querySelector('[data-lm-via-icon]');
    const viaName = document.querySelector('[data-lm-via-name]');
    const chips = [...document.querySelectorAll('[data-scene]')];
    const toggle = document.querySelector('[data-demo-toggle]');
    const HOLD = 3600;

    let index = 0;
    let paused = reduce;
    let visible = !('IntersectionObserver' in window);
    let timer = 0;
    let run = 0; // bumps on every new scene, so a stale typing loop stops

    const pose = (name) => poses.forEach((p) => p.classList.toggle('is-on', p.dataset.pose === name));

    function rowEl(r, selected) {
        const li = document.createElement('li');
        li.className = `lm-row${selected ? ' is-sel' : ''}`;
        const icon = document.createElement('span');
        icon.className = `lm-row__icon${r.swatch ? ' lm-row__icon--swatch' : ''}`;
        if (r.swatch) icon.style.setProperty('--c', r.swatch);
        else icon.textContent = r.icon;
        const text = document.createElement('span');
        text.className = 'lm-row__text';
        const b = document.createElement('b');
        if (r.mono) b.className = 'mono';
        b.textContent = r.title;
        const small = document.createElement('small');
        small.textContent = r.sub || '';
        text.append(b, small);
        const kbd = document.createElement('kbd');
        kbd.textContent = 'Enter';
        li.append(icon, text, kbd);
        return li;
    }

    function finish(s) {
        rows.replaceChildren(...s.rows.map((r, i) => rowEl(r, i === 0)));
        root.classList.remove('is-typing', 'is-empty');
        pose('happy');
        if (via) via.setAttribute('href', `#ext-${s.id}`);
        if (viaIcon) viaIcon.textContent = s.icon;
        if (viaName) viaName.textContent = s.name;
    }

    function mark() {
        chips.forEach((c, i) => c.setAttribute('aria-current', String(i === index)));
    }

    async function show(i, { animate = !reduce } = {}) {
        const my = ++run;
        clearTimeout(timer);
        index = (i + SCENES.length) % SCENES.length;
        const s = SCENES[index];
        mark();
        root.classList.toggle('is-anim', animate);
        if (!animate) {
            query.textContent = s.q;
            finish(s);
            plan();
            return;
        }
        rows.replaceChildren();
        query.textContent = '';
        root.classList.add('is-typing', 'is-empty');
        pose('typing');
        await wait(260);
        for (const ch of s.q) {
            if (my !== run) return;
            query.textContent += ch;
            root.classList.remove('is-empty');
            await wait(55 + Math.random() * 60);
        }
        if (my !== run) return;
        await wait(160);
        if (my !== run) return;
        finish(s);
        plan();
    }

    function plan() {
        clearTimeout(timer);
        if (paused || !visible || document.hidden) return;
        timer = setTimeout(() => show(index + 1), HOLD);
    }

    function wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function setPaused(p) {
        paused = p;
        toggle?.setAttribute('aria-pressed', String(p));
        root.classList.toggle('is-playing', !p && !reduce);
        if (p) clearTimeout(timer);
        else show(index + 1);
    }

    chips.forEach((c, i) =>
        c.addEventListener('click', () => {
            // Picking an example holds it there.
            paused = true;
            toggle?.setAttribute('aria-pressed', 'true');
            root.classList.remove('is-playing');
            show(i);
        })
    );
    toggle?.addEventListener('click', () => setPaused(toggle.getAttribute('aria-pressed') !== 'true'));

    if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
            const v = entries[entries.length - 1].isIntersecting;
            if (v === visible) return;
            visible = v;
            plan();
        }).observe(root);
    }
    document.addEventListener('visibilitychange', plan);

    toggle?.setAttribute('aria-pressed', String(paused));
    root.classList.toggle('is-playing', !paused && !reduce);
    mark();
    plan();
})();
