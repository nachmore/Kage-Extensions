import { afterEach, describe, expect, it } from 'vitest';
import * as text from './text.js';
import { FILE_LIMITS, FILE_REF_RE, GENERIC_TITLE_RE, addRef, bodyKeyphrases, dedupeDecision, docTitle, findPassages, validateFileText } from './files.js';

const lib = { text };
const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const SHA2 = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752';
const REF = 'fr1_AbCdEfGhIjKlMnOpQrStUv';
const REF2 = 'fr1_0123456789abcdefghij_-';
const ref = (n) => `fr1_${String(n).padStart(22, 'x')}`;
const BODY = 'Q3 launch plan\n\nShip the beta to the Bingo team.';
const BODY_CHARS = 48;

// What pick_file_text returns (Kage EXTENSION_FILE_TEXT §3.6); `chars`
// follows `text` unless given.
function hostResult(over = {}) {
  const out = {
    name: 'Q3 plan.pdf', extension: 'pdf', format: 'pdf', size: 48211, modified_at: 1793000000000,
    title: 'Q3 launch plan', text: BODY, truncated: false,
    pages: { count: 2, read: 2 }, page_starts: [0, 16], warnings: [], sha256: SHA, file_ref: REF, ...over,
  };
  if ('text' in over && !('page_starts' in over)) out.page_starts = [0];
  if (!('chars' in over)) out.chars = typeof out.text === 'string' ? [...out.text].length : 0;
  if (!('total_chars' in over)) out.total_chars = out.chars;
  return out;
}
const validated = (over) => validateFileText(hostResult(over)).file;
const doc = (id, file, refs) => ({ id, kind: 'doc', title: id, file, ...(refs ? { fileRefs: refs } : {}) });

