#!/usr/bin/env node
// Bundle hygiene: catch files that shouldn't ship and reasonable size
// limits, so a malformed extension doesn't bloat the catalog or leak
// developer-machine artefacts.
//
// What we look for:
//
//   Forbidden file patterns — always an error.
//     .DS_Store, Thumbs.db    OS junk, never useful in a shipped zip.
//     .env, .env.*            secrets the author probably didn't mean
//                              to commit.
//     node_modules/           massive, host-fetched at runtime via
//                              sandboxVendor allowlist.
//     *.map (.js.map etc.)    sourcemaps — leak code structure +
//                              bloat the package; useless without
//                              devtools attached anyway.
//     .git/, .svn/            VCS metadata.
//     credentials.json,
//     id_rsa, *.pem, *.key    sensitive material.
//
//   Per-file size limit — error at 5MB, warn at 500KB.
//     A single source file approaching either threshold is a code
//     smell or an embedded binary blob; the host caps the package
//     size at 10MB anyway so the install would fail late.
//
//   Total extension size — error at 10MB.
//     Aligns with the host's package size guard. Better to fail fast
//     here with a clear message than via a network 413.
//
// Affected-paths logic mirrors the other check-*.mjs scripts.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedItems, shouldRun } from './lib/affected.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const flagAll = args.has('--all');

const FILE_WARN_BYTES = 500 * 1024;
const FILE_ERROR_BYTES = 5 * 1024 * 1024;
const TOTAL_ERROR_BYTES = 10 * 1024 * 1024;

// Returns the matching pattern label, or null. Each entry is a
// predicate over (relPath, baseName). Tests run in order; first match
// wins so the user sees a specific reason rather than a generic one.
const FORBIDDEN = [
    {
        label: 'OS junk (.DS_Store / Thumbs.db / desktop.ini)',
        test: (_p, name) =>
            name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini',
    },
    {
        label: 'environment file',
        test: (_p, name) => name === '.env' || /^\.env\.[\w.-]+$/.test(name),
    },
    {
        label: 'node_modules tree',
        test: (rel) => rel.split('/').includes('node_modules'),
    },
    {
        label: 'VCS metadata',
        test: (rel) => /(?:^|\/)\.(?:git|svn|hg)(?:\/|$)/.test(rel),
    },
    {
        label: 'source map',
        test: (_p, name) => /\.(?:js|mjs|cjs|css)\.map$/.test(name),
    },
    {
        label: 'editor backup',
        test: (_p, name) => name.endsWith('~') || name === '.editorconfig.bak',
    },
    {
        label: 'sensitive material',
        test: (_p, name) =>
            name === 'credentials.json' ||
            name === 'id_rsa' ||
            name === 'id_ed25519' ||
            /\.(?:pem|key|p12|pfx)$/i.test(name),
    },
    {
        label: 'lock file shipped to user',
        // package-lock.json / yarn.lock / pnpm-lock.yaml inside an
        // extension are a sign that node_modules was *almost* shipped.
        // Catalog packaging strips them anyway, but flagging early
        // saves a head-scratch when the author wonders why their
        // 50MB extension turned into 200KB.
        test: (_p, name) =>
            name === 'package-lock.json' ||
            name === 'yarn.lock' ||
            name === 'pnpm-lock.yaml',
    },
];

const errors = [];
const warnings = [];

async function walk(dir, relTo) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(relTo, full).replaceAll('\\', '/');
        if (e.isDirectory()) {
            out.push(...(await walk(full, relTo)));
        } else if (e.isFile()) {
            const st = await stat(full).catch(() => null);
            if (st) out.push({ full, rel, name: e.name, size: st.size });
        }
    }
    return out;
}

async function checkItem(itemKey) {
    const itemDir = path.join(repoRoot, itemKey);
    const files = await walk(itemDir, itemDir);

    let total = 0;
    for (const f of files) {
        total += f.size;

        for (const rule of FORBIDDEN) {
            if (rule.test(f.rel, f.name)) {
                errors.push(`${itemKey}/${f.rel}: forbidden — ${rule.label}`);
                break;
            }
        }

        if (f.size > FILE_ERROR_BYTES) {
            errors.push(
                `${itemKey}/${f.rel}: file is ${formatSize(f.size)}, exceeds ${formatSize(FILE_ERROR_BYTES)} per-file cap`
            );
        } else if (f.size > FILE_WARN_BYTES) {
            warnings.push(
                `${itemKey}/${f.rel}: file is ${formatSize(f.size)} — large source/asset, consider trimming`
            );
        }
    }

    if (total > TOTAL_ERROR_BYTES) {
        errors.push(
            `${itemKey}: total size ${formatSize(total)} exceeds ${formatSize(TOTAL_ERROR_BYTES)} cap`
        );
    }
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function main() {
    const affected = await affectedItems();
    const targets = affected.all.filter((it) => shouldRun(it, affected, { all: flagAll }));

    if (affected.mode === 'changed' && !flagAll) {
        const skipped = affected.all.length - targets.length;
        if (skipped > 0) {
            console.log(
                `[bundle] checking ${targets.length}/${affected.all.length} item(s) — ${skipped} unchanged.`
            );
        }
    }

    for (const it of targets) {
        await checkItem(it);
    }

    for (const w of warnings) console.warn(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);

    console.log(`[bundle] ${errors.length} error(s), ${warnings.length} warning(s).`);
    if (errors.length > 0) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
