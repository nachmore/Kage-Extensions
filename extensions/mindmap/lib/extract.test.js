import { describe, expect, it } from 'vitest';
import * as text from './text.js';
import * as dates from './dates.js';
import * as url from './url.js';
import * as entities from './entities.js';
import { ACTION_HEADING_RE, EXTRACTOR_VERSION, IMPERATIVE_VERBS, extract, previewOf } from './extract.js';

const lib = { text, dates, url, entities };
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const day = (ms) => dates.toIsoDay(ms);
const dict = (list = []) => entities.buildDictionary(list, lib);
const MTCS = { entityId: 'e00000000000mtc', type: 'term', names: ['MTCS'] };
const BINGO = { entityId: 'e0000000000bngo', type: 'team', names: ['Bingo'] };
const DANA = { entityId: 'e0000000000dana', type: 'person', names: ['Dana'] };
const ZEBRA = { entityId: 'e000000000zebra', type: 'team', names: ['Zebra'] };
const env = (now, known = [], extra = {}) => ({ lib, now, weekStart: 1, dict: dict(known), myNames: [], autoAccept: false, ...extra });
const run = (input, now, known, extra) => extract(typeof input === 'string' ? { text: input, via: 'launcher' } : input, env(now, known, extra));
const names = (ex) => ex.mentions.map((m) => m.name);

const F6 = [
  'Bingo team sync',
  '- [ ] Send MTCS numbers to Dana by Friday',
  '- Dana to share the roadmap deck',
  "- I'll book the offsite",
  'Action items:',
  '- review the Bingo launch checklist',
].join('\n');

