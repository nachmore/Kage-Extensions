#!/usr/bin/env node
// Version-bump gate.
//
// Clients update an installed extension only when the catalog advertises a
// HIGHER manifest version (Kage compares semver: remote > local). So any
// change to an extension's source that ships without a version bump is
// invisible to every user who already has it installed — the fix merges,
// CI goes green, and nothing flows. We hit exactly this with the calendar
// and todos timezone/widget fixes.
//
// This gate catches it deterministically. The catalog builder already
// records a per-extension `sourceHash` (sha256 of the source tree) next to
// its `version` in the published catalog.json. We recompute each local
// extension's hash with the SAME hashTree() the builder uses, fetch the
// live catalog, and fail when:
//
//     local sourceHash != published sourceHash   (the source changed)
//   AND local version  == published version       (but the version didn't)
//
// Reusing the builder's hashTree() means zero false positives from
// whitespace/formatting that the packager would also ignore — the hash IS
// what decides whether a new zip gets cut.
//
// New extensions (id absent from the live catalog) are fine: there's
// nothing to update from. A bumped version is fine regardless of hash.
//
// Network note: if the live catalog can't be fetched (first-ever deploy,
// Pages outage), we can't compare — that's a soft skip with a loud log,
// not a hard fail, so a transient outage doesn't block all merges. The
// build job re-derives everything from scratch in that case anyway.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree, listDirs, readJson } from './build-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PAGES_URL = process.env.PAGES_URL || 'https://nachmore.github.io/Kage-Extensions';

const errors = [];
const note = (loc, msg) => errors.push(`${loc}: ${msg}`);

async function fetchLiveCatalog() {
    try {
        const resp = await fetch(`${PAGES_URL}/catalog.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const catalog = await resp.json();
        if (!catalog || !Array.isArray(catalog.items)) {
            throw new Error('catalog has no items array');
        }
        return catalog;
    } catch (e) {
        return { error: e.message };
    }
}

async function main() {
    const catalog = await fetchLiveCatalog();
    if (catalog.error) {
        console.log(
            `[versions] SKIP — could not fetch the live catalog (${catalog.error}). ` +
                `Nothing to compare against; the build job rebuilds from scratch.`
        );
        return;
    }

    const publishedById = new Map();
    for (const it of catalog.items) publishedById.set(it.id, it);

    // Walk both kinds, mirroring build-catalog.mjs's iteration.
    for (const kind of ['extension', 'theme']) {
        const root = path.join(repoRoot, kind === 'extension' ? 'extensions' : 'themes');
        const dirs = (await listDirs(root)).sort();

        for (const d of dirs) {
            const dir = path.join(root, d);
            const manifestPath = path.join(dir, 'manifest.json');
            try {
                await stat(manifestPath);
            } catch {
                // validate-manifests.mjs flags a missing manifest; skip here.
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
            const version = manifest?.version;
            const published = publishedById.get(id);

            // Not yet published → first release, nothing to drift from.
            if (!published) continue;

            const localHash = await hashTree(dir);

            if (localHash === published.sourceHash) continue; // unchanged

            // Source changed. The only acceptable state is a higher version.
            if (version === published.version) {
                note(
                    `${kind}s/${d}`,
                    `source changed but version is still ${version} — clients won't see ` +
                        `the update (Kage only pulls a higher semver). Bump "version" in ` +
                        `${path.relative(repoRoot, manifestPath).replace(/\\/g, '/')}.`
                );
            }
            // version != published.version (assumed higher; validate-manifests
            // already enforces semver shape) → the bump is present, good.
        }
    }

    if (errors.length > 0) {
        console.error(`[versions] ${errors.length} unbumped change(s):`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log('[versions] OK — every changed extension has a version bump.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
