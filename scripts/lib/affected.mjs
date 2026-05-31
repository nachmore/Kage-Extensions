// Determine which extensions changed in this CI run.
//
// The repo layout is:
//   extensions/<id>/...
//   themes/<id>/...
//
// We classify a check as either "always-run" (cheap; runs on every
// extension every time — manifest schema, license metadata, etc.) or
// "changed-only" (heavier; only runs on extensions whose source files
// changed). This keeps CI fast on PRs that touch one extension and
// avoids the perverse outcome where an unrelated extension's check
// regresses (e.g. a vendored library going out of date) and blocks an
// unrelated PR.
//
// Detection strategy:
//   - In GitHub Actions, the `BASE_SHA` / `HEAD_SHA` env vars (set by
//     our workflow) point at the merge-base and PR head. We diff and
//     bucket changed paths into per-extension/per-theme groups.
//   - Locally, fall back to comparing against `origin/main` if it
//     exists, otherwise treat every extension as changed (run
//     everything — safest default for ad-hoc local runs).
//
// Always returns a stable, sorted list so downstream behaviour is
// deterministic.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

/**
 * Split a list of changed file paths (relative to repo root) into a
 * map keyed by `<kind>/<id>` (e.g. `extensions/calendar`). Files
 * outside `extensions/` and `themes/` are returned under the special
 * key `__non_item__`.
 */
function bucketChangedPaths(changedPaths) {
    const buckets = new Map();
    const nonItem = [];
    for (const p of changedPaths) {
        const parts = p.split('/');
        if ((parts[0] === 'extensions' || parts[0] === 'themes') && parts.length > 1) {
            const key = `${parts[0]}/${parts[1]}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(p);
        } else {
            nonItem.push(p);
        }
    }
    return { buckets, nonItem };
}

/**
 * Resolve the diff range against which we should determine "changed."
 * Honours env first (GitHub Actions sets these from the workflow);
 * otherwise tries `origin/main`; otherwise returns null which signals
 * "fall back to everything."
 */
function resolveDiffRange() {
    const base = process.env.BASE_SHA;
    const head = process.env.HEAD_SHA;
    if (base && head) return { base, head };
    // Local fallback: diff against origin/main if available.
    const merge = git(['merge-base', 'HEAD', 'origin/main']);
    if (merge) return { base: merge, head: 'HEAD' };
    return null;
}

/**
 * Run `git diff --name-only base..head` and return the list of changed
 * file paths relative to the repo root. Empty array on any error.
 */
function gitChangedPaths(base, head) {
    const out = git(['diff', '--name-only', `${base}..${head}`]);
    if (!out) return [];
    return out.split('\n').filter(Boolean);
}

/**
 * List every `<kind>/<id>` pair currently on disk (not from git).
 * Used as the universe when we have to fall back to "everything."
 */
async function allItemsOnDisk() {
    const out = [];
    for (const kind of ['extensions', 'themes']) {
        const root = path.join(repoRoot, kind);
        if (!existsSync(root)) continue;
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) out.push(`${kind}/${e.name}`);
        }
    }
    out.sort();
    return out;
}

/**
 * Returns:
 *   {
 *     mode: 'changed' | 'all',
 *     changed: Array<'extensions/<id>' | 'themes/<id>'> sorted,
 *     all:     Array<...> sorted,
 *     nonItemChanged: Array<string>   // changed paths outside extensions/themes
 *   }
 *
 * `mode` is 'changed' if we successfully resolved a diff; 'all' if we
 * fell back to everything-is-changed.
 */
export async function affectedItems() {
    const all = await allItemsOnDisk();
    const range = resolveDiffRange();
    if (!range) {
        return { mode: 'all', changed: all, all, nonItemChanged: [] };
    }
    const paths = gitChangedPaths(range.base, range.head);
    if (paths.length === 0) {
        // No changes detected (e.g. push to main with empty merge).
        // Fall through to nothing-to-check rather than everything.
        return { mode: 'changed', changed: [], all, nonItemChanged: [] };
    }
    const { buckets, nonItem } = bucketChangedPaths(paths);
    const changed = [...buckets.keys()].filter((k) => all.includes(k)).sort();
    return { mode: 'changed', changed, all, nonItemChanged: nonItem };
}

/**
 * Decide whether a particular check should run against a particular
 * item, given the affected-items report and a flag.
 *
 * - `--all` cli flag forces every check to run on every item.
 * - In `mode: 'all'` (no diff range), every item runs.
 * - Otherwise, only items in `changed` run.
 */
export function shouldRun(item, affected, options = {}) {
    if (options.all) return true;
    if (affected.mode === 'all') return true;
    return affected.changed.includes(item);
}

export function repoRootPath() {
    return repoRoot;
}
