// Procedural city layout. Pure data – no three.js – so it can be unit tested.
//
// The city is a grid of CHUNK-sized cells. Roads run every (BLOCK_CELLS + ROAD_CELLS)
// cells in both directions; the south edge (+z) is a harbour quay facing the sea.
// Every building is a small voxel grid (w x d x h cells) whose cells become
// individually destructible chunks at runtime.

import { BLOCK_CELLS, CHUNK, HARBOR_CELLS, MAX_FLOORS, ROAD_CELLS } from '../config';
import { Rng } from '../core/rng';

export const CELL = {
  LOT: 0,
  ROAD: 1,
  PARK: 2,
  HARBOR: 3,
  PLAZA: 4,
} as const;

/** Window / facade pattern ids understood by the building shader. */
export const STYLE = {
  OFFICE: 0,
  RESIDENTIAL: 1,
  GLASS: 2,
  SHOP: 3,
  WAREHOUSE: 4,
  LATTICE: 5,
  CONTAINER: 6,
  HOUSE: 7,
  PLAIN: 8,
} as const;

export type BuildingKind =
  | 'office'
  | 'glass'
  | 'residential'
  | 'brick'
  | 'shop'
  | 'house'
  | 'warehouse'
  | 'container'
  | 'tower'
  | 'dome'
  | 'crane';

export interface BuildingSpec {
  /** Min cell index on the city grid. */
  i0: number;
  k0: number;
  /** Bounding size in cells / floors. */
  w: number;
  d: number;
  h: number;
  /** Occupancy, index = x + z * w + y * w * d. 1 = chunk present. */
  solid: Uint8Array;
  /** Per-cell colour (0xRRGGBB, sRGB). */
  color: Uint32Array;
  /** Per-cell facade style (STYLE.*). */
  style: Uint8Array;
  kind: BuildingKind;
  /** Extra score bonus when destroyed (landmarks). */
  value: number;
  /** Probability that the building topples over instead of pancaking. */
  topple: number;
  /** Display name for landmarks. */
  name?: string;
}

export interface TreeSpec {
  x: number;
  z: number;
  s: number;
}

export interface CityLayout {
  seed: number;
  gridW: number;
  gridD: number;
  /** Rows of the grid that belong to the city proper (the rest is harbour). */
  cityRows: number;
  originX: number;
  originZ: number;
  cellType: Uint8Array;
  buildings: BuildingSpec[];
  trees: TreeSpec[];
  /** World x of each north-south road centre line. */
  roadX: number[];
  /** World z of each east-west road centre line. */
  roadZ: number[];
  shoreZ: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  kaijuStart: { x: number; z: number };
  totalChunks: number;
}

export interface CityParams {
  seed: number;
  blocksX: number;
  blocksZ: number;
}

const PAL = {
  office: [0x9aa3ad, 0x8d98a5, 0xa7aeb5, 0x7f8b97, 0xb3b0a8, 0x969088, 0xa39c92],
  glass: [0x4d6f8c, 0x3f5f7d, 0x557c93, 0x2f4d66, 0x60828f, 0x3d6a78],
  residential: [0xd9cfbf, 0xcdbfa6, 0xe3d9c7, 0xc4b59d, 0xb9c4b5, 0xd6c0b0, 0xc9ccd2],
  house: [0xe8e0d0, 0xd8c8b0, 0xc9b8a0, 0xb8c8c0, 0xe0d0c8, 0xd0d8e0],
  brick: [0xa8674f, 0x9a5d48, 0xb4775a, 0x8f5a4a],
  shopfront: [0x5b4d45, 0x4a4f57, 0x6a5040, 0x3f4a52],
  accent: [0xc84b31, 0x2f6f9f, 0x3c8d5a, 0xd9a13b, 0x6d5a8f],
  warehouse: [0x9fb0bd, 0xc8bfa8, 0xa89880, 0x8fa39a, 0xb8b0a0],
  container: [0xc0392b, 0x2e6da4, 0x2e8b57, 0xd98c1f, 0xd9c21f, 0x7d7d7d, 0x8e44ad, 0x16a085, 0xa04020],
} as const;

/** Multiply an sRGB hex colour by k (per channel, clamped). */
export function tint(hex: number, k: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * k)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * k)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * k)));
  return (r << 16) | (g << 8) | b;
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

class BuildingBuilder {
  readonly solid: Uint8Array;
  readonly color: Uint32Array;
  readonly style: Uint8Array;

