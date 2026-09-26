import * as THREE from 'three';
import { GRAVITY, WATER_LEVEL } from '../config';
import { rand } from '../core/rng';

/** Environment queries debris needs for collisions. */
export interface DebrisWorld {
  /** Terrain height (ground / sea bed). */
  terrainAt(x: number, z: number): number;
  /** Height of the top of the building column at (x, z), 0 if none. */
  colTop(x: number, z: number): number;
  onSplash?(x: number, z: number, size: number): void;
}

const FREE = 0;
const FLYING = 1;
const RESTING = 2;
const SHRINKING = 3;

// sRGB -> linear lookup
const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LUT[i] = c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/**
 * Pool of rigid-ish debris boxes (building chunks, vehicle parts...).
 * Simple integration with ground / rooftop collisions, then they rest and shrink away.
 */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly q: Float32Array;
  private readonly w: Float32Array;
  private readonly s: Float32Array;
  private readonly state: Uint8Array;
  private readonly timer: Float32Array;
  private readonly shrink: Float32Array;
  private cursor = 0;
  active = 0;

  constructor(max = 4500) {
    this.n = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.q = new Float32Array(max * 4);
    this.w = new Float32Array(max * 3);
    this.s = new Float32Array(max * 3);
    this.state = new Uint8Array(max);
    this.timer = new Float32Array(max);
    this.shrink = new Float32Array(max);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    (this.mesh.instanceMatrix.array as Float32Array).fill(0);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'debris';
  }

  /** Spawn one piece. Colour is 0xRRGGBB (sRGB). */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, color: number, spin = 3): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    if (this.state[i] === FREE) this.active++;
    const i3 = i * 3;
    this.p[i3] = x;
    this.p[i3 + 1] = y;
    this.p[i3 + 2] = z;
    this.v[i3] = vx;
    this.v[i3 + 1] = vy;
    this.v[i3 + 2] = vz;
    this.w[i3] = rand(-spin, spin);
    this.w[i3 + 1] = rand(-spin, spin);
    this.w[i3 + 2] = rand(-spin, spin);
    this.s[i3] = sx;
    this.s[i3 + 1] = sy;
    this.s[i3 + 2] = sz;
    // random initial orientation
    const qx = rand(-1, 1);
    const qy = rand(-1, 1);
    const qz = rand(-1, 1);
    const qw = rand(-1, 1);
    const ql = Math.hypot(qx, qy, qz, qw) || 1;
    const i4 = i * 4;
    this.q[i4] = qx / ql;
    this.q[i4 + 1] = qy / ql;
    this.q[i4 + 2] = qz / ql;
    this.q[i4 + 3] = qw / ql;
    this.state[i] = FLYING;
    this.timer[i] = 12;
    this.shrink[i] = 1;
    const col = this.mesh.instanceColor!.array as Float32Array;
    col[i3] = LUT[(color >> 16) & 255];
    col[i3 + 1] = LUT[(color >> 8) & 255];
    col[i3 + 2] = LUT[color & 255];
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Wake resting pieces inside an area (e.g. the roof they were lying on collapsed). */
  wakeArea(minX: number, minZ: number, maxX: number, maxZ: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== RESTING) continue;
      const x = this.p[i * 3];
      const z = this.p[i * 3 + 2];
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ && this.p[i * 3 + 1] > 1.5) {
        this.state[i] = FLYING;
        this.timer[i] = 8;
      }
    }
  }

  update(dt: number, world: DebrisWorld): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    let active = 0;
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      if (st === FREE) continue;
      active++;
      const i3 = i * 3;
      const i4 = i * 4;
      if (st === FLYING) {
        let x = this.p[i3];
        let y = this.p[i3 + 1];
        let z = this.p[i3 + 2];
        const py = y;
        this.v[i3 + 1] -= GRAVITY * dt;
        x += this.v[i3] * dt;
        y += this.v[i3 + 1] * dt;
        z += this.v[i3 + 2] * dt;
        const he = Math.min(this.s[i3], this.s[i3 + 1], this.s[i3 + 2]) * 0.5;
        const terrain = world.terrainAt(x, z);
        let floor = terrain;
        const top = world.colTop(x, z);
        if (top > 0 && py - he >= top - 0.3) floor = Math.max(floor, top);
        if (terrain < WATER_LEVEL - 0.5 && y < WATER_LEVEL && py >= WATER_LEVEL) {
          if (this.s[i3] > 1.2 && world.onSplash && Math.random() < 0.5) world.onSplash(x, z, this.s[i3] * 1.6);
        }
        if (y - he < floor) {
          y = floor + he;
          const vy = this.v[i3 + 1];
          if (vy < 0) this.v[i3 + 1] = -vy * 0.28;
          this.v[i3] *= 0.55;
          this.v[i3 + 2] *= 0.55;
          this.w[i3] *= 0.55;
          this.w[i3 + 1] *= 0.55;
          this.w[i3 + 2] *= 0.55;
          const sp = Math.abs(this.v[i3]) + Math.abs(this.v[i3 + 1]) + Math.abs(this.v[i3 + 2]);
          if (sp < 2.2) {
            this.state[i] = floor < WATER_LEVEL ? SHRINKING : RESTING;
            this.timer[i] = floor < WATER_LEVEL ? 0.6 : rand(3.5, 7.5);
          }
        }
        this.p[i3] = x;
        this.p[i3 + 1] = y;
        this.p[i3 + 2] = z;
        // integrate rotation
        const wx = this.w[i3];
        const wy = this.w[i3 + 1];
        const wz = this.w[i3 + 2];
        let qx = this.q[i4];
        let qy = this.q[i4 + 1];
        let qz = this.q[i4 + 2];
        let qw = this.q[i4 + 3];
        const h = 0.5 * dt;
        const nx = qx + h * (wx * qw + wy * qz - wz * qy);
        const ny = qy + h * (wy * qw + wz * qx - wx * qz);
        const nz = qz + h * (wz * qw + wx * qy - wy * qx);
        const nw = qw + h * (-wx * qx - wy * qy - wz * qz);
        const l = Math.hypot(nx, ny, nz, nw) || 1;
        qx = nx / l;
        qy = ny / l;
        qz = nz / l;
        qw = nw / l;
        this.q[i4] = qx;
        this.q[i4 + 1] = qy;
        this.q[i4 + 2] = qz;
        this.q[i4 + 3] = qw;
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.state[i] = SHRINKING;
          this.timer[i] = 0.8;
        }
      } else if (st === RESTING) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.state[i] = SHRINKING;
          this.timer[i] = 1.2;
        }
        continue; // matrix unchanged
      } else if (st === SHRINKING) {
        this.timer[i] -= dt;
        this.shrink[i] = Math.max(0, this.timer[i] / 1.2);
        this.p[i3 + 1] -= dt * 0.6;
        if (this.timer[i] <= 0) {
          this.state[i] = FREE;
          for (let k = 0; k < 16; k++) m[i * 16 + k] = 0;
          continue;
        }
      }
      writeMatrix(m, i * 16, this.p, i3, this.q, i4, this.s[i3] * this.shrink[i], this.s[i3 + 1] * this.shrink[i], this.s[i3 + 2] * this.shrink[i]);
    }
    this.active = active;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.state.fill(FREE);
    (this.mesh.instanceMatrix.array as Float32Array).fill(0);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.active = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** Compose a TRS matrix directly into a Float32Array (column-major, like three.js). */
export function writeMatrix(
  m: Float32Array,
  o: number,
  p: ArrayLike<number>,
  pi: number,
  q: ArrayLike<number>,
  qi: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const x = q[qi];
  const y = q[qi + 1];
  const z = q[qi + 2];
  const w = q[qi + 3];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  m[o] = (1 - (yy + zz)) * sx;
  m[o + 1] = (xy + wz) * sx;
  m[o + 2] = (xz - wy) * sx;
  m[o + 3] = 0;
  m[o + 4] = (xy - wz) * sy;
  m[o + 5] = (1 - (xx + zz)) * sy;
  m[o + 6] = (yz + wx) * sy;
  m[o + 7] = 0;
  m[o + 8] = (xz + wy) * sz;
  m[o + 9] = (yz - wx) * sz;
  m[o + 10] = (1 - (xx + yy)) * sz;
  m[o + 11] = 0;
  m[o + 12] = p[pi];
  m[o + 13] = p[pi + 1];
  m[o + 14] = p[pi + 2];
  m[o + 15] = 1;
}
