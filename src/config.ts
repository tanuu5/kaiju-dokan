// Global tuning constants. World units are roughly metres; the kaiju is ~45 m tall.

/** Horizontal size of one building chunk (m). One city grid cell == one chunk. */
export const CHUNK = 4;
/** Vertical size of one building chunk (one "floor", m). */
export const FLOOR = 4;
/** Road width in grid cells. */
export const ROAD_CELLS = 3;
/** City block (buildable lot) size in grid cells. */
export const BLOCK_CELLS = 8;
/** Harbour quay depth in grid cells (between the last road and the sea). */
export const HARBOR_CELLS = 10;
/** Highest building (in floors) the generator may produce. */
export const MAX_FLOORS = 22;

/** Gravity used for debris / vehicles (slightly heavier than real for snappier feel at kaiju scale). */
export const GRAVITY = 26;
/** Water surface height. */
export const WATER_LEVEL = -1.4;

/** Kaiju tuning. */
export const KAIJU = {
  /** Uniform model scale (1 = ~46 m tall). */
  scale: 1.25,
  maxHp: 1000,
  maxEnergy: 100,
  walkSpeed: 13,
  runSpeed: 23,
  turnSpeed: 3.4,
  strideLength: 16,
  breathCost: 26, // energy / second
  breathChargeTime: 0.45,
  breathRange: 260,
  tailCooldown: 1.6,
  jumpCooldown: 2.6,
  roarCooldown: 11,
  regenDelay: 4,
  regenRate: 9,
  /** HP restored whenever a building collapses (rewards aggression). */
  healPerCollapse: 3,
};

/** Defence force tuning (stage 1 is meant to be forgiving). */
export const MILITARY = {
  shellDamage: 5,
  /** Seconds between tank shots [min, max]. */
  shellInterval: [4, 6] as const,
  /** Random aim error (m). */
  shellSpread: 8,
  missileDamage: 8,
  missileInterval: [5, 7] as const,
  tankSpeed: 10,
  /** Tanks try to keep roughly this distance from the kaiju. */
  tankRange: 95,
};

/** Score values. */
export const SCORE = {
  chunk: 10,
  collapsePerFloor: 60,
  car: 80,
  tank: 400,
  heli: 600,
  tree: 5,
  comboWindow: 2.6,
};

/** Energy gained from destruction. */
export const ENERGY_GAIN = {
  chunk: 0.28,
  collapse: 4,
  vehicle: 3,
};
