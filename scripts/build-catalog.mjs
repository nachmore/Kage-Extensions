#!/usr/bin/env node
// Build the static catalog that Kage's store consumes.
//
// Output layout (under dist/):
//   catalog.json                         — index for the store browser + Kage client
//   detail/<id>.json                     — full per-item record (manifest + readme + size + sha256)
//   packages/<id>-<version>.zip          — the installable bundle, content-hash-stable
//   packages/<id>-<version>.zip.sha256   — sidecar checksum (CI integrity self-check)
//
// Versioned zip names give us cache-immutable URLs: when a zip's contents
// change the file name changes too, so any CDN / Pages cache returns the
// fresh artifact instantly without invalidation.
//
// Incremental rebuilds: if a previous dist/ exists (CI checks out the
// gh-pages branch into dist/), we hash each extension's source tree and
// reuse the existing zip when the hash matches. Manifest version stays
// the source of truth for the user-facing version field; the source
// content hash is what decides whether we repackage.

import { createHash } from 'node:crypto';
import {
    cp,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import archiver from 'archiver';

const SCHEMA_VERSION = 1;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(repoRoot, 'dist');
const distPackages = path.join(distRoot, 'packages');
const distDetail = path.join(distRoot, 'detail');
const previousCatalogPath = path.join(distRoot, 'catalog.json');

async function readJson(p) {
    return JSON.parse(await readFile(p, 'utf8'));
}

async function listDirs(parent) {
    try {
        const entries = await readdir(parent, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

// Recursively list every regular file under `dir`, returned as paths
// relative to `dir`. Sorted for deterministic hashing across machines.
async function listFilesRecursive(dir) {
    const out = [];
    async function walk(rel) {
        const abs = path.join(dir, rel);
        const entries = await readdir(abs, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                await walk(childRel);
            } else if (e.isFile()) {
                out.push(childRel);
            }
        }
    }
    await walk('');
    return out;
}

// Hash of the entire extension/theme source tree. Stable across OSes
// because we sort entries and hash content + relative path.
async function hashTree(dir) {
    const files = await listFilesRecursive(dir);
    const hasher = createHash('sha256');
    for (const rel of files) {
        hasher.update(rel);
        hasher.update('\0');
        const data = await readFile(path.join(dir, rel));
        hasher.update(data);
        hasher.update('\0');
    }
    return hasher.digest('hex');
}

// sha256 of an existing file (used for the published zip checksum).
async function hashFile(p) {
    const hasher = createHash('sha256');
    return new Promise((resolve, reject) => {
        const s = createReadStream(p);
        s.on('error', reject);
        s.on('data', (chunk) => hasher.update(chunk));
        s.on('end', () => resolve(hasher.digest('hex')));
    });
}

// Zip the extension folder so its files are at the zip root (manifest.json
// at top level). Kage's installer accepts either layout, but a flat zip
// is the conventional one and what the dev_server.py mock currently expects.
async function packageDir(srcDir, outZip) {
    await mkdir(path.dirname(outZip), { recursive: true });
    return new Promise((resolve, reject) => {
        const output = createWriteStream(outZip);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('warning', (err) => {
            if (err.code !== 'ENOENT') reject(err);
        });
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(srcDir, false);
        archive.finalize();
    });
}

async function loadPreviousCatalog() {
    if (!existsSync(previousCatalogPath)) return null;
    try {
        return await readJson(previousCatalogPath);
    } catch {
        return null;
    }
}

async function processItem({ kind, dirName, previousById }) {
    const srcRoot = path.join(repoRoot, kind === 'extension' ? 'extensions' : 'themes');
    const srcDir = path.join(srcRoot, dirName);
    const manifestPath = path.join(srcDir, 'manifest.json');
    const manifest = await readJson(manifestPath);

    const id = manifest.id;
    const version = manifest.version;
    const sourceHash = await hashTree(srcDir);
    const zipName = `${id}-${version}.zip`;
    const zipPath = path.join(distPackages, zipName);
    const checksumPath = `${zipPath}.sha256`;

    const previous = previousById.get(id);
    const reuseExisting =
        previous &&
        previous.version === version &&
        previous.sourceHash === sourceHash &&
        existsSync(zipPath) &&
        existsSync(checksumPath);

    let sha256;
    let size;
    let updatedAt;

    if (reuseExisting) {
        sha256 = previous.sha256;
        size = previous.size;
        updatedAt = previous.updatedAt;
        console.log(`  reuse  ${id}@${version} (unchanged)`);
    } else {
        await packageDir(srcDir, zipPath);
        sha256 = await hashFile(zipPath);
        await writeFile(checksumPath, `${sha256}  ${zipName}\n`);
        const st = await stat(zipPath);
        size = st.size;
        updatedAt = new Date().toISOString();
        console.log(`  build  ${id}@${version} (size=${size} sha256=${sha256.slice(0, 12)}...)`);
    }

    // README.md if present, used by the store detail page.
    let readme = null;
    const readmePath = path.join(srcDir, 'README.md');
    if (existsSync(readmePath)) {
        readme = await readFile(readmePath, 'utf8');
    }

    const catalogEntry = {
        id,
        type: manifest.type,
        name: manifest.name,
        version,
        author: manifest.author ?? null,
        description: manifest.description ?? '',
        icon: manifest.icon ?? '',
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        downloadUrl: `packages/${zipName}`,
        detailUrl: `detail/${id}.json`,
        size,
        sha256,
        sourceHash,
        updatedAt,
    };

    const detailEntry = {
        ...catalogEntry,
        manifest,
        readme,
    };

    const detailPath = path.join(distDetail, `${id}.json`);
    await mkdir(path.dirname(detailPath), { recursive: true });
    await writeFile(detailPath, JSON.stringify(detailEntry, null, 2));

    return catalogEntry;
}

async function main() {
    // Don't blow away dist/ — CI seeds it with the previous gh-pages content
    // so we can detect "no change → reuse zip" cases. We only delete
    // detail/ (always rewritten) and stale package files at the end.
    await mkdir(distRoot, { recursive: true });
    await mkdir(distPackages, { recursive: true });
    await rm(distDetail, { recursive: true, force: true });
    await mkdir(distDetail, { recursive: true });

    const previous = await loadPreviousCatalog();
    const previousById = new Map();
    if (previous && Array.isArray(previous.items)) {
        for (const it of previous.items) previousById.set(it.id, it);
    }

    const items = [];
    for (const kind of ['extension', 'theme']) {
        const root = path.join(repoRoot, kind === 'extension' ? 'extensions' : 'themes');
        const dirs = (await listDirs(root)).sort();
        for (const d of dirs) {
            try {
                const entry = await processItem({ kind, dirName: d, previousById });
                items.push(entry);
            } catch (e) {
                console.error(`Failed to process ${kind}/${d}: ${e.message}`);
                process.exit(1);
            }
        }
    }

    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const catalog = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        items,
    };

    await writeFile(previousCatalogPath, JSON.stringify(catalog, null, 2));

    // Prune zips that no longer correspond to a current item-version.
    // (Renames / version bumps would otherwise leave the old artifacts
    // forever; tags-as-versions in the URL means we can't just overwrite.)
    const wantedZips = new Set();
    for (const it of items) {
        const name = path.basename(it.downloadUrl);
        wantedZips.add(name);
        wantedZips.add(`${name}.sha256`);
    }
    const presentZips = await readdir(distPackages);
    for (const f of presentZips) {
        if (!wantedZips.has(f)) {
            await rm(path.join(distPackages, f), { force: true });
            console.log(`  prune  ${f}`);
        }
    }

    console.log(`Wrote catalog with ${items.length} item(s) -> ${previousCatalogPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
