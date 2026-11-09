import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { makeContext } from '../../../test-helpers/mock-context.mjs';
import { RELAX_ITERATIONS, RELAX_TIMEOUT_MS, relax } from './layout.js';

function overlapping(n = 12) {
  // Every node starts on (almost) the same spot.
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `i${String(i).padStart(14, '0')}`, x: i % 2, y: 0, w: 160, h: 40, fixed: false }));
  nodes[0].fixed = true;
  const edges = nodes.slice(1).map((_, i) => ({ a: 0, b: i + 1, len: 200 }));
  return { nodes, edges, iterations: 300, budgetMs: 5000 };
}

function boxes(input, xy) {
  return input.nodes.map((n, i) => ({ x: xy[i * 2] - n.w / 2, y: xy[i * 2 + 1] - n.h / 2, w: n.w, h: n.h }));
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('relax', () => {
  it('has the documented limits', () => {
    expect(RELAX_ITERATIONS).toBe(300);
    expect(RELAX_TIMEOUT_MS).toBe(250);
  });

  it('pulls overlapping nodes apart and keeps fixed nodes still', () => {
    const input = overlapping(12);
    const out = relax(input);
    expect(out.xy).toHaveLength(24);
    expect(out.iterations).toBe(300);
    expect(out.done).toBe(true);
    expect([out.xy[0], out.xy[1]]).toEqual([0, 0]);
    const b = boxes(input, out.xy);
    let hits = 0;
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (overlaps(b[i], b[j])) hits++;
    expect(hits).toBe(0);
  });

  it('is deterministic: the same input gives the same output', () => {
    expect(relax(overlapping(30))).toEqual(relax(overlapping(30)));
  });

  it('stays near its seeds when nothing overlaps', () => {
    const input = {
      nodes: [{ id: 'a', x: 0, y: 0, w: 100, h: 30, fixed: true }, { id: 'b', x: 0, y: -200, w: 100, h: 30 }, { id: 'c', x: 400, y: 0, w: 100, h: 30 }],
      edges: [{ a: 0, b: 1, len: 200 }, { a: 0, b: 2, len: 400 }],
    };
    const out = relax(input);
    expect(Math.abs(out.xy[2] - 0)).toBeLessThan(5);
    expect(Math.abs(out.xy[3] + 200)).toBeLessThan(5);
    expect(Math.abs(out.xy[4] - 400)).toBeLessThan(5);
  });

  it('copes with junk input', () => {
    expect(relax(null)).toEqual({ xy: [], iterations: 0, done: true });
    const out = relax({ nodes: [{ x: 'a', y: null }, {}], edges: [{ a: 0, b: 9 }, { a: 1, b: 1 }, null], iterations: 5000 });
    expect(out.xy.every(Number.isFinite)).toBe(true);
    expect(out.iterations).toBeLessThanOrEqual(300);
  });

  it('stops at its time budget', () => {
    const input = overlapping(200);
    const out = relax({ ...input, budgetMs: 0.0001 });
    expect(out.done).toBe(false);
    expect(out.iterations).toBeLessThan(300);
  });

  it('survives Function.toString(): it closes over nothing', async () => {
    // The mock runner rebuilds `run` from its source text, like the host's Worker.
    const { context } = makeContext();
    const input = overlapping(10);
    const out = await context.runSandboxed({ run: relax, data: input });
    expect(out).toEqual(relax(input));
  });

  it('runs in a plain worker', async () => {
    const input = overlapping(16);
    const source = `const { parentPort, workerData } = require('node:worker_threads');\nconst run = (${relax.toString()});\nparentPort.postMessage(run(workerData));`;
    const out = await new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: input });
      worker.once('message', (msg) => {
        resolve(msg);
        worker.terminate();
      });
      worker.once('error', reject);
    });
    expect(out).toEqual(relax(input));
  });

  it('relaxes 300 nodes within the budget (soft)', () => {
    const input = overlapping(300);
    const started = performance.now();
    const out = relax({ ...input, budgetMs: RELAX_TIMEOUT_MS - 50 });
    const ms = performance.now() - started;
    if (ms > RELAX_TIMEOUT_MS) console.warn(`relax took ${ms.toFixed(0)} ms for 300 nodes`);
    expect(out.xy).toHaveLength(600);
  });
});