  constructor(
    readonly w: number,
    readonly d: number,
    readonly h: number,
  ) {
    const n = w * d * h;
    this.solid = new Uint8Array(n);
    this.color = new Uint32Array(n);
    this.style = new Uint8Array(n);
  }

  idx(x: number, y: number, z: number): number {
    return x + z * this.w + y * this.w * this.d;
  }

  set(x: number, y: number, z: number, color: number, style: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.h || z >= this.d) return;
    const i = this.idx(x, y, z);
    this.solid[i] = 1;
    this.color[i] = color;
    this.style[i] = style;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: (y: number) => number, style: (y: number) => number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, color(y), style(y));
  }

  /** Trim unused top floors so h matches the real height. */
  spec(i0: number, k0: number, kind: BuildingKind, value: number, topple: number, name?: string): BuildingSpec {
    let top = 0;
    for (let i = 0; i < this.solid.length; i++) if (this.solid[i]) top = Math.max(top, Math.floor(i / (this.w * this.d)) + 1);
    const n = this.w * this.d * top;
    return {
      i0,
      k0,
      w: this.w,
      d: this.d,
      h: top,
      solid: this.solid.slice(0, n),
      color: this.color.slice(0, n),
      style: this.style.slice(0, n),
      kind,
      value,
      topple,
      name,
    };
  }
}

export function countChunks(b: BuildingSpec): number {
  let n = 0;
  for (let i = 0; i < b.solid.length; i++) n += b.solid[i];
  return n;
}

