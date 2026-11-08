import { describe, expect, it } from 'vitest';
import * as text from './text.js';
import * as dates from './dates.js';
import * as entities from './entities.js';
import { COMMANDS, FILLER, KIND_WORDS, STATUS_WORDS, parseQuery, toSyntax } from './query.js';

const lib = { text, dates, entities };
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const KNOWN = [
  { entityId: 'e00000000000mtc', type: 'term', names: ['MTCS'] },
  { entityId: 'e0000000000bngo', type: 'team', names: ['Bingo'] },
  { entityId: 'e0000000000dana', type: 'person', names: ['Dana'] },
  { entityId: 'e000000000zebra', type: 'team', names: ['Zebra'] },
  { entityId: 'e0000000000atls', type: 'project', names: ['Atlas'] },
];
const ID = Object.fromEntries(KNOWN.map((e) => [e.names[0].toLowerCase(), e.entityId]));
const dict = entities.buildDictionary(KNOWN, lib);
// Mind's resolver: by key or alias, any type (the hint is only a preference).
const resolveEntity = (phrase) => {
  const hit = entities.lookupKey(dict, text.normalizeKey(phrase))[0];
  return hit ? { entityId: hit.entityId, name: hit.name, type: hit.type } : null;
};
const ENV = () => ({ lib, now: at(2026, 11, 6, 10), weekStart: 1, resolveEntity, dict });
const parse = (input, extra = {}) => parseQuery(input, { ...ENV(), ...extra });
const terms = (spec) => spec.terms.map((t) => t.t);
const span = (r) => [dates.toIsoDay(r.start), dates.toIsoDay(r.end)];

describe('owner acceptance queries', () => {
  it('AT-1: "remind me which doc spoke about mtcs last week"', () => {
    const spec = parse('remind me which doc spoke about mtcs last week');
    expect(spec).toMatchObject({ command: null, intent: 'find', kinds: ['doc', 'link'], kindBoost: 'doc', status: null, owner: null, unresolved: [] });
    expect(spec.range.start).toBe(at(2026, 10, 26));
    expect(spec.range.end).toBe(at(2026, 11, 2));
    expect(spec.range.field).toBe('any');
    expect(spec.terms).toEqual([{ t: 'mtcs', w: 1, raw: 'mtcs' }]);
    expect(spec.entities.filter((e) => e.hard)).toEqual([]);
    expect(spec.syntax).toBe('kind:doc,link when:2026-10-26..2026-11-01 mtcs');
    expect(spec.chips.map((c) => c.type)).toEqual(['kinds', 'range', 'terms']);
  });

  it('AT-1-agent: the tool query without "remind me" parses the same scope', () => {
    const spec = parse('which doc spoke about mtcs last week', { trailingSpace: true });
    expect(spec.kinds).toEqual(['doc', 'link']);
    expect([dates.toIsoDay(spec.range.start), dates.toIsoDay(spec.range.end)]).toEqual(['2026-10-26', '2026-11-02']);
    expect(terms(spec)).toEqual(['mtcs']);
  });

  it('AT-1b: "yesterday" is Thu 2026-11-05', () => {
    const spec = parse('which doc spoke about mtcs yesterday');
    expect(span(spec.range)).toEqual(['2026-11-05', '2026-11-06']);
    expect(spec.range.granularity).toBe('day');
    expect(terms(spec)).toEqual(['mtcs']);
    expect(spec.syntax).toBe('kind:doc,link when:2026-11-05 mtcs');
  });

  it('AT-2: "what were my actions for the bingo team"', () => {
    const spec = parse('what were my actions for the bingo team');
    expect(spec).toMatchObject({ intent: 'actions', owner: 'me', status: 'open', kinds: null, range: null, terms: [], unresolved: [] });
    expect(spec.entities).toEqual([{ entityId: ID.bingo, hard: true, via: 'phrase', name: 'Bingo', type: 'team' }]);
    expect(spec.syntax).toBe('actions @bingo');
    expect(spec.chips).toEqual([
      { type: 'owner', value: 'me' }, { type: 'entity', value: ID.bingo }, { type: 'status', value: 'open' },
    ]);
    // "Show everyone's actions" appends owner:anyone to the same query.
    const everyone = parse(`${spec.syntax} owner:anyone`);
    expect(everyone).toMatchObject({ command: 'actions', intent: 'actions', owner: 'anyone', status: 'open' });
    expect(everyone.syntax).toBe('actions @bingo owner:anyone');
  });

  it('AT-2-agent: the tool path asks for the same entity', () => {
    expect(parse('actions @bingo').entities.map((e) => [e.entityId, e.hard])).toEqual([[ID.bingo, true]]);
  });

  it('AT-2b: an unknown team is unresolved and its word is searched', () => {
    const spec = parse('what were my actions for the walrus team');
    expect(spec).toMatchObject({ intent: 'actions', owner: 'me', entities: [], unresolved: [{ phrase: 'walrus', type: 'team' }] });
    expect(terms(spec)).toEqual(['walrus']);
    expect(spec.chips.map((c) => c.type)).toEqual(['owner', 'unresolved', 'status', 'terms']);
  });

  it('AT-5: "bingo salary" keeps both words and boosts Bingo softly', () => {
    const spec = parse('bingo salary', { trailingSpace: true });
    expect(spec.intent).toBe('find');
    expect(terms(spec)).toEqual(['bingo', 'salary']);
    expect(spec.entities).toEqual([{ entityId: ID.bingo, hard: false, via: 'dict', name: 'Bingo', type: 'team' }]);
  });
});

