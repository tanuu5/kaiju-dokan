import * as THREE from 'three';
import { rand } from '../core/rng';

// Instanced camera-facing quads with a soft "puff" shape. Two layers:
// alpha-blended (dust / smoke / water spray) and additive (fire / sparks / glow).

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aCol;
attribute vec2 aSR;
varying vec4 vCol;
varying vec2 vUv;
varying float vSeed;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vCol = aCol;
  vec4 mvPosition = modelViewMatrix * vec4(aPos, 1.0);
  float c = cos(aSR.y);
  float s = sin(aSR.y);
  vec2 q = position.xy;
  vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  mvPosition.xy += rq * aSR.x;
  vShade = rq.y;
  vSeed = fract(aSR.y * 0.15915);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
varying vec4 vCol;
varying vec2 vUv;
varying float vSeed;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float ang = atan(q.y, q.x + 1e-5);
  float lump = 0.11 * sin(ang * 5.0 + vSeed * 31.0) + 0.07 * sin(ang * 3.0 - vSeed * 17.0);
  float a = 1.0 - smoothstep(0.45 + lump, 1.0 + lump * 0.4, r);
  a *= clamp(vCol.a, 0.0, 1.0);
  if (a < 0.004) discard;
#ifdef ADDITIVE
  float core = 1.0 - smoothstep(0.0, 0.6, r);
  vec3 c = vCol.rgb * (0.7 + core * 0.8);
  #ifdef USE_FOG
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    c *= 1.0 - fogFactor;
  #endif
  gl_FragColor = vec4(max(c, vec3(0.0)), a);
#else
  float shade = 0.82 + 0.4 * vShade;
  gl_FragColor = vec4(max(vCol.rgb * shade, vec3(0.0)), a);
  #include <fog_fragment>
