import { describe, expect, it } from 'vitest';
import { decideCollapse, findUnsupported } from '../src/world/structure';

const idx = (x: number, y: number, z: number, w: number, d: number) => x + z * w + y * w * d;

function column(h: number): Uint8Array {
  return new Uint8Array(h).fill(1); // 1x1xh
}

describe('findUnsupported', () => {
  it('returns nothing for an intact column', () => {
    expect(findUnsupported(column(5), 1, 1, 5)).toEqual([]);
  });

  it('returns everything above a missing chunk in a 1x1 column', () => {
    const c = column(5);
    c[2] = 0;
    expect(findUnsupported(c, 1, 1, 5)).toEqual([3, 4]);
  });

  it('keeps overhangs that are still connected sideways', () => {
    // 2x1x3: remove the bottom-right cell, the right column is held by the left one
    const w = 2;
    const d = 1;
    const h = 3;
    const a = new Uint8Array(w * d * h).fill(1);
    a[idx(1, 0, 0, w, d)] = 0;
    expect(findUnsupported(a, w, d, h)).toEqual([]);
  });

  it('detects a floating slab', () => {
    const w = 3;
    const d = 3;
    const h = 4;
    const a = new Uint8Array(w * d * h).fill(1);
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) a[idx(x, 1, z, w, d)] = 0; // cut floor 1
    const out = findUnsupported(a, w, d, h);
    expect(out.length).toBe(w * d * 2); // floors 2 and 3
  });
});

describe('decideCollapse', () => {
  it('collapses when most of the ground floor is gone', () => {
    const w = 2;
    const d = 2;
    const h = 3;
    const a = new Uint8Array(w * d * h).fill(1);
    a[0] = 0;
    a[1] = 0;
    a[2] = 0;
    const r = decideCollapse(a, w, d, h, { alive: 9, total: 12, groundAlive: 1, groundTotal: 4 });
    expect(r.collapse).toBe(true);
  });

  it('drops small floating bits without collapsing', () => {
    const w = 3;
    const d = 3;
    const h = 6;
    const a = new Uint8Array(w * d * h).fill(1);
    // a single chunk at the top corner whose support below was removed
    a[idx(0, 4, 0, w, d)] = 0;
    a[idx(1, 5, 0, w, d)] = 0;
    a[idx(0, 5, 1, w, d)] = 0;
    // (0,5,0) is now only connected via removed neighbours
    const alive = a.reduce((s, v) => s + v, 0);
    const r = decideCollapse(a, w, d, h, { alive, total: 54, groundAlive: 9, groundTotal: 9 });
    expect(r.collapse).toBe(false);
    expect(r.drop).toEqual([idx(0, 5, 0, w, d)]);
  });
});