describe('validateFileText', () => {
  it('accepts a host result and maps it to camelCase, dropping unknown fields', () => {
    const result = validateFileText(hostResult({ path: '/home/someone/Q3 plan.pdf', extra: 1 }), { maxChars: 200000, formats: ['text', 'markdown', 'pdf', 'docx'] });
    expect(result).toEqual({
      ok: true,
      file: {
        name: 'Q3 plan.pdf', ext: 'pdf', format: 'pdf', size: 48211, modifiedAt: 1793000000000, title: 'Q3 launch plan',
        text: BODY, chars: BODY_CHARS, truncated: false, totalChars: BODY_CHARS, pages: { count: 2, read: 2 }, pageStarts: [0, 16],
        warnings: [], sha256: SHA, fileRef: REF,
      },
    });
    expect(JSON.stringify(result)).not.toContain('/home/');
  });

  it('omits the optional fields the host left out', () => {
    const { file } = validateFileText(hostResult({ modified_at: null, title: null, total_chars: undefined, pages: null, page_starts: null, extension: 'md', format: 'markdown', name: 'notes.md' }));
    expect(Object.keys(file)).toEqual(['name', 'ext', 'format', 'size', 'text', 'chars', 'truncated', 'warnings', 'sha256', 'fileRef']);
  });

  it.each([
    ['name', 42, 'bad_name'], ['name', '   ', 'bad_name'], ['extension', '.pdf', 'bad_ext'], ['extension', 'PDF', 'bad_ext'],
    ['format', 'PDF', 'bad_format'], ['format', 3, 'bad_format'], ['size', -1, 'bad_size'], ['size', 1.5, 'bad_size'],
    ['size', '10', 'bad_size'], ['modified_at', 'yesterday', 'bad_modified'], ['modified_at', 1.5, 'bad_modified'],
    ['title', 7, 'bad_title'], ['text', null, 'bad_text'], ['chars', '48', 'bad_chars'], ['truncated', 'no', 'bad_truncated'],
    ['total_chars', -1, 'bad_total'], ['total_chars', 3, 'bad_total'], ['pages', [2, 2], 'bad_pages'],
    ['pages', { count: 1, read: 2 }, 'bad_pages'], ['pages', { count: 2 }, 'bad_pages'], ['warnings', undefined, 'bad_warnings'],
    ['warnings', 'no_text', 'bad_warnings'], ['warnings', [1], 'bad_warnings'], ['warnings', ['No Text'], 'bad_warnings'],
    ['sha256', undefined, 'bad_hash'], ['file_ref', undefined, 'bad_ref'],
  ])('rejects %s = %j (%s)', (field, value, code) => {
    expect(validateFileText(hostResult({ [field]: value }))).toEqual({ ok: false, code });
  });

  it('rejects what is not an object', () => {
    for (const value of [null, undefined, 'text', 42, [hostResult()]]) expect(validateFileText(value)).toEqual({ ok: false, code: 'not_object' });
  });

  it('rejects oversized names, titles, text and files', () => {
    expect(validateFileText(hostResult({ name: `${'n'.repeat(251)}.pdf` })).ok).toBe(true);
    expect(validateFileText(hostResult({ name: `${'n'.repeat(252)}.pdf` })).code).toBe('bad_name');
    // 255 scalar values, more UTF-16 units.
    expect(validateFileText(hostResult({ name: `${'😀'.repeat(251)}.pdf` })).ok).toBe(true);
    expect(validateFileText(hostResult({ title: 't'.repeat(200) })).ok).toBe(true);
    expect(validateFileText(hostResult({ title: 't'.repeat(201) })).code).toBe('bad_title');
    const long = 'word '.repeat(2000);
    expect(validateFileText(hostResult({ text: long }), { maxChars: 10000 }).ok).toBe(true);
    expect(validateFileText(hostResult({ text: long }), { maxChars: 9999 }).code).toBe('too_long');
    expect(validateFileText(hostResult({ text: 'x'.repeat(30) }), { maxChars: 10 }).code).toBe('too_long');
    expect(validateFileText(hostResult({ size: FILE_LIMITS.maxInputBytes })).ok).toBe(true);
    expect(validateFileText(hostResult({ size: FILE_LIMITS.maxInputBytes + 1 })).code).toBe('bad_size');
    expect(validateFileText(hostResult({ size: 2048 }), { maxBytes: 1024 }).code).toBe('bad_size');
    // Without maxChars the host's ceiling applies.
    expect(validateFileText(hostResult({ text: 'x', chars: 1 }), { maxChars: 0 }).ok).toBe(true);
  });

  it('counts scalar values, not UTF-16 units, and refuses lone surrogates', () => {
    expect(validateFileText(hostResult({ text: 'a😀b' })).file.chars).toBe(3);
    expect(validateFileText(hostResult({ text: 'a😀b', chars: 4, total_chars: 4 })).code).toBe('bad_chars');
    expect(validateFileText(hostResult({ text: 'ab', chars: 3, total_chars: 3 })).code).toBe('bad_chars');
    expect(validateFileText(hostResult({ text: 'a\ud800b', chars: 3, total_chars: 3 })).code).toBe('bad_text');
    expect(validateFileText(hostResult({ text: 'a\udc00', chars: 2, total_chars: 2 })).code).toBe('bad_text');
    expect(validateFileText(hostResult({ title: 'x\ud83d' })).code).toBe('bad_title');
  });

  it('wants sha256 as 64 hex digits and keeps it lowercase', () => {
    expect(validateFileText(hostResult({ sha256: SHA.slice(1) })).code).toBe('bad_hash');
    expect(validateFileText(hostResult({ sha256: `${SHA}0` })).code).toBe('bad_hash');
    expect(validateFileText(hostResult({ sha256: `g${SHA.slice(1)}` })).code).toBe('bad_hash');
    expect(validateFileText(hostResult({ sha256: SHA.toUpperCase() })).file.sha256).toBe(SHA);
  });

  it('wants file_ref as fr1_ plus 22 base64url characters', () => {
    for (const bad of ['fr2_AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKlMnOpQrStUvWx', `${REF}w`, REF.slice(0, -1), 'fr1_AbCdEfGhIjKlMnOpQrSt+/', 'fr1_AbCdEfGhIjKlMnOpQrSt==', ` ${REF}`]) {
      expect(validateFileText(hostResult({ file_ref: bad })).code, bad).toBe('bad_ref');
    }
    expect(validateFileText(hostResult({ file_ref: REF2 })).file.fileRef).toBe(REF2);
    expect(FILE_REF_RE.test(REF)).toBe(true);
  });

  it('refuses a path or a control character in place of a file name', () => {
    for (const name of ['/home/someone/Q3 plan.pdf', 'docs/Q3 plan.pdf', 'C:\\Users\\someone\\Q3 plan.pdf', '\\\\server\\share\\a.pdf', 'Q3\nplan.pdf', 'Q3\u2028plan.pdf', 'Q3\u0000.pdf', '.', '..']) {
      expect(validateFileText(hostResult({ name })).code, name).toBe('bad_name');
    }
    // A Linux file name may hold a backslash.
    expect(validateFileText(hostResult({ name: 'a\\b.pdf' })).ok).toBe(true);
  });

  it('checks the format against what was asked, and accepts a format this code does not know yet', () => {
    expect(validateFileText(hostResult(), { formats: ['text', 'markdown'] }).code).toBe('bad_format');
    expect(validateFileText(hostResult({ format: 'odt', extension: 'odt', name: 'plan.odt', pages: null, page_starts: null })).file.format).toBe('odt');
    expect(validateFileText(hostResult({ format: 'odt' }), { formats: ['text', 'pdf'] }).code).toBe('bad_format');
  });

  it('checks page starts against the pages read and the text, and converts them to string offsets', () => {
    expect(validateFileText(hostResult({ pages: null })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: [16, 0] })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: [0, BODY_CHARS + 1] })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: [0, 1, 2] })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: [0, 1.5] })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: 'all' })).code).toBe('bad_page_starts');
    expect(validateFileText(hostResult({ page_starts: [0, 0] })).file.pageStarts).toEqual([0, 0]);
    expect(validateFileText(hostResult({ page_starts: [0, BODY_CHARS] })).ok).toBe(true);
    // Host offsets count scalar values; JS strings count UTF-16 units.
    const t = '😀😀 one\n\nPage 😀 two\n\nthree';
    const { file } = validateFileText(hostResult({ text: t, pages: { count: 3, read: 3 }, page_starts: [0, 8, 20] }));
    expect(file.pageStarts).toEqual([0, 10, 23]);
    expect(t.slice(file.pageStarts[1]).startsWith('Page')).toBe(true);
    expect(t.slice(file.pageStarts[2])).toBe('three');
  });

  it('keeps each warning once, including ones newer than this code', () => {
    const { file } = validateFileText(hostResult({ warnings: ['no_text', 'possible_secret', 'no_text', 'ocr_used'] }));
    expect(file.warnings).toEqual(['no_text', 'possible_secret', 'ocr_used']);
    expect(validateFileText(hostResult({ warnings: Array(33).fill('no_text') })).code).toBe('bad_warnings');
  });

  it('is deterministic and leaves its input alone', () => {
    const raw = hostResult();
    const copy = JSON.parse(JSON.stringify(raw));
    expect(validateFileText(raw)).toEqual(validateFileText(raw));
    expect(raw).toEqual(copy);
  });
});

