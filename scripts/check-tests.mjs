#!/usr/bin/env node
// Test-presence gate.
//
// Every extension that ships executable provider code (a search/tool/trigger/
// formatter/toolbar provider, or a widget) must carry at least one *.test.js
// file in its directory. Provider logic — parsers, matchers, formatters — is
// exactly what silently regresses when an author refactors; the math extension
// shipped broken once precisely because nothing exercised it. This check makes
// "add a test" the default for new contributions instead of an afterthought.
//
// Runs against EVERY extension every time (cheap: it's just file-existence and
// a manifest read), like validate-manifests. Themes and pure command-packs are
// exempt — they contribute no JS to test.
//
// Exemptions: an extension can opt out by adding its id to TEST_EXEMPT below
// with a one-line reason. Opting out is deliberately a code change so it
// surfaces in review rather than passing silently. Keep this list short.
//
// Single-pass: collect every failure, then exit non-zero so a contributor sees
// the whole list in one round trip.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const extensionsRoot = path.join(repoRoot, 'extensions');

// Extensions allowed to ship without tests, each with a reason. Adding an id
// here is a conscious, reviewable decision — prefer writing a test instead.
// Empty by design: every code-contributing extension currently has tests.
// Even the network/DOM-heavy ones (spotify, link-preview) have basic coverage
// of their pure parsing/formatting logic.
const TEST_EXEMPT = new Map();

// Manifest `contributes.*` keys that point at executable JS we expect tested.
// (css/themes are assets, not logic, so they don't count.)
const CODE_PROVIDER_KEYS = [
    'searchProvider',
    'toolProvider',
    'triggerProvider',
    'messageFormatters',
    'toolbarButtons',
    'settingsProvider',
    'widgets',
];

const errors = [];
const note = (loc, msg) => errors.push(`${loc}: ${msg}`);

async function listDirs(parent) {
    let entries;
    try {
        entries = await readdir(parent, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function readJson(p) {
    return JSON.parse(await readFile(p, 'utf8'));
}

/** Does this manifest contribute any executable provider code? */
function contributesCode(manifest) {
    const c = manifest?.contributes;
    if (!c || typeof c !== 'object') return false;
    return CODE_PROVIDER_KEYS.some((k) => {
        const v = c[k];
        if (v == null) return false;
        if (Array.isArray(v)) return v.length > 0; // widgets
        return true;
    });
}

/** True if the directory contains at least one *.test.js (or *.test.mjs). */
async function hasTestFile(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    } catch {
        return false;
    }
    return entries.some((f) => /\.test\.m?js$/.test(f));
}

async function main() {
    const dirs = await listDirs(extensionsRoot);
    const exemptUsed = new Set();

    for (const d of dirs) {
        const dir = path.join(extensionsRoot, d);
        const manifestPath = path.join(dir, 'manifest.json');
        try {
            await stat(manifestPath);
        } catch {
            // validate-manifests.mjs already flags a missing manifest; skip here.
            continue;
        }

        let manifest;
        try {
            manifest = await readJson(manifestPath);
        } catch {
            // Parse error already reported by validate-manifests.mjs.
            continue;
        }

        const id = typeof manifest?.id === 'string' ? manifest.id : d;

        if (!contributesCode(manifest)) {
            // No executable provider → nothing to unit-test (e.g. a command
            // pack). If such an extension is also on the exemption list, that's
            // stale — flag it so the list stays honest.
            if (TEST_EXEMPT.has(id)) {
                note(
                    `extensions/${d}`,
                    `is on TEST_EXEMPT but contributes no provider code — remove the stale exemption`
                );
            }
            continue;
        }

        const hasTest = await hasTestFile(dir);

        if (TEST_EXEMPT.has(id)) {
            exemptUsed.add(id);
            // An exempt extension that DID add tests no longer needs the
            // exemption — nudge the author to drop it.
            if (hasTest) {
                note(
                    `extensions/${d}`,
                    `now has tests but is still listed in TEST_EXEMPT — remove the exemption`
                );
            }
            continue;
        }

        if (!hasTest) {
            note(
                `extensions/${d}`,
                `contributes provider code but has no *.test.js. Add a functional test ` +
                    `(see extensions/math/search.test.js + test-helpers/mock-context.mjs), ` +
                    `or, if it genuinely can't be unit-tested, add '${id}' to TEST_EXEMPT in ` +
                    `scripts/check-tests.mjs with a reason.`
            );
        }
    }

    // Flag exemptions for extensions that no longer exist, so the list doesn't rot.
    for (const id of TEST_EXEMPT.keys()) {
        if (!exemptUsed.has(id) && !errors.some((e) => e.includes(`/${id}:`))) {
            const stillPresent = dirs.includes(id);
            if (!stillPresent) {
                note(
                    'scripts/check-tests.mjs',
                    `TEST_EXEMPT lists '${id}' but no such extension exists — remove the stale entry`
                );
            }
        }
    }

    if (errors.length > 0) {
        console.error(`[tests] ${errors.length} issue(s):`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log(`[tests] OK — every code-contributing extension has a test (or a declared exemption).`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
