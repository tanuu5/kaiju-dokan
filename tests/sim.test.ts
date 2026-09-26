import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim/simulate';
import { STAGE1 } from '../src/stages/stages';

// Runs the real gameplay code (Session + World) headlessly with a bot.
describe('headless simulation (stage 1)', () => {
  it('a bot wrecks part of the city in 60 s without errors or NaNs', () => {
    const r = simulate(STAGE1, { seconds: 60, fps: 30, sampleEvery: 20 });
    expect(r.status).toBe('running');
    expect(r.final.destruction).toBeGreaterThan(0.03);
    expect(r.final.collapsed).toBeGreaterThan(3);
    expect(Number.isFinite(r.final.score)).toBe(true);
    expect(r.final.score).toBeGreaterThan(0);
    expect(r.final.hp).toBeGreaterThan(0);
    for (const s of r.samples) {
      expect(Number.isFinite(s.destruction)).toBe(true);
      expect(s.debris).toBeLessThanOrEqual(4500);
    }
  }, 60_000);

  it('the defence force shows up and hurts the kaiju', () => {
    const r = simulate(STAGE1, { seconds: 100, fps: 20, sampleEvery: 50 });
    expect(r.samples.some((s) => s.tanks > 0)).toBe(true);
    expect(r.final.hp).toBeLessThan(1000);
  }, 60_000);
});
