import { describe, expect, it } from 'vitest';
import { fovForAspect } from '../src/game/cameraRig';
import { stickVector } from '../src/ui/touchControls';

describe('stickVector', () => {
  it('ignores tiny wobble around the touch point', () => {
    expect(stickVector(0, 0)).toEqual({ x: 0, y: 0, run: false });
    expect(stickVector(2, -3)).toEqual({ x: 0, y: 0, run: false });
  });

  it('scales with the drag distance up to the rim', () => {
    const half = stickVector(28, 0, 56);
    expect(half.x).toBeCloseTo(0.5);
    expect(half.y).toBeCloseTo(0);
    expect(half.run).toBe(false);
  });

  it('clamps to length 1 past the rim and runs there', () => {
    const v = stickVector(-300, 400, 56);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(-0.6);
    expect(v.y).toBeCloseTo(0.8);
    expect(v.run).toBe(true);
  });

  it('treats NaN as centred', () => {
    expect(stickVector(NaN, 10)).toEqual({ x: 0, y: 0, run: false });
  });
});

describe('fovForAspect', () => {
  it('keeps the default FOV on landscape screens', () => {
    expect(fovForAspect(16 / 9)).toBe(55);
    expect(fovForAspect(1)).toBe(55);
  });

  it('widens the vertical FOV on portrait phones, within limits', () => {
    const phone = fovForAspect(390 / 844);
    expect(phone).toBeGreaterThan(70);
    expect(phone).toBeLessThanOrEqual(78);
    expect(fovForAspect(0.1)).toBe(78);
  });
});
