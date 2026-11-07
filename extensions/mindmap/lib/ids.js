// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Record ids, citation tokens and card tokens. Ids never contain user text.

const PREFIXES = new Set(['i', 'e', 'o']);
const TIME_LEN = 9;
const RAND_LEN = 5;

export const ID_RE = /^(?:[ieo][0-9a-z]{14}|me)$/;
// Global regexes: callers must reset lastIndex (or use matchAll / replace).
export const CITE_RE = /\[mm:([ie][0-9a-z]{14}|me)\]/g;
export const CARD_RE = /\[mm-card:(op|item|map|help)(?::(o|me|[ieo][0-9a-z]{14}))?\]/g;

const defaultRand = (array) => globalThis.crypto.getRandomValues(array);

export function newId(prefix, now = Date.now(), rand = defaultRand) {
  if (!PREFIXES.has(prefix)) throw new TypeError(`newId: unknown prefix ${String(prefix)}`);
  const ms = Math.max(0, Math.floor(Number(now) || 0));
  const time = ms.toString(36).padStart(TIME_LEN, '0').slice(-TIME_LEN);
  const values = rand(new Uint32Array(RAND_LEN));
  let tail = '';
  for (let i = 0; i < RAND_LEN; i++) tail += ((values[i] >>> 0) % 36).toString(36);
  return prefix + time + tail;
}

export function idTime(id) {
  if (typeof id !== 'string' || id === 'me' || !ID_RE.test(id)) return null;
  const ms = parseInt(id.slice(1, 1 + TIME_LEN), 36);
  return Number.isFinite(ms) ? ms : null;
}

export function isItemId(s) {
  return typeof s === 'string' && /^i[0-9a-z]{14}$/.test(s);
}

export function isEntityId(s) {
  return typeof s === 'string' && (s === 'me' || /^e[0-9a-z]{14}$/.test(s));
}

export function isOpId(s) {
  return typeof s === 'string' && /^o[0-9a-z]{14}$/.test(s);
}

export function cite(id) {
  return '[mm:' + id + ']';
}

// Accepts '[mm:<id>]', 'mm:<id>', '<id>', and the launcher row forms
// 'mm:i:<id>' / 'mm:e:<id>'. Returns the bare id when valid, else null.
export function stripCite(s) {
  if (typeof s !== 'string') return null;
  let v = s.trim();
  const bracket = /^\[mm:([^\]]*)\]$/.exec(v);
  if (bracket) v = bracket[1].trim();
  else if (v.startsWith('mm:')) v = v.slice(3);
  const row = /^[ie]:(.+)$/.exec(v);
  if (row && ID_RE.test(row[1])) v = row[1];
  return ID_RE.test(v) ? v : null;
}

// A replayable id source. A mutation retried under the lock calls reset()
// and gets the same ids again, per prefix and in the same order, so a
// re-applied op upserts the records it already wrote.
export function createIdPool(rand = defaultRand) {
  const issued = { i: [], e: [], o: [] };
  const cursor = { i: 0, e: 0, o: 0 };
  return {
    next(prefix, now = Date.now()) {
      if (!PREFIXES.has(prefix)) throw new TypeError(`createIdPool: unknown prefix ${String(prefix)}`);
      const list = issued[prefix];
      if (cursor[prefix] < list.length) return list[cursor[prefix]++];
      const id = newId(prefix, now, rand);
      list.push(id);
      cursor[prefix] = list.length;
      return id;
    },
    reset() {
      cursor.i = 0;
      cursor.e = 0;
      cursor.o = 0;
    },
    get issued() {
      return { i: [...issued.i], e: [...issued.e], o: [...issued.o] };
    },
  };
}