describe('dedupeDecision', () => {
  const file = validated();
  const changedFile = validated({ sha256: SHA2 });

  it('S: this file_ref and this sha256 → same, no write', () => {
    const items = [doc('i000000000000a1', { sha256: SHA, chars: BODY_CHARS }, [REF2, REF])];
    expect(dedupeDecision(items, file)).toEqual({ case: 'same', itemId: 'i000000000000a1' });
  });

  it('U: this file_ref and another sha256 → update', () => {
    const items = [doc('i000000000000a1', { sha256: SHA, chars: BODY_CHARS }, [REF])];
    expect(dedupeDecision(items, changedFile)).toEqual({ case: 'update', itemId: 'i000000000000a1' });
  });

  it('C: only the sha256 matches (another computer, a copy) → copy', () => {
    const items = [doc('i000000000000a1', { sha256: SHA.toUpperCase(), chars: BODY_CHARS }, [REF2]), doc('i000000000000a2', { sha256: SHA, chars: BODY_CHARS })];
    expect(dedupeDecision(items, file)).toEqual({ case: 'copy', itemId: 'i000000000000a1' });
  });

  it('N: nothing matches → new', () => {
    expect(dedupeDecision([doc('i000000000000a1', { sha256: SHA2 }, [REF2])], file)).toEqual({ case: 'new' });
    expect(dedupeDecision([], file)).toEqual({ case: 'new' });
    expect(dedupeDecision(null, file)).toEqual({ case: 'new' });
  });

  it('first match wins: S before U before C', () => {
    const copyOnly = doc('i000000000000a1', { sha256: SHA });
    const same = doc('i000000000000b1', { sha256: SHA }, [REF]);
    const moved = doc('i000000000000c1', { sha256: SHA2 }, [REF]);
    expect(dedupeDecision([copyOnly, moved, same], file)).toEqual({ case: 'same', itemId: same.id });
    expect(dedupeDecision([copyOnly, moved], file)).toEqual({ case: 'update', itemId: moved.id });
  });

  it('picks the oldest of equal matches, whatever the order', () => {
    const a = doc('i000000000000a1', { sha256: SHA });
    const b = doc('i000000000000b1', { sha256: SHA });
    expect(dedupeDecision([b, a], file).itemId).toBe(a.id);
    expect(dedupeDecision([a, b], file).itemId).toBe(a.id);
  });

  it('takes a Map of items and skips records that are not docs', () => {
    const items = new Map([
      ['i000000000000a1', { id: 'i000000000000a1', kind: 'note', text: SHA }],
      ['i000000000000a2', { id: 'i000000000000a2', kind: 'doc', file: 'broken', fileRefs: 'fr1_' }],
      ['bad', null],
      ['i000000000000a3', doc('i000000000000a3', { sha256: SHA }, [REF])],
    ]);
    expect(dedupeDecision(items, file)).toEqual({ case: 'same', itemId: 'i000000000000a3' });
  });

  describe('Update from file…', () => {
    const target = doc('i000000000000t1', { sha256: SHA, chars: BODY_CHARS, truncated: false }, [REF]);

    it('re-reads the target when the content changed', () => {
      expect(dedupeDecision([target], changedFile, { targetId: target.id })).toEqual({ case: 'update', itemId: target.id });
    });

    it('re-reads the same content when more of it is kept now', () => {
      const short = doc('i000000000000t1', { sha256: SHA, chars: 20, truncated: true }, [REF]);
      expect(dedupeDecision([short], file, { targetId: short.id })).toEqual({ case: 'update', itemId: short.id });
    });

    it('does nothing for an identical read, or only adds the file_ref', () => {
      expect(dedupeDecision([target], file, { targetId: target.id })).toEqual({ case: 'same', itemId: target.id });
      const elsewhere = validated({ file_ref: REF2 });
      expect(dedupeDecision([target], elsewhere, { targetId: target.id })).toEqual({ case: 'copy', itemId: target.id });
    });

    it('follows the user even when another doc holds this file', () => {
      const other = doc('i000000000000a1', { sha256: SHA2, chars: BODY_CHARS }, [REF]);
      expect(dedupeDecision([other, target], changedFile, { targetId: target.id })).toEqual({ case: 'update', itemId: target.id });
    });

    it('falls back to the usual rules when the target is gone', () => {
      expect(dedupeDecision([target], changedFile, { targetId: 'i000000000000zz' })).toEqual({ case: 'update', itemId: target.id });
      expect(dedupeDecision([], file, { targetId: 'i000000000000zz' })).toEqual({ case: 'new' });
    });
  });
});