describe('filter syntax', () => {
  it('kind:, when:, due:, @, #, is:, owner:, "phrase" and -term', () => {
    const spec = parse('kind:note,docs when:last-week @dana #mtcs is:done owner:anyone "exact phrase" -draft rollout ', {});
    expect(spec.kinds).toEqual(['doc', 'note']);
    expect(span(spec.range)).toEqual(['2026-10-26', '2026-11-02']);
    expect(spec.entities.map((e) => [e.entityId, e.hard, e.via])).toEqual([[ID.dana, true, 'marker'], [ID.mtcs, true, 'marker']]);
    expect(spec).toMatchObject({ status: 'done', owner: 'anyone', phrases: ['exact phrase'], intent: 'actions' });
    expect(spec.terms).toEqual([
      { t: 'draft', w: 1, neg: true, raw: 'draft' },
      { t: 'rollout', w: 1, raw: 'rollout' },
      { t: 'exact', w: 1, raw: 'exact', phrase: true },
      { t: 'phrase', w: 1, raw: 'phrase', phrase: true },
    ]);
  });

  it('when: accepts ISO ranges and open ends; due: makes a due range', () => {
    expect(span(parse('when:2026-10-26..2026-11-01 mtcs').range)).toEqual(['2026-10-26', '2026-11-02']);
    expect(parse('when:..2026-10-25').range.start).toBe(0);
    const due = parse('due:this-week');
    expect(due).toMatchObject({ intent: 'actions', range: { field: 'due' } });
    expect(span(due.range)).toEqual(['2026-11-02', '2026-11-09']);
  });

  it('is:private and #private ask for private items only', () => {
    expect(parse('is:private bingo')).toMatchObject({ privateOnly: true, includePrivate: true });
    expect(parse('#private')).toMatchObject({ privateOnly: true });
  });

  it('unknown @names stay searchable', () => {
    const spec = parse('@walrus ', {});
    expect(spec.unresolved).toEqual([{ phrase: 'walrus', type: null }]);
    expect(terms(spec)).toEqual(['walrus']);
  });

  it('works in any UI language: filters are not English words', () => {
    const spec = parse('kind:doc when:2026-10-26 @bingo réunion ');
    expect(spec).toMatchObject({ kinds: ['doc'] });
    expect(terms(spec)).toEqual(['reunion']);
  });
});

