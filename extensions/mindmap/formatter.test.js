// @vitest-environment jsdom
// The message-formatter wrapper (formatter.js). The rendering itself is
// view.formatHtml's job (view.test.js); this pins the wrapper's contract:
// skip streaming, return null fast, upgrade placeholders progressively on
// current hosts, and wait for the data on hosts without context.formatter.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, makeContext, makeHarness } from '../../test-helpers/mindmap/corpus.mjs';
import MindMapFormatter from './formatter.js';

const ctx = { streaming: false, role: 'assistant' };
const chips = (html) => {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  return [...doc.querySelectorAll('.mm-cite')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
};

let h;
let F;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  F = await buildCorpus(h, { only: ['F1', 'F2', 'F6', 'F10'] });
  h.at(FIXTURE_NOW);
}, 60_000);
afterAll(() => vi.useRealTimers());

function windowFormatter({ formatter = true } = {}) {
  const context = makeContext(h.host, { invoke: h.host.connect().invoke, formatter });
  const f = new MindMapFormatter();
  f.initialize(context);
  return { f, context };
}

describe('fast paths', () => {
  it('skips streaming renders and messages without markers', async () => {
    expect(await h.formatter.format(`<p>[mm:${F.F1}]</p>`, { streaming: true })).toBeNull();
    expect(await h.formatter.format('<p>Nothing to see here.</p>', ctx)).toBeNull();
    expect(await h.formatter.format('', ctx)).toBeNull();
    expect(await h.formatter.format(null, ctx)).toBeNull();
    const start = performance.now();
    for (let i = 0; i < 200; i++) await h.formatter.format('<p>A long ordinary answer with no markers at all.</p>', ctx);
    expect((performance.now() - start) / 200).toBeLessThan(5);
  });

  it('does nothing while the extension is disabled', async () => {
    const f = new MindMapFormatter();
    f.initialize({ ...h.context, config: { enabled: false } });
    expect(await f.format(`<p>[mm:${F.F1}]</p>`, ctx)).toBeNull();
  });

  it('renders chips, cards and help, and is idempotent', async () => {
    const op = h.mind.state.ops.at(-1).opId;
    const html = `<p>See [mm:${F.F1}].</p><p>[mm-card:op:${op}]</p><p>[mm-card:item:${F.F6}]</p><p>[mm-card:help]</p>`;
    const out = await h.formatter.format(html, ctx);
    expect(chips(out)).toEqual(['[1] MTCS design review']);
    expect(out).toContain('mm-t-op');
    expect(out).toContain('mm-t-item');
    expect(out).toContain('mm-t-help');
    expect(out).not.toContain('[mm-card:');
    expect(await h.formatter.format(out, ctx)).toBeNull();
  });

  it('keeps tokens inside code untouched', async () => {
    expect(await h.formatter.format(`<pre><code>[mm:${F.F1}]</code></pre>`, ctx)).toBeNull();
  });
});

describe('a window that has not loaded yet', () => {
  it('renders placeholders, loads, then asks the host to reformat', async () => {
    const { f, context } = windowFormatter();
    const first = await f.format(`<p>Read [mm:${F.F1}] and [mm:${F.F2}].</p>`, ctx);
    expect(chips(first)).toEqual(['[1] …', '[2] …']);
    await f.mind.ready();
    await vi.waitFor(() => expect(context.formatter.requestReformat).toHaveBeenCalled());
    const second = await f.format(first, ctx);
    expect(chips(second)).toEqual(['[1] MTCS design review', '[2] MTCS rollout plan.docx']);
    expect(await f.format(second, ctx)).toBeNull();
  });

  it('on hosts without context.formatter it waits for the data instead', async () => {
    const { f } = windowFormatter({ formatter: false });
    const out = await f.format(`<p>Read [mm:${F.F1}].</p><p>[mm-card:map:${F.F6}]</p>`, ctx);
    expect(chips(out)).toEqual(['[1] MTCS design review']);
    expect(out).toContain('Update Kage to navigate the map — or use mm @name');
  });

  it('private items stay private in chips', async () => {
    const { f } = windowFormatter({ formatter: false });
    const out = await f.format(`<p>That was [mm:${F.F10}].</p>`, ctx);
    expect(chips(out)).toEqual(['[1] private item']);
    expect(out).not.toMatch(/salary/i);
  });
});

describe('repaint after a change', () => {
  it('a card re-renders when its data changes and stays put otherwise', async () => {
    const kid = h.mind.childrenOf(F.F6)[0];
    const op = h.mind.state.ops.find((o) => o.created?.items?.includes(kid.id)).opId;
    const out = await h.formatter.format(`<p>[mm-card:op:${op}]</p>`, ctx);
    expect(await h.formatter.format(out, ctx)).toBeNull();
    await h.mind.setStatus(kid.id, 'done');
    const again = await h.formatter.format(out, ctx);
    expect(again).not.toBeNull();
    expect(await h.formatter.format(again, ctx)).toBeNull();
    await h.mind.setStatus(kid.id, 'open');
  });
});