export function generateCity(params: CityParams): CityLayout {
  const rng = new Rng(params.seed);
  const { blocksX, blocksZ } = params;
  const P = BLOCK_CELLS + ROAD_CELLS;
  const gridW = blocksX * P + ROAD_CELLS;
  const cityRows = blocksZ * P + ROAD_CELLS;
  const gridD = cityRows + HARBOR_CELLS;
  const originX = (-gridW * CHUNK) / 2;
  const originZ = (-gridD * CHUNK) / 2;
  const shoreZ = originZ + gridD * CHUNK;

  const cellType = new Uint8Array(gridW * gridD);
  const occupied = new Uint8Array(gridW * gridD);
  for (let k = 0; k < gridD; k++) {
    for (let i = 0; i < gridW; i++) {
      let t: number = CELL.LOT;
      if (k >= cityRows) t = CELL.HARBOR;
      else if (i % P < ROAD_CELLS || k % P < ROAD_CELLS) t = CELL.ROAD;
      cellType[i + k * gridW] = t;
    }
  }

  const buildings: BuildingSpec[] = [];
  const trees: TreeSpec[] = [];
  const cellX = (i: number) => originX + (i + 0.5) * CHUNK;
  const cellZ = (k: number) => originZ + (k + 0.5) * CHUNK;

  const addBuilding = (spec: BuildingSpec) => {
    if (spec.h <= 0) return;
    for (let z = 0; z < spec.d; z++) {
      for (let x = 0; x < spec.w; x++) {
        let any = false;
        for (let y = 0; y < spec.h; y++) if (spec.solid[x + z * spec.w + y * spec.w * spec.d]) any = true;
        if (any) occupied[spec.i0 + x + (spec.k0 + z) * gridW] = 1;
      }
    }
    buildings.push(spec);
  };

  // ---- choose special blocks ----
  const towerBX = Math.floor(blocksX / 2);
  const towerBZ = Math.floor(blocksZ / 2);
  const domeBX = rng.chance(0.5) ? 1 : blocksX - 2;
  const domeBZ = 1;
  const parkBlocks = new Set<string>();
  const nParks = Math.max(2, Math.round(blocksX * blocksZ * 0.07));
  let guard = 0;
  while (parkBlocks.size < nParks && guard++ < 200) {
    const bx = rng.int(0, blocksX - 1);
    const bz = rng.int(0, blocksZ - 1);
    if ((bx === towerBX && bz === towerBZ) || (bx === domeBX && bz === domeBZ)) continue;
    if (Math.abs(bx - towerBX) <= 1 && Math.abs(bz - towerBZ) <= 1) continue; // keep downtown dense
    parkBlocks.add(`${bx},${bz}`);
  }

  const cx = (blocksX - 1) / 2;
  const cz = (blocksZ - 1) / 2;
  const maxDist = Math.hypot(cx, cz) + 0.5;

  for (let bz = 0; bz < blocksZ; bz++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const i0 = bx * P + ROAD_CELLS;
      const k0 = bz * P + ROAD_CELLS;
      const downtown = 1 - Math.min(1, Math.hypot(bx - cx, bz - cz) / maxDist);

      if (bx === towerBX && bz === towerBZ) {
        markBlock(cellType, gridW, i0, k0, CELL.PLAZA);
        addBuilding(makeTower(i0 + 1, k0 + 1));
        // trees around the plaza edge
        for (let t = 0; t < BLOCK_CELLS; t++) {
          if (t % 2 === 0) {
            trees.push({ x: cellX(i0 + t), z: cellZ(k0) - 1, s: rng.range(0.8, 1.1) });
            trees.push({ x: cellX(i0 + t), z: cellZ(k0 + BLOCK_CELLS - 1) + 1, s: rng.range(0.8, 1.1) });
          }
        }
        continue;
      }
      if (bx === domeBX && bz === domeBZ) {
        markBlock(cellType, gridW, i0, k0, CELL.PLAZA);
        addBuilding(makeDome(i0, k0));
        continue;
      }
      if (parkBlocks.has(`${bx},${bz}`)) {
        markBlock(cellType, gridW, i0, k0, CELL.PARK);
        const n = rng.int(26, 40);
        for (let t = 0; t < n; t++) {
          const x = originX + (i0 + rng.range(0.4, BLOCK_CELLS - 0.4)) * CHUNK;
          const z = originZ + (k0 + rng.range(0.4, BLOCK_CELLS - 0.4)) * CHUNK;
          trees.push({ x, z, s: rng.range(0.75, 1.35) });
        }
        continue;
      }

      // ---- regular block ----
      const lots: Rect[] = [];
      if (rng.chance(0.1 + downtown * 0.1)) {
        lots.push({ x: 0, z: 0, w: BLOCK_CELLS, d: BLOCK_CELLS });
      } else {
        splitLots(rng, { x: 0, z: 0, w: BLOCK_CELLS, d: BLOCK_CELLS }, 0, lots);
      }
      for (const lot of lots) {
        if (lot.w * lot.d >= 6 && rng.chance(0.07)) {
          // small green space
          for (let t = 0; t < Math.ceil((lot.w * lot.d) / 5); t++) {
            trees.push({
              x: originX + (i0 + lot.x + rng.range(0.3, lot.w - 0.3)) * CHUNK,
              z: originZ + (k0 + lot.z + rng.range(0.3, lot.d - 0.3)) * CHUNK,
              s: rng.range(0.7, 1.1),
            });
          }
          continue;
        }
        const fp = shrinkLot(rng, lot);
        const spec = makeRegularBuilding(rng, i0 + fp.x, k0 + fp.z, fp.w, fp.d, downtown, lot.w * lot.d >= 36);
        addBuilding(spec);
      }
    }
  }

  // ---- harbour ----
  buildHarbor(rng, gridW, cityRows, gridD, addBuilding, occupied);

  // ---- street trees along the sidewalks ----
  for (let bz = 0; bz < blocksZ; bz++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const i0 = bx * P + ROAD_CELLS;
      const k0 = bz * P + ROAD_CELLS;
      if (cellType[i0 + k0 * gridW] !== CELL.LOT) continue;
      for (let t = 1; t < BLOCK_CELLS; t += 3) {
        if (rng.chance(0.55)) trees.push({ x: originX + (i0 + t) * CHUNK, z: originZ + k0 * CHUNK - 1.6, s: rng.range(0.55, 0.75) });
        if (rng.chance(0.55)) trees.push({ x: originX + (i0 - 0) * CHUNK - 1.6, z: originZ + (k0 + t) * CHUNK, s: rng.range(0.55, 0.75) });
      }
    }
  }

  const roadX: number[] = [];
  for (let j = 0; j <= blocksX; j++) roadX.push(originX + (j * P + ROAD_CELLS / 2) * CHUNK);
  const roadZ: number[] = [];
  for (let j = 0; j <= blocksZ; j++) roadZ.push(originZ + (j * P + ROAD_CELLS / 2) * CHUNK);

  let totalChunks = 0;
  for (const b of buildings) totalChunks += countChunks(b);

  return {
    seed: params.seed,
    gridW,
    gridD,
    cityRows,
    originX,
    originZ,
    cellType,
    buildings,
    trees,
    roadX,
    roadZ,
    shoreZ,
    bounds: { minX: originX, maxX: originX + gridW * CHUNK, minZ: originZ, maxZ: shoreZ },
    kaijuStart: { x: 0, z: shoreZ + 75 },
    totalChunks,
  };
}

