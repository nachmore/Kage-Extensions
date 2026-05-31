#!/usr/bin/env node
// Drift check: compare our vendored host-capabilities.mjs against the
// upstream Kage permissions table.
//
// Why we vendor at all: every PR check should run offline (no network
// dependency that could slow CI or fail flakily), and Kage-Extensions
// gets cloned by extension authors who don't want a hidden dependency
// on the Kage repo for `npm run validate`.
//
// Why we still want a drift check: the vendored copy has to be kept in
// sync. We run THIS script on a daily schedule (.github/workflows/
// host-sync.yml) so a divergence surfaces within 24h of the host
// landing a change. We DO NOT run it on every PR — that would block
// extension PRs on changes the extension didn't make.
//
// Output:
//   - exit 0 if our table is a strict superset of the upstream's
//     non-null entries (a vendored table that knows MORE than upstream
//     is OK; usually means upstream removed a command we still
//     reference for forward-compat).
//   - exit 1 with a diff summary otherwise.

import { COMMAND_CAPABILITIES, CAPABILITIES } from './host-capabilities.mjs';

const UPSTREAM_URL =
    'https://raw.githubusercontent.com/nachmore/Kage/main/ui/js/shared/extension-permissions.js';

async function fetchUpstream() {
    const r = await fetch(UPSTREAM_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${UPSTREAM_URL}`);
    return await r.text();
}

/**
 * Extract the upstream COMMAND_CAPABILITIES table from the source by
 * regex. We deliberately avoid `eval` / dynamic import — the file
 * contains other top-level code we don't want to execute, and the
 * shape of the table is stable enough that a regex works.
 *
 * Strategy:
 *   - Find the `export const COMMAND_CAPABILITIES = Object.freeze({` line.
 *   - Slurp until the matching `});`.
 *   - For each `key: 'value'` or `key: null` line, record the pair.
 *
 * Tolerates trailing commas, quoted keys, comments. Doesn't try to
 * handle weirder JS — if the host file ever stops being a flat
 * key→value object, this script will fail loudly and we update.
 */
function extractTable(src, name) {
    const start = src.indexOf(`export const ${name} = Object.freeze({`);
    if (start < 0) throw new Error(`could not find '${name}' in upstream`);
    let depth = 0;
    let i = start;
    while (i < src.length) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                i++;
                break;
            }
        }
        i++;
    }
    const body = src.slice(start, i);
    const out = {};
    // Strip line comments first.
    const cleaned = body
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    // Match `name: 'cap'` / `name: "cap"` / `name: null`.
    const re = /(?:^|[\s,{])([a-z_][a-z0-9_]*)\s*:\s*(?:null|'([^']*)'|"([^"]*)")/gi;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const key = m[1];
        if (key === 'COMMAND_CAPABILITIES' || key === 'CAPABILITIES') continue; // header
        out[key] = m[2] ?? m[3] ?? null;
    }
    return out;
}

async function main() {
    let src;
    try {
        src = await fetchUpstream();
    } catch (e) {
        console.error(`Could not fetch upstream — skipping drift check: ${e.message}`);
        // Don't fail CI on a transient network blip; the schedule will
        // catch it next run.
        process.exit(0);
    }

    let upstream;
    try {
        upstream = extractTable(src, 'COMMAND_CAPABILITIES');
    } catch (e) {
        console.error(
            `Couldn't parse upstream COMMAND_CAPABILITIES — host file shape may have changed: ${e.message}`
        );
        process.exit(1);
    }

    const issues = [];
    // Commands upstream knows about but we don't.
    for (const [cmd, cap] of Object.entries(upstream)) {
        if (!Object.hasOwn(COMMAND_CAPABILITIES, cmd)) {
            issues.push(`MISSING: '${cmd}' (upstream cap=${cap === null ? 'null' : `'${cap}'`})`);
        } else if (COMMAND_CAPABILITIES[cmd] !== cap) {
            issues.push(
                `DRIFT: '${cmd}' — upstream=${cap === null ? 'null' : `'${cap}'`}, vendored=${COMMAND_CAPABILITIES[cmd] === null ? 'null' : `'${COMMAND_CAPABILITIES[cmd]}'`}`
            );
        }
    }

    // Capabilities upstream knows about but we don't list in
    // KNOWN_CAPABILITIES. Use a heuristic: any new cap value that
    // appears in upstream.
    const upstreamCapValues = new Set(
        Object.values(upstream).filter((c) => typeof c === 'string')
    );
    const ourCaps = new Set(Object.keys(CAPABILITIES));
    for (const cap of upstreamCapValues) {
        if (!ourCaps.has(cap)) {
            issues.push(`UNKNOWN-CAP: upstream uses capability '${cap}' that we don't list`);
        }
    }

    if (issues.length > 0) {
        console.error(`Host capability drift detected (${issues.length} issue(s)):`);
        for (const i of issues) console.error(`  - ${i}`);
        console.error(
            `\nSync scripts/host-capabilities.mjs against ${UPSTREAM_URL} and re-run.`
        );
        process.exit(1);
    }
    console.log('Host capability table is in sync with upstream.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