describe('round trip', () => {
  const queries = [
    'remind me which doc spoke about mtcs last week', 'what were my actions for the bingo team', 'what were my actions for the walrus team',
    'kind:doc,link when:2026-10-26..2026-11-01 mtcs', 'actions @bingo owner:anyone', '"exact phrase" -draft notes', 'what is due this week',
    'is:done owner:dana', 'docs about mtcs before oct 26', 'mtcs recently', 'map bingo', 'is:private', 'meetings with dana in october',
    'Dana\'s actions', 'overdue', 'bingo', 'notes since monday', 'atlas project docs',
  ];
  it.each(queries)('toSyntax(parseQuery(%j)) is stable', (q) => {
    const first = parse(q, { trailingSpace: true });
    const again = parse(first.syntax, { trailingSpace: true });
    expect(again.syntax).toBe(first.syntax);
    expect(again.intent).toBe(first.intent);
    expect(again.kinds).toEqual(first.kinds);
    expect(again.owner).toBe(first.owner);
    expect(again.status).toBe(first.status);
    expect(again.entities.filter((e) => e.hard).map((e) => e.entityId)).toEqual(first.entities.filter((e) => e.hard).map((e) => e.entityId));
  });

  it('toSyntax uses nameOf for entities and owners', () => {
    const spec = { intent: 'actions', command: null, kinds: null, range: null, entities: [{ entityId: 'e1', hard: true }], owner: 'e2', status: 'done', terms: [], phrases: [] };
    expect(toSyntax(spec, { nameOf: (id) => ({ e1: 'Bingo Launch', e2: 'Dana Smith' })[id], lib })).toBe('actions @bingo-launch owner:dana-smith is:done');
  });
});

