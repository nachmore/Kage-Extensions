// The words for a document the user added from a file (lib/filetext.js,
// Kage EXTENSION_FILE_TEXT §11.9), through the EN catalog.
import { describe, expect, it } from 'vitest';
import { makeI18n } from '../../../test-helpers/mindmap/corpus.mjs';
import { fileErrorText, fileLines, fileSize } from './filetext.js';

const { t } = makeI18n();
const FILE = { name: 'Q3 plan.pdf', format: 'pdf', pages: { count: 12, read: 12 }, chars: 48211, truncated: false, warnings: [] };
const result = (extra = {}) => ({ ok: true, case: 'new', itemId: 'i000000000000aa', title: 'Q3 plan', addedAt: Date.UTC(2026, 9, 26, 12), file: FILE, private: false, secret: false, keptLocal: false, ...extra });

describe('fileSize', () => {
  it('counts characters, and pages when there are any', () => {
    expect(fileSize(FILE, { t })).toBe('12 pages, 48,211 characters');
    expect(fileSize({ ...FILE, pages: null, chars: 1 }, { t })).toBe('1 character');
    expect(fileSize({ ...FILE, pages: { count: 1, read: 1 } }, { t, locale: 'de' })).toBe('1 page, 48.211 characters');
  });
});

describe('fileLines', () => {
  it('new and updated docs: the headline and what was found', () => {
    expect(fileLines(result({ found: { people: 3, teams: 0, projects: 2, topics: 0, actions: 4 } }), { t })).toEqual([
      'Added Q3 plan.pdf: 12 pages, 48,211 characters.',
      'Found 3 people, 2 projects, and 4 suggested actions.',
    ]);
    expect(fileLines(result({ case: 'update', found: { people: 1, teams: 1, projects: 0, topics: 1, actions: 0 } }), { t })).toEqual([
      'Updated Q3 plan.pdf: 12 pages, 48,211 characters.',
      'Found 1 person, 1 team, and 1 topic.',
    ]);
    // Nothing found: no second line.
    expect(fileLines(result({ found: { people: 0, teams: 0, projects: 0, topics: 0, actions: 0 } }), { t })).toHaveLength(1);
  });

  it('notes: kept part, no text, pages skipped, a possible secret', () => {
    const long = fileLines(result({ file: { ...FILE, chars: 200000, truncated: true, warnings: ['pages_skipped'], pages: { count: 2500, read: 2000 } } }), { t });
    expect(long.slice(1)).toEqual(['Kept the first 200,000 characters.', 'Read the first 2,000 pages.']);
    // No text wins over "kept the first".
    expect(fileLines(result({ file: { ...FILE, chars: 0, truncated: true, warnings: ['no_text'] } }), { t }).slice(1)).toEqual(['No text found. It may be a scanned PDF. Saved the file name only.']);
    const secret = fileLines(result({ private: true, secret: true }), { t });
    expect(secret[1]).toBe('This file looks like it contains a password or key, so it’s private: your agent never sees it.');
    expect(fileLines(result({ private: true, secret: true, keptLocal: true }), { t })[1]).toMatch(/never sees it\. It stays on this computer\.$/);
    // Made shareable since: no secret note.
    expect(fileLines(result({ private: false, secret: true }), { t })).toHaveLength(1);
  });

  it('nothing written: same, copy and unchanged', () => {
    const now = Date.UTC(2026, 10, 9, 12);
    expect(fileLines(result({ case: 'same' }), { t, now })).toEqual(['Already in your mind map (added Mon, Oct 26)']);
    expect(fileLines(result({ case: 'same' }), { t, now, fmtDay: () => 'yesterday' })).toEqual(['Already in your mind map (added yesterday)']);
    expect(fileLines(result({ case: 'copy' }), { t })).toEqual(['Already saved as “Q3 plan”']);
    expect(fileLines(result({ case: 'unchanged' }), { t })).toEqual(['“Q3 plan” hasn’t changed since you added it.']);
    expect(fileLines({ case: 'new' }, { t })).toEqual([]);
  });
});

describe('fileErrorText', () => {
  it('Kage’s own message, with a hint for files that are too large', () => {
    expect(fileErrorText({ ok: false, code: 'host', message: 'Q3 plan.pdf is password-protected.', key: 'errors.file_text.encrypted' }, { t })).toBe('Q3 plan.pdf is password-protected.');
    expect(fileErrorText({ ok: false, code: 'host', message: 'Q3 plan.pdf is 48.2 MB.', key: 'errors.file_text.too_large' }, { t }))
      .toBe('Q3 plan.pdf is 48.2 MB. Try a smaller copy, or save part of it as a PDF.');
    expect(fileErrorText({ ok: false, code: 'host', message: '' }, { t })).toBe(t('err.generic'));
  });

  it('Mind Map’s own reasons; nothing for a cancelled dialog', () => {
    expect(fileErrorText({ ok: false, code: 'cancelled' }, { t })).toBe('');
    expect(fileErrorText({ ok: false, code: 'storage_full' }, { t })).toBe('Mind Map’s document storage is full (64 MB). Delete some documents first.');
    expect(fileErrorText({ ok: false, code: 'bad_file' }, { t })).toBe(t('files.error.bad_result'));
    expect(fileErrorText({ ok: false, code: 'unavailable' }, { t })).toBe(t('files.error.unavailable'));
    expect(fileErrorText({ ok: false, code: 'readonly' }, { t })).toBe(t('err.readonly'));
    expect(fileErrorText({ ok: false, code: 'mystery' }, { t })).toBe(t('err.generic'));
  });
});
