#!/usr/bin/env node
// CI helper — fetches the currently-published catalog (and the zips it
// references) from the live GitHub Pages URL into dist/, so the next
// build-catalog.mjs run can skip repackaging unchanged extensions.
//
// We can't use actions/checkout against `gh-pages` because we deploy to
// Pages via the `deploy-pages` action (artifact upload, no branch).
// Hitting the public URL is the most direct way to recover the prior
// state — and it's read-only, so there's no race with a concurrent
// build.
//
// Failures are non-fatal: on the first deploy the URL 404s, and we
// fall through to a from-scratch build.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dist = path.join(repoRoot, 'dist');

const PAGES_URL = process.env.PAGES_URL || 'https://nachmore.github.io/Kage-Extensions';

async function fetchBuf(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}

async function fetchJson(url) {
    const buf = await fetchBuf(url);
    return JSON.parse(buf.toString('utf8'));
}

async function main() {
    await mkdir(dist, { recursive: true });
    let catalog;
    try {
        catalog = await fetchJson(`${PAGES_URL}/catalog.json`);
    } catch (e) {
        console.log(`No previous catalog (${e.message}); skipping seed.`);
        return;
    }
    if (!catalog || !Array.isArray(catalog.items)) {
        console.log('Catalog has no items; skipping seed.');
        return;
    }

    await writeFile(path.join(dist, 'catalog.json'), JSON.stringify(catalog, null, 2));

    const pkgDir = path.join(dist, 'packages');
    await mkdir(pkgDir, { recursive: true });

    let reused = 0;
    let missed = 0;
    for (const item of catalog.items) {
        const rel = item.downloadUrl;
        if (!rel) continue;
        const name = path.basename(rel);
        const target = path.join(pkgDir, name);
        if (existsSync(target)) continue;
        try {
            const buf = await fetchBuf(`${PAGES_URL}/${rel}`);
            await writeFile(target, buf);
            // Sidecar checksum, in case a downstream consumer wants it.
            await writeFile(`${target}.sha256`, `${item.sha256}  ${name}\n`);
            reused++;
        } catch (e) {
            missed++;
            console.log(`  miss   ${name} (${e.message})`);
        }
    }
    console.log(`Seeded ${reused} zip(s) from previous deploy (${missed} missing).`);
}

main().catch((e) => {
    console.error(`seed-dist failed: ${e.message}`);
    // Don't fail the build — incremental is an optimization, not a requirement.
    process.exit(0);
});