function markBlock(cellType: Uint8Array, gridW: number, i0: number, k0: number, t: number): void {
  for (let k = k0; k < k0 + BLOCK_CELLS; k++) for (let i = i0; i < i0 + BLOCK_CELLS; i++) cellType[i + k * gridW] = t;
}

function splitLots(rng: Rng, r: Rect, depth: number, out: Rect[]): void {
  const canX = r.w >= 4;
  const canZ = r.d >= 4;
  const area = r.w * r.d;
  if ((!canX && !canZ) || depth >= 3 || (depth >= 1 && area <= 20 && rng.chance(0.45))) {
    out.push(r);
    return;
  }
  let splitX = r.w > r.d ? true : r.w < r.d ? false : rng.chance(0.5);
  if (splitX && !canX) splitX = false;
  if (!splitX && !canZ) splitX = true;
  if (splitX) {
    const s = rng.int(2, r.w - 2);
    splitLots(rng, { x: r.x, z: r.z, w: s, d: r.d }, depth + 1, out);
    splitLots(rng, { x: r.x + s, z: r.z, w: r.w - s, d: r.d }, depth + 1, out);
  } else {
    const s = rng.int(2, r.d - 2);
    splitLots(rng, { x: r.x, z: r.z, w: r.w, d: s }, depth + 1, out);
    splitLots(rng, { x: r.x, z: r.z + s, w: r.w, d: r.d - s }, depth + 1, out);
  }
}

/** Leave occasional 1-cell alleys so blocks don't read as one solid mass. */
function shrinkLot(rng: Rng, lot: Rect): Rect {
  let { x, z, w, d } = lot;
  if (w >= 4 && rng.chance(0.35)) {
    if (rng.chance(0.5)) x += 1;
    w -= 1;
  }
  if (d >= 4 && rng.chance(0.35)) {
    if (rng.chance(0.5)) z += 1;
    d -= 1;
  }
  return { x, z, w, d };
}

