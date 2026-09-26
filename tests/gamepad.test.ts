import { describe, expect, it } from 'vitest';
import { applyDeadzone, stickToWorld } from '../src/core/gamepad';

describe('applyDeadzone', () => {
  it('zeroes small drift', () => {
    expect(applyDeadzone(0.05, -0.1)).toEqual([0, 0]);
    expect(applyDeadzone(0, 0)).toEqual([0, 0]);
  });

  it('rescales so full tilt stays 1 and just outside the dead zone is near 0', () => {
    const [x] = applyDeadzone(1, 0);
    expect(x).toBeCloseTo(1);
    const [x2] = applyDeadzone(0.16, 0);
    expect(x2).toBeGreaterThan(0);
    expect(x2).toBeLessThan(0.02);
  });

  it('keeps the direction and clamps diagonal overshoot to length 1', () => {
    const [x, y] = applyDeadzone(1, 1);
    expect(Math.hypot(x, y)).toBeCloseTo(1);
    expect(x).toBeCloseTo(y);
  });

  it('treats NaN input as centred', () => {
    expect(applyDeadzone(NaN, 0)).toEqual([0, 0]);
  });
});

describe('stickToWorld', () => {
  // camera looking north (-z): forward (0, -1), right (1, 0)
  const cam = [0, -1, 1, 0] as const;

  it('stick up moves away from the camera', () => {
    const [x, z] = stickToWorld(0, -1, ...cam);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });

  it('stick right moves to the camera right', () => {
    const [x, z] = stickToWorld(1, 0, ...cam);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('half tilt walks slower (length below 1)', () => {
    const [x, z] = stickToWorld(0, -0.5, ...cam);
    expect(Math.hypot(x, z)).toBeCloseTo(0.5);
  });
});
