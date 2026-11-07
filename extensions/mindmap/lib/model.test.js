import { describe, expect, it } from 'vitest';
import * as journal from './journal.js';
import {
  applyAccept, applyAnnotate, applyBackfill, applyCapture, applyDelete, applyEdit, applyEnrichLink,
  applyForget, applyImport, applyMerge, applyPromotions, applyReextract, applyRename, applyStatus,
  emptyState, entityByKey, findDuplicate, fromPersisted, keyPart, listParts, migrate, partKey,
  payloadFor, shardOf,
} from './model.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 6, 10);
const NOV6 = at(2026, 11, 6);

// A replayable id source with the lib/ids.js shape: per-prefix sequences,
// time-sortable, and reset() replays the same ids.
function testPool() {
  const issued = { i: [], e: [], o: [] };
  const cursor = { i: 0, e: 0, o: 0 };
  let n = 0;
  return {
    next(prefix, now) {
      if (cursor[prefix] < issued[prefix].length) return issued[prefix][cursor[prefix]++];
      const id = prefix + Math.floor(now).toString(36).padStart(9, '0').slice(-9) + (n++).toString(36).padStart(5, '0');
      issued[prefix].push(id);
      cursor[prefix]++;
      return id;
    },
    reset() { cursor.i = 0; cursor.e = 0; cursor.o = 0; },
  };
}

const envAt = (pool, now, extra = {}) => ({ now, newId: (p) => pool.next(p, now), journal, ...extra });
const commit = (state, change) => {
  if (change.op) state.ops = journal.appendOp(state.ops, change.op);
  return change;
};

function persist(state, { journalToo = true } = {}) {
  const shards = {};
  for (const part of listParts(state)) {
    if (part.startsWith('items:')) shards[part.slice(6)] = { ...payloadFor(state, part), rev: 1 };
  }
  return {
    meta: { ...payloadFor(state, 'meta'), rev: 1, txn: null },
    shards,
    entities: { ...payloadFor(state, 'entities'), rev: 1 },
    links: { ...payloadFor(state, 'links'), rev: 1 },
    journal: journalToo ? { ...payloadFor(state, 'journal'), rev: 1 } : null,
  };
}
const reload = (state, options) => fromPersisted(JSON.parse(JSON.stringify(persist(state, options))), { now: NOW }).state;

