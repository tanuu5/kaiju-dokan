import * as THREE from 'three';
import { CHUNK, FLOOR, MAX_FLOORS } from '../config';
import { rand } from '../core/rng';
import type { Particles } from '../fx/particles';
import { createBuildingMaterial } from './buildingMaterial';
import { STYLE, tint, type BuildingSpec, type CityLayout } from './cityGen';
import { writeMatrix, type Debris } from './debris';
import { decideCollapse } from './structure';

export interface BuildingState {
  id: number;
  spec: BuildingSpec;
  /** World min corner of the footprint. */
  x0: number;
  z0: number;
  w: number;
  d: number;
  h: number;
  /** Cell -> instance index (-1 = empty). */
  inst: Int32Array;
  alive: Uint8Array;
  aliveCount: number;
  total: number;
  groundAlive: number;
  groundTotal: number;
  /** 0 standing, 1 collapsing, 2 gone. */
  state: number;
  cx: number;
  cz: number;
  stamp: number;
  /** Counts towards the "buildings destroyed" tally (containers don't). */
  countable: boolean;
}

export interface DamageOpts {
  /** Debris launch speed. */
  force?: number;
  /** Extra push direction (unit vector) applied to debris. */
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  /** Vertical radius multiplier (ellipsoid). */
  scaleY?: number;
  /** Where the blow came from – buildings topple away from it. */
  srcX?: number;
  srcZ?: number;
  /** Building id to ignore (a toppling building doesn't hit itself). */
  ignore?: number;
  /** Blacken nearby surviving chunks. */
  soot?: number;
  /** Fraction of debris to spawn (performance knob). */
  debris?: number;
}

export interface BuildingHooks {
  onChunks(n: number, x: number, y: number, z: number): void;
  onCollapse(b: BuildingState, x: number, z: number): void;
  onImpact(x: number, y: number, z: number, size: number): void;
  onFinish(b: BuildingState, x: number, z: number, radius: number): void;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  building: number;
}

interface Collapse {
  b: BuildingState;
  topple: boolean;
  t: number;
  offset: number;
  vel: number;
  angle: number;
  angVel: number;
  maxAngle: number;
  axisX: number;
  axisZ: number;
  pivotX: number;
  pivotZ: number;
  dirX: number;
  dirZ: number;
  L: number;
  cells: number[];
  base: Float32Array;
  gone: Uint8Array;
  remaining: number;
  frame: number;
  dustAcc: number;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _col = new THREE.Color();
const QARR = new Float32Array(4);
const PARR = new Float32Array(3);

/** Persistent rubble mounds left behind by collapsed buildings. */
class Rubble {
  readonly mesh: THREE.InstancedMesh;
  private count = 0;

  constructor(private readonly max = 3500) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rubble';
  }

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, tilt: number, color: number): void {
    const i = this.count < this.max ? this.count++ : Math.floor(Math.random() * this.max);
    _euler.set(tilt * rand(-1, 1), yaw, tilt * rand(-1, 1));
    _q.setFromEuler(_euler);
    _m.compose(_pos.set(x, y, z), _q, _scale.set(sx, sy, sz));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, _col.setHex(color));
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** Scratch buffer of chunks destroyed in the current damage call. */
const BROKEN_MAX = 2048;
const brokenPos = new Float32Array(BROKEN_MAX * 3);
const brokenCol = new Uint32Array(BROKEN_MAX);
const brokenGlass = new Uint8Array(BROKEN_MAX);

export class Buildings {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  readonly list: BuildingState[] = [];
  readonly rubble = new Rubble();
  readonly totalChunks: number;
  readonly countableTotal: number;
  destroyedChunks = 0;
  collapsedCount = 0;

  private readonly owner: Int32Array;
  private readonly top: Float32Array;
  private readonly styleAttr: THREE.InstancedBufferAttribute;
  private readonly matArr: Float32Array;
  private mDirtyMin = Infinity;
  private mDirtyMax = -1;
  private sDirtyMin = Infinity;
  private sDirtyMax = -1;
  private collapses: Collapse[] = [];
  private stampCounter = 1;
  private brokenCount = 0;

