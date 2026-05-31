#!/usr/bin/env node
// Static security checks for extension JS source.
//
// Extensions run inside a sandboxed iframe (allow-scripts only, no
// allow-same-origin), so the host's WebView already protects against
// the worst classes of damage. These checks are belt-and-suspenders:
// they catch authoring mistakes that survive the sandbox in spirit if
// not in mechanics — patterns that turn an extension into a vehicle
// for arbitrary code execution from non-source data, or that defeat
// the host's vendor-allowlist by pulling in remote scripts.
//
// Patterns checked (each is reported with file + line):
//
//   eval / new Function / setTimeout(string)
//     The classic dynamic-code-execution trio. Even inside a sandbox
//     these turn user-typed strings into code; a search provider that
//     evals a query is a foothold for anything the extension's own
//     caps grant. There's never a legitimate reason to use them in an
//     extension — lookup tables and switch statements always work.
//
//   import('http...') / import("http...")
//     Defeats the host's vendor allowlist and the offline-after-install
//     model. The sandbox host fetches every dependency at boot from
//     local sources or the explicit sandboxVendor allowlist; runtime
//     imports of arbitrary URLs are a downgrade attack vector.
//
//   <script src="http...">
//     Same reason. Pure-string match — won't catch every vector but
//     catches the obvious authoring mistake.
//
//   document.write
//     Generally a code-smell and historically a vector for HTML
//     injection. Sandboxed iframes have a null origin so this is less
//     dangerous than on the open web, but still wrong tool / wrong
//     job.
//
//   innerHTML += / .innerHTML = `...${var}...` (best-effort)
//     XSS-shaped pattern: variable interpolated directly into HTML.
//     Reported as a warning rather than an error because there's a
//     legitimate use (interpolating values you ALREADY HTML-escaped),
//     but it's worth flagging so reviewers double-check.
//
// Usage:
//   node scripts/check-security.mjs              # check changed extensions only
//   node scripts/check-security.mjs --all        # force-check everything
//
// Affected-paths logic: see scripts/lib/affected.mjs. CI passes the
// PR base/head SHAs via env so we only re-scan extensions whose files
// changed; an unrelated PR shouldn't be blocked by a regression in
// an unrelated extension.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedItems, shouldRun } from './lib/affected.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const flagAll = args.has('--all');

// Pattern table. Each entry has:
//   id       — short stable name for log filtering
//   severity — 'error' (fails CI) or 'warn' (logged, doesn't fail)
//   regex    — applied per-line; first match per line is reported
//   message  — human-readable explanation shown in the log
const PATTERNS = [
    {
        id: 'eval',
        severity: 'error',
        // `eval(` but skip property accesses like `obj.eval` — those are
        // user-defined methods, not the global eval.
        regex: /(?<![.\w$])eval\s*\(/,
        message:
            "eval() is forbidden — turn dynamic strings into a lookup table or switch statement instead.",
    },
    {
        id: 'new-function',
        severity: 'error',
        regex: /\bnew\s+Function\s*\(/,
        message: "new Function(...) is forbidden — same reasoning as eval().",
    },
    {
        id: 'set-timeout-string',
        severity: 'error',
        // setTimeout/setInterval with a string first arg, e.g.
        // setTimeout('alert(1)', 100). Quick heuristic: opening quote
        // immediately after the paren.
        regex: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/,
        message:
            "setTimeout/setInterval with a string body is forbidden — pass a function reference.",
    },
    {
        id: 'remote-import',
        severity: 'error',
        // `import('http...')` or `import("http...")` — dynamic remote
        // code load, defeats the vendor allowlist.
        regex: /\bimport\s*\(\s*['"`]https?:/,
        message:
            "Remote dynamic import() is forbidden — every dependency must be vendored or declared in the manifest's sandboxVendor allowlist.",
    },
    {
        id: 'remote-script',
        severity: 'error',
        regex: /<script[^>]+src\s*=\s*['"`]https?:/,
        message:
            "<script src='http...'> is forbidden — dependencies must be local or in the sandboxVendor allowlist.",
    },
    {
        id: 'document-write',
        severity: 'error',
        regex: /document\.write\s*\(/,
        message:
            "document.write() is forbidden — manipulate the DOM via createElement/textContent instead.",
    },
    {
        id: 'innerhtml-interp',
        severity: 'warn',
        // `.innerHTML = `...${...}...`` or `.innerHTML += ...` with
        // a template string. Heuristic — reviewer must verify that
        // interpolated values were HTML-escaped.
        regex: /\binnerHTML\s*[+]?=\s*`[^`]*\$\{/,
        message:
            "innerHTML interpolation: confirm every variable is HTML-escaped (use the host's escapeHtml or textContent for untrusted input).",
    },
];

const results = []; // { extId, file, line, lineText, pattern, severity, message }

async function listJsFiles(dir) {
    // Skip _locales — they're JSON.
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.name === 'node_modules' || e.name === '_locales') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await listJsFiles(full)));
        } else if (/\.(?:js|mjs|cjs)$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

async function scanFile(file, extId) {
    let txt;
    try {
        txt = await readFile(file, 'utf8');
    } catch {
        return;
    }
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip pure-comment lines for the strict patterns to avoid false
        // positives on documentation that mentions `eval`. We don't try to
        // be clever — multi-line block comments are NOT excluded; reviewer
        // can suppress with a // safe: ... comment if needed.
        const stripped = line.replace(/\/\/.*$/, '');
        for (const pat of PATTERNS) {
            if (pat.regex.test(stripped)) {
                results.push({
                    extId,
                    file: path.relative(repoRoot, file),
                    line: i + 1,
                    lineText: line.trim(),
                    pattern: pat.id,
                    severity: pat.severity,
                    message: pat.message,
                });
                // One pattern per line is enough — keep output tight.
                break;
            }
        }
    }
}

async function scanItem(itemKey) {
    const dir = path.join(repoRoot, itemKey);
    const files = await listJsFiles(dir);
    for (const f of files) await scanFile(f, itemKey);
}

async function main() {
    const affected = await affectedItems();
    const targets = affected.all.filter((it) => shouldRun(it, affected, { all: flagAll }));

    if (affected.mode === 'changed' && !flagAll) {
        const skipped = affected.all.length - targets.length;
        if (skipped > 0) {
            console.log(
                `[security] scanning ${targets.length}/${affected.all.length} item(s) — ${skipped} unchanged.`
            );
        }
    }

    for (const it of targets) {
        // Themes are pure data; no JS.
        if (it.startsWith('themes/')) continue;
        await scanItem(it);
    }

    if (results.length === 0) {
        console.log('[security] OK');
        return;
    }

    const errs = results.filter((r) => r.severity === 'error');
    const warns = results.filter((r) => r.severity === 'warn');

    for (const r of errs) {
        console.error(
            `${r.file}:${r.line}: error [${r.pattern}] ${r.message}\n  | ${r.lineText}`
        );
    }
    for (const r of warns) {
        console.warn(
            `${r.file}:${r.line}: warn [${r.pattern}] ${r.message}\n  | ${r.lineText}`
        );
    }

    console.error(
        `[security] ${errs.length} error(s), ${warns.length} warning(s).`
    );
    if (errs.length > 0) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