// Everything that is data (not caches, not the journal).
const facts = (state) => ({
  items: [...state.items.values()].sort((a, b) => a.id.localeCompare(b.id)),
  entities: [...state.entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
  candidates: [...state.candidates.values()].sort((a, b) => a.key.localeCompare(b.key)),
  links: state.links,
  rejections: state.rejections,
});

function ext(overrides = {}) {
  return {
    v: 1, text: '', truncated: false, private: false, kind: 'note', title: '', titleSource: 'auto',
    mentions: [], candidates: [], aliases: [], keyphrases: [], self: null, actions: [], links: [],
    rejectedActions: [], segments: 1, isDump: false, ...overrides,
  };
}

const F1_URL = 'https://wiki.example.com/mtcs/design-review';
const F1 = () => ext({
  text: F1_URL, kind: 'doc', title: 'wiki.example.com › design-review', url: F1_URL,
  canonicalUrl: 'wiki.example.com/mtcs/design-review',
});
const F6_TEXT = 'Bingo team sync\n- [ ] Send MTCS numbers to Dana by Friday\n- Dana to share the roadmap deck\n'
  + "- I'll book the offsite\nAction items:\n- review the Bingo launch checklist";
const F6 = () => ext({
  text: F6_TEXT, kind: 'meeting', title: 'Bingo team sync', isDump: true, segments: 6,
  mentions: [
    { key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', explicit: true, seg: 0 },
    { key: 'dana', name: 'Dana', type: 'person', origin: 'rule', explicit: false, seg: 1 },
    { key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', explicit: false, seg: 5 },
  ],
  candidates: [{ key: 'mtcs', display: 'MTCS', type: 'term' }],
  keyphrases: ['mtcs numbers', 'roadmap deck'],
  actions: [
    { seg: 1, text: 'Send MTCS numbers to Dana by Friday', title: 'Send MTCS numbers to Dana', quote: 'Send MTCS numbers to Dana by Friday', status: 'open', confidence: 1, suggested: false, owner: 'me', dueAt: NOV6, origin: 'rule' },
    { seg: 2, text: 'Dana to share the roadmap deck', title: 'Dana to share the roadmap deck', quote: 'Dana to share the roadmap deck', status: 'open', confidence: 0.6, suggested: true, owner: { key: 'dana', name: 'Dana' }, origin: 'rule' },
    { seg: 3, text: "I'll book the offsite", title: 'book the offsite', quote: "I'll book the offsite", status: 'open', confidence: 0.8, suggested: false, owner: 'me', origin: 'rule' },
    { seg: 5, text: 'review the Bingo launch checklist', title: 'review the Bingo launch checklist', quote: 'review the Bingo launch checklist', status: 'open', confidence: 1, suggested: false, owner: 'me', origin: 'rule' },
  ],
});
const action = (text, overrides = {}) => ext({
  text, kind: 'action', title: text,
  self: { seg: 0, text, title: text, quote: text, status: 'open', confidence: 0.8, suggested: false, owner: 'me', origin: 'rule' },
  ...overrides,
});

function capture(state, pool, x, now, extra) {
  return commit(state, applyCapture(state, x, envAt(pool, now, extra)));
}

describe('state, shards and keys', () => {
  it('starts empty with the me entity', () => {
    const state = emptyState(NOW);
    expect([...state.entities.keys()]).toEqual(['me']);
    expect(state.entities.get('me')).toMatchObject({ id: 'me', type: 'person', name: 'Me', key: 'me', aliases: [] });
    expect(state.meta).toMatchObject({ schema: 1, rev: 0, keys: {}, createdAt: NOW });
  });

  it('shards by the UTC month of createdAt', () => {
    expect(shardOf({ createdAt: Date.UTC(2026, 9, 31, 23, 59) })).toBe('2026-10');
    expect(shardOf({ createdAt: Date.UTC(2026, 10, 1, 0, 0) })).toBe('2026-11');
  });

  it('maps parts to storage keys and back', () => {
    expect(partKey('items:2026-11')).toBe('mm-items-2026-11');
    expect(partKey('entities')).toBe('mm-entities');
    expect(partKey('meta')).toBe('mm-meta');
    expect(partKey('items:../x')).toBeNull();
    for (const part of ['items:2026-01', 'entities', 'links', 'journal', 'meta']) expect(keyPart(partKey(part))).toBe(part);
    expect(keyPart('nx-mm-meta')).toBeNull();
    expect(keyPart('mm-lock')).toBeNull();
  });
});

describe('persistence round trip and validation', () => {
  function sample() {
    const state = emptyState(at(2026, 10, 1));
    const pool = testPool();
    capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    capture(state, pool, F6(), at(2026, 10, 30, 16));
    capture(state, pool, action('email the bingo team about the demo date', {
      mentions: [{ key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', seg: 0 }],
    }), at(2026, 11, 2, 9));
    capture(state, pool, ext({ text: 'bingo salary thoughts', private: true }), at(2026, 11, 4, 12));
    state.candidates.set('qpr', { key: 'qpr', display: 'QPR', type: 'term', n: 1, firstSeen: NOW, sample: [] });
    state.links.push({ s: [...state.items.keys()][0], t: [...state.items.keys()][1], type: 'related', origin: 'user', at: NOW });
    state.rejections.push({ s: '*', t: 'walrus', type: 'entity', at: NOW });
    return state;
  }

  it('reloads exactly what payloadFor wrote', () => {
    const state = sample();
    const { state: loaded, problems } = fromPersisted(JSON.parse(JSON.stringify(persist(state))), { now: NOW });
    expect(problems).toEqual([]);
    expect(facts(loaded)).toEqual(facts(state));
    expect(loaded.ops).toEqual(state.ops);
    expect([...loaded.shardRevs.keys()]).toEqual(['2026-10', '2026-11']);
    expect(loaded.partRevs).toEqual({ entities: 1, links: 1, journal: 1 });
    expect(payloadFor(loaded, 'meta').counts).toEqual({ items: 8, entities: 3 });
  });

  it('never persists the me entity\'s aliases (they come from settings)', () => {
    const state = emptyState(NOW);
    state.entities.get('me').aliases = ['Oren', 'ON'];
    const me = payloadFor(state, 'entities').entities.find((e) => e.id === 'me');
    expect(me.aliases).toEqual([]);
    expect(state.entities.get('me').aliases).toEqual(['Oren', 'ON']);
  });

  it('drops malformed records and lists every problem', () => {
    const good = sample();
    const parts = JSON.parse(JSON.stringify(persist(good)));
    const shard = parts.shards['2026-10'];
    const kept = shard.items.length;
    shard.items.push({ id: 'not-an-id', kind: 'note', createdAt: 1 }, { id: 'i000000000zzzzz', kind: 'poem', createdAt: 1 }, 'text', null);
    parts.entities.entities.push({ id: 'e00000000000001', type: 'alien', name: 'x' }, { id: 'e00000000000002', type: 'team', name: '  ' });
    parts.links.links.push({ s: 'a', t: 'b', type: 'friend' });
    parts.journal.ops.push({ opId: 'nope', kind: 'capture' });
    const { state, problems } = fromPersisted(parts, { now: NOW });
    expect(problems).toHaveLength(8);
    expect(problems.every((p) => p.code === 'bad_record')).toBe(true);
    expect([...state.items.values()].filter((i) => shardOf(i) === '2026-10')).toHaveLength(kept);
    expect(state.entities.size).toBe(good.entities.size);
  });

  it('repairs soft fields instead of dropping the record', () => {
    const { state } = fromPersisted({
      shards: { '2026-11': { schema: 1, rev: 2, items: [{ id: 'i00000000000001', kind: 'action', createdAt: Date.UTC(2026, 10, 2), entityIds: ['me', 'bad', 'me'], enrich: { state: 'weird' }, owner: 'nobody' }] } },
    }, { now: NOW });
    expect(state.items.get('i00000000000001')).toMatchObject({
      status: 'open', entityIds: ['me'], mentionOrigin: { me: 'rule' }, enrich: { state: 'none' },
      source: { via: 'launcher' }, rev: 1, v: 1, title: '', text: '',
    });
    expect(state.items.get('i00000000000001').owner).toBeUndefined();
  });

  it('keeps the higher rev of a duplicated item and flags items in the wrong shard', () => {
    const item = { id: 'i00000000000001', kind: 'note', createdAt: Date.UTC(2026, 10, 2), title: 'a', rev: 1 };
    const { state, problems } = fromPersisted({
      shards: {
        '2026-10': { schema: 1, rev: 1, items: [{ ...item, title: 'newer', rev: 3 }] },
        '2026-11': { schema: 1, rev: 1, items: [item] },
      },
    }, { now: NOW });
    expect(state.items.get(item.id).title).toBe('newer');
    expect(problems).toEqual([
      { part: 'items:2026-10', code: 'wrong_shard', id: item.id },
      { part: 'items:2026-11', code: 'duplicate', id: item.id },
    ]);
  });

  it('reports a future schema instead of guessing, and skips that part', () => {
    expect(() => migrate({ schema: 2, items: [] }, 'items:2026-11')).toThrow(expect.objectContaining({ code: 'future_schema' }));
    expect(() => migrate([], 'meta')).toThrow(expect.objectContaining({ code: 'bad_payload' }));
    expect(migrate({ items: [] }, 'items:2026-11')).toEqual({ items: [], schema: 1 });
    const { state, problems } = fromPersisted({
      shards: { '2026-11': { schema: 9, rev: 1, items: [{ id: 'i00000000000001', kind: 'note', createdAt: 1 }] } },
      entities: { schema: 1, rev: 1, entities: [], candidates: [] },
    }, { now: NOW });
    expect(problems).toEqual([{ part: 'items:2026-11', code: 'future_schema' }]);
    expect(state.items.size).toBe(0);
  });
});

describe('applyCapture', () => {
  it('splits a brain dump into a meeting and 4 actions with pool ids, inherited entities and owners (AT-3)', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const when = at(2026, 10, 30, 16);
    const change = capture(state, pool, F6(), when);
    expect(state.items.size).toBe(5);
    const parent = state.items.get(change.itemId);
    expect(parent).toMatchObject({ kind: 'meeting', title: 'Bingo team sync', createdAt: when, rev: 1 });
    expect(change.childIds).toHaveLength(4);
    expect([change.op.opId, change.itemId, ...change.childIds].every((id) => /^[io][0-9a-z]{14}$/.test(id))).toBe(true);

    const bingo = entityByKey(state, 'bingo');
    const dana = entityByKey(state, 'dana');
    expect(bingo).toMatchObject({ type: 'team', name: 'Bingo', origin: 'rule' });
    expect(dana).toMatchObject({ type: 'person', name: 'Dana' });
    expect(change.newEntityIds).toEqual([bingo.id, dana.id]);
    expect(parent.entityIds).toEqual([bingo.id, dana.id]);

    const [send, share, book, review] = change.childIds.map((id) => state.items.get(id));
    expect(send).toMatchObject({ kind: 'action', title: 'Send MTCS numbers to Dana', quote: 'Send MTCS numbers to Dana by Friday', status: 'open', suggested: false, owner: 'me', dueAt: NOV6, parentId: parent.id, seg: 1, origin: 'rule' });
    expect(share).toMatchObject({ status: 'open', suggested: true, owner: dana.id, confidence: 0.6 });
    expect(book).toMatchObject({ title: 'book the offsite', quote: "I'll book the offsite", owner: 'me' });
    expect(book.entityIds).toContain(bingo.id);
    expect(review.seg).toBe(5);
    for (const child of [send, share, book, review]) expect(child.entityIds.slice(0, 2)).toEqual([bingo.id, dana.id]);

    expect(change.touched).toEqual(new Set(['items:2026-10', 'entities']));
    expect(change.op).toMatchObject({ kind: 'capture', label: { code: 'capture', params: { itemId: parent.id, count: 5 } } });
    expect(change.op.created.items).toEqual([parent.id, ...change.childIds]);
    expect(change.op.created.entities).toEqual([bingo.id, dana.id]);
    expect(change.op.created.candidates).toEqual(['mtcs']);
  });

  it('links an existing entity instead of creating it, and keeps the strongest mention origin', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, F6(), at(2026, 10, 30, 16));
    const change = capture(state, pool, action('email the bingo team about the demo date', {
      mentions: [
        { key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', seg: 0 },
        { key: 'bingo', name: 'bingo', type: 'topic', origin: 'agent', seg: 0 },
      ],
    }), at(2026, 11, 2, 9));
    const item = state.items.get(change.itemId);
    const bingo = entityByKey(state, 'bingo');
    expect(change.newEntityIds).toEqual([]);
    expect(item).toMatchObject({ kind: 'action', status: 'open', owner: 'me', suggested: false, entityIds: [bingo.id], mentionOrigin: { [bingo.id]: 'agent' } });
  });

  it('records done actions, private items and provenance', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const when = at(2026, 11, 4, 9);
    const done = capture(state, pool, action('update the Bingo dashboard', {
      self: { seg: 0, text: 'update the Bingo dashboard', title: 'update the Bingo dashboard', quote: '[x] update the Bingo dashboard', status: 'done', confidence: 1, suggested: false, owner: 'me', origin: 'rule' },
    }), when, { via: 'chat', source: { app: 'Notes', window: '' } });
    expect(state.items.get(done.itemId)).toMatchObject({ status: 'done', doneAt: when, suggested: false, source: { via: 'chat', app: 'Notes' } });
    expect(state.items.get(done.itemId).source.window).toBeUndefined();

    const dump = capture(state, pool, { ...F6(), private: true }, when);
    for (const id of [dump.itemId, ...dump.childIds]) expect(state.items.get(id).private).toBe(true);
  });

  it('creates link children, flags links for enrichment and never duplicates a saved URL inside a dump', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f1 = capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    expect(state.items.get(f1.itemId).enrich).toEqual({ state: 'pending' });
    const dump = capture(state, pool, ext({
      text: 'reading\nhttps://example.com/a.pdf\nhttps://wiki.example.com/mtcs/design-review', kind: 'note', isDump: true,
      links: [
        { seg: 1, url: 'https://example.com/a.pdf', canonicalUrl: 'example.com/a.pdf', isDoc: true },
        { seg: 2, url: F1_URL, canonicalUrl: 'wiki.example.com/mtcs/design-review', isDoc: true },
      ],
    }), at(2026, 10, 27));
    expect(dump.childIds).toHaveLength(1);
    expect(state.items.get(dump.childIds[0])).toMatchObject({ kind: 'doc', url: 'https://example.com/a.pdf', parentId: dump.itemId, enrich: { state: 'pending' } });
    expect(dump.result.linkDupes).toEqual([f1.itemId]);

    const quiet = capture(state, pool, ext({ text: 'https://example.org/pricing', kind: 'link', url: 'https://example.org/pricing', canonicalUrl: 'example.org/pricing' }), NOW, { enrichLinks: false });
    expect(state.items.get(quiet.itemId).enrich).toEqual({ state: 'none' });
  });

  it('gives a "read later" link its child action', () => {
    const state = emptyState(NOW);
    const change = capture(state, testPool(), ext({
      text: 'read later https://example.com/blog/mtcs-intro', kind: 'link', url: 'https://example.com/blog/mtcs-intro', canonicalUrl: 'example.com/blog/mtcs-intro',
      actions: [{ seg: 0, text: 'read later', title: 'read later', quote: 'read later', status: 'open', confidence: 0.8, suggested: false, owner: 'me', origin: 'rule' }],
    }), NOW);
    expect(state.items.get(change.childIds[0])).toMatchObject({ kind: 'action', title: 'read later', parentId: change.itemId, status: 'open' });
  });

  it('merges a duplicate URL into the saved item with a dated annotation line (AT-4)', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f1 = capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const raw = 'https://WWW.wiki.example.com/mtcs/design-review/?utm_source=mail#top note: send to Ravi';
    const again = () => ext({
      text: raw, kind: 'doc', url: 'https://WWW.wiki.example.com/mtcs/design-review/?utm_source=mail#top',
      canonicalUrl: 'wiki.example.com/mtcs/design-review',
      mentions: [{ key: 'ravi', name: 'Ravi', type: 'person', origin: 'rule', seg: 0 }],
    });
    const change = capture(state, pool, again(), NOW);
    expect(state.items.size).toBe(1);
    expect(change).toMatchObject({ itemId: f1.itemId, dedupedInto: f1.itemId, childIds: [], result: { annotated: true } });
    expect(change.op.label.code).toBe('capture_dedup');
    const item = state.items.get(f1.itemId);
    expect(item.text).toBe(`${F1_URL}\n— 2026-11-06: note: send to Ravi`);
    expect(item.rev).toBe(2);
    expect(item.entityIds).toEqual([entityByKey(state, 'ravi').id]);

    capture(state, pool, again(), NOW);
    expect(state.items.get(f1.itemId).text.match(/send to Ravi/g)).toHaveLength(1);

    // extract's `extra` (the input without its URL span) wins when present.
    capture(state, pool, { ...again(), text: `${F1_URL} weird www.x`, extra: 'second note' }, NOW);
    expect(state.items.get(f1.itemId).text.split('\n').at(-1)).toBe('— 2026-11-06: second note');
  });

  it('dedups by path (Windows paths ignore case) and window doc key, never for dumps', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const doc = capture(state, pool, ext({ text: 'C:\\Docs\\Plan.docx', kind: 'doc', path: 'c:\\docs\\plan.docx' }), NOW);
    const win = capture(state, pool, ext({ text: '', kind: 'doc', title: 'MTCS rollout plan.docx', docKey: 'Microsoft Word\u0000MTCS rollout plan.docx' }), NOW);
    expect(findDuplicate(state, { path: 'C:\\DOCS\\PLAN.DOCX' })).toBe(doc.itemId);
    expect(findDuplicate(state, { docKey: 'Microsoft Word\u0000MTCS rollout plan.docx' })).toBe(win.itemId);
    expect(findDuplicate(state, { path: 'c:\\docs\\plan.docx', isDump: true })).toBeNull();
    expect(findDuplicate(state, { path: 'c:\\docs\\plan.docx' }, { exclude: new Set([doc.itemId]) })).toBeNull();
    // Saving the same window again adds nothing when there's no extra text.
    const again = capture(state, pool, ext({ text: 'MTCS rollout plan.docx', kind: 'doc', title: 'MTCS rollout plan.docx', docKey: 'Microsoft Word\u0000MTCS rollout plan.docx' }), NOW);
    expect(again.result.annotated).toBe(false);
    expect(state.items.get(win.itemId).rev).toBe(1);
  });

  it('uses a known owner id, and keeps an email address as the new person\'s alias', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, F6(), NOW);
    const dana = entityByKey(state, 'dana').id;
    const change = capture(state, pool, ext({
      text: 'Dana D to send the deck, cc sam@example.com', isDump: true,
      mentions: [{ key: 'sam', name: 'Sam', type: 'person', origin: 'rule', seg: 0, alias: 'sam@example.com' }],
      actions: [{ seg: 0, text: 'send the deck', title: 'send the deck', quote: 'Dana D to send the deck', status: 'open', confidence: 0.6, suggested: true, owner: { entityId: dana, key: 'dana d', name: 'Dana D' }, origin: 'rule' }],
    }), NOW);
    expect(state.items.get(change.childIds[0]).owner).toBe(dana);
    expect(entityByKey(state, 'sam')).toMatchObject({ type: 'person', aliases: ['sam@example.com'] });
    expect(entityByKey(state, 'dana d')).toBeNull();
  });

  it('never creates a rejected entity', () => {
    const state = emptyState(NOW);
    state.rejections.push({ s: '*', t: 'bingo', type: 'entity', at: NOW });
    const change = capture(state, testPool(), F6(), NOW);
    expect(entityByKey(state, 'bingo')).toBeNull();
    expect(state.items.get(change.itemId).entityIds).toEqual([entityByKey(state, 'dana').id]);
  });

  it('caps children at 50 and entities per item at 24', () => {
    const state = emptyState(NOW);
    const actions = Array.from({ length: 60 }, (_, i) => ({ seg: i, text: `task ${i}`, title: `task ${i}`, quote: `task ${i}`, status: 'open', confidence: 1, suggested: false, owner: 'me', origin: 'rule' }));
    const mentions = Array.from({ length: 30 }, (_, i) => ({ key: `topic${i}`, name: `topic${i}`, type: 'topic', origin: 'rule', seg: 0 }));
    const change = capture(state, testPool(), ext({ text: 'many', isDump: true, actions, mentions }), NOW);
    expect(change.childIds).toHaveLength(50);
    expect(state.items.get(change.itemId).entityIds).toHaveLength(24);
  });
});

