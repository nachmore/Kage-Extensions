import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LANES, LANE_CAP, layout } from './lib/graph.js';

// The CSS gate for styles.css. Extension CSS is injected into the host
// document (Kage: ui/js/shared/extension-manager/sources.js drops rules that
// could overlay host UI or beacon), so ours must stay inside .mm-* and
// never need that safety net.

const CSS = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// A small recursive block parser: [{ prelude, decls, rules, at }].
function parse(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) {
      if (text.slice(i).trim()) throw new Error(`trailing CSS: ${text.slice(i).trim().slice(0, 40)}`);
      break;
    }
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    if (depth) throw new Error(`unbalanced braces after ${prelude}`);
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) out.push({ prelude, at: prelude.split(/[\s(]/)[0], rules: /\{/.test(body) ? parse(body) : [], decls: /\{/.test(body) ? [] : decls(body) });
    else out.push({ prelude, decls: decls(body), rules: [] });
    i = j;
  }
  return out;
}

function decls(body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      return { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
    });
}

function* walk(rules, parents = []) {
  for (const r of rules) {
    yield { rule: r, parents };
    if (r.rules.length) yield* walk(r.rules, [...parents, r]);
  }
}

const RULES = parse(stripComments(CSS));
const ALL = [...walk(RULES)];

describe('styles.css gate', () => {
  it('parses', () => {
    expect(RULES.length).toBeGreaterThan(50);
  });

  it('scopes every selector to .mm-*', () => {
    for (const { rule, parents } of ALL) {
      if (rule.at) continue;
      const inKeyframes = parents.some((p) => p.at === '@keyframes');
      for (const sel of rule.prelude.split(',').map((s) => s.trim())) {
        if (inKeyframes) expect(sel, sel).toMatch(/^(from|to|\d+%)$/);
        else expect(sel, sel).toMatch(/^\.mm-[a-z0-9-]/);
      }
    }
  });

  it('uses only @media, @supports and mm- keyframes', () => {
    for (const { rule } of ALL) {
      if (!rule.at) continue;
      expect(['@media', '@supports', '@keyframes'], rule.prelude).toContain(rule.at);
      if (rule.at === '@keyframes') expect(rule.prelude).toMatch(/^@keyframes mm-[a-z0-9-]+$/);
    }
  });

  it('never escapes its container or stacks over the host', () => {
    for (const { rule } of ALL) {
      for (const d of rule.decls) {
        if (d.prop === 'position') expect(d.value, rule.prelude).not.toMatch(/fixed|sticky|var\(|env\(/);
        if (d.prop === 'z-index') {
          expect(d.value, rule.prelude).toMatch(/^-?\d+$/);
          expect(Number(d.value), rule.prelude).toBeLessThanOrEqual(10);
        }
        expect(d.value, `${rule.prelude} ${d.prop}`).not.toMatch(/!important/);
      }
    }
  });

  it('loads nothing from the network', () => {
    expect(CSS).not.toMatch(/url\s*\(/i);
    expect(CSS).not.toMatch(/image-set\s*\(/i);
    expect(CSS).not.toMatch(/@import/i);
  });

  it('keeps every transition and animation behind prefers-reduced-motion', () => {
    let motion = 0;
    for (const { rule, parents } of ALL) {
      for (const d of rule.decls) {
        if (!/^(transition|animation)(-|$)/.test(d.prop)) continue;
        motion++;
        const guarded = parents.some((p) => p.at === '@media' && /prefers-reduced-motion:\s*no-preference/.test(p.prelude));
        expect(guarded, `${rule.prelude} ${d.prop}`).toBe(true);
      }
    }
    expect(motion).toBeGreaterThan(0);
    // the guard exists and wraps a 120 ms fade, nothing longer
    const guard = RULES.find((r) => r.at === '@media' && /prefers-reduced-motion:\s*no-preference/.test(r.prelude));
    const durations = [...walk(guard.rules)].flatMap(({ rule }) => rule.decls).flatMap((d) => [...d.value.matchAll(/(\d+)ms/g)].map((m) => Number(m[1])));
    expect(Math.max(...durations)).toBeLessThanOrEqual(120);
  });

  it('declares the map stage and edge layer the formatter relies on', () => {
    // the last top-level declaration of `p` in any rule that lists `sel`
    const prop = (sel, p) => ALL.filter(({ rule, parents }) => !rule.at && !parents.length && rule.prelude.split(',').map((s) => s.trim()).includes(sel))
      .flatMap(({ rule }) => rule.decls.filter((d) => d.prop === p))
      .at(-1)?.value;
    expect(prop('.mm-stage', 'position')).toBe('relative');
    expect(prop('.mm-stage', 'height')).toBe('264px');
    expect(prop('.mm-edges', 'position')).toBe('absolute');
    expect(prop('.mm-edges', 'pointer-events')).toBe('none');
    expect(prop('.mm-edges', 'width')).toBe('100%');
    expect(prop('.mm-center', 'width')).toBe('36%');
    expect(prop('.mm-node', 'max-width')).toBe('26%');
    expect(prop('.mm-node', 'width')).toBe('max-content'); // not the shrink-to-fit width left of a right-edge slot
    expect(prop('.mm-cite', 'display')).toBe('inline');
    expect(prop('.mm-cite-x', 'display')).toBe('inline');
  });

  it('has a position class for every coordinate the layout can produce', () => {
    const xs = new Set();
    const ys = new Set();
    for (const rtl of [false, true]) {
      for (const lane of LANES) {
        for (let n = 0; n <= LANE_CAP[lane]; n++) {
          const nodes = Array.from({ length: n }, (_, i) => ({ ref: `i${String(i).padStart(14, '0')}`, group: 'item', kind: 'note', label: 'x' }));
          const lanes = Object.fromEntries(LANES.map((l) => [l, { role: 'notes', nodes: l === lane ? nodes : [] }]));
          const placed = layout({ center: {}, lanes }, { rtl });
          for (const p of [...placed.nodes, ...placed.hints]) {
            xs.add(p.x);
            ys.add(p.y);
          }
        }
      }
    }
    for (const x of xs) expect(CSS, `.mm-x-${x}`).toMatch(new RegExp(`\\.mm-x-${x}\\s*\\{\\s*left:\\s*${x}%;\\s*\\}`));
    for (const y of ys) expect(CSS, `.mm-y-${y}`).toMatch(new RegExp(`\\.mm-y-${y}\\s*\\{\\s*top:\\s*${y}%;\\s*\\}`));
  });

  it('styles every focusable control with a :focus-visible ring', () => {
    const ring = ALL.find(({ rule }) => /:focus-visible/.test(rule.prelude) && rule.decls.some((d) => d.prop === 'outline'))?.rule;
    expect(ring).toBeDefined();
    for (const cls of ['.mm-node', '.mm-btn', '.mm-tool', '.mm-crumb', '.mm-cite', '.mm-li', '.mm-echip', '.mm-rel']) {
      expect(ring.prelude, cls).toContain(`${cls}:focus-visible`);
    }
    expect(ring.decls.find((d) => d.prop === 'outline').value).toContain('var(--kage-accent');
  });
});
