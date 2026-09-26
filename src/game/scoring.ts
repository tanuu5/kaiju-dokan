import { SCORE } from '../config';

export type Rank = 'S' | 'A' | 'B' | 'C';

export interface RunStats {
  buildings: number;
  cars: number;
  tanks: number;
  helis: number;
  trees: number;
  landmarks: number;
}

/** Score, combo and statistics for one run. Pure logic (unit tested). */
export class ScoreKeeper {
  score = 0;
  combo = 0;
  maxCombo = 0;
  comboTimer = 0;
  readonly stats: RunStats = { buildings: 0, cars: 0, tanks: 0, helis: 0, trees: 0, landmarks: 0 };

  /** Combo multiplier: x1, then +0.5 every 5 hits, capped at x5. */
  get multiplier(): number {
    return Math.min(5, 1 + Math.floor(this.combo / 5) * 0.5);
  }

  /** Add points (multiplied by the current combo multiplier). Returns the points actually added. */
  add(points: number): number {
    const p = Math.round(points * this.multiplier);
    this.score += p;
    return p;
  }

  /** A distinct destructive hit: extends the combo. */
  hit(): void {
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.comboTimer = SCORE.comboWindow;
  }

  /** Continuous destruction keeps an existing combo alive without increasing it. */
  keepAlive(): void {
    if (this.combo > 0) this.comboTimer = Math.max(this.comboTimer, SCORE.comboWindow * 0.6);
  }

  update(dt: number): void {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboTimer = 0;
        this.combo = 0;
      }
    }
  }
}

export interface FinalBreakdown {
  base: number;
  clearBonus: number;
  timeBonus: number;
  destructionBonus: number;
  total: number;
}

export function finalScore(base: number, cleared: boolean, timeLeft: number, destruction: number, goal: number): FinalBreakdown {
  const clearBonus = cleared ? 30000 : 0;
  const timeBonus = cleared ? Math.round(Math.max(0, timeLeft) * 250) : 0;
  const destructionBonus = cleared ? Math.round(Math.max(0, destruction - goal) * 200000) : 0;
  return { base, clearBonus, timeBonus, destructionBonus, total: base + clearBonus + timeBonus + destructionBonus };
}

export function rankFor(total: number, cleared: boolean, t: { S: number; A: number; B: number }): Rank {
  if (!cleared) return 'C';
  if (total >= t.S) return 'S';
  if (total >= t.A) return 'A';
  if (total >= t.B) return 'B';
  return 'C';
}