describe('idempotent re-apply (SPEC §7.4)', () => {
  it.each([[true], [false]])('re-applying a capture after reload changes nothing (journal landed: %s)', (journalToo) => {
    const pool = testPool();
    const state = emptyState(NOW);
    capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const base = reload(state);
    const attempt = testPool();
    const change = commit(base, applyCapture(base, F6(), envAt(attempt, at(2026, 10, 30, 16))));
    const replayed = reload(base, { journalToo });
    attempt.reset();
    const again = commit(replayed, applyCapture(replayed, F6(), envAt(attempt, at(2026, 10, 30, 16))));
    expect(facts(replayed)).toEqual(facts(base));
    expect(again.itemId).toBe(change.itemId);
    expect(again.childIds).toEqual(change.childIds);
    expect(again.newEntityIds).toEqual(change.newEntityIds);
    if (journalToo) expect(replayed.ops).toEqual(base.ops);
    else expect(again.op.created).toEqual(change.op.created);
  });

  it('re-applying a dedup merge never adds the annotation twice, and keeps the original snapshot', () => {
    const pool = testPool();
    const state = emptyState(NOW);
    capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const base = reload(state);
    const attempt = testPool();
    const x = ext({ text: `${F1_URL} note: send to Ravi`, kind: 'doc', url: F1_URL, canonicalUrl: 'wiki.example.com/mtcs/design-review' });
    commit(base, applyCapture(base, x, envAt(attempt, NOW)));
    const replayed = reload(base);
    attempt.reset();
    const again = commit(replayed, applyCapture(replayed, x, envAt(attempt, NOW)));
    expect(facts(replayed)).toEqual(facts(base));
    expect(again.op.before.items[0].text).toBe(F1_URL);
    expect(journal.applyUndo(replayed, again.op, envAt(attempt, NOW)).op).not.toBeNull();
    expect(replayed.items.get(again.itemId).text).toBe(F1_URL);
  });

  it('re-applying a status change, promotions and back-fill after reload changes nothing', () => {
    const pool = testPool();
    const state = emptyState(NOW);
    const f6 = capture(state, pool, F6(), at(2026, 10, 30, 16));
    const f1 = capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const base = reload(state);
    const attempt = testPool();
    const run = (s) => {
      const env = envAt(attempt, NOW);
      const change = applyStatus(s, f6.childIds[0], 'done', env);
      commit(s, change);
      const cap = applyCapture(s, ext({ text: 'MTCS rollout plan', candidates: [{ key: 'mtcs', display: 'MTCS', type: 'term' }] }), env);
      s.candidates.set('mtcs', { key: 'mtcs', display: 'MTCS', type: 'term', n: 2, firstSeen: NOW, sample: [f6.itemId, cap.itemId] });
      applyPromotions(s, cap, [{ key: 'mtcs', display: 'MTCS', type: 'term', itemIds: [f6.itemId, cap.itemId] }], env);
      applyBackfill(s, cap, entityByKey(s, 'mtcs').id, [f1.itemId], env);
      commit(s, cap);
    };
    run(base);
    const replayed = reload(base);
    attempt.reset();
    run(replayed);
    expect(facts(replayed)).toEqual(facts(base));
    expect(replayed.ops).toEqual(base.ops);
  });
});

