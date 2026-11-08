import { afterEach, describe, expect, it } from 'vitest';
import {
  ACRONYM_STOPLIST, STOPWORDS, _setSegmenterForTests, cleanWindowTitle, collapseWs, containsQuote, escapeHtml, escapeMd,
  firstLine, normalizeKey, rake, scanWords, snippet, splitLines, splitSentences, stem, tokenize, truncate,
} from './text.js';

afterEach(() => _setSegmenterForTests(undefined));

describe('normalizeKey', () => {
  it('folds dotted acronyms, accents, case, possessives and punctuation', () => {
    expect(normalizeKey('M.T.C.S.')).toBe('mtcs');
    expect(normalizeKey('Café')).toBe('cafe');
    expect(normalizeKey('  Bingo   Team ')).toBe('bingo team');
    expect(normalizeKey('MTCS’s')).toBe('mtcs');
    expect(normalizeKey('design-review')).toBe('design review');
    expect(normalizeKey('R&D')).toBe('rd');
    expect(normalizeKey('Ünïcödé Ñame')).toBe('unicode name');
  });
});

describe('scanWords', () => {
  it('reports raw, norm, offsets, caps and acronym shape', () => {
    const words = scanWords('Send MTCS numbers to Dana');
    expect(words.map((w) => w.raw)).toEqual(['Send', 'MTCS', 'numbers', 'to', 'Dana']);
    expect(words[1]).toEqual({ raw: 'MTCS', norm: 'mtcs', start: 5, end: 9, caps: true, acronym: true });
    expect(words[2].caps).toBe(false);
    expect(words[4].acronym).toBe(false);
  });

  it('keeps dotted acronyms, numbers and contractions together; splits file names and filters', () => {
    const raws = scanWords("M.T.C.S. notes.pdf kind:doc,link 3.5 don't node.js").map((w) => w.raw);
    expect(raws).toEqual(['M.T.C.S', 'notes', 'pdf', 'kind', 'doc', 'link', '3.5', "don't", 'node', 'js']);
  });

  it('gives the same words without Intl.Segmenter for ASCII text', () => {
    const sample = "Bingo team sync - [ ] Send MTCS numbers to Dana by Friday. I'll book the offsite (M.T.C.S. v1.2, kind:doc) e-mail foo_bar 2026-10-26";
    const withSegmenter = scanWords(sample);
    _setSegmenterForTests(null);
    const fallback = scanWords(sample);
    expect(fallback).toEqual(withSegmenter);
    expect(tokenize(sample)).toEqual(tokenize(sample));
  });

  it('uses the Segmenter for scripts without spaces', () => {
    const words = scanWords('東京都に住む');
    expect(words.length).toBeGreaterThan(1);
  });
});

describe('stem and tokenize', () => {
  it('applies the light s-stemmer', () => {
    expect(stem('actions')).toBe('action');
    expect(stem('status')).toBe('status');
    expect(stem('docs')).toBe('docs');
    expect(stem('policies')).toBe('policy');
    // Light -ing / -ed / four-letter -es, with the same stem on both sides.
    for (const [a, b] of [['onboarding', 'onboard'], ['onboarded', 'onboard'], ['owes', 'owe'], ['planning', 'plan'], ['planned', 'plan'],
      ['saving', 'save'], ['saved', 'save'], ['updated', 'update'], ['meetings', 'meeting'], ['added', 'add'], ['hiring', 'hire']]) {
      expect(stem(a), a).toBe(stem(b));
    }
    for (const w of ['string', 'spring', 'need', 'speed', 'docs', 'thing']) expect(stem(w), w).toBe(w);
    expect(stem('boxes')).toBe('box');
    expect(stem('classes')).toBe('class');
    expect(stem('matches')).toBe('match');
    expect(stem('houses')).toBe('house');
    expect(stem('analysis')).toBe('analysis');
    expect(stem('famous')).toBe('famous');
    expect(stem('2026s')).toBe('2026s');
  });

  it('folds acronym plurals and possessives', () => {
    expect(tokenize('MTCSs MTCS’s mtcs')).toEqual(['mtcs', 'mtcs', 'mtcs']);
    expect(tokenize("Dana's IDs")).toEqual(['dana', 'id']);
    expect(tokenize('M.T.C.S. rollout')).toEqual(['mtcs', 'rollout']);
  });

  it('drops stop words on request and can skip stemming', () => {
    expect(tokenize('the actions for the team', { stop: true })).toEqual(['action', 'team']);
    expect(tokenize('the actions', { stemming: false })).toEqual(['the', 'actions']);
  });

  it('exports the English lexicons', () => {
    expect(STOPWORDS.has('the')).toBe(true);
    for (const a of ['OK', 'TODO', 'FYI', 'ASAP', 'URL', 'PDF', 'API', 'PR', 'EOD', 'Q4', 'H1', 'US', 'HR', 'CEO', 'AI']) {
      expect(ACRONYM_STOPLIST.has(a), a).toBe(true);
    }
    expect(ACRONYM_STOPLIST.has('MTCS')).toBe(false);
  });
});