function makeRegularBuilding(rng: Rng, i0: number, k0: number, w: number, d: number, downtown: number, bigLot: boolean): BuildingSpec {
  // ---- height ----
  let h = Math.round((2 + 9 * Math.pow(downtown, 1.4)) * rng.range(0.65, 1.35));
  if (downtown > 0.55 && w >= 3 && d >= 3 && rng.chance(0.28)) h = rng.int(12, 17);
  if (bigLot) h = Math.max(3, Math.round(h * 0.75));
  if (w * d <= 4) h = Math.min(h, 7);
  h = Math.max(1, Math.min(MAX_FLOORS - 2, h));

  // ---- kind ----
  let kind: BuildingKind;
  const r = rng.next();
  if (h >= 9) kind = r < 0.5 ? 'glass' : 'office';
  else if (h >= 5) kind = r < 0.4 ? 'office' : r < 0.85 ? 'residential' : 'brick';
  else if (h <= 3 && w * d <= 12) kind = r < 0.55 ? 'house' : 'shop';
  else kind = r < 0.5 ? 'shop' : r < 0.8 ? 'residential' : 'brick';

  const baseColor =
    kind === 'glass'
      ? rng.pick(PAL.glass)
      : kind === 'office'
        ? rng.pick(PAL.office)
        : kind === 'brick'
          ? rng.pick(PAL.brick)
          : kind === 'house'
            ? rng.pick(PAL.house)
            : rng.pick(PAL.residential);
  const bodyStyle =
    kind === 'glass' ? STYLE.GLASS : kind === 'office' ? STYLE.OFFICE : kind === 'house' ? STYLE.HOUSE : kind === 'brick' ? STYLE.OFFICE : STYLE.RESIDENTIAL;
  const shopFront = kind !== 'house' && rng.chance(kind === 'shop' ? 1 : 0.6);
  const shopColor = rng.pick(PAL.shopfront);
  const accent = rng.chance(0.35) ? rng.pick(PAL.accent) : -1;
  const floorJitter: number[] = [];
  for (let y = 0; y < h + 4; y++) floorJitter.push(rng.range(0.95, 1.04));

  const colorAt = (y: number) => {
    if (y === 0 && shopFront) return shopColor;
    if (accent >= 0 && y === h - 1 && h >= 4) return accent;
    return tint(baseColor, floorJitter[y]);
  };
  const styleAt = (y: number) => (y === 0 && shopFront ? STYLE.SHOP : bodyStyle);

  const b = new BuildingBuilder(w, d, h + 3);
  const shapeRoll = rng.next();
  if (h >= 8 && w >= 3 && d >= 3 && shapeRoll < 0.3) {
    // setback tower
    const s1 = Math.max(3, Math.round(h * rng.range(0.5, 0.72)));
    b.fill(0, 0, 0, w - 1, s1 - 1, d - 1, colorAt, styleAt);
    b.fill(1, s1, 1, w - 2, h - 1, d - 2, colorAt, styleAt);
  } else if (h >= 7 && w >= 3 && d >= 3 && shapeRoll < 0.55) {
    // podium + tower on a corner
    const p = rng.int(2, 3);
    b.fill(0, 0, 0, w - 1, p - 1, d - 1, (y) => (y === 0 && shopFront ? shopColor : tint(baseColor, 0.9)), styleAt);
    const tw = Math.max(2, w - rng.int(1, 2));
    const td = Math.max(2, d - rng.int(1, 2));
    const ox = rng.chance(0.5) ? 0 : w - tw;
    const oz = rng.chance(0.5) ? 0 : d - td;
    b.fill(ox, p, oz, ox + tw - 1, h - 1, oz + td - 1, colorAt, styleAt);
  } else if (h >= 4 && w >= 3 && d >= 3 && shapeRoll < 0.68) {
    // L-shape above the ground floors
    b.fill(0, 0, 0, w - 1, 1, d - 1, colorAt, styleAt);
    const hx = Math.floor(w / 2);
    const hz = Math.floor(d / 2);
    for (let y = 2; y < h; y++) {
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          if (x >= hx && z >= hz) continue;
          b.set(x, y, z, colorAt(y), styleAt(y));
        }
      }
    }
  } else {
    b.fill(0, 0, 0, w - 1, h - 1, d - 1, colorAt, styleAt);
  }

  // rooftop details: spire / machinery house
  if (h >= 10 && rng.chance(0.4)) {
    const sx = Math.floor((w - 1) / 2);
    const sz = Math.floor((d - 1) / 2);
    const topY = topAt(b, sx, sz);
    const n = rng.int(1, 3);
    for (let y = topY; y < topY + n; y++) b.set(sx, y, sz, 0xc9c9c9, STYLE.PLAIN);
  } else if (h >= 3 && w >= 3 && d >= 3 && rng.chance(0.3)) {
    const sx = rng.int(0, w - 2);
    const sz = rng.int(0, d - 2);
    const topY = topAt(b, sx, sz);
    if (topY >= h) b.set(sx, topY, sz, tint(baseColor, 0.8), STYLE.PLAIN);
  }

  const topple = h >= 12 ? 0.75 : h >= 8 ? 0.5 : 0.12;
  return b.spec(i0, k0, kind, 0, topple);
}

function topAt(b: BuildingBuilder, x: number, z: number): number {
  let top = 0;
  for (let y = 0; y < b.h; y++) if (b.solid[b.idx(x, y, z)]) top = y + 1;
  return top;
}

/** The TV tower landmark: legs, lower deck, tapering body, observation deck and antenna. */
function makeTower(i0: number, k0: number): BuildingSpec {
  const w = 5;
  const b = new BuildingBuilder(w, w, MAX_FLOORS);
  const red = 0xd8412f;
  const white = 0xf0ece2;
  const band = (y: number) => (Math.floor(y / 2) % 2 === 0 ? red : white);
  const L = STYLE.LATTICE;
  // legs
  for (const [x, z] of [
    [0, 0],
    [4, 0],
    [0, 4],
    [4, 4],
  ] as const) {
    b.set(x, 0, z, red, L);
    b.set(x, 1, z, red, L);
  }
  // lower deck
  b.fill(0, 2, 0, 4, 2, 4, () => white, () => STYLE.PLAIN);
  // tapering body
  b.fill(1, 3, 1, 3, 6, 3, band, () => L);
  for (let y = 7; y <= 14; y++) b.set(2, y, 2, band(y), L);
  // observation deck
  b.fill(1, 15, 1, 3, 16, 3, () => white, () => STYLE.GLASS);
  // antenna
  for (let y = 17; y < MAX_FLOORS; y++) b.set(2, y, 2, band(y), L);
  return b.spec(i0, k0, 'tower', 12000, 1, 'ドカンタワー');
}