describe('promotions, back-fill and aliases', () => {
  it('creates a promoted entity, links it on the sighting items and the captured parent\'s children, in the same op', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), at(2026, 10, 30, 16));
    const env = envAt(pool, NOW);
    const change = applyCapture(state, ext({ text: 'MTCS hiring with Dana', candidates: [{ key: 'mtcs', display: 'MTCS', type: 'term' }] }), env);
    applyPromotions(state, change, [{ key: 'mtcs', display: 'MTCS', type: 'term', itemIds: [f6.itemId, change.itemId] }], env);
    commit(state, change);
    const mtcs = entityByKey(state, 'mtcs');
    expect(mtcs).toMatchObject({ type: 'term', name: 'MTCS', origin: 'rule' });
    expect(change.newEntityIds).toContain(mtcs.id);
    expect(change.op.created.entities).toContain(mtcs.id);
    expect(state.items.get(f6.itemId).entityIds).toContain(mtcs.id);
    expect(state.items.get(change.itemId).entityIds).toContain(mtcs.id);
    expect(change.op.before.items.map((i) => i.id)).toEqual([f6.itemId]);
    expect(change.touched.has('items:2026-10')).toBe(true);
    expect(change.op.after[f6.itemId]).toBe(state.items.get(f6.itemId).rev);
  });

  it('links an existing entity on promotion and respects rejections', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, F6(), NOW);
    const env = envAt(pool, NOW);
    const change = applyCapture(state, ext({ text: 'Dana and Zebra' }), env);
    state.rejections.push({ s: '*', t: 'zebra', type: 'entity', at: NOW });
    applyPromotions(state, change, [
      { key: 'dana', display: 'Dana', type: 'person', itemIds: [change.itemId] },
      { key: 'zebra', display: 'Zebra', type: 'term', itemIds: [change.itemId] },
    ], env);
    expect(change.newEntityIds).toEqual([]);
    expect(state.items.get(change.itemId).entityIds).toEqual([entityByKey(state, 'dana').id]);
    expect(entityByKey(state, 'zebra')).toBeNull();
  });

  it('back-fills earlier items and records it in the op', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f1 = capture(state, pool, F1(), at(2026, 10, 26));
    const env = envAt(pool, NOW);
    const change = applyCapture(state, ext({ text: 'Bingo team sync', mentions: [{ key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', seg: 0 }] }), env);
    const bingo = entityByKey(state, 'bingo').id;
    applyBackfill(state, change, bingo, [f1.itemId, change.itemId, 'i0000000000zzzz'], env);
    expect(state.items.get(f1.itemId)).toMatchObject({ entityIds: [bingo], mentionOrigin: { [bingo]: 'rule' }, rev: 2 });
    expect(change.op.before.items.map((i) => i.id)).toEqual([f1.itemId]);
    expect(change.touched.has('items:2026-10')).toBe(true);
  });

  it('attaches a learned long form to the short form\'s entity, now or once promoted', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, ext({ text: 'QPR', mentions: [{ key: 'qpr', name: 'QPR', type: 'term', origin: 'rule', seg: 0 }] }), NOW);
    capture(state, pool, ext({ text: 'Quarterly Planning Review (QPR)', aliases: [{ long: 'Quarterly Planning Review', longKey: 'quarterly planning review', short: 'QPR', shortKey: 'qpr' }] }), NOW);
    expect(entityByKey(state, 'qpr').aliases).toEqual(['Quarterly Planning Review']);
    expect(entityByKey(state, 'quarterly planning review').id).toBe(entityByKey(state, 'qpr').id);

    const env = envAt(pool, NOW);
    const change = applyCapture(state, ext({ text: 'Site Reliability Review (SRR)', candidates: [{ key: 'srr', display: 'SRR', type: 'term' }], aliases: [{ long: 'Site Reliability Review', longKey: 'site reliability review', short: 'SRR', shortKey: 'srr' }] }), env);
    state.candidates.set('srr', { key: 'srr', display: 'SRR', type: 'term', n: 1, firstSeen: NOW, sample: [change.itemId] });
    applyPromotions(state, change, [], env);
    commit(state, change);
    const later = applyCapture(state, ext({ text: 'SRR again', candidates: [{ key: 'srr', display: 'SRR', type: 'term' }] }), env);
    applyPromotions(state, later, [{ key: 'srr', display: 'SRR', type: 'term', itemIds: [change.itemId, later.itemId] }], env);
    expect(entityByKey(state, 'srr').aliases).toEqual(['Site Reliability Review']);
  });
});

