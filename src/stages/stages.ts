/** Enemy reinforcement schedule entry. */
export interface WaveDef {
  /** Seconds after the rampage starts. */
  time: number;
  tanks: number;
  helis: number;
  message?: string;
}

export interface StageDef {
  id: number;
  name: string;
  subtitle: string;
  seed: number;
  blocksX: number;
  blocksZ: number;
  /** Seconds. */
  timeLimit: number;
  /** Destruction ratio (0..1, by building volume) needed to clear the stage. */
  goal: number;
  waves: WaveDef[];
  maxTanks: number;
  maxHelis: number;
  carCount: number;
  /** Minimum final score for each rank. */
  rank: { S: number; A: number; B: number };
}

export const STAGE1: StageDef = {
  id: 1,
  name: '湾岸シティ',
  subtitle: 'BAY CITY',
  seed: 20260926,
  blocksX: 8,
  blocksZ: 7,
  timeLimit: 240,
  goal: 0.4,
  waves: [
    { time: 18, tanks: 2, helis: 0, message: '防衛軍 出動！' },
    { time: 40, tanks: 3, helis: 0 },
    { time: 70, tanks: 2, helis: 2, message: '攻撃ヘリ 接近中！' },
    { time: 105, tanks: 3, helis: 1 },
    { time: 140, tanks: 3, helis: 2, message: '増援部隊 到着！' },
    { time: 175, tanks: 3, helis: 2 },
    { time: 205, tanks: 4, helis: 2, message: '総攻撃だ！' },
  ],
  maxTanks: 8,
  maxHelis: 4,
  carCount: 70,
  rank: { S: 420000, A: 280000, B: 160000 },
};

export const STAGES: StageDef[] = [STAGE1];