describe('addRef', () => {
  it('adds the newest last and moves a known ref to the end', () => {
    expect(addRef([], REF)).toEqual([REF]);
    expect(addRef(undefined, REF)).toEqual([REF]);
    expect(addRef([REF, REF2], REF)).toEqual([REF2, REF]);
    expect(addRef([REF2, REF], REF)).toEqual([REF2, REF]);
  });

  it('keeps at most 8, dropping the oldest', () => {
    const refs = [1, 2, 3, 4, 5, 6, 7, 8].map(ref);
    const out = addRef(refs, ref(9));
    expect(out).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(ref));
    expect(out).toHaveLength(FILE_LIMITS.refs);
    expect(addRef(refs, ref(9), 3)).toEqual([7, 8, 9].map(ref));
  });

  it('drops invalid and repeated refs, never changes its input, and ignores an invalid new ref', () => {
    const refs = [REF, 'junk', REF, 42, REF2];
    const before = [...refs];
    expect(addRef(refs, 'fr1_short')).toEqual([REF, REF2]);
    expect(refs).toEqual(before);
    expect(addRef(refs, REF2)).not.toBe(refs);
  });
});

describe('docTitle', () => {
  const title = (name, t) => docTitle({ name, ext: name.split('.').pop(), title: t }, lib);

  it('uses a usable document title', () => {
    expect(title('Q3 plan.pdf', 'Q3 launch plan')).toEqual({ title: 'Q3 launch plan', titleSource: 'meta' });
    expect(title('q3.pdf', '  Q3   launch\nplan ')).toEqual({ title: 'Q3 launch plan', titleSource: 'meta' });
  });

  it('falls back to the file name without its extension', () => {
    expect(title('Q3 plan.pdf', undefined)).toEqual({ title: 'Q3 plan', titleSource: 'auto' });
    expect(title('Q3 plan.pdf', '')).toEqual({ title: 'Q3 plan', titleSource: 'auto' });
    expect(title('v1.2 notes.md', null)).toEqual({ title: 'v1.2 notes', titleSource: 'auto' });
    expect(docTitle({ name: 'README', ext: 'txt' }, lib)).toEqual({ title: 'README', titleSource: 'auto' });
    expect(docTitle({ name: '.md', ext: 'md' }, lib)).toEqual({ title: '.md', titleSource: 'auto' });
  });

  it('skips a title that is just the file name', () => {
    expect(title('Q3 plan.pdf', 'Q3 plan.pdf').titleSource).toBe('auto');
    expect(title('Q3 plan.pdf', 'q3 PLAN').titleSource).toBe('auto');
    expect(title('Q3 plan.pdf', 'Microsoft Word - Q3 plan.docx')).toEqual({ title: 'Q3 plan', titleSource: 'auto' });
    expect(title('Q3 plan.pdf', 'Microsoft Word - Budget review')).toEqual({ title: 'Budget review', titleSource: 'meta' });
    expect(title('deck.pdf', 'Microsoft PowerPoint - Deck review')).toEqual({ title: 'Deck review', titleSource: 'meta' });
  });

  it('skips app defaults, other file names and paths', () => {
    for (const t of ['Untitled', 'untitled document', 'Untitled-1', 'Document1', 'Document 2', 'Word Document', 'Presentation1', 'PowerPoint Presentation', 'Slide 1', 'Title', 'Book1', 'N/A', '---']) {
      expect(GENERIC_TITLE_RE.test(t) || !/[\p{L}\p{N}]/u.test(t), t).toBe(true);
      expect(title('Q3 plan.pdf', t), t).toEqual({ title: 'Q3 plan', titleSource: 'auto' });
    }
    for (const t of ['report-final.docx', 'C:\\Users\\someone\\Documents\\report.doc', '/home/someone/report', '~/report', 'file:///tmp/a', 'a\\b']) {
      expect(title('Q3 plan.pdf', t).titleSource, t).toBe('auto');
    }
    expect(title('Q3 plan.pdf', 'Presentation skills for new leads').titleSource).toBe('meta');
  });

  it('caps the title at 120 characters', () => {
    const long = 'Quarterly '.repeat(20);
    const out = title('q.pdf', long);
    expect(out.titleSource).toBe('meta');
    expect([...out.title].length).toBeLessThanOrEqual(120);
    expect(out.title.endsWith('\u2026')).toBe(true);
    expect([...docTitle({ name: `${'n'.repeat(200)}.txt`, ext: 'txt' }, lib).title].length).toBe(120);
  });
});