describe('entityByKey', () => {
  it('prefers the same type, matches aliases, and follows merges', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, ext({ text: 'x', mentions: [
      { key: 'atlas', name: 'Atlas', type: 'topic', origin: 'rule', seg: 0 },
      { key: 'atlas', name: 'Atlas', type: 'project', origin: 'rule', seg: 0 },
    ] }), NOW);
    // The second mention links the existing topic (SPEC §5 S4: link, don't duplicate).
    expect([...state.entities.values()].filter((e) => e.key === 'atlas')).toHaveLength(1);
    const atlas = entityByKey(state, 'atlas', 'project');
    expect(atlas.type).toBe('topic');
    state.entities.set('e00000000000009', { id: 'e00000000000009', type: 'project', name: 'Atlas', key: 'atlas', aliases: [], origin: 'user', createdAt: NOW, updatedAt: NOW, rev: 1 });
    expect(entityByKey(state, 'atlas', 'project').id).toBe('e00000000000009');
    state.entities.get('me').aliases = ['Oren'];
    expect(entityByKey(state, 'oren', 'person').id).toBe('me');
    state.entities.set(atlas.id, { ...atlas, mergedInto: 'e00000000000009' });
    expect(entityByKey(state, 'atlas', 'topic').id).toBe('e00000000000009');
    expect(entityByKey(state, '')).toBeNull();
  });
});

