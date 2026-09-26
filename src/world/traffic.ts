import * as THREE from 'three';
import { GRAVITY } from '../config';
import { damp } from '../core/math';
import { rand } from '../core/rng';
import type { Particles } from '../fx/particles';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Car {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
  heading: number;
  ni: number;
  nj: number;
  pi: number;
  pj: number;
  speed: number;
  state: 0 | 1 | 2; // driving, flying, wreck
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotZ: number;
  spinX: number;
  spinZ: number;
  t: number;
}

const CAR_COLORS = [0xe8e8e8, 0x202428, 0xb22222, 0x1f4e8c, 0xd9d9d0, 0x6b6f74, 0xd8b030, 0x2f6b3a, 0xf0f0f0, 0x8a1c2b];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(2.2, 1.1, 4.6);
  body.translate(0, 0.85, 0);
  const cabin = new THREE.BoxGeometry(1.9, 0.9, 2.4);
  cabin.translate(0, 1.8, -0.3);
  const paint = (g: THREE.BufferGeometry, r: number, gg: number, b: number) => {
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = r;
      c[i * 3 + 1] = gg;
      c[i * 3 + 2] = b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  };
  paint(body, 1, 1, 1);
  paint(cabin, 0.22, 0.25, 0.3);
  return mergeGeometries([body, cabin])!;
}

export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  private readonly cars: Car[] = [];
  destroyed = 0;

  constructor(
    private readonly roadX: number[],
    private readonly roadZ: number[],
    count: number,
    private readonly fx: Particles,
    private readonly onDestroyed: (x: number, y: number, z: number) => void,
  ) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.3, vertexColors: true });
    this.mesh = new THREE.InstancedMesh(carGeometry(), mat, count);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const nx = roadX.length;
    const nz = roadZ.length;
    for (let i = 0; i < count; i++) {
      const ni = Math.floor(Math.random() * nx);
      const nj = Math.floor(Math.random() * (nz - 1));
      // start somewhere along a segment
      const horizontal = Math.random() < 0.5 && ni < nx - 1;
      const pi = ni;
      const pj = nj;
      const ti = horizontal ? ni + 1 : ni;
      const tj = horizontal ? nj : Math.min(nz - 1, nj + 1);
      const u = Math.random();
      const x = roadX[pi] + (roadX[ti] - roadX[pi]) * u;
      const z = roadZ[pj] + (roadZ[tj] - roadZ[pj]) * u;
      this.cars.push({
        x,
        y: 0,
        z,
        rx: x,
        rz: z,
        heading: Math.atan2(roadX[ti] - roadX[pi], roadZ[tj] - roadZ[pj]),
        ni: ti,
        nj: tj,
        pi,
        pj,
        speed: rand(9, 14),
        state: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: 0,
        rotZ: 0,
        spinX: 0,
        spinZ: 0,
        t: 0,
      });
      this.mesh.setColorAt(i, _c.setHex(CAR_COLORS[i % CAR_COLORS.length]));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Launch cars caught in a blast. */
  damageSphere(x: number, y: number, z: number, r: number, force: number): number {
    let n = 0;
    for (const c of this.cars) {
      if (c.state !== 0) continue;
      const d = Math.hypot(c.rx - x, c.y + 1 - y, c.rz - z);
      if (d > r + 2) continue;
      let ox = c.rx - x;
      let oz = c.rz - z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      c.state = 1;
      c.vx = ox * force * rand(0.6, 1.2);
      c.vz = oz * force * rand(0.6, 1.2);
      c.vy = rand(8, 16) + force * 0.3;
      c.spinX = rand(-6, 6);
      c.spinZ = rand(-6, 6);
      c.t = 0;
      n++;
    }
    return n;
  }

  update(dt: number, kx: number, kz: number): void {
    const { roadX, roadZ } = this;
    const nx = roadX.length;
    const nz = roadZ.length;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      c.t += dt;
      if (c.state === 0) {
        const tx = roadX[c.ni];
        const tz = roadZ[c.nj];
        const dx = tx - c.x;
        const dz = tz - c.z;
        const d = Math.hypot(dx, dz);
        const kd = Math.hypot(kx - c.x, kz - c.z);
        const flee = kd < 110;
        const sp = (flee ? 19 : c.speed) * dt;
        if (d <= sp) {
          c.x = tx;
          c.z = tz;
          const opts: [number, number][] = [];
          if (c.ni > 0) opts.push([c.ni - 1, c.nj]);
          if (c.ni < nx - 1) opts.push([c.ni + 1, c.nj]);
          if (c.nj > 0) opts.push([c.ni, c.nj - 1]);
          if (c.nj < nz - 1) opts.push([c.ni, c.nj + 1]);
          let choices = opts.filter((o) => !(o[0] === c.pi && o[1] === c.pj));
          if (choices.length === 0) choices = opts;
          let pick = choices[Math.floor(Math.random() * choices.length)];
          if (flee) {
            let best = -Infinity;
            for (const o of choices) {
              const od = Math.hypot(roadX[o[0]] - kx, roadZ[o[1]] - kz) + rand(0, 20);
              if (od > best) {
                best = od;
                pick = o;
              }
            }
          }
          c.pi = c.ni;
          c.pj = c.nj;
          c.ni = pick[0];
          c.nj = pick[1];
        } else {
          c.x += (dx / d) * sp;
          c.z += (dz / d) * sp;
          const want = Math.atan2(dx, dz);
          c.heading = want;
        }
        // keep left (Japanese traffic)
        const hx = Math.sin(c.heading);
        const hz = Math.cos(c.heading);
        const lx = c.x + hz * 2.8;
        const lz = c.z - hx * 2.8;
        const k = damp(6, dt);
        c.rx += (lx - c.rx) * k;
        c.rz += (lz - c.rz) * k;
      } else if (c.state === 1) {
        c.vy -= GRAVITY * dt;
        c.rx += c.vx * dt;
        c.y += c.vy * dt;
        c.rz += c.vz * dt;
        c.rotX += c.spinX * dt;
        c.rotZ += c.spinZ * dt;
        if (c.y <= 0 && c.vy < 0) {
          c.y = 0;
          c.state = 2;
          c.rotX = Math.round(c.rotX / Math.PI) * Math.PI;
          c.rotZ = 0;
          this.mesh.setColorAt(i, _c.setHex(0x1c1a19));
          if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
          this.fx.explosion(c.rx, 1.5, c.rz, 4.5);
          this.fx.addPlume(c.rx, 1, c.rz, 2, 7, true);
          this.destroyed++;
          this.onDestroyed(c.rx, 2, c.rz);
        }
      }
      _e.set(c.rotX, c.heading, c.rotZ);
      _q.setFromEuler(_e);
      _p.set(c.rx, c.y + (c.state === 2 && Math.abs(c.rotX) > 1 ? 2.2 : 0), c.rz);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
