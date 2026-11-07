import { describe, expect, it } from 'vitest';
import { DEFAULT_FIELDS, PREFIX_MIN, createIndex } from './bm25.js';

const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

describe('BM25F scoring', () => {
  // title weight 2, body weight 1, k1 1.2, b 0.75. N = 3.
  //   d1  title [a]      body [a b]
  //   d2  title [b]      body [c]
  //   d3  title —        body [a c c]
  // avg title length 2/3, avg body length 2.
  const index = createIndex({ fields: { title: 2, body: 1 } });
  index.add('d1', { title: ['a'], body: ['a', 'b'] });
  index.add('d2', { title: ['b'], body: ['c'] });
  index.add('d3', { body: ['a', 'c', 'c'] });
  const sat = (w) => w * 2.2 / (1.2 + w);

  it('matches hand-computed scores for a 3-document corpus', () => {
    expect(index.size).toBe(3);
    expect(index.df('a')).toBe(2);
    expect(index.idf('a')).toBeCloseTo(Math.log(1 + 1.5 / 2.5), 12);
    // d1: title tf 1, norm 0.25 + 0.75·(1/(2/3)) = 1.375; body tf 1, norm 1.
    const d1 = Math.log(1.6) * sat(2 / 1.375 + 1);
    // d3: body tf 1, len 3: norm 0.25 + 0.75·1.5 = 1.375.
    const d3 = Math.log(1.6) * sat(1 / 1.375);
    const hits = index.search([{ t: 'a' }]);
    expect(hits.map((h) => h.id)).toEqual(['d1', 'd3']);
    expect(hits[0].score).toBeCloseTo(d1, 10);
    expect(hits[1].score).toBeCloseTo(d3, 10);
    expect(hits[0]).toMatchObject({ hits: ['a'], matched: [0] });

    // c: df 2. d2 body tf 1 len 1: norm 0.25 + 0.375 = 0.625. d3 body tf 2 len 3: norm 1.375.
    const [c2, c3] = [Math.log(1.6) * sat(1 / 0.625), Math.log(1.6) * sat(2 / 1.375)];
    const both = index.search([{ t: 'a' }, { t: 'c', w: 0.5 }]);
    expect(Object.fromEntries(both.map((h) => [h.id, h.score]))).toEqual({
      d1: expect.closeTo(d1, 10), d2: expect.closeTo(0.5 * c2, 10), d3: expect.closeTo(d3 + 0.5 * c3, 10),
    });
    expect(both.find((h) => h.id === 'd3').matched).toEqual([0, 1]);
  });

  it('ranks a title hit above a body hit with the default field weights', () => {
    expect(DEFAULT_FIELDS).toEqual({ title: 2.0, kp: 1.5, ent: 1.5, sum: 1.2, body: 1.0, host: 0.5 });
    const idx = createIndex();
    idx.add('i1', { title: words('mtcs design review'), body: words('failover plan') });
    idx.add('i2', { title: words('lunch with dana'), body: words('talked about mtcs hiring') });
    idx.add('i3', { title: words('pricing page'), body: words('pricing for teams') });
    expect(idx.search([{ t: 'mtcs' }]).map((h) => h.id)).toEqual(['i1', 'i2']);
    expect(idx.fieldTerms('i1', 'title')).toEqual(new Set(['mtcs', 'design', 'review']));
    expect(idx.fieldTerms('nope', 'title')).toEqual(new Set());
  });

  it('breaks ties newest first (id descending) and honours limit and filter', () => {
    const idx = createIndex();
    for (const id of ['i001', 'i003', 'i002']) idx.add(id, { body: ['same'] });
    expect(idx.search([{ t: 'same' }]).map((h) => h.id)).toEqual(['i003', 'i002', 'i001']);
    expect(idx.search([{ t: 'same' }], { limit: 1 }).map((h) => h.id)).toEqual(['i003']);
    expect(idx.search([{ t: 'same' }], { filter: (id) => id !== 'i003' }).map((h) => h.id)).toEqual(['i002', 'i001']);
    expect(idx.search([])).toEqual([]);
    expect(idx.search([{ t: 'missing' }])).toEqual([]);
  });
});