  constructor(
    private readonly city: CityLayout,
    private readonly debris: Debris,
    private readonly fx: Particles,
    private readonly hooks: BuildingHooks,
  ) {
    let total = 0;
    for (const s of city.buildings) for (let i = 0; i < s.solid.length; i++) total += s.solid[i];
    this.totalChunks = total;

    const geo = new THREE.BoxGeometry(CHUNK, FLOOR, CHUNK);
    const styleArr = new Float32Array(total * 4);
    this.styleAttr = new THREE.InstancedBufferAttribute(styleArr, 4);
    this.styleAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStyle', this.styleAttr);
    this.mesh = new THREE.InstancedMesh(geo, createBuildingMaterial(), total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'buildings';
    this.matArr = this.mesh.instanceMatrix.array as Float32Array;

    this.owner = new Int32Array(city.gridW * city.gridD).fill(-1);
    this.top = new Float32Array(city.gridW * city.gridD);

    let next = 0;
    let countable = 0;
    city.buildings.forEach((spec, id) => {
      const n = spec.w * spec.d * spec.h;
      const b: BuildingState = {
        id,
        spec,
        x0: city.originX + spec.i0 * CHUNK,
        z0: city.originZ + spec.k0 * CHUNK,
        w: spec.w,
        d: spec.d,
        h: spec.h,
        inst: new Int32Array(n).fill(-1),
        alive: new Uint8Array(n),
        aliveCount: 0,
        total: 0,
        groundAlive: 0,
        groundTotal: 0,
        state: 0,
        cx: city.originX + (spec.i0 + spec.w / 2) * CHUNK,
        cz: city.originZ + (spec.k0 + spec.d / 2) * CHUNK,
        stamp: 0,
        countable: spec.kind !== 'container',
      };
      if (b.countable) countable++;
      const seedBase = Math.random();
      const lit = spec.kind === 'warehouse' || spec.kind === 'container' ? 0 : rand(0.06, 0.3);
      for (let c = 0; c < n; c++) {
        if (!spec.solid[c]) continue;
        const y = Math.floor(c / (spec.w * spec.d));
        const r = c - y * spec.w * spec.d;
        const z = Math.floor(r / spec.w);
        const x = r - z * spec.w;
        const i = next++;
        b.inst[c] = i;
        b.alive[c] = 1;
        b.aliveCount++;
        b.total++;
        if (y === 0) {
          b.groundAlive++;
          b.groundTotal++;
        }
        const o = i * 16;
        this.matArr[o] = 1;
        this.matArr[o + 5] = 1;
        this.matArr[o + 10] = 1;
        this.matArr[o + 15] = 1;
        this.matArr[o + 12] = b.x0 + (x + 0.5) * CHUNK;
        this.matArr[o + 13] = (y + 0.5) * FLOOR;
        this.matArr[o + 14] = b.z0 + (z + 0.5) * CHUNK;
        this.mesh.setColorAt(i, _col.setHex(spec.color[c]));
        styleArr[i * 4] = spec.style[c];
        styleArr[i * 4 + 1] = (seedBase + y * 0.1234567 + x * 0.013 + z * 0.0071) % 1;
        styleArr[i * 4 + 2] = 0;
        styleArr[i * 4 + 3] = lit;
        const cell = spec.i0 + x + (spec.k0 + z) * city.gridW;
        this.owner[cell] = id;
        this.top[cell] = Math.max(this.top[cell], (y + 1) * FLOOR);
      }
      this.list.push(b);
    });
    this.countableTotal = countable;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.group.add(this.mesh, this.rubble.mesh);
  }

  get destructionRatio(): number {
    return this.totalChunks > 0 ? this.destroyedChunks / this.totalChunks : 0;
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  private cellIndex(x: number, z: number): number {
    const i = Math.floor((x - this.city.originX) / CHUNK);
    const k = Math.floor((z - this.city.originZ) / CHUNK);
    if (i < 0 || k < 0 || i >= this.city.gridW || k >= this.city.gridD) return -1;
    return i + k * this.city.gridW;
  }

  /** Height of the top of the building column at (x, z), 0 if none. */
  colTop(x: number, z: number): number {
    const c = this.cellIndex(x, z);
    return c < 0 ? 0 : this.top[c];
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    const c = this.cellIndex(x, z);
    if (c < 0 || y < 0) return false;
    if (y >= this.top[c]) return false;
    const i = c % this.city.gridW;
    const k = Math.floor(c / this.city.gridW);
    return this.solidCell(i, Math.floor(y / FLOOR), k);
  }

  private solidCell(i: number, fy: number, k: number): boolean {
    const id = this.owner[i + k * this.city.gridW];
    if (id < 0) return false;
    const b = this.list[id];
    if (b.state !== 0 || fy < 0 || fy >= b.h) return false;
    const lx = i - b.spec.i0;
    const lz = k - b.spec.k0;
    return b.alive[lx + lz * b.w + fy * b.w * b.d] === 1;
  }

  /** Voxel DDA ray cast against standing chunks. Direction must be normalised. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: RayHit): boolean {
    const { originX, originZ, gridW, gridD } = this.city;
    const minB = [originX, 0, originZ];
    const maxB = [originX + gridW * CHUNK, MAX_FLOORS * FLOOR, originZ + gridD * CHUNK];
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];
    let t0 = 0;
    let t1 = maxDist;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < minB[a] || o[a] > maxB[a]) return false;
      } else {
        let ta = (minB[a] - o[a]) / d[a];
        let tb = (maxB[a] - o[a]) / d[a];
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
      }
    }
    const size = [CHUNK, FLOOR, CHUNK];
    const lim = [gridW, MAX_FLOORS, gridD];
    const tStart = t0 + 1e-4;
    const cell = [0, 0, 0];
    const step = [0, 0, 0];
    const tMax = [Infinity, Infinity, Infinity];
    const tDelta = [Infinity, Infinity, Infinity];
    for (let a = 0; a < 3; a++) {
      const p = o[a] + d[a] * tStart - minB[a];
      cell[a] = Math.min(lim[a] - 1, Math.max(0, Math.floor(p / size[a])));
      if (d[a] > 0) {
        step[a] = 1;
        tDelta[a] = size[a] / d[a];
        tMax[a] = tStart + ((cell[a] + 1) * size[a] - p) / d[a];
      } else if (d[a] < 0) {
        step[a] = -1;
        tDelta[a] = -size[a] / d[a];
        tMax[a] = tStart + (cell[a] * size[a] - p) / d[a];
      }
    }
    let t = t0;
    for (let guard = 0; guard < 1024 && t <= t1; guard++) {
      if (this.solidCell(cell[0], cell[1], cell[2])) {
        out.t = t;
        out.x = ox + dx * t;
        out.y = oy + dy * t;
        out.z = oz + dz * t;
        out.building = this.owner[cell[0] + cell[2] * gridW];
        return true;
      }
      let a = 0;
      if (tMax[1] < tMax[a]) a = 1;
      if (tMax[2] < tMax[a]) a = 2;
      t = tMax[a];
      cell[a] += step[a];
      if (cell[a] < 0 || cell[a] >= lim[a]) return false;
      tMax[a] += tDelta[a];
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Damage
  // ------------------------------------------------------------------

  /** Destroy chunks within a sphere/ellipsoid. Returns the number of chunks destroyed. */
  damageSphere(x: number, y: number, z: number, r: number, o: DamageOpts = {}): number {
    const { originX, originZ, gridW, gridD } = this.city;
    const sy = o.scaleY ?? 1;
    const ry = r * sy;
    const i0 = Math.max(0, Math.floor((x - r - originX) / CHUNK));
    const i1 = Math.min(gridW - 1, Math.floor((x + r - originX) / CHUNK));
    const k0 = Math.max(0, Math.floor((z - r - originZ) / CHUNK));
    const k1 = Math.min(gridD - 1, Math.floor((z + r - originZ) / CHUNK));
    if (i0 > i1 || k0 > k1 || y + ry < 0) return 0;
    const stamp = ++this.stampCounter;
    const touched: BuildingState[] = [];
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const id = this.owner[i + k * gridW];
        if (id < 0) continue;
        const b = this.list[id];
        if (b.stamp === stamp || b.state !== 0 || id === o.ignore) continue;
        b.stamp = stamp;
        touched.push(b);
      }
    }
    if (touched.length === 0) return 0;
    this.brokenCount = 0;
    let destroyed = 0;
    for (const b of touched) {
      const lx0 = Math.max(0, i0 - b.spec.i0);
      const lx1 = Math.min(b.w - 1, i1 - b.spec.i0);
      const lz0 = Math.max(0, k0 - b.spec.k0);
      const lz1 = Math.min(b.d - 1, k1 - b.spec.k0);
      const ly0 = Math.max(0, Math.floor((y - ry) / FLOOR));
      const ly1 = Math.min(b.h - 1, Math.floor((y + ry) / FLOOR));
      if (ly0 > ly1) continue;
      let n = 0;
      for (let ly = ly0; ly <= ly1; ly++) {
        const wy = (ly + 0.5) * FLOOR;
        const dy = (wy - y) / sy;
        for (let lz = lz0; lz <= lz1; lz++) {
          const wz = b.z0 + (lz + 0.5) * CHUNK;
          const dz = wz - z;
          for (let lx = lx0; lx <= lx1; lx++) {
            const c = lx + lz * b.w + ly * b.w * b.d;
            if (!b.alive[c]) continue;
            const wx = b.x0 + (lx + 0.5) * CHUNK;
            const dx = wx - x;
            const rr = r + CHUNK * (Math.random() * 0.5 - 0.15);
            if (dx * dx + dy * dy + dz * dz < rr * rr) {
              this.breakChunk(b, c, lx, lz, wx, wy, wz);
              n++;
            }
          }
        }
      }
      if (n > 0) {
        destroyed += n;
        this.checkStructure(b, o.srcX ?? x, o.srcZ ?? z);
      }
    }
    if (destroyed > 0) {
      this.spawnBrokenFx(x, y, z, o);
      this.hooks.onChunks(destroyed, x, y, z);
    }
    if (o.soot) this.applySoot(x, y, z, r * 1.8, o.soot);
    return destroyed;
  }

