import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The CSS gate for explorer.css, the explorer window's own stylesheet
// (EXTENSION_VIEWS §4: injected into the view document only). Every class
// is ex- prefixed, every colour is a Kage token, nothing loads from a URL,
// and motion waits for prefers-reduced-motion: no-preference.

const CSS = readFileSync(new URL('./explorer.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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
    if (prelude.startsWith('@')) out.push({ prelude, rules: parse(body), decls: [] });
    else out.push({ prelude, rules: [], decls: body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => ({ prop: d.slice(0, d.indexOf(':')).trim(), value: d.slice(d.indexOf(':') + 1).trim() })) });
    i = j;
  }
  return out;
}

function* walk(rules, parents = []) {
  for (const r of rules) {
    yield { rule: r, parents };
    if (r.rules.length) yield* walk(r.rules, [...parents, r]);
  }
}

const ALL = [...walk(parse(CSS))];
const COLOUR_PROPS = /^(?:color|background|background-color|border(?:-[a-z-]+)?-color|border(?:-(?:block|inline)(?:-(?:start|end))?)?|outline|fill|stroke)$/;

describe('explorer.css gate', () => {
  it('parses and scopes every selector to .ex-*', () => {
    expect(ALL.length).toBeGreaterThan(30);
    for (const { rule } of ALL) {
      if (rule.prelude.startsWith('@')) continue;
      for (const sel of rule.prelude.split(',').map((s) => s.trim())) expect(sel, sel).toMatch(/^\.ex-[a-z0-9-]/);
    }
  });

  it('uses only the reduced-motion media query', () => {
    for (const { rule } of ALL) if (rule.prelude.startsWith('@')) expect(rule.prelude).toBe('@media (prefers-reduced-motion: no-preference)');
  });

  it('takes every colour from a Kage token', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(CSS).not.toMatch(/\brgba?\(|\bhsla?\(/i);
    for (const { rule } of ALL) {
      for (const d of rule.decls) {
        if (!COLOUR_PROPS.test(d.prop)) continue;
        if (/^(?:none|0|transparent|inherit)$/.test(d.value) || /^\d+px solid$/.test(d.value)) continue;
        expect(d.value, `${rule.prelude} { ${d.prop} }`).toMatch(/var\(--kage-[a-z-]+\)|^transparent$/);
      }
    }
  });

  it('never loads from a URL, never imports, and needs no !important', () => {
    expect(CSS).not.toMatch(/url\(/i);
    expect(CSS).not.toMatch(/@import/i);
    expect(CSS).not.toMatch(/!important/);
  });

  it('animates only inside the reduced-motion guard', () => {
    for (const { rule, parents } of ALL) {
      for (const d of rule.decls) {
        if (!/^(?:transition|animation)/.test(d.prop)) continue;
        expect(parents.some((p) => p.prelude.includes('prefers-reduced-motion: no-preference')), rule.prelude).toBe(true);
      }
    }
  });

  it('mirrors with the text direction (logical properties, no left/right margins or padding)', () => {
    expect(CSS).not.toMatch(/(?:margin|padding|border)-(?:left|right)\s*:/);
    expect(CSS).toMatch(/border-inline-end/);
  });
});
