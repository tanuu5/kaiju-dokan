// Headless simulation of a stage (no DOM, no WebGL): used by tests and `npm run sim`.

import { AudioSys } from '../core/audio';
import type { RunStats } from '../game/scoring';
import { NO_FEEDBACK, Session, type SessionStatus } from '../game/session';
import type { StageDef } from '../stages/stages';
import { RampageBot } from './bot';

export interface SimSample {
  /** Seconds since the start. */
  t: number;
  destruction: number;
  collapsed: number;
  hp: number;
  score: number;
  tanks: number;
  helis: number;
  debris: number;
  particles: number;
}

export interface SimReport {
  samples: SimSample[];
  status: SessionStatus;
  cleared: boolean;
  /** Seconds after the start when the goal was reached (null = never). */
  clearTime: number | null;
  final: SimSample;
  stats: RunStats;
  maxCombo: number;
}

export interface SimOptions {
  /** Simulated seconds (defaults to the stage time limit). */
  seconds?: number;
  fps?: number;
  sampleEvery?: number;
}

export function simulate(stage: StageDef, opts: SimOptions = {}): SimReport {
  const seconds = opts.seconds ?? stage.timeLimit;
  const fps = opts.fps ?? 30;
  const sampleEvery = opts.sampleEvery ?? 30;
  const dt = 1 / fps;
  const session = new Session(stage, new AudioSys(), NO_FEEDBACK);
  session.startPlaying();
  const bot = new RampageBot();
  const samples: SimSample[] = [];
  let status: SessionStatus = 'running';
  let clearTime: number | null = null;
  let nextSample = sampleEvery;
  const sample = (): SimSample => {
    const w = session.world;
    return {
      t: Math.round(session.elapsed),
      destruction: w.buildings.destructionRatio,
      collapsed: w.buildings.collapsedCount,
      hp: Math.round(w.kaiju.hp.value),
      score: session.score.score,
      tanks: w.military.aliveTanks,
      helis: w.military.aliveHelis,
      debris: w.debris.active,
      particles: w.fx.smoke.count + w.fx.glow.count,
    };
  };
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames && status === 'running'; i++) {
    session.updateWorld(dt, bot.input(session));
    status = session.updateRules(dt);
    if (clearTime === null && session.cleared) clearTime = session.elapsed;
    if (session.elapsed >= nextSample) {
      samples.push(sample());
      nextSample += sampleEvery;
    }
  }
  const final = sample();
  const report: SimReport = {
    samples,
    status,
    cleared: session.cleared,
    clearTime,
    final,
    stats: { ...session.score.stats },
    maxCombo: session.score.maxCombo,
  };
  session.dispose();
  return report;
}