describe('SPEC §3.1 fixtures F1–F11', () => {
  it('F1: a wiki URL is a doc; metadata adds the title and summary words', () => {
    const now = at(2026, 10, 26, 9, 12);
    const ex = run('https://wiki.example.com/mtcs/design-review', now);
    expect(ex).toMatchObject({ kind: 'doc', url: 'https://wiki.example.com/mtcs/design-review', canonicalUrl: 'wiki.example.com/mtcs/design-review', titleSource: 'auto' });
    expect(ex.title).toBe('wiki.example.com › design-review');
    const enriched = extract({ text: ex.text, via: 'launcher', hint: { title: 'MTCS design review', summary: 'Failover and capacity plan for MTCS.' } }, env(now));
    expect(enriched).toMatchObject({ kind: 'doc', title: 'MTCS design review', summary: 'Failover and capacity plan for MTCS.' });
    expect(enriched.candidates).toEqual([{ key: 'mtcs', display: 'MTCS', type: 'term' }]);
    expect(enriched.keyphrases).toContain('mtcs design review');
  });

  it('F2: the source window becomes a doc with a cleaned title and a dedup key', () => {
    const ex = extract({ text: '', via: 'launcher', source: { window: 'MTCS rollout plan.docx - Word', app: 'Microsoft Word' } }, env(at(2026, 10, 28, 14, 3), [MTCS]));
    expect(ex).toMatchObject({ kind: 'doc', title: 'MTCS rollout plan.docx', docKey: 'Microsoft Word\u0000MTCS rollout plan.docx', empty: false });
    expect(names(ex)).toEqual(['MTCS']);
  });

  it('F2 (macOS without Screen Recording): an empty or app-only title yields nothing to save', () => {
    for (const window of ['', 'Microsoft Word']) {
      const ex = extract({ text: '', via: 'launcher', source: { window, app: 'Microsoft Word' } }, env(at(2026, 10, 28)));
      expect(ex.empty).toBe(true);
      expect(ex.kind).toBe('note');
      expect(ex.title).toBe('');
      expect(ex.docKey).toBeUndefined();
    }
  });

  it('F3: a home path is a doc titled with its file name', () => {
    const ex = run('~/Documents/MTCS capacity notes.pdf', at(2026, 11, 3, 11), [MTCS]);
    expect(ex).toMatchObject({ kind: 'doc', path: '~/Documents/MTCS capacity notes.pdf', title: 'MTCS capacity notes.pdf' });
    expect(names(ex)).toEqual(['MTCS']);
    expect(ex.keyphrases).toEqual(['mtcs capacity notes']);
  });

  it('F4 and F11: other URLs are links', () => {
    expect(run('https://example.com/blog/mtcs-intro', at(2026, 10, 22, 8, 30))).toMatchObject({ kind: 'link', canonicalUrl: 'example.com/blog/mtcs-intro', title: 'example.com › mtcs-intro' });
    expect(run('https://example.org/pricing', at(2026, 10, 29, 15), [MTCS])).toMatchObject({ kind: 'link', canonicalUrl: 'example.org/pricing', mentions: [] });
  });

  it('F5: a thought is a note; Dana and MTCS are counted as candidates', () => {
    const ex = run('Lunch with Dana, talked about MTCS hiring', at(2026, 10, 29, 13, 10));
    expect(ex).toMatchObject({ kind: 'note', title: 'Lunch with Dana, talked about MTCS hiring', self: null, actions: [] });
    expect(ex.candidates).toEqual([{ key: 'dana', display: 'Dana', type: 'person' }, { key: 'mtcs', display: 'MTCS', type: 'term' }]);
    // Once MTCS is an entity it is a mention, not a candidate.
    const later = run('Lunch with Dana, talked about MTCS hiring', at(2026, 10, 29, 13, 10), [MTCS]);
    expect(names(later)).toEqual(['MTCS']);
    expect(later.candidates.map((c) => c.key)).toEqual(['dana']);
  });

  it('F6: a meeting with 4 child actions (AT-3)', () => {
    const ex = run(F6, at(2026, 10, 30, 16), [MTCS]);
    expect(ex).toMatchObject({ kind: 'meeting', title: 'Bingo team sync', isDump: true, segments: 6, self: null, links: [] });
    expect(ex.actions.map((a) => ({ title: a.title, quote: a.quote, status: a.status, suggested: a.suggested, owner: a.owner, due: a.dueAt && day(a.dueAt) }))).toEqual([
      { title: 'Send MTCS numbers to Dana', quote: 'Send MTCS numbers to Dana by Friday', status: 'open', suggested: false, owner: 'me', due: '2026-11-06' },
      { title: 'Dana to share the roadmap deck', quote: 'Dana to share the roadmap deck', status: 'open', suggested: true, owner: { key: 'dana', name: 'Dana' }, due: undefined },
      { title: 'book the offsite', quote: "I'll book the offsite", status: 'open', suggested: false, owner: 'me', due: undefined },
      { title: 'review the Bingo launch checklist', quote: 'review the Bingo launch checklist', status: 'open', suggested: false, owner: 'me', due: undefined },
    ]);
    expect(ex.actions.map((a) => a.confidence)).toEqual([1, 0.6, 0.8, 1]);
    expect(ex.actions.map((a) => a.seg)).toEqual([1, 2, 3, 5]);
    // Bingo (explicit "Bingo team") and Dana (owner cue) are new; MTCS is known.
    expect(ex.mentions).toEqual([
      { key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', explicit: true, seg: 0, segs: [0, 5] },
      { key: 'dana', name: 'Dana', type: 'person', origin: 'rule', explicit: true, seg: 1, segs: [1, 2] },
      { entityId: MTCS.entityId, key: 'mtcs', name: 'MTCS', type: 'term', origin: 'rule', explicit: false, seg: 1, segs: [1] },
    ]);
    // Every quote is the source line without its bullet marker.
    const lines = F6.split('\n');
    for (const a of ex.actions) expect(lines[a.seg].replace(/^- (?:\[ \] )?/, '')).toBe(a.quote);
  });

  it('F6 preview: "meeting · Bingo · Dana · MTCS · 4 actions (1 suggested) · due Fri, Nov 6"', () => {
    expect(previewOf(run(F6, at(2026, 10, 30, 16), [MTCS]))).toEqual({
      kind: 'meeting', entityNames: ['Bingo', 'Dana', 'MTCS'], actionCount: 4, suggestedCount: 1, nextDue: at(2026, 11, 6),
      linkCount: 0, private: false, truncated: false,
    });
  });

  it('F7: "todo:" makes an open action of mine about the Bingo team', () => {
    const ex = run('todo: email the bingo team about the demo date', at(2026, 11, 2, 9), [MTCS, BINGO, DANA]);
    expect(ex).toMatchObject({ kind: 'action', title: 'email the bingo team about the demo date' });
    expect(ex.self).toMatchObject({ status: 'open', owner: 'me', confidence: 1, suggested: false, quote: 'todo: email the bingo team about the demo date' });
    expect(ex.mentions).toEqual([{ entityId: BINGO.entityId, key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', explicit: true, seg: 0, segs: [0] }]);
  });

  it('F8: a one-line imperative is an open action; "Zebra team" is a new team', () => {
    const ex = run('call the Zebra team about invoices', at(2026, 11, 3, 9), [MTCS, BINGO, DANA]);
    expect(ex).toMatchObject({ kind: 'action', title: 'call the Zebra team about invoices' });
    expect(ex.self).toMatchObject({ status: 'open', owner: 'me', confidence: 0.8, suggested: false });
    expect(ex.mentions.map((m) => [m.type, m.name, m.entityId])).toEqual([['team', 'Zebra', undefined]]);
  });

  it('F9: "[x]" is a done action', () => {
    const ex = run('[x] update the Bingo dashboard', at(2026, 11, 4, 9), [MTCS, BINGO, DANA, ZEBRA]);
    expect(ex).toMatchObject({ kind: 'action', title: 'update the Bingo dashboard' });
    expect(ex.self).toMatchObject({ status: 'done', owner: 'me', quote: 'update the Bingo dashboard' });
    expect(names(ex)).toEqual(['Bingo']);
  });

  it('F10: a leading "!" makes a private note', () => {
    const ex = run('! bingo salary thoughts', at(2026, 11, 4, 12), [MTCS, BINGO, DANA, ZEBRA]);
    expect(ex).toMatchObject({ kind: 'note', private: true, text: 'bingo salary thoughts', title: 'bingo salary thoughts', self: null, actions: [] });
    expect(names(ex)).toEqual(['Bingo']);
  });

  it('MTCS is promoted after two distinct items (F4 then F1 with metadata)', () => {
    const candidates = new Map();
    const f4 = extract({ text: 'https://example.com/blog/mtcs-intro', via: 'launcher', hint: { title: 'An intro to MTCS' } }, env(at(2026, 10, 22, 8, 30)));
    expect(entities.bumpCandidates(candidates, f4.candidates, 'iF4', 1).promote).toEqual([]);
    const f1 = extract({ text: 'https://wiki.example.com/mtcs/design-review', via: 'launcher', hint: { title: 'MTCS design review', summary: 'Failover and capacity plan for MTCS.' } }, env(at(2026, 10, 26, 9, 12)));
    expect(entities.bumpCandidates(candidates, f1.candidates, 'iF1', 2).promote).toEqual([{ key: 'mtcs', display: 'MTCS', type: 'term', itemIds: ['iF4', 'iF1'] }]);
  });
});

describe('SPEC §5 S0 normalize', () => {
  const now = at(2026, 11, 6, 10);

  it('detects private markers and strips them from the saved text', () => {
    expect(run('! secret plan', now)).toMatchObject({ private: true, text: 'secret plan' });
    expect(run('salary thoughts #private', now)).toMatchObject({ private: true, text: 'salary thoughts' });
    expect(run('#private', now).mentions).toEqual([]);
    expect(extract({ text: 'plain', via: 'launcher', hint: { private: true } }, env(now)).private).toBe(true);
    expect(run('!important note', now).private).toBe(false);
  });

  it('applies NFC, trims, and caps at 8,000 characters', () => {
    expect(run('  Cafe\u0301 notes \n', now).text).toBe('Café notes');
    const long = run('word '.repeat(2000), now);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(8000);
    expect(extract({ text: 'x'.repeat(50), via: 'launcher' }, env(now, [], { maxText: 10 })).text).toBe('x'.repeat(10));
  });

  it('strips an optional trigger', () => {
    expect(extract({ text: 'mm+ hello there', via: 'launcher' }, env(now, [], { trigger: 'mm' })).text).toBe('hello there');
  });
});

describe('SPEC §5 S2 classify', () => {
  const now = at(2026, 11, 6, 10);

  it('meetings by first line or attendees', () => {
    for (const s of ['1:1 with Dana', 'Weekly standup', 'Retro: sprint 12', 'Interview notes for the role', 'call with Dana tomorrow', 'notes\nattendees: Dana, Robin']) {
      expect(run(s, now).kind, s).toBe('meeting');
    }
    expect(run('call with Dana tomorrow', now).actions).toEqual([]);
  });

  it('"call <someone>" is an action, not a meeting', () => {
    expect(run('call Dana about MTCS', now).kind).toBe('action');
  });

  it('one URL with more than 20 other words is a note with a child link', () => {
    const words = Array.from({ length: 22 }, (_, i) => `word${i}`).join(' ');
    const ex = run(`${words} https://example.com/a`, now);
    expect(ex.kind).toBe('note');
    expect(ex.links).toEqual([{ seg: 0, url: 'https://example.com/a', canonicalUrl: 'example.com/a', isDoc: false }]);
  });

  it('doc URLs and paths', () => {
    expect(run('https://example.com/spec.pdf', now).kind).toBe('doc');
    expect(run('C:\\Users\\Dana\\Plan.DOCX', now)).toMatchObject({ kind: 'doc', path: 'c:\\users\\dana\\plan.docx', title: 'Plan.DOCX' });
    expect(run('file:///Users/dana/a%20b.pdf', now)).toMatchObject({ kind: 'doc', path: '/Users/dana/a b.pdf', title: 'a b.pdf' });
  });

  it('a multi-line capture is never an action itself', () => {
    const ex = run('call Dana\nemail Robin', now);
    expect(ex.kind).toBe('note');
    expect(ex.self).toBeNull();
    // A list of imperative lines is a to-do list: open actions, not suggestions.
    expect(ex.actions.map((a) => [a.title, a.suggested])).toEqual([['call Dana', false], ['email Robin', false]]);
    // One verb line among notes stays a suggestion.
    const mixed = run('Notes from the vendor call\nthey liked the demo\nprices go up in March\nsend them the deck', now);
    expect(mixed.actions.map((a) => [a.title, a.suggested])).toEqual([['send them the deck', true]]);
  });

  it('todos people actually type: need to / gotta / must, to-do lists, "the 1st"', () => {
    for (const [input, title] of [['Need to update the pricing page by EOW', 'update the pricing page'], ['need to call the bank', 'call the bank'],
      ['gotta renew the domain', 'renew the domain'], ['must read the security doc', 'read the security doc']]) {
      const ex = run(input, now);
      expect(ex.kind, input).toBe('action');
      expect(ex.self, input).toMatchObject({ title, status: 'open', suggested: false, confidence: 0.8 });
    }
    expect(run('should I go to the conference', now).kind).toBe('note');
    expect(run('need to call the bank?', now).kind).toBe('note');
    const list = run('Weekly planning\nfinish the budget\nemail Dana the numbers\nbook flights to Berlin', now);
    expect(list.actions.map((a) => [a.title, a.suggested])).toEqual([['finish the budget', false], ['email Dana the numbers', false], ['book flights to Berlin', false]]);
    const inLine = run('Pricing discussion with Sarah: talked about tiers. Need to update the pricing page by EOW', now);
    expect(inLine.actions.map((a) => a.title)).toEqual(['update the pricing page']);
    const rent = run('remind me to pay rent on the 1st', now);
    expect(rent.self).toMatchObject({ title: 'pay rent' });
    expect(new Date(rent.self.dueAt).getDate()).toBe(1);
    expect(rent.self.dueAt).toBeGreaterThan(now);
  });

  it('a note that mentions a coming date is not dated by it (S6)', () => {
    const thu = at(2026, 11, 5, 10);
    for (const input of ['Sarah said the launch moves to Dec 3 because of the security review', 'deadline is Jan 15 for the RFP',
      'The conference is on March 3 in Berlin', 'Offsite planning meeting on Dec 10']) {
      expect(run(input, thu).occurredAt, input).toBeUndefined();
    }
    expect(run('dentist appt thu 3pm', at(2026, 11, 6, 10)).occurredAt).toBeUndefined();
    expect(run('Lunch with Dana on Monday', thu).occurredAt).toBeUndefined();
    expect(run('met Dana on tuesday about hiring', thu).occurredAt).toBe(at(2026, 11, 3));
    expect(run('On Oct 3 we chose the vendor', thu).occurredAt).toBe(at(2026, 10, 3));
  });

  it('the agent can set the kind', () => {
    expect(extract({ text: 'call Dana', via: 'agent', hint: { kind: 'note' } }, env(now)).kind).toBe('note');
    const action = extract({ text: 'call Dana by friday', via: 'agent', hint: { kind: 'action' } }, env(now));
    expect(action.kind).toBe('action');
    expect(action.self).toMatchObject({ title: 'call Dana', origin: 'agent', suggested: true, dueAt: at(2026, 11, 13) });
  });
});

describe('SPEC §5 S3 dedup keys', () => {
  it('AT-4: the noisy F1 URL has F1\'s key, and the note is kept for the annotation', () => {
    const ex = run('https://WWW.wiki.example.com/mtcs/design-review/?utm_source=mail#top note: send to Ravi', at(2026, 11, 6, 10));
    expect(ex.canonicalUrl).toBe('wiki.example.com/mtcs/design-review');
    expect(ex.extra).toBe('note: send to Ravi');
    expect(ex.actions).toEqual([]);
  });
});

describe('SPEC §5 S4 entities', () => {
  const now = at(2026, 11, 6, 10);

  it('links an explicit mention to an existing entity of another type', () => {
    const ex = run('notes from @bingo', now, [BINGO]);
    expect(ex.mentions).toEqual([{ entityId: BINGO.entityId, key: 'bingo', name: 'Bingo', type: 'team', origin: 'rule', explicit: true, seg: 0, segs: [0] }]);
  });

  it('my_names and @me map to the me entity', () => {
    const ex = run('Oren and @me to sync with ON', now, [], { myNames: ['Oren', 'ON'] });
    expect(ex.mentions.map((m) => [m.entityId, m.name])).toEqual([['me', 'Me']]);
    expect(ex.candidates).toEqual([]);
  });

  it('learns aliases and caps entities per item at 24', () => {
    expect(run('The Quarterly Planning Review (QPR) is due', now).aliases).toEqual([
      { long: 'Quarterly Planning Review', longKey: 'quarterly planning review', short: 'QPR', shortKey: 'qpr' },
    ]);
    const tags = Array.from({ length: 30 }, (_, i) => `#tag${String.fromCharCode(97 + (i % 26))}${i}`).join(' ');
    expect(run(tags, now).mentions).toHaveLength(24);
  });
});

describe('SPEC §5 S5 actions', () => {
  const now = at(2026, 11, 6, 10);

  it('single-line imperative + due phrase → open at 0.9 with the due phrase removed from the title', () => {
    const ex = run('call dana about mtcs by friday', now, [DANA, MTCS]);
    expect(ex.self).toMatchObject({ title: 'call dana about mtcs', confidence: 0.9, status: 'open', dueAt: at(2026, 11, 13), suggested: false });
    expect(ex.title).toBe('call dana about mtcs');
  });

  it('markers and commitments', () => {
    expect(run('remind me to renew the passport tomorrow', now).self).toMatchObject({ title: 'renew the passport', confidence: 1, dueAt: at(2026, 11, 7) });
    expect(run('Action: draft the memo', now).self).toMatchObject({ title: 'draft the memo', confidence: 1 });
    expect(run('I need to finish the slides', now).self).toMatchObject({ title: 'finish the slides', confidence: 0.8 });
    expect(run("don't forget to pay rent EOD", now).self).toMatchObject({ title: 'pay rent', dueAt: at(2026, 11, 6) });
    expect(run('Follow up with Robin on pricing', now).self).toMatchObject({ confidence: 0.8 });
  });

  it('"@name will …" is open and owned by that person', () => {
    const ex = run('@robin will send the deck', now);
    expect(ex.kind).toBe('action');
    expect(ex.self).toMatchObject({ status: 'open', suggested: false, owner: { key: 'robin', name: 'Robin' } });
  });

  it('a one-line "<Name> to <verb>" is a note with a suggested action for that person', () => {
    const ex = run('Dana to share the roadmap deck', now, [DANA]);
    expect(ex.kind).toBe('note');
    expect(ex.actions).toEqual([expect.objectContaining({ suggested: true, owner: { key: 'dana', name: 'Dana', entityId: DANA.entityId } })]);
  });

  it('"ask <Name> to …" in a dump stays mine; teams are never owners', () => {
    const ex = run('Planning\nask Dana to review the budget\nBingo will launch soon', now, [BINGO]);
    expect(ex.actions.map((a) => [a.title, a.owner, a.suggested])).toEqual([['ask Dana to review the budget', 'me', true]]);
  });

  it('action context ends at a blank line', () => {
    const ex = run('Retro\nNext steps:\nshare notes\nupdate tickets\n\nGood sprint overall', now);
    expect(ex.actions.map((a) => [a.title, a.confidence])).toEqual([['share notes', 1], ['update tickets', 1]]);
    for (const h of ['Action items:', '## Next steps', 'follow-ups', 'TODOs:', 'AIs']) expect(ACTION_HEADING_RE.test(h), h).toBe(true);
  });

  it('commitments inside a longer note become child actions', () => {
    const ex = run('Lunch with Dana, talked about MTCS hiring. I need to send her the job description.', now);
    expect(ex.kind).toBe('note');
    expect(ex.actions.map((a) => [a.title, a.confidence])).toEqual([['send her the job description', 0.8]]);
  });

  it('"read later <url>" adds a child action pointing at the link', () => {
    const ex = run('https://example.com/article read later', now);
    expect(ex.kind).toBe('link');
    expect(ex.actions).toEqual([expect.objectContaining({ title: 'read later', confidence: 0.8, status: 'open', suggested: false })]);
    expect(run('https://example.com/article great stuff', now).actions).toEqual([]);
  });

  it('auto_accept_inferred opens suggestions', () => {
    const ex = run(F6, at(2026, 10, 30, 16), [MTCS], { autoAccept: true });
    expect(ex.actions.every((a) => !a.suggested)).toBe(true);
  });

  it('caps children at maxChildren (actions first)', () => {
    const dump = ['Plan', ...Array.from({ length: 60 }, (_, i) => `- [ ] task ${i} https://example.com/${i}`)].join('\n');
    const ex = run(dump, now);
    expect(ex.actions.length + ex.links.length).toBe(50);
    expect(ex.actions).toHaveLength(50);
  });

  it('dumps get child links for each URL', () => {
    const ex = run('Reading list\n- https://example.com/a\n- https://example.org/b.pdf\n- https://example.com/a', now);
    expect(ex.links.map((l) => [l.seg, l.canonicalUrl, l.isDoc])).toEqual([[1, 'example.com/a', false], [2, 'example.org/b.pdf', true]]);
  });

  it('exports the imperative verb lexicon', () => {
    for (const v of ['send', 'email', 'call', 'review', 'book', 'renew', 'deploy', 'apply']) expect(IMPERATIVE_VERBS.has(v)).toBe(true);
  });
});

describe('agent capture (AT-11)', () => {
  it('validates quotes, keeps terms and summary, and suggests actions', () => {
    const textIn = 'Design notes. We agreed to Book review with the team next week, then ship.';
    const ex = extract({
      text: textIn,
      via: 'agent',
      hint: {
        summary: 'Design notes and the review plan.',
        terms: ['MTCS', 'mtcs', '  capacity  '],
        actions: [{ text: 'Book review', quote: 'book review  with the TEAM' }, { text: 'Invent', quote: 'not in text' }, { quote: 'x' }],
      },
    }, env(at(2026, 11, 6, 10)));
    expect(ex.summary).toBe('Design notes and the review plan.');
    expect(ex.terms).toEqual(['MTCS', 'capacity']);
    expect(ex.actions).toEqual([expect.objectContaining({ text: 'Book review', title: 'Book review', origin: 'agent', suggested: true, status: 'open', owner: 'me', seg: 0 })]);
    expect(ex.rejectedActions).toEqual([{ text: 'Invent', reason: 'quote_not_found' }, { text: '', reason: 'invalid' }]);
  });

  it('uses the agent title, owner and due date', () => {
    const ex = extract({
      text: 'Robin will send the numbers',
      via: 'agent',
      hint: { title: 'Numbers', actions: [{ text: 'Send the numbers', quote: 'send the numbers', owner: 'Robin', due: '2026-11-20' }] },
    }, env(at(2026, 11, 6, 10)));
    expect(ex).toMatchObject({ title: 'Numbers', titleSource: 'agent' });
    expect(ex.actions[0]).toMatchObject({ owner: { key: 'robin', name: 'Robin' }, dueAt: at(2026, 11, 20), origin: 'agent' });
    expect(ex.mentions).toEqual([expect.objectContaining({ key: 'robin', type: 'person', origin: 'agent', explicit: true })]);
  });
});

describe('SPEC §5 S6 dates', () => {
  const now = at(2026, 11, 6, 10);

  it('a meeting takes its own day; a note only a past day it names', () => {
    expect(run("yesterday's sync with Dana", now).occurredAt).toBe(at(2026, 11, 5));
    expect(run('Retro for last week', now).occurredAt).toBe(at(2026, 10, 26));
    expect(run('Yesterday Dana mentioned the MTCS budget', now).occurredAt).toBe(at(2026, 11, 5));
    expect(run('On Oct 3 we chose the vendor', now).occurredAt).toBe(at(2026, 10, 3));
    expect(run('Dana will send it by Monday', now).occurredAt).toBeUndefined();
    expect(run('thinking about next week', now).occurredAt).toBeUndefined();
    expect(run('Bingo team sync', now).occurredAt).toBeUndefined();
  });
});

describe('properties', () => {
  it('stamps the extractor version', () => {
    expect(run('hello', at(2026, 11, 6)).v).toBe(EXTRACTOR_VERSION);
    expect(EXTRACTOR_VERSION).toBe(1);
  });

  it('is deterministic: the same input twice is deep-equal', () => {
    const now = at(2026, 10, 30, 16);
    for (const input of [F6, 'call dana about mtcs by friday', 'https://example.com/a read later', 'Lunch with Dana, talked about MTCS hiring']) {
      expect(run(input, now, [MTCS])).toEqual(run(input, now, [MTCS]));
    }
  });

  it('is JSON-serializable', () => {
    const ex = run(F6, at(2026, 10, 30, 16), [MTCS]);
    expect(JSON.parse(JSON.stringify(ex))).toEqual(ex);
  });

  it('extracts 4 KB in under 15 ms (soft on slow CI)', () => {
    const block = `${F6}\nhttps://example.com/x Notes with Dana Smith about MTCS and #capacity planning for the Bingo team.\n`;
    const input = block.repeat(Math.ceil(4096 / block.length)).slice(0, 4096);
    const known = [MTCS, BINGO, DANA, ZEBRA, ...Array.from({ length: 500 }, (_, i) => ({ entityId: `e${String(i).padStart(14, '0')}`, type: 'term', names: [`Term${i}`] }))];
    const e = env(at(2026, 10, 30, 16), known);
    extract({ text: input, via: 'launcher' }, e);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) extract({ text: input, via: 'launcher' }, e);
    const ms = (performance.now() - t0) / 5;
    if (ms > 15) console.warn(`extract: 4 KB took ${ms.toFixed(1)} ms (budget 15 ms)`);
    expect(ms).toBeLessThan(150);
  });
});