/** Voxel dome stadium occupying a whole block. */
function makeDome(i0: number, k0: number): BuildingSpec {
  const W = BLOCK_CELLS;
  const b = new BuildingBuilder(W, W, 5);
  const R = W / 2;
  const H = 4.3;
  for (let y = 0; y < 5; y++) {
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - R) / R;
        const dz = (z + 0.5 - R) / R;
        const dy = (y + 0.5) / H;
        const n = Math.sqrt(dx * dx + dz * dz + dy * dy);
        const horiz = Math.sqrt(dx * dx + dz * dz);
        if (y === 0 && horiz <= 1.0 && horiz >= 0.62) b.set(x, y, z, 0x8c8f96, STYLE.OFFICE);
        else if (y > 0 && n <= 1.02 && n >= 0.7) b.set(x, y, z, y >= 3 ? 0xe9edf2 : 0xd4d9e0, STYLE.PLAIN);
      }
    }
  }
  return b.spec(i0, k0, 'dome', 6000, 0, 'ドカンドーム');
}

function buildHarbor(
  rng: Rng,
  gridW: number,
  cityRows: number,
  gridD: number,
  add: (b: BuildingSpec) => void,
  occupied: Uint8Array,
): void {
  const k0 = cityRows + 1; // leave one row of apron next to the road
  let i = ROAD_CELLS;
  const centre = Math.floor(gridW / 2);
  // keep a landing gap in front of the kaiju's start position
  const gapStart = centre - 4;
  const gapEnd = centre + 4;
  const end = gridW - ROAD_CELLS;
  while (i < end - 2) {
    if (i >= gapStart && i < gapEnd) {
      i = gapEnd;
      continue;
    }
    const limit = i < gapStart ? gapStart : end;
    const avail = limit - i;
    if (avail < 3) {
      i = limit === gapStart ? gapEnd : end;
      continue;
    }
    const roll = rng.next();
    if (roll < 0.35 && avail >= 4) {
      // warehouse
      const w = Math.min(rng.int(6, 10), avail);
      const d = rng.int(4, 5);
      const h = rng.int(2, 3);
      const b = new BuildingBuilder(w, d, h);
      const col = rng.pick(PAL.warehouse);
      b.fill(0, 0, 0, w - 1, h - 1, d - 1, (y) => tint(col, y === h - 1 ? 0.92 : 1), () => STYLE.WAREHOUSE);
      add(b.spec(i, k0, 'warehouse', 0, 0));
      i += w + rng.int(1, 3);
    } else if (roll < 0.75 || avail < 5) {
      // container yard: rows of 1x3 stacks
      const yardW = Math.min(rng.int(6, 9), avail);
      for (let row = 0; row < 2; row++) {
        const zOff = k0 + row * 4;
        for (let x = 0; x < yardW; x += 1) {
          if (rng.chance(0.2)) continue;
          const h = rng.int(1, 3);
          const b = new BuildingBuilder(1, 3, h);
          for (let y = 0; y < h; y++) {
            const c = rng.pick(PAL.container);
            for (let z = 0; z < 3; z++) b.set(0, y, z, c, STYLE.CONTAINER);
          }
          add(b.spec(i + x, zOff, 'container', 0, 0));
        }
      }
      i += yardW + rng.int(1, 2);
    } else {
      // gantry crane at the water's edge
      const w = 5;
      const kc = gridD - 3;
      const h = 10;
      const b = new BuildingBuilder(w, 2, h);
      const col = rng.chance(0.5) ? 0xd9412f : 0xe0b020;
      for (const x of [0, w - 1]) for (let z = 0; z < 2; z++) for (let y = 0; y < 7; y++) b.set(x, y, z, col, STYLE.LATTICE);
      b.fill(0, 7, 0, w - 1, 7, 1, () => col, () => STYLE.LATTICE);
      b.fill(1, 8, 0, 3, 8, 1, () => 0xe8e8e8, () => STYLE.PLAIN);
      let free = true;
      for (let x = 0; x < w; x++) for (let z = 0; z < 2; z++) if (occupied[i + x + (kc + z) * gridW]) free = false;
      if (free) add(b.spec(i, kc, 'crane', 1500, 0.9, 'ガントリークレーン'));
      i += w + rng.int(2, 3);
    }
  }
}
