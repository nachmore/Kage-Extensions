import { describe, expect, it } from 'vitest';
import { createGrid, hit, insert, query, remove, size } from './spatial.js';

describe('spatial grid', () => {
  it('finds rects that meet a query, in insertion order', () => {
    const g = createGrid(100);
    insert(g, 'a', { x: 0, y: 0, w: 50, h: 50 });
    insert(g, 'b', { x: 400, y: 400, w: 50, h: 50 });
    insert(g, 'c', { x: 90, y: 90, w: 300, h: 20 });
    expect(query(g, { x: 0, y: 0, w: 100, h: 100 })).toEqual(['a', 'c']);
    expect(query(g, { x: 380, y: 380, w: 10, h: 10 })).toEqual([]);
    expect(query(g, { x: 380, y: 380, w: 30, h: 30 })).toEqual(['b']);
    expect(query(g, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 })).toEqual(['a', 'b', 'c']);
    expect(query(g, { x: NaN, y: 0, w: 1, h: 1 })).toEqual([]);
  });

  it('hit-tests to the topmost rect under a point', () => {
    const g = createGrid(64);
    insert(g, 'under', { x: 0, y: 0, w: 100, h: 100 });
    insert(g, 'over', { x: 50, y: 50, w: 100, h: 100 });
    expect(hit(g, 10, 10)).toBe('under');
    expect(hit(g, 75, 75)).toBe('over');
    expect(hit(g, 140, 140)).toBe('over');
    expect(hit(g, 500, 500)).toBeNull();
    // Re-inserting moves a rect and puts it on top.
    insert(g, 'under', { x: 0, y: 0, w: 100, h: 100 });
    expect(hit(g, 75, 75)).toBe('under');
  });

  it('works across negative coordinates and cell edges', () => {
    const g = createGrid(50);
    insert(g, 'n', { x: -120, y: -75, w: 40, h: 30 });
    expect(hit(g, -100, -60)).toBe('n');
    expect(hit(g, -80, -45)).toBe('n');
    expect(hit(g, -79, -45)).toBeNull();
    expect(query(g, { x: -200, y: -200, w: 100, h: 140 })).toEqual(['n']);
  });

  it('removes and moves rects', () => {
    const g = createGrid(100);
    insert(g, 'a', { x: 0, y: 0, w: 10, h: 10 });
    insert(g, 'a', { x: 500, y: 500, w: 10, h: 10 });
    expect(size(g)).toBe(1);
    expect(hit(g, 5, 5)).toBeNull();
    expect(hit(g, 505, 505)).toBe('a');
    expect(remove(g, 'a')).toBe(true);
    expect(remove(g, 'a')).toBe(false);
    expect(size(g)).toBe(0);
    expect(g.cells.size).toBe(0);
  });

  it('ignores rects that aren’t finite', () => {
    const g = createGrid();
    insert(g, 'x', { x: Infinity, y: 0, w: 1, h: 1 });
    expect(size(g)).toBe(0);
  });
});
