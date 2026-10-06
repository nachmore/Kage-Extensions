/**
 * Shared mock of the host `context` object that Kage injects into every
 * extension provider's `initialize(context)`.
 *
 * The real context is built by the sandbox runtime (Kage repo:
 * ui/js/extension-sandbox/runtime.js :: buildContext). It exposes:
 *   - invoke(command, args)      → Promise; proxies a Tauri command via the host
 *   - config                     → the extension's resolved config object
 *   - log {debug,info,warn,error}→ routes to the app log
 *   - runSandboxed({run,vendor,data,timeoutMs}) → runs `run(data, lib)` in a
 *                                  pooled Worker, with `lib.<name>` set to each
 *                                  requested vendor global (e.g. lib.math = mathjs)
 *   - i18n {t, language, isRtl}  → ICU-subset translator
 *   - mascot {setActivity, clearActivity} → generic mascot activity hints
 *
 * These mocks reproduce that surface closely enough for functional tests
 * while staying synchronous-friendly and inspectable:
 *   - `invoke` is a vi.fn() you can stub per test (or seed via `invokes`).
 *   - `runSandboxed` actually executes the provider's `run` fn in-process,
 *     passing a `lib` you supply (e.g. { math }). This exercises the real
 *     serialization-shaped code path (run fn closes over nothing, reads
 *     inputs from `data`, vendor globals from `lib`) without a Worker.
 *   - `log` records calls so tests can assert "this failure was logged".
 *   - `i18n.t` returns the catalog value or echoes the key, mirroring the
 *     runtime's fallback so a missing translation never throws.
 *   - `mascot.setActivity` / `clearActivity` are vi.fn()s so a test can assert
 *     the activity lease is asserted and released at the right moments. Pass
 *     `mascot: null` to simulate an OLDER HOST that has no mascot API at all —
 *     every extension must keep working in that case.
 */

import { vi } from 'vitest';

/**
 * Build a mock context.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]   - extension config (defaults to {})
 * @param {object} [opts.invokes]  - map of command name → handler(args) or value.
 *                                    A function is called with args; anything else
 *                                    is returned as-is. Unlisted commands reject.
 * @param {object} [opts.lib]      - vendor globals for runSandboxed (e.g. { math }).
 * @param {object} [opts.catalog]  - i18n catalog: { key: { message } } or { key: string }.
 * @param {string} [opts.language] - active language (default 'en').
 * @param {boolean}[opts.rtl]      - RTL flag (default false).
 * @param {object|null} [opts.mascot] - pass `null` to omit `context.mascot`
 *                                    entirely (simulates a pre-mascot host).
 * @returns {{context: object, log: object, invoke: import('vitest').Mock, mascot: object|null}}
 *          `context` to hand to initialize(); `log`, `invoke` and `mascot` exposed for assertions.
 */
export function makeContext(opts = {}) {
    const {
        config = {},
        invokes = {},
        lib = {},
        catalog = {},
        language = 'en',
        rtl = false,
        mascot: mascotOpt,
    } = opts;

    const invoke = vi.fn(async (command, args) => {
        if (!(command in invokes)) {
            throw new Error(`mock invoke: no handler registered for '${command}'`);
        }
        const h = invokes[command];
        return typeof h === 'function' ? h(args) : h;
    });

    const log = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };

    // Execute the provider's run fn in-process. Mirrors the runtime contract:
    // `run(data, lib)` — no closures over outer state, vendor globals via lib.
    // We deliberately run it through Function-toString-and-back so a test
    // catches a run fn that accidentally closes over its lexical scope (which
    // would silently work here but break in the real Worker).
    const runSandboxed = vi.fn(async ({ run, vendor = [], data } = {}) => {
        if (typeof run !== 'function') {
            throw new Error('runSandboxed: run must be a function');
        }
        const reRun = new Function(`return (${run.toString()})`)();
        const scopedLib = {};
        for (const name of vendor) scopedLib[name] = lib[name];
        return reRun(data, scopedLib);
    });

    const t = (key, vars) => {
        const entry = catalog[key];
        const tpl = typeof entry === 'string' ? entry : (entry?.message ?? key);
        return formatIcuSubset(tpl, vars || {});
    };

    // Generic mascot activity hints. The real surface is fire-and-forget (the
    // runtime just posts a message), so these return nothing — an extension
    // must not depend on a return value. `mascot: null` drops the whole object
    // so tests can prove the extension survives an older host.
    const mascot =
        mascotOpt === null
            ? null
            : mascotOpt || {
                setActivity: vi.fn(),
                clearActivity: vi.fn(),
            };

    const context = {
        invoke,
        config,
        log,
        runSandboxed,
        i18n: { t, language: () => language, isRtl: () => rtl },
    };
    if (mascot) context.mascot = mascot;

    return { context, log, invoke, mascot };
}

/**
 * Tiny ICU-subset substitution: replaces `{name}` with vars.name. Mirrors the
 * common case of the runtime's formatIcu without pulling in plural/select —
 * enough for test assertions on translated strings.
 */
function formatIcuSubset(template, vars) {
    if (typeof template !== 'string' || !template.includes('{')) return template || '';
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
        name in vars ? String(vars[name]) : whole
    );
}