describe('natural language', () => {
  it('the last word matches by prefix while typing', () => {
    expect(parse('mtc').terms).toEqual([{ t: 'mtc', w: 1, raw: 'mtc', prefix: true }]);
    expect(parse('mtc ').terms).toEqual([{ t: 'mtc', w: 1, raw: 'mtc' }]);
    expect(parse('mtcs last week').terms[0].prefix).toBeUndefined();
    expect(parse('roll', { trailingSpace: false }).terms[0].prefix).toBe(true);
  });

  it('commands take the first token; the rest are args', () => {
    expect(parse('review')).toMatchObject({ command: 'review', intent: 'command', args: '' });
    expect(parse('undo')).toMatchObject({ command: 'undo', intent: 'command' });
    expect(parse('help')).toMatchObject({ command: 'help' });
    expect(parse('recent')).toMatchObject({ command: 'recent' });
    expect(parse('todos @bingo')).toMatchObject({ command: 'actions', intent: 'actions', owner: 'me', status: 'open' });
    expect(parse('tasks')).toMatchObject({ command: 'actions' });
    const map = parse('map bingo');
    expect(map).toMatchObject({ command: 'map', intent: 'command', args: 'bingo' });
    expect(map.entities[0].entityId).toBe(ID.bingo);
    expect(parse('rename @bingo Bingo Squad').args).toBe('@bingo Bingo Squad');
    expect(Object.keys(COMMANDS)).toEqual(expect.arrayContaining(['map', 'actions', 'todos', 'tasks', 'review', 'recent', 'undo', 'help', 'organize', 'merge', 'forget', 'rename']));
  });

  it('empty input is home', () => {
    expect(parse('').intent).toBe('home');
    expect(parse('   ').intent).toBe('home');
  });

  it('kind words', () => {
    expect(parse('slides about mtcs ').kinds).toEqual(['doc', 'link']);
    expect(parse('articles about pricing ').kinds).toEqual(['link']);
    expect(parse('ideas about pricing ')).toMatchObject({ kinds: ['note'], kindBoost: null });
    expect(parse('1:1s with dana ').kinds).toEqual(['meeting']);
    expect(parse('my action items ').intent).toBe('actions');
    expect(parse('to-dos ').intent).toBe('actions');
  });

  it('status words apply to actions; elsewhere they stay words', () => {
    expect(parse('my done tasks ')).toMatchObject({ intent: 'actions', status: 'done' });
    expect(parse('my finished actions ')).toMatchObject({ status: 'done' });
    expect(parse('pending actions ')).toMatchObject({ status: 'open' });
    expect(parse('what is overdue ')).toMatchObject({ intent: 'actions', status: 'overdue' });
    expect(parse('suggested actions ')).toMatchObject({ status: 'suggested' });
    expect(terms(parse('done deal notes '))).toEqual(['done', 'deal']);
  });

  it('assignees: my, <Name>\'s, assigned to <Name>, for <Name>', () => {
    expect(parse("Dana's actions ")).toMatchObject({ intent: 'actions', owner: ID.dana });
    expect(parse('actions assigned to dana ')).toMatchObject({ owner: ID.dana });
    expect(parse('actions for Dana ')).toMatchObject({ owner: ID.dana });
    expect(parse('actions for me ')).toMatchObject({ owner: 'me' });
    const unknown = parse('actions assigned to robin ');
    expect(unknown.unresolved).toEqual([{ phrase: 'robin', type: 'person' }]);
    // Outside the actions intent a person becomes a hard entity, not an owner.
    expect(parse("Dana's notes ")).toMatchObject({ owner: null, intent: 'find', entities: [expect.objectContaining({ entityId: ID.dana, hard: true })] });
  });

  it('"X team" / "X project" phrases are hard filters, with or without a preposition', () => {
    expect(parse('docs from the zebra team ').entities).toEqual([{ entityId: ID.zebra, hard: true, via: 'phrase', name: 'Zebra', type: 'team' }]);
    expect(parse('atlas project docs ').entities[0]).toMatchObject({ entityId: ID.atlas, hard: true });
    expect(parse('bingo team ')).toMatchObject({ intent: 'entity', terms: [] });
    expect(parse('actions for bingo ').entities).toEqual([expect.objectContaining({ entityId: ID.bingo, hard: true })]);
  });

  it('"due" before a time phrase makes it a due range and the actions intent', () => {
    const week = parse('what is due this week');
    expect(week).toMatchObject({ intent: 'actions', range: { field: 'due', granularity: 'week' } });
    expect(span(week.range)).toEqual(['2026-11-02', '2026-11-09']);
    // A weekday after "due" is future-biased, but asked on that weekday it
    // means today ("todos due friday" on a Friday).
    expect(span(parse('actions due friday').range)).toEqual(['2026-11-06', '2026-11-07']);
    expect(span(parse('actions due monday').range)).toEqual(['2026-11-09', '2026-11-10']);
    const by = parse('actions due by friday');
    expect(by.range.start).toBe(0);
    expect(by.range.end).toBe(at(2026, 11, 7));
    // Due phrases the range grammar doesn't read.
    expect(span(parse("what's due tomorrow").range)).toEqual(['2026-11-07', '2026-11-08']);
    expect(parse("what's due tomorrow")).toMatchObject({ intent: 'actions', range: { field: 'due' } });
    expect(span(parse('actions due eow').range)).toEqual(['2026-11-06', '2026-11-07']);
    expect(parse('what is due').range).toBeNull();
  });

  it('"recently" is a recency boost, not a range', () => {
    expect(parse('mtcs recently')).toMatchObject({ recency: true, range: null });
  });

  it('an exact entity name is the entity intent', () => {
    expect(parse('bingo')).toMatchObject({ intent: 'entity', terms: [], entities: [expect.objectContaining({ entityId: ID.bingo, hard: true })] });
    expect(parse('@bingo')).toMatchObject({ intent: 'entity' });
    expect(parse('#mtcs')).toMatchObject({ intent: 'entity', syntax: '@mtcs' });
    expect(parse('bingo salary').intent).toBe('find');
  });

  it('filler words never become terms', () => {
    expect(terms(parse('can you please show me what was mentioned about the roadmap '))).toEqual(['roadmap']);
    expect(terms(parse('find notes related to capacity planning '))).toEqual(['capacity', 'plan']);
    // Saving verbs and generic nouns are filler too.
    expect(terms(parse('what did I save yesterday '))).toEqual([]);
    expect(terms(parse('stuff and things I added about the roadmap '))).toEqual(['roadmap']);
  });

  it('exports the English lexicons', () => {
    expect(KIND_WORDS.doc).toContain('spreadsheet');
    expect(STATUS_WORDS.overdue).toContain('late');
    expect(FILLER).toContain('spoke about');
  });

  it('works without a resolver or a dictionary', () => {
    const spec = parseQuery('what were my actions for the bingo team', { lib, now: at(2026, 11, 6, 10), weekStart: 1 });
    expect(spec).toMatchObject({ intent: 'actions', unresolved: [{ phrase: 'bingo', type: 'team' }] });
    expect(terms(spec)).toEqual(['bingo']);
  });
});
