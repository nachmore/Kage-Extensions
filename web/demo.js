/* Kage Extension Store: the launcher in the hero.
 *
 * Types an example query, then shows what the extension answers, and moves
 * on to the next every few seconds. The markup is the first scene, finished,
 * so without this script (or with reduced motion) there's still a complete
 * picture. The chips jump to an example and hold it; the button pauses and
 * plays the cycle (WCAG 2.2.2). Nothing runs while the launcher is off
 * screen or the tab is hidden: pausing, scrolling away or switching tabs
 * stops the typing on the spot and leaves that scene complete.
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
    // Every wait belongs to a generation. cancel() starts a new one and
    // ends the waits of the old, so whatever was typing (or waiting to
    // move on) stops there: nothing keeps a timer once it's cancelled.
    let gen = 0;
    const waits = new Map(); // timer id → resolve
    let typing = false; // a scene is being typed in
    let planned = false; // the next scene is waiting its turn

    const onScreen = () => visible && !document.hidden;
    const pose = (name) => poses.forEach((p) => p.classList.toggle('is-on', p.dataset.pose === name));

    // Resolves true after `ms`, or false as soon as cancel() runs.
    function wait(ms) {
        const my = gen;
        return new Promise((resolve) => {
            const id = setTimeout(() => {
                waits.delete(id);
                resolve(my === gen);
            }, ms);
            waits.set(id, resolve);
        });
    }

    function cancel() {
        gen++;
        planned = false;
        for (const [id, resolve] of waits) {
            clearTimeout(id);
            resolve(false);
        }
        waits.clear();
    }

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

    // The scene, complete: its whole query and its answer.
    function finish(s) {
        typing = false;
        query.textContent = s.q;
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
        cancel();
        index = (i + SCENES.length) % SCENES.length;
        const s = SCENES[index];
        mark();
        root.classList.toggle('is-anim', animate);
        if (!animate || !onScreen()) {
            finish(s);
            plan();
            return;
        }
        typing = true;
        rows.replaceChildren();
        query.textContent = '';
        root.classList.add('is-typing', 'is-empty');
        pose('typing');
        if (!(await wait(260))) return;
        for (const ch of s.q) {
            query.textContent += ch;
            root.classList.remove('is-empty');
            if (!(await wait(55 + Math.random() * 60))) return;
        }
        if (!(await wait(160))) return;
        finish(s);
        plan();
    }

    // Queue the next scene, if the cycle is playing and can be seen.
    function plan() {
        if (planned || typing || paused || !onScreen()) return;
        planned = true;
        wait(HOLD).then((ok) => {
            if (ok) show(index + 1);
        });
    }

    // Stop where we are. A scene cut off mid-typing is shown complete, so
    // a pause (or coming back to the tab) always starts from a whole scene.
    function halt() {
        const cut = typing;
        cancel();
        if (cut) finish(SCENES[index]);
    }

    function setPaused(p) {
        paused = p;
        toggle?.setAttribute('aria-pressed', String(p));
        root.classList.toggle('is-playing', !p && !reduce);
        if (p) halt();
        else if (onScreen()) show(index + 1);
    }

    // Off screen or in a hidden tab, nothing runs; back in view, the
    // cycle carries on from the scene that's showing.
    function onVisibility() {
        if (onScreen()) plan();
        else halt();
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
            onVisibility();
        }).observe(root);
    }
    document.addEventListener('visibilitychange', onVisibility);

    toggle?.setAttribute('aria-pressed', String(paused));
    root.classList.toggle('is-playing', !paused && !reduce);
    mark();
    plan();
})();
