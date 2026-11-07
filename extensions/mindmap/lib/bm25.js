// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// An incremental BM25F index over already-tokenized fields (SPEC §8.2).
// For a term t and document d:
//   w(t,d)   = Σ_f weight_f · tf_f(t,d) / (1 − b + b · len_f(d) / avglen_f)
//   score    = idf(t) · w · (k1 + 1) / (k1 + w)
//   idf(t)   = ln(1 + (N − df + 0.5) / (df + 0.5))
// len_f counts tokens; avglen_f averages over every document. A query term
// may carry a weight `w`, match by `prefix` (the 20 most frequent vocabulary
// terms that start with it; a document scores its best expansion), or be
// `neg` (documents containing it are excluded). A one-character prefix only
// matches exactly: expanding it would pull in the most common words.
//
// Tokens arrive already normalized (lib/text.js tokenize); this module never
// looks at raw text. Ties sort by id descending: ids are time-ordered, so the
// newest document wins.

export const DEFAULT_FIELDS = Object.freeze({ title: 2.0, kp: 1.5, ent: 1.5, sum: 1.2, body: 1.0, host: 0.5 });
export const PREFIX_MIN = 2;

const byScoreThenNewest = (a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function createIndex({ fields = DEFAULT_FIELDS, k1 = 1.2, b = 0.75 } = {}) {
  const names = Object.keys(fields);
  const docs = new Map();
  const postings = new Map();
  const totalLen = Object.fromEntries(names.map((f) => [f, 0]));
  let vocab = null;

  function remove(id) {
    const doc = docs.get(id);
    if (!doc) return false;
    const terms = new Set();
    for (const f of names) {
      const tf = doc.tf[f];
      if (!tf) continue;
      totalLen[f] -= doc.len[f];
      for (const term of tf.keys()) terms.add(term);
    }
    // A term can sit in several fields of one document: drop it once.
    for (const term of terms) {
      const set = postings.get(term);
      set.delete(id);
      if (!set.size) {
        postings.delete(term);
        vocab = null;
      }
    }
    docs.delete(id);
    return true;
  }

  function add(id, fieldTokens = {}) {
    if (docs.has(id)) remove(id);
    const doc = { tf: {}, len: {} };
    for (const f of names) {
      const tokens = fieldTokens?.[f];
      if (!Array.isArray(tokens) || !tokens.length) continue;
      const tf = new Map();
      let len = 0;
      for (const token of tokens) {
        if (typeof token !== 'string' || !token) continue;
        tf.set(token, (tf.get(token) || 0) + 1);
        len++;
      }
      if (!len) continue;
      doc.tf[f] = tf;
      doc.len[f] = len;
      totalLen[f] += len;
      for (const term of tf.keys()) {
        let set = postings.get(term);
        if (!set) {
          set = new Set();
          postings.set(term, set);
          vocab = null;
        }
        set.add(id);
      }
    }
    docs.set(id, doc);
  }

  const df = (term) => postings.get(term)?.size || 0;
  const idf = (term) => Math.log(1 + (docs.size - df(term) + 0.5) / (df(term) + 0.5));

  // Average field lengths, computed once per query.
  const averages = () => names.map((f) => totalLen[f] / docs.size);

  function weight(doc, term, avgs) {
    let w = 0;
    for (let i = 0; i < names.length; i++) {
      const n = doc.tf[names[i]]?.get(term);
      if (!n) continue;
      const norm = avgs[i] > 0 ? 1 - b + b * (doc.len[names[i]] / avgs[i]) : 1;
      w += fields[names[i]] * n / norm;
    }
    return w;
  }

  function termScore(doc, term, termIdf, avgs) {
    const w = weight(doc, term, avgs);
    return w > 0 ? termIdf * w * (k1 + 1) / (k1 + w) : 0;
  }

  function vocabPrefix(prefix, { limit = 20 } = {}) {
    if (typeof prefix !== 'string' || !prefix) return [];
    vocab ||= [...postings.keys()].sort();
    let lo = 0;
    let hi = vocab.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vocab[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < vocab.length && vocab[i].startsWith(prefix); i++) out.push(vocab[i]);
    out.sort((x, y) => df(y) - df(x) || (x < y ? -1 : x > y ? 1 : 0));
    return out.slice(0, limit);
  }

  const expand = (q) => (q.prefix && q.t.length >= PREFIX_MIN ? vocabPrefix(q.t) : postings.has(q.t) ? [q.t] : []);

  // terms: [{t, w = 1, prefix?, neg?}] → [{id, score, hits, matched}], where
  // hits are the index terms that matched and matched the indexes (into
  // `terms`) of the query terms a document matched.
  function search(terms, { filter, limit = 50 } = {}) {
    const list = Array.isArray(terms) ? terms : [];
    const allowed = new Map();
    const ok = (id) => {
      if (!filter) return true;
      if (!allowed.has(id)) allowed.set(id, !!filter(id));
      return allowed.get(id);
    };
    const excluded = new Set();
    for (const q of list) {
      if (!q?.neg || typeof q.t !== 'string' || !q.t) continue;
      for (const term of expand(q)) for (const id of postings.get(term)) excluded.add(id);
    }
    const acc = new Map();
    const avgs = averages();
    list.forEach((q, index) => {
      if (!q || q.neg || typeof q.t !== 'string' || !q.t) return;
      const w = Number.isFinite(q.w) ? q.w : 1;
      const best = new Map();
      for (const term of expand(q)) {
        const termIdf = idf(term);
        for (const id of postings.get(term)) {
          if (excluded.has(id) || !ok(id)) continue;
          const s = termScore(docs.get(id), term, termIdf, avgs);
          const current = best.get(id);
          if (!current || s > current.s) best.set(id, { s, term });
        }
      }
      for (const [id, { s, term }] of best) {
        let entry = acc.get(id);
        if (!entry) {
          entry = { id, score: 0, hits: new Set(), matched: new Set() };
          acc.set(id, entry);
        }
        entry.score += w * s;
        entry.hits.add(term);
        entry.matched.add(index);
      }
    });
    return [...acc.values()]
      .map((e) => ({ id: e.id, score: e.score, hits: [...e.hits], matched: [...e.matched] }))
      .sort(byScoreThenNewest)
      .slice(0, limit);
  }

  // Documents like `id`: its 32 most characteristic terms as the query,
  // keeping hits that score at least minRatio × the document's own score.
  function similar(id, { limit = 5, minRatio = 0.25, filter } = {}) {
    const doc = docs.get(id);
    if (!doc) return [];
    const mass = new Map();
    for (const f of names) {
      for (const [term, n] of doc.tf[f] || []) mass.set(term, (mass.get(term) || 0) + fields[f] * n);
    }
    const query = [...mass.entries()]
      .map(([t, m]) => ({ t, rank: m * idf(t) }))
      .sort((x, y) => y.rank - x.rank || (x.t < y.t ? -1 : 1))
      .slice(0, 32)
      .map(({ t }) => ({ t }));
    const avgs = averages();
    const self = query.reduce((sum, q) => sum + termScore(doc, q.t, idf(q.t), avgs), 0);
    if (!(self > 0)) return [];
    return search(query, { filter: (other) => other !== id && (!filter || filter(other)), limit: Infinity })
      .filter((hit) => hit.score >= minRatio * self)
      .slice(0, limit)
      .map(({ id: other, score }) => ({ id: other, score }));
  }

  return {
    add,
    remove,
    has: (id) => docs.has(id),
    get size() { return docs.size; },
    df,
    idf,
    // The live posting set: read it, don't mutate it.
    postings: (term) => postings.get(term) || new Set(),
    fieldTerms: (id, field) => new Set(docs.get(id)?.tf[field]?.keys() || []),
    fieldHas: (id, field, term) => !!docs.get(id)?.tf[field]?.has(term),
    search,
    similar,
    vocabPrefix,
  };
}