describe('bodyKeyphrases', () => {
  afterEach(() => text._setSegmenterForTests(undefined));

  it('ranks terms by frequency, ties by first appearance, without stop words, numbers or single letters', () => {
    const body = 'The roadmap and the budget. Budget review for 2026: budget, roadmap, a b c 42 3.5 review zebra';
    expect(bodyKeyphrases(body, lib)).toEqual(['budget', 'roadmap', 'review', 'zebra']);
  });

  it('counts heading terms double', () => {
    expect(bodyKeyphrases('# Launch\nbudget\nbudget', lib)).toEqual(['launch', 'budget']);
    expect(bodyKeyphrases('# Launch\nbudget\nbudget\nbudget', lib)).toEqual(['budget', 'launch']);
    expect(bodyKeyphrases('### Launch\n## Launch', lib)).toEqual(['launch']);
  });

  it('treats #tags as text and skips the structure lines Kage writes', () => {
    expect(bodyKeyphrases('#zebra notes\nbudget\nbudget', lib)).toEqual(['budget', 'zebra', 'notes']);
    expect(bodyKeyphrases('## Slide 3\nNotes:\nbudget\n## Slide 4\nslide deck', lib)).toEqual(['budget', 'slide', 'deck']);
  });

  it('returns forms that tokenize back to their own term', () => {
    const body = 'composed browsing choosing MTCSs MTCS’s mtcs meetings Meeting Dana’s café Café naïve M.T.C.S';
    const out = bodyKeyphrases(body, lib);
    expect(out).toContain('composed');
    expect(out).toContain('mtcs');
    expect(out).toContain('cafe');
    expect(out.filter((k) => k === 'mtcs')).toHaveLength(1);
    for (const k of out) expect(text.tokenize(k), k).toHaveLength(1);
    const terms = out.map((k) => text.tokenize(k)[0]);
    expect(new Set(terms).size).toBe(terms.length);
    expect(new Set(terms)).toEqual(new Set(text.tokenize(body, { stop: true }).filter((t) => t.length > 1)));
  });

  it('keeps at most max, and nothing for no text', () => {
    const body = Array.from({ length: 100 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ');
    expect(bodyKeyphrases(body, lib)).toHaveLength(FILE_LIMITS.keyphrases);
    expect(bodyKeyphrases(body, lib, { max: 5 })).toHaveLength(5);
    expect(bodyKeyphrases('', lib)).toEqual([]);
    expect(bodyKeyphrases(null, lib)).toEqual([]);
    expect(bodyKeyphrases('the and of', lib)).toEqual([]);
  });

  it('is deterministic, with or without Intl.Segmenter', () => {
    const body = '# Bingo launch\nDana to share the roadmap deck.\n- review the Bingo launch checklist\nBudget, budget, roadmap.';
    const first = bodyKeyphrases(body, lib);
    expect(bodyKeyphrases(body, lib)).toEqual(first);
    text._setSegmenterForTests(null);
    expect(bodyKeyphrases(body, lib)).toEqual(first);
  });

  it('reads 200,000 characters quickly (soft budget: 60 ms)', () => {
    const words = ['launch', 'planning', 'Dana', 'roadmap', 'the', 'budget', 'review', 'checklist', 'customers', 'analysis'];
    let body = '';
    for (let i = 0; body.length < 200000; i++) body += words[(i * 7) % words.length] + (i % 11 ? ' ' : (i % 77 ? '.\n' : '\n# Section heading\n'));
    bodyKeyphrases(body, lib);
    const t0 = performance.now();
    const out = bodyKeyphrases(body, lib);
    const ms = performance.now() - t0;
    if (ms > 60) console.warn(`files: keyphrases for 200,000 chars took ${ms.toFixed(1)} ms (budget 60 ms)`);
    expect(out.length).toBeGreaterThan(5);
  });
});

describe('findPassages', () => {
  const filler = (n, seed = 0) => Array.from({ length: n }, (_, i) => ['alpha', 'river', 'stone', 'garden', 'window', 'silver'][(i + seed) % 6]).join(' ');

  it('returns a passage around a term, cut at spaces, with ellipses, within the length', () => {
    const body = `${filler(200)} the MTCS numbers are due ${filler(200, 3)}`;
    const [p, ...rest] = findPassages(body, ['mtcs'], lib);
    expect(rest).toEqual([]);
    expect(p.text).toContain('MTCS numbers');
    expect(p.text.startsWith('\u2026') && p.text.endsWith('\u2026')).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(400);
    expect(p.text.length).toBeGreaterThan(300);
    expect(body.slice(p.start, p.end).replace(/\s+/g, ' ').trim()).toBe(p.text.slice(1, -1));
    expect(/\s/.test(body[p.start - 1]) && /\s/.test(body[p.end])).toBe(true);
    const short = findPassages(body, ['mtcs'], lib, { max: 1, chars: 160 });
    expect(short[0].text.length).toBeLessThanOrEqual(160);
    expect(short[0].text).toContain('MTCS');
  });

  it('shows a short text whole, without ellipses', () => {
    expect(findPassages('Send the  MTCS\nnumbers', ['mtcs'], lib)).toEqual([{ text: 'Send the MTCS numbers', start: 0, end: 22 }]);
  });

  it('prefers the passage where more of the terms meet, then more hits', () => {
    const body = `${filler(150)} budget budget budget ${filler(150, 1)} the budget for zebra ${filler(150, 2)}`;
    const [best, next] = findPassages(body, ['budget', 'zebra'], lib);
    expect(best.text).toContain('budget for zebra');
    expect(next.text).toContain('budget budget budget');
    expect(next.start).toBeLessThan(best.start);
  });

  it('returns up to max passages, best first, never overlapping', () => {
    const body = Array.from({ length: 6 }, (_, i) => `${filler(120, i)} roadmap ${i % 2 ? 'zebra' : ''}`).join(' ');
    const out = findPassages(body, ['roadmap', 'zebra'], lib);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.text.includes('zebra'))).toEqual([true, true, true]);
    const sorted = [...out].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    expect(findPassages(body, ['roadmap'], lib, { max: 10 }).length).toBe(6);
    expect(findPassages(body, ['roadmap'], lib, { max: 0 })).toEqual([]);
  });

  it('trims a passage to meet a neighbour instead of dropping it', () => {
    // Too far apart for one 120-character passage, close enough that their
    // context would overlap: 'roadmap' at 200, 'zebra' at 314.
    const body = `${'q '.repeat(100)}roadmap ${'q '.repeat(53)}zebra ${'q '.repeat(100)}`;
    const out = findPassages(body, ['roadmap', 'zebra'], lib, { chars: 120 });
    expect(out).toHaveLength(2);
    const [a, b] = out;
    expect(a.text).toContain('roadmap');
    expect(b.text).toContain('zebra');
    expect(b.text).not.toContain('roadmap');
    expect([a.start, a.end, b.start, b.end]).toEqual([146, 261, 261, 375]);
  });

  it('takes QuerySpec terms: prefixes match, negated terms are ignored', () => {
    const body = `${filler(80)} the roadmapping session ${filler(80, 2)} zebra crossing ${filler(80, 4)}`;
    expect(findPassages(body, [{ t: 'roadm', prefix: true }], lib)[0].text).toContain('roadmapping');
    expect(findPassages(body, [{ t: 'roadm' }], lib)).toEqual([]);
    expect(findPassages(body, [{ t: 'zebra', neg: true }], lib)).toEqual([]);
    expect(findPassages(body, [{ t: 'zebra', neg: true }, { t: 'session', w: 1, raw: 'session' }], lib)[0].text).toContain('session');
  });

  it('matches every spelling the index folds to a term', () => {
    const forms = ['Café', 'naïve', 'M.T.C.S.', 'MTCSs', 'Dana’s', "O'Neill", 'meetings', 'companies', 'İstanbul', 'ΟΔΟΣ', 'e.g.', '3.5', 'v1.2', 'node.js', 'choosing', 'browsing', 'ﬁnance', 'Ｑ３', 'Straße'];
    // Filler with no words, so even a one-letter prefix has one match.
    const blank = '\u2014 '.repeat(300);
    for (const form of forms) {
      const body = `${blank}${form} ${blank}`;
      const terms = text.tokenize(form);
      expect(terms.length, form).toBeGreaterThan(0);
      for (const t of terms) {
        expect(findPassages(body, [t], lib).length, `${form} → ${t}`).toBe(1);
        for (let k = 1; k <= t.length; k++) expect(findPassages(body, [{ t: t.slice(0, k), prefix: true }], lib).length, `${form} → ${t.slice(0, k)}*`).toBe(1);
      }
    }
  });

  it('finds what a full scan finds (the block test never hides a hit)', () => {
    const vocab = ['plan', 'planning', 'planned', 'Plans', 'café', 'cafe', 'MTCS', 'M.T.C.S', 'Dana’s', 'zebra', 'budgets', 'it’s', 'naïve'];
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    // Hits at least 60 characters apart, over several 4,096-character blocks.
    let body = '';
    while (body.length < 14000) body += `${vocab[Math.floor(rand() * vocab.length)]}${rand() < 0.2 ? '\n' : ' '}${filler(10 + Math.floor(rand() * 20), Math.floor(rand() * 6))} `;
    const words = text.scanWords(body);
    for (const t of ['plan', 'cafe', 'mtcs', 'dana', 'zebra', 'budget', 'naive']) {
      const hits = words.filter((w) => text.wordTerm(w) === t || w.norm === t);
      expect(hits.length, t).toBeGreaterThan(0);
      // Equal scores go by position, so the passages are the first hits.
      const out = findPassages(body, [t], lib, { max: 10, chars: 40 });
      expect(out.length, t).toBe(Math.min(10, hits.length));
      out.forEach((p, i) => expect(p.start <= hits[i].start && hits[i].end <= p.end, `${t} #${i}`).toBe(true));
    }
  });

  it('finds nothing without terms, text or a match', () => {
    expect(findPassages('', ['mtcs'], lib)).toEqual([]);
    expect(findPassages(null, ['mtcs'], lib)).toEqual([]);
    expect(findPassages('MTCS', [], lib)).toEqual([]);
    expect(findPassages('MTCS', null, lib)).toEqual([]);
    expect(findPassages('MTCS', [{ t: '' }, 42, null], lib)).toEqual([]);
    expect(findPassages(filler(500), ['zebra'], lib)).toEqual([]);
  });

  it('labels passages with their page', () => {
    const pages = [`${filler(100)} intro`, `${filler(100, 1)} the MTCS budget`, `${filler(100, 2)} zebra`];
    const body = pages.join('\n\n');
    const pageStarts = [0, pages[0].length + 2, pages[0].length + pages[1].length + 4];
    const out = findPassages(body, ['mtcs', 'zebra'], lib, { pageStarts, chars: 120 });
    expect(out.map((p) => [p.page, /MTCS|zebra/.exec(p.text)[0]]).sort()).toEqual([[2, 'MTCS'], [3, 'zebra']]);
    expect(findPassages(body, ['mtcs'], lib)[0].page).toBeUndefined();
  });

  it('never splits a surrogate pair and stays within the length', () => {
    const body = `${'😀'.repeat(300)} MTCS ${'😀'.repeat(300)}`;
    const [p] = findPassages(body, ['mtcs'], lib, { chars: 100 });
    expect(p.text.length).toBeLessThanOrEqual(100);
    expect(p.text).toContain('MTCS');
    expect(p.text.isWellFormed()).toBe(true);
    const run = `${'😀'.repeat(5000)}MTCS`;
    for (const q of findPassages(`${run} ${run}`, ['mtcs'], lib)) expect(q.text.isWellFormed()).toBe(true);
  });

  it('is deterministic', () => {
    const body = `${filler(300)} budget zebra ${filler(300, 1)} budget ${filler(300, 2)} zebra`;
    expect(findPassages(body, ['budget', 'zebra'], lib)).toEqual(findPassages(body, ['budget', 'zebra'], lib));
  });

  it('searches 1,000,000 characters quickly for a rare term (soft budget: 50 ms)', () => {
    let body = filler(170000);
    body = `${body.slice(0, 700000)} the MTCS zebra ${body.slice(700000)}`;
    findPassages(body, ['mtcs'], lib);
    const t0 = performance.now();
    const out = findPassages(body, ['mtcs', 'zebra'], lib);
    const ms = performance.now() - t0;
    if (ms > 50) console.warn(`files: passages in 1,000,000 chars took ${ms.toFixed(1)} ms (budget 50 ms)`);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('MTCS zebra');
  });
});
