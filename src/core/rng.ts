/** Small, fast, seedable PRNG (mulberry32). Deterministic for a given seed. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/** Non-deterministic helpers for visual-only randomness (particles, debris spin...). */
export const rand = (min = 0, max = 1): number => min + (max - min) * Math.random();
export const randInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));
export const randPick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