describe('status, accept, edit, delete', () => {
  function seeded() {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), at(2026, 10, 30, 16));
    return { state, pool, f6, env: () => envAt(pool, NOW) };
  }

  it('marks done and reopens, with doneAt and labels', () => {
    const { state, f6, env } = seeded();
    const id = f6.childIds[0];
    const done = commit(state, applyStatus(state, id, 'done', env()));
    expect(state.items.get(id)).toMatchObject({ status: 'done', doneAt: NOW, rev: 2 });
    expect(done.op).toMatchObject({ kind: 'status', label: { code: 'status_done', params: { itemId: id } } });
    expect(done.touched).toEqual(new Set(['items:2026-10']));
    commit(state, applyStatus(state, id, 'open', env()));
    expect(state.items.get(id).status).toBe('open');
    expect(state.items.get(id).doneAt).toBeUndefined();
  });

  it('refuses unknown items, non-actions, bad statuses and no-ops', () => {
    const { state, f6, env } = seeded();
    expect(applyStatus(state, 'i0000000000zzzz', 'done', env())).toMatchObject({ op: null, code: 'not_found' });
    expect(applyStatus(state, f6.itemId, 'done', env())).toMatchObject({ op: null, code: 'not_action' });
    expect(applyStatus(state, f6.childIds[0], 'archived', env())).toMatchObject({ op: null, code: 'bad_status' });
    expect(applyStatus(state, f6.childIds[0], 'open', env())).toMatchObject({ op: null, code: 'noop' });
  });

  it('accepts and dismisses suggestions', () => {
    const { state, f6, env } = seeded();
    const id = f6.childIds[1];
    const dismissed = commit(state, applyStatus(state, id, 'dismissed', env()));
    expect(dismissed.op).toMatchObject({ kind: 'dismiss', label: { code: 'dismiss' } });
    const accepted = commit(state, applyAccept(state, id, env()));
    expect(accepted.op.kind).toBe('accept');
    expect(state.items.get(id)).toMatchObject({ status: 'open', suggested: false });
  });

  it('edits as the user and makes children private with their parent', () => {
    const { state, f6, env } = seeded();
    const titled = commit(state, applyEdit(state, f6.itemId, { title: 'Bingo weekly', archived: true }, env()));
    expect(titled.op.kind).toBe('edit');
    expect(state.items.get(f6.itemId)).toMatchObject({ title: 'Bingo weekly', titleSource: 'user', archived: true });
    const hidden = commit(state, applyEdit(state, f6.itemId, { private: true }, env()));
    expect(hidden.op).toMatchObject({ kind: 'privacy', label: { code: 'privacy_on' } });
    for (const id of [f6.itemId, ...f6.childIds]) expect(state.items.get(id).private).toBe(true);
    commit(state, applyEdit(state, f6.itemId, { private: false, archived: false }, env()));
    for (const id of [f6.itemId, ...f6.childIds]) expect(state.items.get(id).private).toBeUndefined();
    commit(state, applyEdit(state, f6.itemId, { kind: 'note' }, env()));
    expect(state.items.get(f6.itemId)).toMatchObject({ kind: 'note', kindSource: 'user' });
  });

  it('deletes children with their parent', () => {
    const { state, f6, env } = seeded();
    state.links.push({ s: f6.childIds[0], t: f6.itemId, type: 'related', origin: 'user', at: NOW });
    const change = commit(state, applyDelete(state, [f6.itemId], env()));
    expect(state.items.size).toBe(0);
    expect(state.links).toEqual([]);
    expect(change.deleted).toHaveLength(5);
    expect(change.op.label).toEqual({ code: 'delete', params: { itemId: f6.itemId, count: 5 } });
    expect(change.op.after[f6.itemId]).toBeNull();
    expect(change.touched).toEqual(new Set(['items:2026-10', 'links']));
  });
});

describe('enrichment and re-derivation', () => {
  it('sets the title only while it is automatic, stores the description, and is silent', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f1 = capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const change = commit(state, applyEnrichLink(state, f1.itemId, { title: 'MTCS design review', description: 'Failover and capacity plan for MTCS.' }, envAt(pool, NOW)));
    expect(change.op).toMatchObject({ kind: 'enrich', silent: true });
    expect(state.items.get(f1.itemId)).toMatchObject({
      title: 'MTCS design review', titleSource: 'meta', summary: 'Failover and capacity plan for MTCS.',
      summarySource: 'meta', enrich: { state: 'done', at: NOW },
    });
    commit(state, applyEdit(state, f1.itemId, { title: 'My title' }, envAt(pool, NOW)));
    commit(state, applyEnrichLink(state, f1.itemId, { title: 'Other', description: 'New description' }, envAt(pool, NOW)));
    expect(state.items.get(f1.itemId)).toMatchObject({ title: 'My title', summary: 'New description' });
    commit(state, applyEnrichLink(state, f1.itemId, null, envAt(pool, NOW)));
    expect(state.items.get(f1.itemId).enrich.state).toBe('failed');
    expect(journal.lastUndoable(state.ops).kind).toBe('edit');
  });

  it('re-derives rule fields only', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    const env = envAt(pool, NOW);
    const annotated = commit(state, applyAnnotate(state, [{ id: f6.itemId, entities: [{ name: 'Launch', type: 'project' }] }], env));
    expect(annotated.applied).toEqual([f6.itemId]);
    const launch = entityByKey(state, 'launch').id;
    const change = commit(state, applyReextract(state, f6.itemId, ext({
      v: 2, keyphrases: ['launch checklist'], mentions: [{ key: 'checklist', name: 'Checklist', type: 'topic', origin: 'rule', seg: 5 }],
    }), { ...envAt(pool, NOW), replaceRule: true }));
    const item = state.items.get(f6.itemId);
    const checklist = entityByKey(state, 'checklist').id;
    expect(change.op).toMatchObject({ kind: 'enrich', silent: true, label: { code: 'reextract' } });
    expect(item.keyphrases).toEqual(['launch checklist']);
    expect(item.v).toBe(2);
    expect(item.entityIds).toEqual([launch, checklist]);
    expect(state.items.get(f6.childIds[0]).entityIds).toContain(checklist);
  });
});

