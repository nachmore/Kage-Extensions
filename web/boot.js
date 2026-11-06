/* Kage Extension Store: runs first, in <head>, before the page is drawn.
 *
 * - Swaps <html class="no-js"> for "js", so the controls that need
 *   JavaScript show (style.css hides .needs-js under .no-js) and the
 *   scroll reveals start hidden. If this file never runs, the page stays
 *   no-js: everything is shown, minus controls that couldn't work anyway.
 *   If main.js then never runs, a CSS failsafe shows the reveals after
 *   2.5 s (see .reveal-ready in style.css).
 * - Notes the OS in data-os, for Mac key labels.
 * - Watches the page's other scripts: when one fails to load (blocked,
 *   offline, a 404), the class in its data-fail-class goes on <html> and
 *   style.css hides what that script would have run. app.js is a module,
 *   so a browser without modules (which skips it silently) is treated as
 *   app.js failing.
 *
 * It's a file, not an inline <script>, so a strict Content-Security-Policy
 * (script-src 'self') doesn't stop it.
 */
(function (d, w) {
    var h = d.documentElement;
    var n = w.navigator;
    var p = (n.userAgentData && n.userAgentData.platform) || n.platform || '';
    h.classList.remove('no-js');
    h.classList.add('js');
    h.setAttribute('data-os', /mac/i.test(p) && n.maxTouchPoints < 2 ? 'mac' : /win/i.test(p) ? 'windows' : 'other');

    function failed(c) {
        if (c && /^[a-z][a-z-]*$/.test(c)) h.classList.add(c);
    }

    if (!('noModule' in d.createElement('script'))) failed('store-failed');

    // Load errors don't bubble, but the capture phase sees them.
    w.addEventListener(
        'error',
        function (e) {
            var t = e.target;
            if (t && t.nodeType === 1 && t.tagName === 'SCRIPT') failed(t.getAttribute('data-fail-class'));
        },
        true
    );
})(document, window);