  private breakChunk(b: BuildingState, c: number, lx: number, lz: number, wx: number, wy: number, wz: number): void {
    const inst = b.inst[c];
    b.inst[c] = -1;
    b.alive[c] = 0;
    b.aliveCount--;
    if (c < b.w * b.d) b.groundAlive--;
    this.hideInstance(inst);
    this.destroyedChunks++;
    this.refreshColumn(b, lx, lz);
    if (this.brokenCount < BROKEN_MAX) {
      const k = this.brokenCount++;
      brokenPos[k * 3] = wx;
      brokenPos[k * 3 + 1] = wy;
      brokenPos[k * 3 + 2] = wz;
      brokenCol[k] = b.spec.color[c];
      const st = b.spec.style[c];
      brokenGlass[k] = st === STYLE.GLASS || st === STYLE.OFFICE || st === STYLE.SHOP ? 1 : 0;
    }
  }

  private spawnBrokenFx(x: number, y: number, z: number, o: DamageOpts): void {
    const n = this.brokenCount;
    const f = o.force ?? 12;
    const frac = (o.debris ?? 1) * Math.min(1, 70 / Math.max(1, n));
    const dustFrac = Math.min(0.6, 18 / Math.max(1, n));
    for (let k = 0; k < n; k++) {
      const wx = brokenPos[k * 3];
      const wy = brokenPos[k * 3 + 1];
      const wz = brokenPos[k * 3 + 2];
      const color = brokenCol[k];
      let rx = wx - x;
      let ry = wy - y;
      let rz = wz - z;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl;
      ry /= rl;
      rz /= rl;
      if (Math.random() < frac) {
        const vx = rx * f * rand(0.35, 1) + (o.dirX ?? 0) * f * 0.7 + rand(-3, 3);
        const vy = ry * f * rand(0.2, 0.6) + (o.dirY ?? 0) * f * 0.5 + rand(3, 10);
        const vz = rz * f * rand(0.35, 1) + (o.dirZ ?? 0) * f * 0.7 + rand(-3, 3);
        this.debris.spawn(wx, wy, wz, vx, vy, vz, CHUNK * rand(0.45, 0.8), FLOOR * rand(0.35, 0.7), CHUNK * rand(0.45, 0.8), tint(color, rand(0.75, 1)));
        if (Math.random() < 0.7) {
          this.debris.spawn(
            wx + rand(-1, 1),
            wy + rand(-1, 1),
            wz + rand(-1, 1),
            vx * rand(0.8, 1.4) + rand(-4, 4),
            vy * rand(0.8, 1.3),
            vz * rand(0.8, 1.4) + rand(-4, 4),
            rand(0.7, 1.7),
            rand(0.5, 1.2),
            rand(0.7, 1.7),
            tint(color, rand(0.6, 0.9)),
            6,
          );
        }
      }
      if (Math.random() < dustFrac) this.fx.dust(wx, wy, wz, 3.5, 1, mixDust(color));
      if (brokenGlass[k] && Math.random() < frac * 0.6) {
        for (let g = 0; g < 2; g++) {
          this.fx.glow.emit({
            x: wx,
            y: wy,
            z: wz,
            vx: rx * rand(4, 12) + rand(-3, 3),
            vy: rand(2, 9),
            vz: rz * rand(4, 12) + rand(-3, 3),
            life: rand(0.6, 1.3),
            size0: rand(0.5, 0.9),
            size1: 0.2,
            color0: 0xd8eeff,
            color1: 0x6080a0,
            alpha: 0.8,
            drag: 0.3,
            gravity: -22,
            spin: 0,
          });
        }
      }
    }
    this.brokenCount = 0;
  }