describe('applyAnnotate (P1)', () => {
  function seeded() {
    const state = emptyState(NOW);
    const pool = testPool();
    const note = capture(state, pool, ext({ text: 'Lunch with Dana, talked about MTCS hiring. Book review next week.', summary: 'Mine', summarySource: 'user' }), NOW);
    const plain = capture(state, pool, ext({ text: 'MTCS capacity notes' }), NOW);
    const secret = capture(state, pool, ext({ text: 'bingo salary thoughts', private: true }), NOW);
    return { state, pool, note, plain, secret };
  }

  it('adds summaries, terms, entities and quoted actions, additively, as one op', () => {
    const { state, pool, note, plain } = seeded();
    const change = commit(state, applyAnnotate(state, [
      { id: `[mm:${note.itemId}]`, summary: 'Agent words', terms: ['MTCS', 'hiring'], entities: [{ name: 'Dana', type: 'person' }],
        actions: [{ text: 'Book review', quote: 'book REVIEW  next week' }, { text: 'Invent', quote: 'not in text' }] },
      { id: plain.itemId, summary: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), kind: 'doc' },
      { id: 'i0000000000zzzz' },
    ], envAt(pool, NOW)));
    expect(change.op).toMatchObject({ kind: 'annotate', label: { code: 'annotate', params: { count: 3 } } });
    expect(change.applied).toEqual([note.itemId, plain.itemId]);
    expect(change.rejected).toEqual([
      { id: note.itemId, reason: 'quote_not_found', text: 'Invent' },
      { id: 'i0000000000zzzz', reason: 'not_found' },
    ]);
    const item = state.items.get(note.itemId);
    const dana = entityByKey(state, 'dana');
    expect(item).toMatchObject({ summary: 'Mine', summarySource: 'user', terms: ['MTCS', 'hiring'], enrich: { state: 'done' } });
    expect(item.mentionOrigin[dana.id]).toBe('agent');
    expect(dana.origin).toBe('agent');
    const [book] = change.childIds.map((id) => state.items.get(id));
    expect(book).toMatchObject({ kind: 'action', title: 'Book review', status: 'open', suggested: true, origin: 'agent', parentId: note.itemId, owner: 'me' });
    expect(state.items.get(plain.itemId)).toMatchObject({ kind: 'doc', summarySource: 'agent' });
    expect(state.items.get(plain.itemId).summary.split(' ')).toHaveLength(25);
  });

  it('never touches private items', () => {
    const { state, pool, secret } = seeded();
    const change = applyAnnotate(state, [{ id: secret.itemId, summary: 'salary' }], envAt(pool, NOW));
    expect(change.rejected).toEqual([{ id: secret.itemId, reason: 'private' }]);
    expect(change.op).toBeNull();
    expect(state.items.get(secret.itemId).summary).toBeUndefined();
  });

  it('accepts agent actions outright when auto-accept is on, and resolves named owners', () => {
    const { state, pool, note } = seeded();
    const change = applyAnnotate(state, [{ id: note.itemId, actions: [{ text: 'Dana books review', quote: 'Book review', owner: 'Dana', due: '2026-11-13' }] }], envAt(pool, NOW, { autoAccept: true }));
    const child = state.items.get(change.childIds[0]);
    expect(child).toMatchObject({ suggested: false, owner: entityByKey(state, 'dana').id, dueAt: at(2026, 11, 13) });
  });
});

describe('merge, forget, rename, import (P2)', () => {
  function seeded() {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    const zebra = capture(state, pool, action('call the Zebra team', { mentions: [{ key: 'zebra', name: 'Zebra', type: 'team', origin: 'rule', seg: 0 }] }), NOW);
    return { state, pool, f6, zebra, env: () => envAt(pool, NOW) };
  }

  it('merges one entity into another', () => {
    const { state, zebra, env } = seeded();
    const bingo = entityByKey(state, 'bingo');
    const z = entityByKey(state, 'zebra');
    const change = commit(state, applyMerge(state, z.id, bingo.id, env()));
    expect(change.op.kind).toBe('merge');
    expect(state.entities.get(z.id).mergedInto).toBe(bingo.id);
    expect(state.entities.get(bingo.id).aliases).toEqual(['Zebra']);
    expect(state.items.get(zebra.itemId).entityIds).toEqual([bingo.id]);
    expect(entityByKey(state, 'zebra').id).toBe(bingo.id);
    expect(applyMerge(state, bingo.id, bingo.id, env())).toMatchObject({ code: 'same' });
    expect(applyMerge(state, 'me', bingo.id, env())).toMatchObject({ code: 'me' });
  });

  it('forgets an entity for good', () => {
    const { state, pool, f6, env } = seeded();
    const dana = entityByKey(state, 'dana');
    commit(state, applyForget(state, dana.id, env()));
    expect(state.entities.has(dana.id)).toBe(false);
    expect(state.items.get(f6.childIds[1]).owner).toBeUndefined();
    expect([...state.items.values()].some((i) => i.entityIds.includes(dana.id))).toBe(false);
    expect(state.rejections).toEqual([{ s: '*', t: 'dana', type: 'entity', at: NOW }]);
    capture(state, pool, ext({ text: 'Dana again', mentions: [{ key: 'dana', name: 'Dana', type: 'person', origin: 'rule', seg: 0 }] }), NOW);
    expect(entityByKey(state, 'dana')).toBeNull();
    expect(applyForget(state, 'me', env())).toMatchObject({ code: 'me' });
  });

  it('renames, keeping the old name as an alias, and refuses a taken key', () => {
    const { state, env } = seeded();
    const bingo = entityByKey(state, 'bingo');
    commit(state, applyRename(state, bingo.id, 'Bingo Squad', undefined, env()));
    expect(state.entities.get(bingo.id)).toMatchObject({ name: 'Bingo Squad', key: 'bingo squad', aliases: ['Bingo'], origin: 'user' });
    expect(entityByKey(state, 'bingo').id).toBe(bingo.id);
    expect(applyRename(state, bingo.id, 'Zebra', 'zebra', env())).toMatchObject({ code: 'conflict' });
  });

  it('imports with the newer updatedAt winning, as one op', () => {
    const { state, env } = seeded();
    const exported = { format: 'kage-mindmap', schema: 1, items: [...state.items.values()].map((i) => JSON.parse(JSON.stringify(i))), entities: [...state.entities.values()], links: [], rejections: [{ s: '*', t: 'walrus', type: 'entity', at: NOW }] };
    exported.items[0] = { ...exported.items[0], title: 'Newer', updatedAt: NOW + 1 };
    exported.items.push({ ...exported.items[1], id: 'i00000000000abc', title: 'Brand new', entityIds: ['e0000000000none'] });
    exported.items.push({ id: 'junk' });
    const change = commit(state, applyImport(state, exported, env()));
    // skipped: me + 3 unchanged entities, 5 unchanged items, 1 malformed item.
    expect(change.result).toEqual({ added: 1, updated: 1, skipped: 10 });
    expect(state.items.get(exported.items[0].id).title).toBe('Newer');
    expect(state.items.get('i00000000000abc').entityIds).toEqual([]);
    expect(state.rejections).toHaveLength(1);
    expect(applyImport(state, { format: 'other' }, env())).toMatchObject({ code: 'bad_format' });
    expect(applyImport(state, { format: 'kage-mindmap', schema: 3 }, env())).toMatchObject({ code: 'future_schema' });
  });
});

