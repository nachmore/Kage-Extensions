import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CARD_RE, CITE_RE, ID_RE, cite, createIdPool, idTime, isEntityId, isItemId, isOpId, newId, stripCite } from './ids.js';

const NOW = Date.UTC(2026, 10, 6, 15, 0, 0);
const fixedRand = (seed = 7) => (array) => {
  for (let i = 0; i < array.length; i++) array[i] = (seed * (i + 3) * 2654435761) >>> 0;
  return array;
};
let counter = 0;
const countingRand = (array) => {
  for (let i = 0; i < array.length; i++) array[i] = counter++;
  return array;
};

describe('newId', () => {
  it('is a prefix + 9 base36 time chars + 5 base36 random chars', () => {
    for (const prefix of ['i', 'e', 'o']) {
      const id = newId(prefix, NOW);
      expect(id).toHaveLength(15);
      expect(id[0]).toBe(prefix);
      expect(id).toMatch(/^[ieo][0-9a-z]{14}$/);
      expect(ID_RE.test(id)).toBe(true);
    }
  });

  it('encodes the time so ids sort by creation time', () => {
    const ids = [NOW - 86_400_000, NOW - 1, NOW, NOW + 1, NOW + 3_600_000].map((t) => newId('i', t, fixedRand()));
    expect([...ids].sort()).toEqual(ids);
    expect(idTime(ids[2])).toBe(NOW);
  });

  it('uses the injected random source and rejects unknown prefixes', () => {
    expect(newId('i', NOW, fixedRand(1))).toBe(newId('i', NOW, fixedRand(1)));
    expect(newId('i', NOW, fixedRand(1))).not.toBe(newId('i', NOW, fixedRand(2)));
    expect(() => newId('x', NOW)).toThrow(TypeError);
    expect(() => newId('me', NOW)).toThrow(TypeError);
  });

  it('uses crypto.getRandomValues by default', () => {
    const a = newId('o', NOW);
    const b = newId('o', NOW);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a).not.toBe(b);
  });
});

describe('id predicates', () => {
  const item = newId('i', NOW);
  const entity = newId('e', NOW);
  const op = newId('o', NOW);

  it('classifies ids by prefix', () => {
    expect([isItemId(item), isItemId(entity), isItemId('me'), isItemId(null)]).toEqual([true, false, false, false]);
    expect([isEntityId(entity), isEntityId('me'), isEntityId(item), isEntityId(42)]).toEqual([true, true, false, false]);
    expect([isOpId(op), isOpId(item)]).toEqual([true, false]);
  });

  it('idTime is null for me and junk', () => {
    expect(idTime('me')).toBeNull();
    expect(idTime('i123')).toBeNull();
    expect(idTime(undefined)).toBeNull();
  });
});

describe('citation and card tokens', () => {
  const item = newId('i', NOW, fixedRand());
  const entity = newId('e', NOW, fixedRand());

  it('cite builds the token CITE_RE accepts', () => {
    expect(cite(item)).toBe(`[mm:${item}]`);
    const found = [...`See ${cite(item)} and ${cite(entity)} and [mm:me].`.matchAll(CITE_RE)].map((m) => m[1]);
    expect(found).toEqual([item, entity, 'me']);
  });

  it('CITE_RE rejects traversal, uppercase, op ids and over-long ids', () => {
    const bad = ['[mm:../x]', `[mm:${item.toUpperCase()}]`, `[mm:${item}0]`, `[mm:${item.slice(0, -1)}]`, `[mm:${newId('o', NOW)}]`, '[mm:]', '[mm: me]'];
    for (const token of bad) {
      CITE_RE.lastIndex = 0;
      expect(CITE_RE.test(token), token).toBe(false);
    }
  });

  it('CARD_RE matches op, item, map and help cards', () => {
    const op = newId('o', NOW, fixedRand());
    const text = `[mm-card:op:${op}] [mm-card:item:${item}] [mm-card:map:o] [mm-card:map:me] [mm-card:map:${entity}] [mm-card:help] [mm-card:bogus:x] [mm-card:map:../x]`;
    const found = [...text.matchAll(CARD_RE)].map((m) => [m[1], m[2] ?? null]);
    expect(found).toEqual([['op', op], ['item', item], ['map', 'o'], ['map', 'me'], ['map', entity], ['help', null]]);
  });

  it('stripCite accepts the token, the mm: form, the bare id and row ids', () => {
    expect(stripCite(`[mm:${item}]`)).toBe(item);
    expect(stripCite(`mm:${item}`)).toBe(item);
    expect(stripCite(` ${item} `)).toBe(item);
    expect(stripCite(`mm:i:${item}`)).toBe(item);
    expect(stripCite(`mm:e:${entity}`)).toBe(entity);
    expect(stripCite('me')).toBe('me');
    for (const bad of ['', '[mm:../etc]', 'mm:', 'i123', `${item}x`, null, 7, `[mm:${item}`]) expect(stripCite(bad)).toBeNull();
  });
});

describe('createIdPool', () => {
  it('reset() replays the same ids per prefix, then issues new ones', () => {
    counter = 0;
    const pool = createIdPool(countingRand);
    const first = [pool.next('i', NOW), pool.next('e', NOW), pool.next('i', NOW), pool.next('o', NOW)];
    expect(new Set(first).size).toBe(4);
    pool.reset();
    // A retry may ask in a different order: each prefix replays its own list.
    const replay = [pool.next('e', NOW + 50), pool.next('i', NOW + 50), pool.next('o', NOW + 50), pool.next('i', NOW + 50)];
    expect(replay).toEqual([first[1], first[0], first[3], first[2]]);
    const extra = pool.next('i', NOW + 50);
    expect(first).not.toContain(extra);
    expect(pool.issued.i).toEqual([first[0], first[2], extra]);
    pool.reset();
    expect(pool.next('i', NOW)).toBe(first[0]);
  });
});

describe('leaf modules (WP-A)', () => {
  it('import nothing, so the host can load them as shared leaves', () => {
    for (const file of ['ids.js', 'text.js', 'dates.js', 'url.js', 'entities.js', 'extract.js', 'query.js']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\bimport\s*[\s{*'"(]/);
      expect(source, file).not.toMatch(/^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]/m);
      expect(source, file).not.toMatch(/\brequire\s*\(/);
      // Time is injected; only ids.js defaults `now` for callers that omit it.
      if (file !== 'ids.js') expect(source, file).not.toMatch(/\bDate\.now\(/);
      expect(source, file).not.toMatch(/\bMath\.random\(/);
    }
  });
});
