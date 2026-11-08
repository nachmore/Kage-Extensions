import { describe, expect, it } from 'vitest';
import * as text from './text.js';
import * as dates from './dates.js';
import * as url from './url.js';
import * as entities from './entities.js';
import { IMPERATIVE_VERBS } from './extract.js';

const lib = { text, dates, url, entities };
const explicit = (s) => entities.explicitMentions(s, lib, { verbs: IMPERATIVE_VERBS }).map((e) => `${e.type}:${e.name}`);
const implicit = (s) => entities.implicitCandidates(s, lib).map((c) => `${c.type}:${c.display}`);

describe('explicitMentions', () => {
  it('#tag → topic, @name → person, @me → me, email → person with alias', () => {
    const found = entities.explicitMentions('#mtcs with @dana and @me, cc dana.smith@example.com', lib);
    expect(found.map((e) => [e.type, e.name, e.key, e.marker])).toEqual([
      ['topic', 'mtcs', 'mtcs', '#'], ['person', 'Dana', 'dana', '@'], ['person', 'Me', 'me', '@'], ['person', 'Dana Smith', 'dana smith', 'email'],
    ]);
    expect(found[2].me).toBe(true);
    expect(found[3].alias).toBe('dana.smith@example.com');
    const s = '#mtcs and @dana';
    for (const e of entities.explicitMentions(s, lib)) expect(s.slice(e.start, e.end)).toMatch(/^[#@]/);
  });

  it('#private is reserved; URL fragments and issue numbers are not tags', () => {
    expect(explicit('#private note')).toEqual([]);
    expect(explicit('see https://example.com/page#top and #123')).toEqual([]);
  });

  it('"<name> team" and "team <Name>" name teams', () => {
    expect(explicit('Bingo team sync')).toEqual(['team:Bingo']);
    expect(explicit('email the bingo team about the demo date')).toEqual(['team:Bingo']);
    expect(explicit('call the Zebra team about invoices')).toEqual(['team:Zebra']);
    expect(explicit('lunch with team Zebra')).toEqual(['team:Zebra']);
    expect(explicit('the growth marketing team')).toEqual(['team:Growth Marketing']);
    expect(explicit('ping bingo team now')).toEqual(['team:Bingo']);
  });

  it('"team meeting", "my team" and "the whole team" name nothing', () => {
    expect(explicit('team meeting at 3')).toEqual([]);
    expect(explicit('Team Meeting notes')).toEqual([]);
    expect(explicit('ask my team')).toEqual([]);
    expect(explicit('the whole team agreed')).toEqual([]);
  });

  it('"project <Name>" and "<name> project" name projects', () => {
    expect(explicit('kickoff for project Atlas')).toEqual(['project:Atlas']);
    expect(explicit('the atlas project')).toEqual(['project:Atlas']);
    expect(explicit('my side project')).toEqual([]);
    expect(explicit('project plan review')).toEqual([]);
  });
});

describe('implicitCandidates', () => {
  it('counts acronyms minus the stoplist; plurals and dots fold', () => {
    expect(implicit('MTCSs and MTCS’s and M.T.C.S. plus OK API PR FYI and Q4')).toEqual(['term:MTCS']);
    expect(entities.implicitCandidates('the MTCSs rollout', lib)[0].key).toBe('mtcs');
  });

  it('finds CamelCase words and capitalized runs that do not start a sentence', () => {
    expect(implicit('Met Dana Smith and Bob Jones about PowerPoint and iPhone')).toEqual([
      'person:Dana Smith', 'term:Bob Jones', 'term:PowerPoint', 'term:iPhone',
    ]);
    expect(implicit('Quarterly Planning is next')).toEqual([]);
  });

  it('types a name as a person after a person cue or before "said"', () => {
    expect(implicit('Lunch with Dana, talked about MTCS hiring')).toEqual(['person:Dana', 'term:MTCS']);
    expect(implicit('Dana said yes')).toEqual(['person:Dana']);
    expect(implicit('ask Robin about it')).toEqual(['person:Robin']);
    expect(implicit('Lunch on Monday')).toEqual([]);
  });

  it('ignores shouting and URLs', () => {
    expect(implicit('PLEASE SEND THE DECK TO BOB NOW')).toEqual([]);
    expect(implicit('https://example.com/MTCS/Design')).toEqual([]);
  });
});

describe('ownerCue', () => {
  it('"<Name> to/will <verb>" and "@x to/will <verb>" at the start of a segment', () => {
    expect(entities.ownerCue('Dana to share the roadmap deck', lib)).toEqual({ name: 'Dana', key: 'dana', start: 0, end: 4, handle: false });
    expect(entities.ownerCue('@dana will send it', lib)).toMatchObject({ name: 'Dana', handle: true });
    expect(entities.ownerCue('TODO: Dana Smith to review', lib)).toMatchObject({ name: 'Dana Smith', key: 'dana smith', start: 6 });
  });

  it('rejects verbs, pronouns, prepositional "to" and mid-sentence names', () => {
    for (const s of ['Remember to call Bob', 'Due to the rain', 'I will book', 'We will see', 'Welcome to Kage', 'Send MTCS numbers to Dana by Friday', 'Talk to Dana', 'Email to Dana']) {
      expect(entities.ownerCue(s, lib, { verbs: IMPERATIVE_VERBS }), s).toBeNull();
    }
  });
});

describe('learnAliases', () => {
  it('learns "Long Form (LF)" and "LF (Long Form)" when the initials match', () => {
    const out = entities.learnAliases('We held the Quarterly Planning Review (QPR). The Department of Motor Vehicles (DMV) too. MTCS (Multi Tenant Capacity Service) works.', lib);
    expect(out.map((a) => [a.long, a.short])).toEqual([
      ['Quarterly Planning Review', 'QPR'], ['Department of Motor Vehicles', 'DMV'], ['Multi Tenant Capacity Service', 'MTCS'],
    ]);
    expect(out[0]).toMatchObject({ longKey: 'quarterly planning review', shortKey: 'qpr' });
  });

  it('ignores parentheses whose initials do not match', () => {
    expect(entities.learnAliases('We met Dana (QPR) today', lib)).toEqual([]);
    expect(entities.learnAliases('see the plan (draft)', lib)).toEqual([]);
  });
});

describe('dictionary', () => {
  const dict = entities.buildDictionary([
    { entityId: 'e1', type: 'team', names: ['Bingo'] },
    { entityId: 'e2', type: 'project', names: ['Bingo launch'] },
    { entityId: 'e3', type: 'term', names: ['MTCS', 'Multi Tenant Capacity Service'] },
    { entityId: 'me', type: 'person', names: ['Alex', 'AL'] },
  ], lib);

  it('takes the longest match at word boundaries, with no overlaps', () => {
    const s = 'review the Bingo launch checklist; bingo MTCSs mtcs’s bingoes on alex';
    const hits = entities.scanDictionary(dict, text.scanWords(s));
    expect(hits.map((h) => [s.slice(h.start, h.end), h.entityId])).toEqual([
      ['Bingo launch', 'e2'], ['bingo', 'e1'], ['MTCSs', 'e3'], ['mtcs’s', 'e3'], ['alex', 'me'],
    ]);
  });

  it('matches aliases and keeps the display name; stop-word aliases never match', () => {
    const hits = entities.scanDictionary(dict, text.scanWords('the multi tenant capacity service is on'));
    expect(hits).toEqual([{ entityId: 'e3', type: 'term', start: 4, end: 33, key: 'mtcs', name: 'MTCS' }]);
  });

  it('looks entities up by key or alias, and extends without mutating', () => {
    expect(entities.lookupKey(dict, 'bingo')).toEqual([{ entityId: 'e1', type: 'team', name: 'Bingo', key: 'bingo' }]);
    expect(entities.lookupKey(dict, 'multi tenant capacity service')[0].entityId).toBe('e3');
    const more = entities.extendDictionary(dict, [{ entityId: 'e9', type: 'person', names: ['Dana'] }], lib);
    expect(entities.scanDictionary(more, text.scanWords('Dana and Bingo')).map((h) => h.entityId)).toEqual(['e9', 'e1']);
    expect(entities.scanDictionary(dict, text.scanWords('Dana and Bingo')).map((h) => h.entityId)).toEqual(['e1']);
  });

  it('an empty dictionary matches nothing', () => {
    expect(entities.scanDictionary(entities.buildDictionary([], lib), text.scanWords('Bingo'))).toEqual([]);
    expect(entities.scanDictionary(null, text.scanWords('Bingo'))).toEqual([]);
  });
});

describe('bumpCandidates', () => {
  const mtcs = [{ key: 'mtcs', display: 'MTCS', type: 'term' }];

  it('promotes on the second distinct item, idempotently per item', () => {
    const map = new Map();
    expect(entities.bumpCandidates(map, mtcs, 'i1', 100).promote).toEqual([]);
    expect(entities.bumpCandidates(map, mtcs, 'i1', 200).promote).toEqual([]);
    expect(map.get('mtcs')).toEqual({ key: 'mtcs', display: 'MTCS', type: 'term', n: 1, firstSeen: 100, sample: ['i1'] });
    const { promote } = entities.bumpCandidates(map, mtcs, 'i2', 300);
    expect(promote).toEqual([{ key: 'mtcs', display: 'MTCS', type: 'term', itemIds: ['i1', 'i2'] }]);
    expect(map.get('mtcs').n).toBe(2);
  });

  it('respects rejections, upgrades to person, caps the sample and sorts promotions', () => {
    const map = new Map();
    expect(entities.bumpCandidates(map, mtcs, 'i1', 1, { rejected: new Set(['mtcs']) })).toEqual({ promote: [] });
    expect(map.size).toBe(0);
    const found = [{ key: 'zed', display: 'Zed', type: 'term' }, { key: 'dana', display: 'Dana', type: 'term' }, { key: 'dana', display: 'Dana', type: 'person' }];
    for (let i = 0; i < 7; i++) entities.bumpCandidates(map, found, `i${i}`, i);
    expect(map.get('dana').type).toBe('person');
    expect(map.get('dana').sample).toHaveLength(5);
    expect(entities.bumpCandidates(map, found, 'i9', 9, { threshold: 3 }).promote.map((p) => p.key)).toEqual(['dana', 'zed']);
  });
});

describe('parseNameList', () => {
  it('splits, trims and dedupes', () => {
    expect(entities.parseNameList('Alex, AL, alex@example.com, ,al;@Alex\nA. L.')).toEqual(['Alex', 'AL', 'alex@example.com', 'A. L.']);
    expect(entities.parseNameList('')).toEqual([]);
    expect(entities.parseNameList(undefined)).toEqual([]);
  });

  it('exports the team stop words', () => {
    for (const w of ['the', 'my', 'our', 'whole', 'entire', 'which', 'what']) expect(entities.TEAM_STOP.has(w)).toBe(true);
  });
});