describe('undo through the journal (AT-8)', () => {
  it('undoing a capture removes its 5 items and the entities only it mentioned', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, F1(), at(2026, 10, 26, 9, 12));
    const before = JSON.parse(JSON.stringify(facts(state)));
    const env = envAt(pool, at(2026, 10, 30, 16));
    const change = applyCapture(state, F6(), env);
    state.candidates.set('mtcs', { key: 'mtcs', display: 'MTCS', type: 'term', n: 1, firstSeen: NOW, sample: [change.itemId] });
    commit(state, change);
    const target = journal.lastUndoable(state.ops);
    expect(target.opId).toBe(change.op.opId);
    const undo = commit(state, journal.applyUndo(state, target, envAt(pool, NOW)));
    expect(undo.op.kind).toBe('undo');
    expect(undo.touched).toEqual(new Set(['items:2026-10', 'entities']));
    expect(facts(state)).toEqual(before);
    expect(entityByKey(state, 'bingo')).toBeNull();
    expect(entityByKey(state, 'dana')).toBeNull();
    expect(journal.lastUndoable(state.ops).kind).toBe('capture');
    expect(journal.canUndo(state, change.op)).toEqual({ ok: false, code: 'already_undone' });
  });

  it('removes promotions and back-fill with the capture they joined', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f1 = capture(state, pool, F1(), at(2026, 10, 26));
    const f2 = capture(state, pool, ext({ text: 'MTCS rollout plan.docx', kind: 'doc' }), at(2026, 10, 28));
    const before = JSON.parse(JSON.stringify(facts(state)));
    const env = envAt(pool, NOW);
    const change = applyCapture(state, ext({ text: 'MTCS hiring' }), env);
    applyPromotions(state, change, [{ key: 'mtcs', display: 'MTCS', type: 'term', itemIds: [f2.itemId, change.itemId] }], env);
    applyBackfill(state, change, entityByKey(state, 'mtcs').id, [f1.itemId], env);
    commit(state, change);
    expect(state.items.get(f1.itemId).entityIds).toHaveLength(1);
    commit(state, journal.applyUndo(state, change.op, envAt(pool, NOW)));
    expect(facts(state)).toEqual(before);
  });

  it('keeps a created entity that a later item still mentions', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    capture(state, pool, action('email the bingo team', { mentions: [{ key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', seg: 0 }] }), NOW);
    commit(state, journal.applyUndo(state, f6.op, envAt(pool, NOW)));
    expect(entityByKey(state, 'bingo')).not.toBeNull();
    expect(entityByKey(state, 'dana')).toBeNull();
    expect(state.items.size).toBe(1);
  });

  it('refuses an undo superseded by a later edit, but not by a silent enrichment', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    const id = f6.childIds[0];
    const done = commit(state, applyStatus(state, id, 'done', envAt(pool, NOW)));
    commit(state, applyEnrichLink(state, id, { title: 'x', description: 'y' }, envAt(pool, NOW)));
    expect(journal.canUndo(state, done.op)).toEqual({ ok: true });
    commit(state, applyEdit(state, id, { title: 'Send the numbers' }, envAt(pool, NOW)));
    expect(journal.canUndo(state, done.op)).toEqual({ ok: false, code: 'superseded' });
    expect(journal.applyUndo(state, done.op, envAt(pool, NOW))).toMatchObject({ op: null, code: 'superseded' });
  });

  it('walks back several ops in order with repeated undo', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    const id = f6.childIds[0];
    const initial = JSON.parse(JSON.stringify(facts(state)));
    commit(state, applyStatus(state, id, 'done', envAt(pool, NOW)));
    const afterDone = JSON.parse(JSON.stringify(facts(state)));
    commit(state, applyEdit(state, id, { title: 'Send the numbers' }, envAt(pool, NOW)));
    commit(state, journal.applyUndo(state, journal.lastUndoable(state.ops), envAt(pool, NOW)));
    expect(facts(state)).toEqual(afterDone);
    commit(state, journal.applyUndo(state, journal.lastUndoable(state.ops), envAt(pool, NOW)));
    expect(facts(state)).toEqual(initial);
    expect(state.items.get(id).status).toBe('open');
  });

  it('brings a forgotten entity and its mentions back', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    capture(state, pool, F6(), NOW);
    const before = JSON.parse(JSON.stringify(facts(state)));
    const forget = commit(state, applyForget(state, entityByKey(state, 'dana').id, envAt(pool, NOW)));
    expect(forget.touched).toEqual(new Set(['items:2026-11', 'entities', 'links']));
    commit(state, journal.applyUndo(state, forget.op, envAt(pool, NOW)));
    expect(facts(state)).toEqual(before);
  });

  it('restores a deleted dump exactly', () => {
    const state = emptyState(NOW);
    const pool = testPool();
    const f6 = capture(state, pool, F6(), NOW);
    const before = JSON.parse(JSON.stringify(facts(state)));
    const deleted = commit(state, applyDelete(state, f6.itemId, envAt(pool, NOW)));
    commit(state, journal.applyUndo(state, deleted.op, envAt(pool, NOW)));
    expect(facts(state)).toEqual(before);
  });
});