#endif
}`;

export interface EmitOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  color0: number; // 0xRRGGBB (sRGB)
  color1?: number;
  alpha?: number;
  drag?: number;
  /** Vertical acceleration (negative = falls, positive = rises). */
  gravity?: number;
  spin?: number;
}

const tmpC0 = new THREE.Color();
const tmpC1 = new THREE.Color();

class ParticleLayer {
  count = 0;
  readonly mesh: THREE.Mesh;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotV: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly c0: Float32Array; // rgb
  private readonly c1: Float32Array; // rgb
  private readonly a0: Float32Array;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aSR: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(
    readonly max: number,
    additive: boolean,
  ) {
    const f = () => new Float32Array(max);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.s0 = f();
    this.s1 = f();
    this.rot = f();
    this.rotV = f();
    this.drag = f();
    this.grav = f();
    this.a0 = f();
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aSR = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSR.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aSR', this.aSR);
    geo.instanceCount = 0;
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? { ADDITIVE: '' } : {},
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  emit(o: EmitOpts): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max);
    this.px[i] = o.x;
    this.py[i] = o.y;
    this.pz[i] = o.z;
    this.vx[i] = o.vx ?? 0;
    this.vy[i] = o.vy ?? 0;
    this.vz[i] = o.vz ?? 0;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, o.life);
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotV[i] = (o.spin ?? 0.4) * (Math.random() - 0.5) * 2;
    this.drag[i] = o.drag ?? 0.5;
    this.grav[i] = o.gravity ?? 0;
    this.a0[i] = o.alpha ?? 1;
    tmpC0.setHex(o.color0);
    tmpC1.setHex(o.color1 ?? o.color0);
    this.c0[i * 3] = tmpC0.r;
    this.c0[i * 3 + 1] = tmpC0.g;
    this.c0[i * 3 + 2] = tmpC0.b;
    this.c1[i * 3] = tmpC1.r;
    this.c1[i * 3 + 1] = tmpC1.g;
    this.c1[i * 3 + 2] = tmpC1.b;
  }

  update(dt: number): void {
    const P = this.aPos.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const S = this.aSR.array as Float32Array;
    let i = 0;
    while (i < this.count) {
      const a = (this.age[i] += dt);
      const life = this.life[i];
      if (a >= life) {
        this.swapRemove(i);
        continue;
      }
      const t = a / life;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dr;
      this.vy[i] = this.vy[i] * dr + this.grav[i] * dt;
      this.vz[i] *= dr;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotV[i] * dt;
      const e = 1 - (1 - t) * (1 - t);
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * e;
      const alpha = this.a0[i] * Math.min(1, t * 12) * Math.pow(1 - t, 1.3);
      P[i * 3] = this.px[i];
      P[i * 3 + 1] = this.py[i];
      P[i * 3 + 2] = this.pz[i];
      const c = i * 3;
      C[i * 4] = this.c0[c] + (this.c1[c] - this.c0[c]) * t;
      C[i * 4 + 1] = this.c0[c + 1] + (this.c1[c + 1] - this.c0[c + 1]) * t;
      C[i * 4 + 2] = this.c0[c + 2] + (this.c1[c + 2] - this.c0[c + 2]) * t;
      C[i * 4 + 3] = alpha;
      S[i * 2] = size;
      S[i * 2 + 1] = this.rot[i];
      i++;
    }
    this.geo.instanceCount = this.count;
    if (this.count > 0) {
      this.aPos.clearUpdateRanges();
      this.aCol.clearUpdateRanges();
      this.aSR.clearUpdateRanges();
      this.aPos.addUpdateRange(0, this.count * 3);
      this.aCol.addUpdateRange(0, this.count * 4);
      this.aSR.addUpdateRange(0, this.count * 2);
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSR.needsUpdate = true;
    }
  }

  private swapRemove(i: number): void {
    const j = --this.count;
    if (i === j) return;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.age[i] = this.age[j];
    this.life[i] = this.life[j];
    this.s0[i] = this.s0[j];
    this.s1[i] = this.s1[j];
    this.rot[i] = this.rot[j];
    this.rotV[i] = this.rotV[j];
    this.drag[i] = this.drag[j];
    this.grav[i] = this.grav[j];
    this.a0[i] = this.a0[j];
    for (let k = 0; k < 3; k++) {
      this.c0[i * 3 + k] = this.c0[j * 3 + k];
      this.c1[i * 3 + k] = this.c1[j * 3 + k];
    }
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

interface Plume {
  x: number;
  y: number;
  z: number;
  r: number;
  t: number;
  dur: number;
  acc: number;
  fire: boolean;
}

/** High-level effects built on two particle layers. */
export class Particles {
  readonly smoke: ParticleLayer;
  readonly glow: ParticleLayer;
  readonly group = new THREE.Group();
  private plumes: Plume[] = [];

  constructor(smokeMax = 6000, glowMax = 4000) {
    this.smoke = new ParticleLayer(smokeMax, false);
    this.glow = new ParticleLayer(glowMax, true);
    this.group.add(this.smoke.mesh, this.glow.mesh);
  }

  /** Billowing dust cloud (building debris, footsteps...). */
  dust(x: number, y: number, z: number, radius: number, count: number, color = 0x9d9184, upward = 3): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const sp = rand(1, 4) * (radius / 6 + 0.5);
      this.smoke.emit({
        x: x + Math.cos(a) * r,
        y: y + rand(0, radius * 0.4),
        z: z + Math.sin(a) * r,
        vx: Math.cos(a) * sp,
        vy: rand(0.5, 1.5) * upward,
        vz: Math.sin(a) * sp,
        life: rand(2.2, 4.5),
        size0: radius * rand(0.5, 0.9),
        size1: radius * rand(1.6, 2.8),
        color0: color,
        color1: 0x6d6560,
        alpha: rand(0.5, 0.85),
        drag: 0.9,
        gravity: 0.3,
        spin: 0.3,
      });
    }
  }

  /** Low ring of dust racing outward along the ground (stomp shockwave). */
  dustRing(x: number, z: number, radius: number, count = 48): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand(-0.05, 0.05);
      const sp = rand(18, 30) * (radius / 20);
      this.smoke.emit({
        x: x + Math.cos(a) * 4,
        y: rand(1, 3),
        z: z + Math.sin(a) * 4,
        vx: Math.cos(a) * sp,
        vy: rand(0.5, 2),
        vz: Math.sin(a) * sp,
        life: rand(1.6, 2.6),
        size0: 5,
        size1: rand(12, 20),
        color0: 0xa89a88,
        color1: 0x7a7068,
        alpha: 0.7,
        drag: 1.6,
        gravity: 0.5,
      });
    }
  }

  smokePuff(x: number, y: number, z: number, size: number, dark = true): void {
    this.smoke.emit({
      x,
      y,
      z,
      vx: rand(-1, 1),
      vy: rand(2, 5),
      vz: rand(-1, 1),
      life: rand(3, 6),
      size0: size * 0.6,
      size1: size * rand(2, 3),
      color0: dark ? 0x3a3432 : 0x8a8480,
      color1: dark ? 0x221f1e : 0x5c5856,
      alpha: dark ? 0.75 : 0.55,
      drag: 0.4,
      gravity: 1.2,
    });
  }

  explosion(x: number, y: number, z: number, size: number): void {
    const n = Math.round(10 + size * 2.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(-0.2, 1);
      const sp = rand(4, 13) * (size / 6);
      this.glow.emit({
        x: x + rand(-1, 1) * size * 0.2,
        y: y + rand(-1, 1) * size * 0.2,
        z: z + rand(-1, 1) * size * 0.2,
        vx: Math.cos(a) * sp * (1 - Math.abs(e) * 0.5),
        vy: e * sp + 2,
        vz: Math.sin(a) * sp * (1 - Math.abs(e) * 0.5),
        life: rand(0.45, 0.9),
        size0: size * rand(0.5, 0.9),
        size1: size * rand(1.4, 2.2),
        color0: 0xfff0b0,
        color1: 0xc2300a,
        alpha: 1,
        drag: 2.5,
        gravity: 3,
      });
    }
    for (let i = 0; i < n * 0.7; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(2, 7) * (size / 6);
      this.smoke.emit({
        x: x + rand(-1, 1) * size * 0.3,
        y: y + rand(0, size * 0.4),
        z: z + rand(-1, 1) * size * 0.3,
        vx: Math.cos(a) * sp,
        vy: rand(2, 6),
        vz: Math.sin(a) * sp,
        life: rand(2.5, 4.5),
        size0: size * 0.8,
        size1: size * rand(2.4, 3.4),
        color0: 0x4a3a32,
        color1: 0x1e1b1a,
        alpha: 0.8,
        drag: 1.0,
        gravity: 1.8,
      });
    }
    this.sparks(x, y, z, Math.round(8 + size), 16 + size * 2);
  }

  sparks(x: number, y: number, z: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(0.1, 1);
      const sp = rand(0.4, 1) * speed;
      this.glow.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * sp * (1 - e * 0.6),
        vy: e * sp,
        vz: Math.sin(a) * sp * (1 - e * 0.6),
        life: rand(0.4, 1.1),
        size0: rand(0.8, 1.6),
        size1: 0.3,
        color0: 0xffe4a0,
        color1: 0xff5010,
        alpha: 1,
        drag: 0.6,
        gravity: -26,
        spin: 0,
      });
    }
  }

  fire(x: number, y: number, z: number, size: number): void {
    this.glow.emit({
      x: x + rand(-1, 1) * size * 0.3,
      y,
      z: z + rand(-1, 1) * size * 0.3,
      vx: rand(-1, 1),
      vy: rand(3, 7),
      vz: rand(-1, 1),
      life: rand(0.5, 1.0),
      size0: size * rand(0.6, 1.0),
      size1: size * 0.2,
      color0: 0xffd070,
      color1: 0xb02008,
      alpha: 0.9,
      drag: 0.8,
      gravity: 4,
    });
  }

  splash(x: number, y: number, z: number, size: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(2, 7) * (size / 6);
      this.smoke.emit({
        x: x + Math.cos(a) * size * 0.3,
        y,
        z: z + Math.sin(a) * size * 0.3,
        vx: Math.cos(a) * sp,
        vy: rand(8, 18) * (size / 8),
        vz: Math.sin(a) * sp,
        life: rand(1.0, 1.8),
        size0: size * 0.4,
        size1: size * rand(0.9, 1.5),
        color0: 0xe8f0f4,
        color1: 0x9ab0bc,
        alpha: 0.75,
        drag: 0.6,
        gravity: -22,
      });
    }
  }

  /** Long-lived smoke column (e.g. over a collapsed building). */
  addPlume(x: number, y: number, z: number, r: number, dur: number, fire: boolean): void {
    if (this.plumes.length > 26) this.plumes.shift();
    this.plumes.push({ x, y, z, r, t: 0, dur, acc: 0, fire });
  }

  update(dt: number): void {
    for (let i = this.plumes.length - 1; i >= 0; i--) {
      const p = this.plumes[i];
      p.t += dt;
      if (p.t >= p.dur) {
        this.plumes.splice(i, 1);
        continue;
      }
      const k = 1 - p.t / p.dur;
      const rate = (1.5 + p.r * 0.35) * (0.35 + 0.65 * k);
      p.acc += rate * dt;
      while (p.acc >= 1) {
        p.acc -= 1;
        this.smoke.emit({
          x: p.x + rand(-1, 1) * p.r * 0.5,
          y: p.y + rand(0, 3),
          z: p.z + rand(-1, 1) * p.r * 0.5,
          vx: rand(-0.6, 0.6) + 1.2,
          vy: rand(4, 8),
          vz: rand(-0.6, 0.6) + 0.5,
          life: rand(5, 8),
          size0: p.r * 0.6 + 2,
          size1: p.r * 1.6 + rand(12, 22),
          color0: 0x2f2b2a,
          color1: 0x55504e,
          alpha: 0.55 * (0.4 + 0.6 * k),
          drag: 0.15,
          gravity: 0.6,
        });
        if (p.fire && p.t < p.dur * 0.45 && Math.random() < 0.8) this.fire(p.x + rand(-1, 1) * p.r * 0.4, p.y + rand(0, 2), p.z + rand(-1, 1) * p.r * 0.4, rand(3, 6));
      }
    }
    this.smoke.update(dt);
    this.glow.update(dt);
  }

  clear(): void {
    this.plumes = [];
    this.smoke.clear();
    this.glow.clear();
  }

  dispose(): void {
    this.smoke.dispose();
    this.glow.dispose();
  }
}