describe('splitLines and splitSentences', () => {
  it('recognizes bullets and checkboxes and keeps text offsets', () => {
    const src = 'Bingo team sync\n- [ ] Send numbers\n* item\n• dot\n1. first\n  [x] done\n\nAction items:';
    const lines = splitLines(src);
    expect(lines.map((l) => [l.text, l.bullet])).toEqual([
      ['Bingo team sync', null], ['Send numbers', 'box'], ['item', 'star'], ['dot', 'dot'], ['first', 'num'],
      ['done', 'boxdone'], ['', null], ['Action items:', null],
    ]);
    for (const l of lines) expect(src.slice(l.start, l.start + l.text.length)).toBe(l.text);
    expect(lines[5].indent).toBe(2);
  });

  it('does not treat hyphenated words or dates as bullets', () => {
    expect(splitLines('-term and 2026-10-26 notes')[0].bullet).toBeNull();
    expect(splitLines('3.5 million')[0].bullet).toBeNull();
  });

  it('splits sentences, sparing abbreviations and dotted acronyms', () => {
    const s = 'Met Dr. Smith about M.T.C.S. today. Next: I will send it! Done? yes';
    expect(splitSentences(s).map((x) => x.text)).toEqual(['Met Dr. Smith about M.T.C.S. today.', 'Next: I will send it!', 'Done? yes']);
    for (const x of splitSentences(s)) expect(s.slice(x.start, x.end)).toBe(x.text);
  });
});

describe('rake', () => {
  it('scores phrases by degree / frequency × idf and keeps the top N deterministically', () => {
    const out = rake('MTCS capacity plan and failover. The MTCS capacity plan is ready.', { max: 3 });
    expect(out[0].phrase).toBe('mtcs capacity plan');
    expect(out.map((x) => x.phrase)).toContain('failover');
    expect(rake('MTCS capacity plan and failover. The MTCS capacity plan is ready.', { max: 3 })).toEqual(out);
  });

  it('lets corpus idf lift rare tokens', () => {
    const idf = (t) => (t === 'mtcs' ? 5 : 1);
    const out = rake('weekly update about mtcs and the weekly plan', { idf });
    expect(out[0].phrase).toBe('mtcs');
  });

  it('splits long stop-word-free runs into short phrases', () => {
    const out = rake('alpha beta gamma delta epsilon zeta', { max: 5 });
    expect(out.every((x) => x.phrase.split(' ').length <= 4)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('snippet', () => {
  const long = `${'lorem ipsum '.repeat(30)}the MTCS capacity review happened here ${'dolor sit '.repeat(30)}`;

  it('centres the window on the first stemmed-term hit, with ellipses', () => {
    const s = snippet(long, ['mtcs'], { max: 60 });
    expect(s).toContain('MTCS');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(62);
    const at = s.indexOf('MTCS');
    expect(at).toBeGreaterThan(10);
    expect(at).toBeLessThan(s.length - 10);
  });

  it('accepts QuerySpec terms, including a prefix term', () => {
    expect(snippet(long, [{ t: 'capac', prefix: true }], { max: 60 })).toContain('capacity');
    expect(snippet(long, [{ t: 'review', w: 1 }], { max: 60 })).toContain('review');
  });

  it('falls back to the start, and returns short text whole', () => {
    expect(snippet(long, ['absent'], { max: 40 }).startsWith('lorem')).toBe(true);
    expect(snippet('short   text\nhere', ['x'])).toBe('short text here');
  });
});

describe('small helpers', () => {
  it('firstLine, truncate and collapseWs', () => {
    expect(firstLine('\n\n  Bingo   team sync \n- next')).toBe('Bingo team sync');
    expect(firstLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('😀😀😀😀', 3)).toBe('😀😀…');
    expect(collapseWs(' a \n\t b ')).toBe('a b');
  });

  it('containsQuote ignores whitespace, case and quote style', () => {
    const text = 'Notes:\nWe should   Book the review\nwith the team’s leads.';
    expect(containsQuote(text, 'book the review with the team')).toBe(true);
    expect(containsQuote(text, "team's leads")).toBe(true);
    expect(containsQuote(text, 'not in text')).toBe(false);
    expect(containsQuote(text, '   ')).toBe(false);
  });

  it('escapeHtml and escapeMd neutralize markup', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const md = escapeMd('*b* _i_ [l](u) # h <tag>');
    expect(md).toBe('\\*b\\* \\_i\\_ \\[l\\]\\(u\\) \\# h tag');
    expect(md).not.toMatch(/[<>]/);
  });
});

describe('cleanWindowTitle', () => {
  it('strips app suffixes and editing markers', () => {
    expect(cleanWindowTitle('MTCS rollout plan.docx - Word', 'Microsoft Word')).toBe('MTCS rollout plan.docx');
    expect(cleanWindowTitle('Capacity plan — Google Docs - Google Chrome', 'Google Chrome')).toBe('Capacity plan');
    expect(cleanWindowTitle('Roadmap and 3 more pages - Personal - Microsoft​ Edge', 'Microsoft Edge')).toBe('Roadmap');
    expect(cleanWindowTitle('Report — Edited', 'Pages')).toBe('Report');
    expect(cleanWindowTitle('● notes.md - project - Visual Studio Code', 'Code')).toBe('notes.md - project');
    expect(cleanWindowTitle('Budget.xlsx [Compatibility Mode] - Excel', 'Microsoft Excel')).toBe('Budget.xlsx');
  });

  it('returns empty when only the app name is left', () => {
    expect(cleanWindowTitle('Microsoft Word', 'Microsoft Word')).toBe('');
    expect(cleanWindowTitle('', 'Microsoft Word')).toBe('');
    expect(cleanWindowTitle('Safari', 'Safari')).toBe('');
  });

  it('only strips ambiguous short names when the app matches', () => {
    expect(cleanWindowTitle('Q3 - Numbers', 'Microsoft Word')).toBe('Q3 - Numbers');
    expect(cleanWindowTitle('Q3 - Numbers', 'Numbers')).toBe('Q3');
    expect(cleanWindowTitle('Report - Work - Word', 'Microsoft Word')).toBe('Report - Work');
  });
});
