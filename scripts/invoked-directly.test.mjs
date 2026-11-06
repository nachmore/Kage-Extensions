import { afterAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(path.join(tmpdir(), 'kage-direct-invocation-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('runs a CLI main through a symlink and keeps imported modules inert', () => {
    const real = path.join(root, 'real.mjs');
    const link = path.join(root, 'linked.mjs');
    const helper = new URL('./lib/invoked-directly.mjs', import.meta.url).href;
    writeFileSync(real, `import {invokedDirectly} from ${JSON.stringify(helper)};
if (invokedDirectly(import.meta.url)) console.log('MAIN RAN');`);
    symlinkSync(real, link);
    expect(execFileSync(process.execPath, [link], { encoding: 'utf8' })).toBe('MAIN RAN\n');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(real).href)};`],
        { encoding: 'utf8' })).toBe('');
});