  private applySoot(x: number, y: number, z: number, R: number, amount: number): void {
    const { originX, originZ, gridW, gridD } = this.city;
    const i0 = Math.max(0, Math.floor((x - R - originX) / CHUNK));
    const i1 = Math.min(gridW - 1, Math.floor((x + R - originX) / CHUNK));
    const k0 = Math.max(0, Math.floor((z - R - originZ) / CHUNK));
    const k1 = Math.min(gridD - 1, Math.floor((z + R - originZ) / CHUNK));
    const arr = this.styleAttr.array as Float32Array;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const id = this.owner[i + k * gridW];
        if (id < 0) continue;
        const b = this.list[id];
        if (b.state !== 0) continue;
        const lx = i - b.spec.i0;
        const lz = k - b.spec.k0;
        const wx = b.x0 + (lx + 0.5) * CHUNK;
        const wz = b.z0 + (lz + 0.5) * CHUNK;
        const ly0 = Math.max(0, Math.floor((y - R) / FLOOR));
        const ly1 = Math.min(b.h - 1, Math.floor((y + R) / FLOOR));
        for (let ly = ly0; ly <= ly1; ly++) {
          const c = lx + lz * b.w + ly * b.w * b.d;
          const inst = b.inst[c];
          if (inst < 0) continue;
          const d = Math.hypot(wx - x, (ly + 0.5) * FLOOR - y, wz - z);
          if (d >= R) continue;
          const s = arr[inst * 4 + 2];
          arr[inst * 4 + 2] = Math.min(1, s + amount * (1 - d / R));
          if (inst < this.sDirtyMin) this.sDirtyMin = inst;
          if (inst > this.sDirtyMax) this.sDirtyMax = inst;
        }
      }
    }
  }

  private hideInstance(inst: number): void {
    const o = inst * 16;
    for (let k = 0; k < 16; k++) this.matArr[o + k] = 0;
    if (inst < this.mDirtyMin) this.mDirtyMin = inst;
    if (inst > this.mDirtyMax) this.mDirtyMax = inst;
  }

  private refreshColumn(b: BuildingState, lx: number, lz: number): void {
    let t = 0;
    for (let y = b.h - 1; y >= 0; y--) {
      if (b.alive[lx + lz * b.w + y * b.w * b.d]) {
        t = (y + 1) * FLOOR;
        break;
      }
    }
    this.top[b.spec.i0 + lx + (b.spec.k0 + lz) * this.city.gridW] = t;
  }

  private checkStructure(b: BuildingState, srcX: number, srcZ: number): void {
    if (b.aliveCount <= 0) {
      // pulverised chunk by chunk: count it as destroyed
      this.startCollapse(b, srcX, srcZ);
      return;
    }
    const dec = decideCollapse(b.alive, b.w, b.d, b.h, {
      alive: b.aliveCount,
      total: b.total,
      groundAlive: b.groundAlive,
      groundTotal: b.groundTotal,
    });
    if (dec.collapse) {
      this.startCollapse(b, srcX, srcZ);
      return;
    }
    if (dec.drop.length === 0) return;
    const layer = b.w * b.d;
    for (const c of dec.drop) {
      const y = Math.floor(c / layer);
      const r = c - y * layer;
      const lz = Math.floor(r / b.w);
      const lx = r - lz * b.w;
      const wx = b.x0 + (lx + 0.5) * CHUNK;
      const wy = (y + 0.5) * FLOOR;
      const wz = b.z0 + (lz + 0.5) * CHUNK;
      const color = b.spec.color[c];
      const inst = b.inst[c];
      b.inst[c] = -1;
      b.alive[c] = 0;
      b.aliveCount--;
      this.hideInstance(inst);
      this.destroyedChunks++;
      this.refreshColumn(b, lx, lz);
      this.debris.spawn(wx, wy, wz, rand(-1, 1), 0, rand(-1, 1), CHUNK * 0.9, FLOOR * 0.85, CHUNK * 0.9, color, 1);
    }
  }

  private startCollapse(b: BuildingState, srcX: number, srcZ: number): void {
    if (b.state !== 0) return;
    b.state = 1;
    this.destroyedChunks += b.aliveCount;
    if (b.countable) this.collapsedCount++;
    // columns no longer block debris
    for (let lz = 0; lz < b.d; lz++) for (let lx = 0; lx < b.w; lx++) this.top[b.spec.i0 + lx + (b.spec.k0 + lz) * this.city.gridW] = 0;
    this.debris.wakeArea(b.x0 - 1, b.z0 - 1, b.x0 + b.w * CHUNK + 1, b.z0 + b.d * CHUNK + 1);

    const cells: number[] = [];
    for (let c = 0; c < b.alive.length; c++) if (b.alive[c]) cells.push(c);
    if (cells.length === 0) {
      b.state = 2;
      this.hooks.onCollapse(b, b.cx, b.cz);
      this.hooks.onFinish(b, b.cx, b.cz, (Math.max(b.w, b.d) * CHUNK) / 2);
      return;
    }
    const base = new Float32Array(cells.length * 3);
    const layer = b.w * b.d;
    let maxY = 0;
    cells.forEach((c, j) => {
      const y = Math.floor(c / layer);
      const r = c - y * layer;
      const lz = Math.floor(r / b.w);
      const lx = r - lz * b.w;
      base[j * 3] = b.x0 + (lx + 0.5) * CHUNK;
      base[j * 3 + 1] = (y + 0.5) * FLOOR;
      base[j * 3 + 2] = b.z0 + (lz + 0.5) * CHUNK;
      maxY = Math.max(maxY, (y + 1) * FLOOR);
    });

    let dirX = b.cx - srcX;
    let dirZ = b.cz - srcZ;
    const dl = Math.hypot(dirX, dirZ);
    if (dl < 0.01) {
      const a = Math.random() * Math.PI * 2;
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
    } else {
      dirX /= dl;
      dirZ /= dl;
    }
    // random deviation
    const dev = rand(-0.35, 0.35);
    const cd = Math.cos(dev);
    const sd = Math.sin(dev);
    const ndx = dirX * cd - dirZ * sd;
    const ndz = dirX * sd + dirZ * cd;
    dirX = ndx;
    dirZ = ndz;

    const topple = cells.length >= 6 && maxY >= 24 && Math.random() < b.spec.topple;
    const hw = (b.w * CHUNK) / 2;
    const hd = (b.d * CHUNK) / 2;
    const tEdge = Math.min(Math.abs(dirX) > 1e-4 ? hw / Math.abs(dirX) : Infinity, Math.abs(dirZ) > 1e-4 ? hd / Math.abs(dirZ) : Infinity);
    const pivotX = topple ? b.cx + dirX * tEdge : b.cx;
    const pivotZ = topple ? b.cz + dirZ * tEdge : b.cz;

    this.collapses.push({
      b,
      topple,
      t: 0,
      offset: 0,
      vel: 0,
      angle: 0,
      angVel: topple ? 0.12 : 0,
      maxAngle: topple ? 1.38 : rand(0.08, 0.2),
      axisX: dirZ,
      axisZ: -dirX,
      pivotX,
      pivotZ,
      dirX,
      dirZ,
      L: maxY,
      cells,
      base,
      gone: new Uint8Array(cells.length),
      remaining: cells.length,
      frame: 0,
      dustAcc: 0,
    });
    const rad = Math.max(hw, hd);
    this.fx.dust(b.cx, 2, b.cz, rad * 0.8, Math.min(30, 8 + cells.length / 10), mixDust(b.spec.color[cells[0]] ?? 0x999999), 2);
    this.hooks.onCollapse(b, b.cx, b.cz);
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  update(dt: number): void {
    const n = this.collapses.length;
    for (let ci = 0; ci < n; ci++) {
      const c = this.collapses[ci];
      if (c.topple) this.updateTopple(c, dt);
      else this.updateSink(c, dt);
    }
    this.collapses = this.collapses.filter((c) => c.remaining > 0);
    this.flush();
  }

  private updateSink(c: Collapse, dt: number): void {
    const b = c.b;
    c.t += dt;
    c.vel = Math.min(c.vel + 20 * dt, 17);
    c.offset -= c.vel * dt;
    c.angle = Math.min(c.maxAngle, c.angle + dt * 0.12);
    _axis.set(c.axisX, 0, c.axisZ);
    _q.setFromAxisAngle(_axis, c.angle);
    QARR[0] = _q.x;
    QARR[1] = _q.y;
    QARR[2] = _q.z;
    QARR[3] = _q.w;
    const jx = rand(-0.25, 0.25);
    const jz = rand(-0.25, 0.25);
    for (let j = 0; j < c.cells.length; j++) {
      if (c.gone[j]) continue;
      const inst = b.inst[c.cells[j]];
      _v.set(c.base[j * 3] - c.pivotX, c.base[j * 3 + 1], c.base[j * 3 + 2] - c.pivotZ).applyQuaternion(_q);
      const px = _v.x + c.pivotX + jx;
      const py = _v.y + c.offset;
      const pz = _v.z + c.pivotZ + jz;
      if (py + FLOOR * 0.5 < 0.3) {
        c.gone[j] = 1;
        c.remaining--;
        this.hideInstance(inst);
        if (Math.random() < 0.3) {
          const ox = px - b.cx;
          const oz = pz - b.cz;
          const ol = Math.hypot(ox, oz) || 1;
          const sp = rand(3, 9);
          this.debris.spawn(px, 1.5, pz, (ox / ol) * sp, rand(3, 9), (oz / ol) * sp, CHUNK * rand(0.4, 0.75), FLOOR * rand(0.3, 0.6), CHUNK * rand(0.4, 0.75), tint(b.spec.color[c.cells[j]], rand(0.6, 0.9)));
        }
        continue;
      }
      PARR[0] = px;
      PARR[1] = py;
      PARR[2] = pz;
      writeMatrix(this.matArr, inst * 16, PARR, 0, QARR, 0, 1, 1, 1);
      this.markMatrix(inst);
    }
    // dust skirt
    const perim = (b.w + b.d) * CHUNK;
    c.dustAcc += dt * (18 + perim * 0.9);
    const col = mixDust(b.spec.color[c.cells[0]] ?? 0x999999);
    while (c.dustAcc >= 1) {
      c.dustAcc -= 1;
      const side = Math.random();
      const u = Math.random();
      let x = b.x0;
      let z = b.z0;
      if (side < 0.25) {
        x += u * b.w * CHUNK;
      } else if (side < 0.5) {
        x += u * b.w * CHUNK;
        z += b.d * CHUNK;
      } else if (side < 0.75) {
        z += u * b.d * CHUNK;
      } else {
        x += b.w * CHUNK;
        z += u * b.d * CHUNK;
      }
      const ox = x - b.cx;
      const oz = z - b.cz;
      const ol = Math.hypot(ox, oz) || 1;
      this.fx.smoke.emit({
        x,
        y: rand(1, 6),
        z,
        vx: (ox / ol) * rand(4, 10),
        vy: rand(2, 7),
        vz: (oz / ol) * rand(4, 10),
        life: rand(2.5, 4.5),
        size0: rand(5, 8),
        size1: rand(14, 24),
        color0: col,
        color1: 0x6a625c,
        alpha: rand(0.55, 0.8),
        drag: 0.8,
        gravity: 0.4,
      });
    }
    if (c.remaining <= 0) this.finish(c);
  }

  private updateTopple(c: Collapse, dt: number): void {
    const b = c.b;
    c.t += dt;
    c.frame++;
    const g = 16;
    c.angVel += ((1.5 * g) / Math.max(8, c.L)) * Math.sin(c.angle + 0.06) * dt;
    c.angle += c.angVel * dt;
    c.offset -= 2.2 * dt;
    _axis.set(c.axisX, 0, c.axisZ);
    _q.setFromAxisAngle(_axis, Math.min(c.angle, c.maxAngle));
    QARR[0] = _q.x;
    QARR[1] = _q.y;
    QARR[2] = _q.z;
    QARR[3] = _q.w;
    for (let j = 0; j < c.cells.length; j++) {
      if (c.gone[j]) continue;
      const inst = b.inst[c.cells[j]];
      _v.set(c.base[j * 3] - c.pivotX, c.base[j * 3 + 1], c.base[j * 3 + 2] - c.pivotZ).applyQuaternion(_q);
      PARR[0] = _v.x + c.pivotX;
      PARR[1] = _v.y + c.offset;
      PARR[2] = _v.z + c.pivotZ;
      writeMatrix(this.matArr, inst * 16, PARR, 0, QARR, 0, 1, 1, 1);
      this.markMatrix(inst);
    }
    // base dust
    if (Math.random() < 0.6) this.fx.dust(c.pivotX + rand(-4, 4), 2, c.pivotZ + rand(-4, 4), 5, 1, 0x9a8f84, 2);
    // chain damage along the falling body
    if (c.frame % 3 === 0 && c.angle > 0.25) {
      const sa = Math.sin(Math.min(c.angle, c.maxAngle));
      const ca = Math.cos(Math.min(c.angle, c.maxAngle));
      for (const f of [0.5, 0.75, 1.0]) {
        const s = c.L * f;
        const px = c.pivotX + c.dirX * s * sa;
        const pz = c.pivotZ + c.dirZ * s * sa;
        const py = s * ca + c.offset;
        this.damageSphere(px, py, pz, CHUNK * 1.5, {
          ignore: b.id,
          force: 8 + c.angVel * 6,
          dirX: c.dirX,
          dirY: -0.5,
          dirZ: c.dirZ,
          srcX: c.pivotX,
          srcZ: c.pivotZ,
          debris: 0.6,
        });
      }
    }
    if (c.angle >= c.maxAngle) this.toppleImpact(c);
  }

  private toppleImpact(c: Collapse): void {
    const b = c.b;
    const w = c.angVel;
    const maxSpawn = 240;
    const frac = Math.min(1, maxSpawn / Math.max(1, c.remaining));
    for (let j = 0; j < c.cells.length; j++) {
      if (c.gone[j]) continue;
      const inst = b.inst[c.cells[j]];
      c.gone[j] = 1;
      this.hideInstance(inst);
      if (Math.random() > frac) continue;
      _v.set(c.base[j * 3] - c.pivotX, c.base[j * 3 + 1], c.base[j * 3 + 2] - c.pivotZ).applyQuaternion(_q);
      const px = _v.x + c.pivotX;
      const py = Math.max(1, _v.y + c.offset);
      const pz = _v.z + c.pivotZ;
      // tangential velocity ω × r
      const rx = _v.x;
      const ry = _v.y;
      const rz = _v.z;
      const vx = (0 * rz - c.axisZ * ry) * w * 0.45 + rand(-4, 4);
      const vy = (c.axisZ * rx - c.axisX * rz) * w * 0.2 + rand(2, 9);
      const vz = (c.axisX * ry - 0 * rx) * w * 0.45 + rand(-4, 4);
      this.debris.spawn(px, py, pz, vx, vy, vz, CHUNK * rand(0.5, 0.85), FLOOR * rand(0.4, 0.75), CHUNK * rand(0.5, 0.85), tint(b.spec.color[c.cells[j]], rand(0.7, 1)));
    }
    c.remaining = 0;
    // dust and damage along the landing line
    const col = mixDust(b.spec.color[c.cells[0]] ?? 0x999999);
    for (let s = 0; s <= c.L; s += 6) {
      const px = c.pivotX + c.dirX * s;
      const pz = c.pivotZ + c.dirZ * s;
      this.fx.dust(px, 2, pz, 7, 3, col, 4);
      if (s > c.L * 0.25) {
        this.damageSphere(px, 3, pz, CHUNK * 1.7, {
          ignore: b.id,
          force: 12,
          dirX: c.dirX,
          dirY: 0.2,
          dirZ: c.dirZ,
          srcX: c.pivotX,
          srcZ: c.pivotZ,
          scaleY: 1.3,
          debris: 0.5,
        });
      }
    }
    const mx = c.pivotX + c.dirX * c.L * 0.55;
    const mz = c.pivotZ + c.dirZ * c.L * 0.55;
    this.hooks.onImpact(mx, 2, mz, c.L);
    this.finish(c);
  }

  private finish(c: Collapse): void {
    const b = c.b;
    b.state = 2;
    b.aliveCount = 0;
    // rubble mound
    const n = Math.max(5, Math.min(34, Math.round(b.total / 5)));
    const palette: number[] = [];
    for (let k = 0; k < Math.min(6, c.cells.length); k++) palette.push(b.spec.color[c.cells[Math.floor(Math.random() * c.cells.length)]]);
    if (palette.length === 0) palette.push(0x888888);
    const fw = b.w * CHUNK;
    const fd = b.d * CHUNK;
    for (let k = 0; k < n; k++) {
      let x: number;
      let z: number;
      let hk: number;
      if (c.topple) {
        const s = rand(0, c.L * 0.95);
        const side = rand(-0.5, 0.5) * Math.min(fw, fd) * 0.9;
        x = c.pivotX + c.dirX * s + c.axisX * side;
        z = c.pivotZ + c.dirZ * s + c.axisZ * side;
        hk = 1 - Math.abs(side) / (Math.min(fw, fd) * 0.5 + 1);
      } else {
        const u = rand(-0.5, 0.5);
        const v = rand(-0.5, 0.5);
        x = b.cx + u * fw * 0.95;
        z = b.cz + v * fd * 0.95;
        hk = 1 - Math.max(Math.abs(u), Math.abs(v)) * 1.4;
      }
      const sy = rand(1.2, 3.2) * (0.5 + Math.max(0, hk)) * Math.min(1.6, 0.6 + b.h * 0.08);
      this.rubble.add(x, sy * 0.3, z, rand(2, 5), sy, rand(2, 5), rand(0, Math.PI), 0.35, tint(palette[k % palette.length], rand(0.45, 0.7)));
    }
    const rad = Math.max(fw, fd) * 0.5;
    const ex = c.topple ? c.pivotX + c.dirX * c.L * 0.5 : b.cx;
    const ez = c.topple ? c.pivotZ + c.dirZ * c.L * 0.5 : b.cz;
    this.hooks.onFinish(b, ex, ez, c.topple ? Math.max(rad, c.L * 0.3) : rad);
  }

  private markMatrix(inst: number): void {
    if (inst < this.mDirtyMin) this.mDirtyMin = inst;
    if (inst > this.mDirtyMax) this.mDirtyMax = inst;
  }

  private flush(): void {
    if (this.mDirtyMax >= 0) {
      const a = this.mesh.instanceMatrix;
      a.clearUpdateRanges();
      a.addUpdateRange(this.mDirtyMin * 16, (this.mDirtyMax - this.mDirtyMin + 1) * 16);
      a.needsUpdate = true;
      this.mDirtyMin = Infinity;
      this.mDirtyMax = -1;
    }
    if (this.sDirtyMax >= 0) {
      const a = this.styleAttr;
      a.clearUpdateRanges();
      a.addUpdateRange(this.sDirtyMin * 4, (this.sDirtyMax - this.sDirtyMin + 1) * 4);
      a.needsUpdate = true;
      this.sDirtyMin = Infinity;
      this.sDirtyMax = -1;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.rubble.dispose();
  }
}

/** Blend a building colour towards a dusty beige for dust clouds. */
function mixDust(color: number): number {
  return tint(((((color >> 16) & 255) * 0.35 + 150 * 0.65) << 16) | ((((color >> 8) & 255) * 0.35 + 140 * 0.65) << 8) | ((color & 255) * 0.35 + 128 * 0.65), 1);
}
