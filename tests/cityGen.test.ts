import { describe, expect, it } from 'vitest';
import { CELL, countChunks, generateCity } from '../src/world/cityGen';
import { STAGE1 } from '../src/stages/stages';

const params = { seed: STAGE1.seed, blocksX: STAGE1.blocksX, blocksZ: STAGE1.blocksZ };

describe('generateCity', () => {
  it('is deterministic for a given seed', () => {
    const a = generateCity(params);
    const b = generateCity(params);
    expect(a.buildings.length).toBe(b.buildings.length);
    expect(a.totalChunks).toBe(b.totalChunks);
    expect(a.trees.length).toBe(b.trees.length);
    expect(Array.from(a.buildings[10].color)).toEqual(Array.from(b.buildings[10].color));
  });

  it('produces a reasonably sized city', () => {
    const c = generateCity(params);
    expect(c.buildings.length).toBeGreaterThan(120);
    expect(c.totalChunks).toBeGreaterThan(8000);
    expect(c.totalChunks).toBeLessThan(60000);
    expect(c.buildings.some((b) => b.kind === 'tower')).toBe(true);
    expect(c.buildings.some((b) => b.kind === 'dome')).toBe(true);
  });

  it('never places buildings on roads, outside the grid, or on top of each other', () => {
    const c = generateCity(params);
    const owner = new Int32Array(c.gridW * c.gridD).fill(-1);
    c.buildings.forEach((b, id) => {
      expect(b.i0).toBeGreaterThanOrEqual(0);
      expect(b.k0).toBeGreaterThanOrEqual(0);
      expect(b.i0 + b.w).toBeLessThanOrEqual(c.gridW);
      expect(b.k0 + b.d).toBeLessThanOrEqual(c.gridD);
      expect(b.solid.length).toBe(b.w * b.d * b.h);
      expect(countChunks(b)).toBeGreaterThan(0);
      for (let z = 0; z < b.d; z++) {
        for (let x = 0; x < b.w; x++) {
          let used = false;
          for (let y = 0; y < b.h; y++) if (b.solid[x + z * b.w + y * b.w * b.d]) used = true;
          if (!used) continue;
          const cell = b.i0 + x + (b.k0 + z) * c.gridW;
          expect(c.cellType[cell]).not.toBe(CELL.ROAD);
          expect(owner[cell]).toBe(-1);
          owner[cell] = id;
        }
      }
    });
  });

  it('gives every building at least one ground-floor chunk', () => {
    const c = generateCity(params);
    for (const b of c.buildings) {
      let ground = 0;
      for (let i = 0; i < b.w * b.d; i++) ground += b.solid[i];
      expect(ground).toBeGreaterThan(0);
    }
  });

  it('puts the kaiju start in the sea south of the shore', () => {
    const c = generateCity(params);
    expect(c.kaijuStart.z).toBeGreaterThan(c.shoreZ);
  });
});
