/**
 * A fake of Kage's file_text host API for the Mind Map tests, coded against
 * Kage's docs/design/EXTENSION_FILE_TEXT.md (the host side is built in
 * parallel; nothing here is copied from it):
 *
 *   - FILE_FEATURES: what a Kage with the API puts in context.hostFeatures
 *     (§3.3; such hosts always have atomic writes, §11.4).
 *   - fileText(text, overrides): a `pick_file_text` result in the §3.6 shape
 *     (snake_case, `chars` in Unicode scalar values, a fake sha256 and
 *     file_ref derived from the text and a seed, never a path).
 *   - installFiles(context): `context.files` (§3.4) over a queue of picks.
 *     Each queued pick is a FileText, null (the user cancelled or chose "Not
 *     now") or an Error to throw (use hostError for Kage's error shape).
 *   - hostError(key, message): an Error carrying `kind` and `key` the way the
 *     sandbox runtime builds them (host-api.js invokeError).
 */

import { vi } from 'vitest';

export const FILE_FEATURES = Object.freeze(['storage.atomic_write', 'files.pick_text']);

/** file_text_support (§3.5) for a host that reads the P0 formats. */
export const SUPPORT = Object.freeze({
  formats: Object.freeze([
    { id: 'text', extensions: ['txt', 'text', 'log', 'csv', 'tsv'] },
    { id: 'markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
    { id: 'pdf', extensions: ['pdf'] },
    { id: 'docx', extensions: ['docx'] },
  ]),
  max_input_bytes: 33554432,
  max_chars: 1000000,
  default_max_chars: 100000,
});

const scalars = (s) => Array.from(String(s)).length;

// FNV-1a over the string, stretched to `length` lowercase hex characters.
function hexOf(seed, length) {
  let out = '';
  for (let round = 0; out.length < length; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

/** A stable fake sha256 (64 lowercase hex) for `text`. */
export const fakeSha = (text) => hexOf(`sha:${text}`, 64);

/** A stable fake file_ref ("fr1_" + 22 base64url characters) for `seed`. */
export function fakeRef(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const hex = hexOf(`ref:${seed}`, 44);
  let out = '';
  for (let i = 0; i < 22; i++) out += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 64];
  return `fr1_${out}`;
}

/**
 * A pick_file_text result for `text`. overrides may set any §3.6 field;
 * `ref` (a seed for file_ref) and `pageCount` are shortcuts.
 */
export function fileText(text, { ref = 'A', pageCount, ...overrides } = {}) {
  const value = {
    name: 'Q3 plan.pdf',
    extension: 'pdf',
    format: 'pdf',
    size: 48211,
    modified_at: Date.UTC(2026, 9, 26, 9, 0),
    title: null,
    text,
    chars: scalars(text),
    truncated: false,
    total_chars: scalars(text),
    pages: null,
    page_starts: null,
    warnings: [],
    sha256: fakeSha(text),
    file_ref: fakeRef(ref),
  };
  if (Number.isInteger(pageCount) && pageCount > 0) {
    value.pages = { count: pageCount, read: pageCount };
    const step = Math.floor(value.chars / pageCount);
    value.page_starts = Array.from({ length: pageCount }, (_, i) => i * step);
  }
  return { ...value, ...overrides };
}

/** An Error the way the sandbox runtime builds it from a host refusal. */
export function hostError(key, message = 'Kage could not read the file.', kind = 'invalid_input') {
  const error = new Error(message);
  error.kind = kind;
  error.key = key;
  return error;
}

/**
 * Adds `context.files` to a sandbox context. Pass FILE_FEATURES (or your
 * own list) to makeContext's hostFeatures as well: Mind Map only uses
 * context.files when the host feature says it may.
 * → { files, calls, queue(...picks), picks }
 */
export function installFiles(context, { support = SUPPORT } = {}) {
  const picks = [];
  const calls = [];
  context.files = {
    support: vi.fn(async () => structuredClone(support)),
    pickText: vi.fn(async (args = {}) => {
      const { signal, ...rest } = args;
      calls.push({ ...rest, signal: !!signal });
      const next = picks.shift();
      if (next instanceof Error) throw next;
      return next == null ? null : structuredClone(next);
    }),
  };
  return { files: context.files, calls, picks, queue: (...items) => picks.push(...items) };
}
