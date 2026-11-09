import { describe, expect, it } from 'vitest';
import { ZOOM_MAX, ZOOM_MIN, centerOf, centerOn, clampZoom, createCamera, fit, lerpCamera, panBy, sameCamera, screenToWorld, visibleRect, worldToScreen, zoomAt } from './camera.js';

const VP = { width: 1000, height: 600 };
const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('camera', () => {
  it('round-trips world and screen points', () => {
    const cam = createCamera({ x: 120, y: -40, zoom: 1.7 });
    for (const [wx, wy] of [[0, 0], [10, -20], [-333.5, 812.25]]) {
      const s = worldToScreen(cam, wx, wy);
      const w = screenToWorld(cam, s.x, s.y);
      close(w.x, wx);
      close(w.y, wy);
    }
  });

  it('zooms at a point, keeping that point still', () => {
    const cam = createCamera({ x: 50, y: 70, zoom: 1 });
    const before = screenToWorld(cam, 300, 200);
    const zoomed = zoomAt(cam, 2.5, 300, 200);
    expect(zoomed.zoom).toBe(2.5);
    const after = screenToWorld(zoomed, 300, 200);
    close(after.x, before.x);
    close(after.y, before.y);
  });

  it('clamps the zoom to 0.1–4', () => {
    expect(ZOOM_MIN).toBe(0.1);
    expect(ZOOM_MAX).toBe(4);
    expect(zoomAt(createCamera(), 100, 0, 0).zoom).toBe(4);
    expect(zoomAt(createCamera(), 0.0001, 0, 0).zoom).toBe(0.1);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(-3)).toBe(1);
    expect(clampZoom(3, { min: 0.5, max: 2 })).toBe(2);
    // Clamped zooms still keep the point still.
    const cam = zoomAt(createCamera({ zoom: 3 }), 10, 400, 100);
    const w = screenToWorld(createCamera({ zoom: 3 }), 400, 100);
    const w2 = screenToWorld(cam, 400, 100);
    close(w.x, w2.x);
  });

  it('pans by screen pixels and never mutates its input', () => {
    const cam = Object.freeze(createCamera({ x: 1, y: 2, zoom: 2 }));
    expect(panBy(cam, 10, -5)).toEqual({ x: 11, y: -3, zoom: 2 });
    expect(zoomAt(cam, 1.5, 0, 0)).not.toBe(cam);
  });

  it('centres on a world point and reads the centre back', () => {
    const cam = centerOn(createCamera(), 250, -80, VP, 2);
    expect(cam.zoom).toBe(2);
    const c = centerOf(cam, VP);
    close(c.x, 250);
    close(c.y, -80);
    expect(worldToScreen(cam, 250, -80)).toEqual({ x: 500, y: 300 });
  });

  it('fits bounds into the viewport, never past the zoom cap', () => {
    const big = fit(createCamera(), { minX: -2000, minY: -500, maxX: 2000, maxY: 500 }, VP, 50);
    expect(big.zoom).toBeCloseTo(900 / 4000, 6);
    const c = centerOf(big, VP);
    close(c.x, 0);
    close(c.y, 0);
    const tiny = fit(createCamera(), { minX: 0, minY: 0, maxX: 10, maxY: 10 }, VP);
    expect(tiny.zoom).toBe(1.25);
    expect(fit(createCamera(), null, VP).zoom).toBe(1);
  });

  it('reports the visible world rectangle', () => {
    const cam = centerOn(createCamera(), 0, 0, VP, 2);
    expect(visibleRect(cam, VP)).toEqual({ minX: -250, minY: -150, maxX: 250, maxY: 150 });
    const grown = visibleRect(cam, VP, 20);
    expect(grown.minX).toBe(-260);
  });

  it('interpolates between cameras through the window centre', () => {
    const a = centerOn(createCamera(), 0, 0, VP, 1);
    const b = centerOn(createCamera(), 400, 200, VP, 4);
    expect(sameCamera(lerpCamera(a, b, 0, VP), a)).toBe(true);
    expect(sameCamera(lerpCamera(a, b, 1, VP), b)).toBe(true);
    const mid = lerpCamera(a, b, 0.5, VP);
    expect(mid.zoom).toBeCloseTo(2, 9);
    const c = centerOf(mid, VP);
    close(c.x, 200);
    close(c.y, 100);
  });
});
