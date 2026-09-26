import { describe, expect, it } from 'vitest';
import { finalScore, rankFor, ScoreKeeper } from '../src/game/scoring';
import { SCORE } from '../src/config';

describe('ScoreKeeper', () => {
  it('applies the combo multiplier', () => {
    const s = new ScoreKeeper();
    expect(s.add(100)).toBe(100);
    for (let i = 0; i < 5; i++) s.hit();
    expect(s.multiplier).toBe(1.5);
    expect(s.add(100)).toBe(150);
    for (let i = 0; i < 100; i++) s.hit();
    expect(s.multiplier).toBe(5);
  });

  it('drops the combo after the combo window', () => {
    const s = new ScoreKeeper();
    s.hit();
    s.hit();
    expect(s.combo).toBe(2);
    s.update(SCORE.comboWindow + 0.01);
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(2);
  });

  it('keepAlive only extends an existing combo', () => {
    const s = new ScoreKeeper();
    s.keepAlive();
    expect(s.comboTimer).toBe(0);
    s.hit();
    s.update(SCORE.comboWindow - 0.1);
    s.keepAlive();
    s.update(0.5);
    expect(s.combo).toBe(1);
  });
});

describe('final score and rank', () => {
  it('gives bonuses only when cleared', () => {
    expect(finalScore(1000, false, 60, 0.8, 0.5).total).toBe(1000);
    const f = finalScore(1000, true, 10, 0.6, 0.5);
    expect(f.clearBonus).toBe(30000);
    expect(f.timeBonus).toBe(2500);
    expect(f.destructionBonus).toBe(20000);
    expect(f.total).toBe(1000 + 30000 + 2500 + 20000);
  });

  it('ranks', () => {
    const t = { S: 300, A: 200, B: 100 };
    expect(rankFor(350, true, t)).toBe('S');
    expect(rankFor(250, true, t)).toBe('A');
    expect(rankFor(150, true, t)).toBe('B');
    expect(rankFor(50, true, t)).toBe('C');
    expect(rankFor(999, false, t)).toBe('C');
  });
});
