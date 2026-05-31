#!/usr/bin/env node
// Permissions hygiene: an extension's manifest must declare exactly the
// capabilities its code actually uses — no more, no less.
//
// Why both directions:
//
//   Over-declared (declared but not used) — friction without payoff.
//     The user is asked to approve capabilities the extension never
//     exercises. Trust erodes: people get used to clicking through
//     prompts they shouldn't have seen, which lowers the bar for the
//     ones they SHOULD scrutinize. Reported as a warning so a planned
//     feature in flight doesn't block a PR.
//
//   Under-declared (used but not declared) — broken at runtime.
//     The host's sandbox blocks any invoke whose capability isn't in
//     the grant, so an under-declared cap means the feature silently
//     fails for users. Reported as an error.
//
// Detection method: a regex sweep for `invoke('cmd', ...)` and
// `invoke("cmd", ...)` call sites in every extension JS file. We
// don't try to follow indirection (variables holding command names,
// computed strings) — that's a deliberate sandbox-level smell anyway,
// and the host blocks anything not on the allowlist regardless. The
// regex catches the call shape used everywhere across the existing
// extensions; if a contributor needs something more dynamic they can
// add a `// permissions: <cap>` comment that we honour as a
// declaration of intent.
//
// Inputs:
//   - `manifest.json` → declared capabilities
//   - `*.js` source under the extension dir → invoke() command names
//   - `scripts/host-capabilities.mjs` → command → capability map
//
// Affected-paths logic mirrors check-security.mjs.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedItems, shouldRun } from './lib/affected.mjs';
import {
    COMMAND_CAPABILITIES,
    FORBIDDEN_COMMANDS,
} from './host-capabilities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const flagAll = args.has('--all');

// Match `invoke('cmd', ...)` or `invoke("cmd", ...)` or
// `_invoke('cmd', ...)` or `this.invoke('cmd', ...)`. The leading
// boundary class allows a `.` (so `this.invoke` and `ctx.invoke`
// match) but rejects identifier chars (so `noinvoke` and
// `myInvoke` don't). The optional `_` prefix is the convention some
// extensions use for a wrapped bridge.
const INVOKE_RE = /(?:^|[^\w$])(?:_)?invoke\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/gi;

// Honour an explicit `// permissions: cap1, cap2` comment as if those
// caps were used. Lets contributors handle the rare dynamic-command
// case without the analysis breaking.
const HINT_RE = /\/\/\s*permissions:\s*([a-z0-9, _-]+)/gi;

const errors = [];
const warnings = [];

async function listJsFiles(dir) {
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

async function readManifest(extDir) {
    const p = path.join(extDir, 'manifest.json');
    try {
        return JSON.parse(await readFile(p, 'utf8'));
    } catch {
        return null;
    }
}

async function analyzeExtension(itemKey) {
    const extDir = path.join(repoRoot, itemKey);
    const manifest = await readManifest(extDir);
    if (!manifest || manifest.type !== 'extension') return;

    const declared = new Set(
        Array.isArray(manifest.permissions)
            ? manifest.permissions.filter((p) => typeof p === 'string')
            : []
    );

    const usedCaps = new Set();
    const usedCommands = new Set();
    const unknownCommands = new Set();
    const forbiddenCommands = new Set();
    const hintedCaps = new Set();

    const files = await listJsFiles(extDir);
    for (const file of files) {
        const txt = await readFile(file, 'utf8').catch(() => '');
        if (!txt) continue;

        for (const m of txt.matchAll(INVOKE_RE)) {
            const cmd = m[1];
            usedCommands.add(cmd);
            if (FORBIDDEN_COMMANDS.has(cmd)) {
                forbiddenCommands.add(cmd);
                continue;
            }
            const cap = COMMAND_CAPABILITIES[cmd];
            if (typeof cap === 'string') {
                usedCaps.add(cap);
            } else if (cap === undefined) {
                unknownCommands.add(cmd);
            }
        }
        for (const m of txt.matchAll(HINT_RE)) {
            for (const part of m[1].split(',')) {
                const c = part.trim().toLowerCase();
                if (c) hintedCaps.add(c);
            }
        }
    }

    // Combine static usage with author-supplied hints. The hint covers
    // dynamic-dispatch cases the regex can't reach.
    const effectivelyUsed = new Set([...usedCaps, ...hintedCaps]);

    // 1. Forbidden command calls — extensions shouldn't even reference
    //    these by name; the host will reject them at runtime.
    for (const cmd of forbiddenCommands) {
        errors.push(
            `${itemKey}: calls forbidden command '${cmd}' (never callable from an extension)`
        );
    }

    // 2. Unknown command names. Could be a typo, could be a host
    //    command we don't know about (vendored table out of date).
    //    Warn rather than error so a host-side addition doesn't block
    //    Kage-Extensions CI before the table sync ships.
    for (const cmd of unknownCommands) {
        warnings.push(
            `${itemKey}: invoke('${cmd}', ...) — unknown host command. ` +
                `Either a typo, or scripts/host-capabilities.mjs is out of sync with Kage. ` +
                `If intentional, add a '// permissions: <cap>' hint to assert the intended cap.`
        );
    }

    // 3. Used-but-not-declared. Hard error — the runtime would block
    //    these calls and the feature would silently break.
    for (const cap of effectivelyUsed) {
        if (!declared.has(cap)) {
            errors.push(
                `${itemKey}: capability '${cap}' is used in code but not declared in manifest.permissions`
            );
        }
    }

    // 4. Declared-but-not-used. Warning — the extension is asking the
    //    user for trust it doesn't currently exercise. Could be a
    //    planned feature, but worth flagging so reviewers ask.
    for (const cap of declared) {
        if (!effectivelyUsed.has(cap)) {
            warnings.push(
                `${itemKey}: capability '${cap}' is declared in manifest but no usage found in source. ` +
                    `Drop it from permissions, or add a '// permissions: ${cap}' hint if usage is dynamic.`
            );
        }
    }
}

async function main() {
    const affected = await affectedItems();
    const targets = affected.all.filter(
        (it) => it.startsWith('extensions/') && shouldRun(it, affected, { all: flagAll })
    );

    if (affected.mode === 'changed' && !flagAll) {
        const totalExt = affected.all.filter((it) => it.startsWith('extensions/')).length;
        const skipped = totalExt - targets.length;
        if (skipped > 0) {
            console.log(
                `[permissions] checking ${targets.length}/${totalExt} extension(s) — ${skipped} unchanged.`
            );
        }
    }

    for (const it of targets) {
        await analyzeExtension(it);
    }

    for (const w of warnings) console.warn(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);

    console.log(
        `[permissions] ${errors.length} error(s), ${warnings.length} warning(s).`
    );
    if (errors.length > 0) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