describe('query features', () => {
  const idx = createIndex();
  idx.add('i1', { title: words('mtcs design review'), body: words('mtcs failover') });
  idx.add('i2', { title: words('mtc meeting'), body: words('mtcs numbers') });
  idx.add('i3', { title: words('bingo salary'), body: words('bingo thoughts') });
  idx.add('i4', { title: words('bingo launch'), body: words('checklist') });

  it('excludes documents containing a negative term', () => {
    expect(idx.search([{ t: 'bingo' }, { t: 'salary', neg: true }]).map((h) => h.id)).toEqual(['i4']);
  });

  it('expands a prefix term to vocabulary terms and scores the best expansion', () => {
    const hits = idx.search([{ t: 'mt', prefix: true, w: 0.8 }]);
    expect(hits.map((h) => h.id).sort()).toEqual(['i1', 'i2']);
    expect(hits.find((h) => h.id === 'i2').hits).toHaveLength(1);
    expect(idx.search([{ t: 'mt' }])).toEqual([]);
  });

  it('matches a one-character prefix exactly instead of expanding it', () => {
    expect(PREFIX_MIN).toBe(2);
    expect(idx.search([{ t: 'b', prefix: true }])).toEqual([]);
    const single = createIndex();
    single.add('x', { body: ['b', 'bingo'] });
    expect(single.search([{ t: 'b', prefix: true }])[0].hits).toEqual(['b']);
  });

  it('answers field membership without building a set', () => {
    expect(idx.fieldHas('i1', 'title', 'mtcs')).toBe(true);
    expect(idx.fieldHas('i1', 'title', 'failover')).toBe(false);
    expect(idx.fieldHas('nope', 'title', 'mtcs')).toBe(false);
  });

  it('lists vocabulary by document frequency, then alphabetically', () => {
    expect(idx.vocabPrefix('mt')).toEqual(['mtcs', 'mtc']);
    expect(idx.vocabPrefix('b')).toEqual(['bingo']);
    expect(idx.vocabPrefix('')).toEqual([]);
    const many = createIndex();
    for (let i = 0; i < 30; i++) many.add(`d${i}`, { body: [`word${String(i).padStart(2, '0')}`, ...(i < 3 ? ['wordzz'] : [])] });
    expect(many.vocabPrefix('word')[0]).toBe('wordzz');
    expect(many.vocabPrefix('word')).toHaveLength(20);
    expect(many.vocabPrefix('word', { limit: 3 })).toEqual(['wordzz', 'word00', 'word01']);
  });

  it('finds similar documents above the ratio threshold', () => {
    const s = createIndex();
    s.add('a', { title: words('mtcs capacity plan'), body: words('failover capacity for mtcs region') });
    s.add('b', { title: words('mtcs capacity notes'), body: words('capacity numbers for mtcs') });
    s.add('c', { title: words('lunch'), body: words('pizza with dana') });
    s.add('d', { title: words('region list'), body: words('an unrelated list of things') });
    const similar = s.similar('a');
    expect(similar.map((h) => h.id)).toEqual(['b']);
    expect(similar[0].score).toBeGreaterThan(0);
    expect(s.similar('a', { minRatio: 0 }).map((h) => h.id)).toEqual(['b', 'd']);
    expect(s.similar('a', { minRatio: 0.99 })).toEqual([]);
    expect(s.similar('a', { filter: (id) => id !== 'b' })).toEqual([]);
    expect(s.similar('missing')).toEqual([]);
  });
});

describe('incremental updates', () => {
  const corpus = {
    i1: { title: words('mtcs design review'), body: words('failover and capacity') },
    i2: { title: words('rollout plan'), body: words('mtcs rollout to regions') },
    i3: { title: words('bingo team sync'), body: words('send mtcs numbers to dana') },
    i4: { title: words('pricing page'), body: words('pricing') },
    i5: { title: words('capacity notes'), body: words('mtcs capacity notes') },
  };
  const queries = [[{ t: 'mtcs' }], [{ t: 'capacity' }, { t: 'mtcs' }], [{ t: 'pric', prefix: true }], [{ t: 'rollout' }]];

  it('add, replace and remove give the same results as a rebuild', () => {
    const live = createIndex();
    for (const [id, doc] of Object.entries(corpus)) live.add(id, doc);
    live.add('i2', { title: words('rollout plan v2'), body: words('rollout') });
    live.remove('i4');
    live.add('i6', { title: words('pricing'), body: words('new pricing page') });
    expect(live.remove('nope')).toBe(false);

    const rebuilt = createIndex();
    const final = { ...corpus, i2: { title: words('rollout plan v2'), body: words('rollout') }, i6: { title: words('pricing'), body: words('new pricing page') } };
    delete final.i4;
    for (const [id, doc] of Object.entries(final)) rebuilt.add(id, doc);

    expect(live.size).toBe(rebuilt.size);
    for (const q of queries) {
      const a = live.search(q);
      const b = rebuilt.search(q);
      expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
      a.forEach((hit, i) => expect(hit.score).toBeCloseTo(b[i].score, 12));
    }
    expect(live.df('mtcs')).toBe(3);
    expect(live.has('i4')).toBe(false);
    expect(live.postings('pricing')).toEqual(new Set(['i6']));
    expect(live.vocabPrefix('pric')).toEqual(['pricing']);
    expect(live.postings('page')).toEqual(new Set(['i6']));
  });

  it('builds 10k documents quickly (soft budget: 250 ms)', () => {
    const vocab = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}`);
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const docs = Array.from({ length: 10_000 }, () => ({
      title: Array.from({ length: 5 }, () => vocab[Math.floor(rand() * vocab.length)]),
      body: Array.from({ length: 40 }, () => vocab[Math.floor(rand() * vocab.length)]),
      kp: Array.from({ length: 3 }, () => vocab[Math.floor(rand() * vocab.length)]),
    }));
    const idx = createIndex();
    const started = performance.now();
    docs.forEach((doc, i) => idx.add(`i${String(i).padStart(14, '0')}`, doc));
    const elapsed = performance.now() - started;
    if (elapsed > 250) console.warn(`bm25: 10k docs built in ${elapsed.toFixed(0)} ms (budget 250 ms)`);
    expect(idx.size).toBe(10_000);
    const t = performance.now();
    const hits = idx.search([{ t: vocab[1] }, { t: 'w', prefix: true, w: 0.8 }], { limit: 50 });
    const searchMs = performance.now() - t;
    if (searchMs > 10) console.warn(`bm25: search over 10k docs took ${searchMs.toFixed(1)} ms`);
    expect(hits.length).toBeGreaterThan(0);
  });
});
