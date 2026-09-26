import * as THREE from 'three';
import { GRAVITY, MILITARY } from '../config';
import type { AudioSys } from '../core/audio';
import { approachAngle, clamp } from '../core/math';
import { rand } from '../core/rng';
import type { Particles } from '../fx/particles';
import type { Kaiju } from './kaiju';

export interface MilitaryEnv {
  roadX: number[];
  roadZ: number[];
  terrainAt(x: number, z: number): number;
  isSolidAt(x: number, y: number, z: number): boolean;
  kaiju: Kaiju;
  fx: Particles;
  audio: AudioSys;
  onKaijuHit(dmg: number, x: number, y: number, z: number): void;
  onUnitDestroyed(kind: 'tank' | 'heli', x: number, y: number, z: number): void;
  /** Crashing helicopters damage what they fall on. */
  onCrash(x: number, y: number, z: number): void;
}

type TankState = 'drive' | 'aim' | 'flying' | 'wreck';

interface Tank {
  g: THREE.Group;
  turret: THREE.Group;
  x: number;
  z: number;
  y: number;
  heading: number;
  turretYaw: number;
  ni: number;
  nj: number;
  pi: number;
  pj: number;
  state: TankState;
  fireCd: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  t: number;
  stun: number;
}

type HeliState = 'fly' | 'falling' | 'gone';

interface Heli {
  g: THREE.Group;
  rotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  orbit: number;
  orbitDir: number;
  radius: number;
  alt: number;
  fireCd: number;
  stun: number;
  state: HeliState;
  yaw: number;
  spin: number;
  t: number;
  /** Which weapon pod fires next (-1 / 1). */
  pod: number;
}

interface Projectile {
  kind: 'shell' | 'missile';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  dmg: number;
}

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

export class Military {
  readonly group = new THREE.Group();
  readonly tanks: Tank[] = [];
  readonly helis: Heli[] = [];
  private projectiles: Projectile[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly olive: THREE.MeshStandardMaterial;
  private readonly dark: THREE.MeshStandardMaterial;
  private readonly burnt: THREE.MeshStandardMaterial;
  private readonly glass: THREE.MeshStandardMaterial;
  private readonly heliMat: THREE.MeshStandardMaterial;
  private readonly tankGeo: {
    body: THREE.BufferGeometry;
    track: THREE.BufferGeometry;
    turret: THREE.BufferGeometry;
    barrel: THREE.BufferGeometry;
  };
  private readonly heliGeo: {
    body: THREE.BufferGeometry;
    boom: THREE.BufferGeometry;
    blade: THREE.BufferGeometry;
    fin: THREE.BufferGeometry;
    skid: THREE.BufferGeometry;
    pod: THREE.BufferGeometry;
  };

  constructor(private readonly env: MilitaryEnv) {
    this.group.name = 'military';
    this.olive = new THREE.MeshStandardMaterial({ color: 0x5b6647, roughness: 0.75, flatShading: true });
    this.dark = new THREE.MeshStandardMaterial({ color: 0x2b2e26, roughness: 0.9, flatShading: true });
    this.burnt = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 1, flatShading: true });
    this.glass = new THREE.MeshStandardMaterial({ color: 0x1c2a3a, roughness: 0.2, metalness: 0.5 });
    this.heliMat = new THREE.MeshStandardMaterial({ color: 0x4f5a48, roughness: 0.6, flatShading: true });
    this.mats.push(this.olive, this.dark, this.burnt, this.glass, this.heliMat);

    const barrel = new THREE.CylinderGeometry(0.32, 0.38, 7, 6);
    barrel.rotateX(Math.PI / 2);
    barrel.translate(0, 0, 3.5);
    this.tankGeo = {
      body: new THREE.BoxGeometry(6.2, 1.9, 9),
      track: new THREE.BoxGeometry(1.5, 1.8, 9.6),
      turret: new THREE.CylinderGeometry(2.2, 2.6, 1.6, 7),
      barrel,
    };
    const body = new THREE.SphereGeometry(1, 10, 7);
    body.scale(2.1, 2.2, 5.2);
    const boom = new THREE.CylinderGeometry(0.35, 0.6, 8, 6);
    boom.rotateX(Math.PI / 2);
    boom.translate(0, 0, -7.5);
    const blade = new THREE.BoxGeometry(0.9, 0.12, 17);
    const fin = new THREE.BoxGeometry(0.2, 2.6, 1.6);
    const skid = new THREE.BoxGeometry(0.25, 0.25, 7);
    const pod = new THREE.CylinderGeometry(0.4, 0.4, 3, 6);
    pod.rotateX(Math.PI / 2);
    this.heliGeo = { body, boom, blade, fin, skid, pod };
    this.geos.push(...Object.values(this.tankGeo), ...Object.values(this.heliGeo));
  }

  get aliveTanks(): number {
    let n = 0;
    for (const t of this.tanks) if (t.state === 'drive' || t.state === 'aim') n++;
    return n;
  }

  get aliveHelis(): number {
    let n = 0;
    for (const h of this.helis) if (h.state === 'fly') n++;
    return n;
  }

  // ------------------------------------------------------------------
  // spawning
  // ------------------------------------------------------------------

  spawnTank(): void {
    const { roadX, roadZ, kaiju } = this.env;
    const nx = roadX.length;
    const nz = roadZ.length;
    const cands: [number, number][] = [];
    for (let i = 0; i < nx; i++) cands.push([i, 0]);
    for (let j = 1; j < nz - 1; j++) {
      cands.push([0, j]);
      cands.push([nx - 1, j]);
    }
    const kp = kaiju.position;
    const far = cands.filter(([i, j]) => Math.hypot(roadX[i] - kp.x, roadZ[j] - kp.z) > 150);
    const pool = far.length > 0 ? far : cands;
    const [i, j] = pool[Math.floor(Math.random() * pool.length)];
    const g = new THREE.Group();
    const bodyM = new THREE.Mesh(this.tankGeo.body, this.olive);
    bodyM.position.y = 2.0;
    const tl = new THREE.Mesh(this.tankGeo.track, this.dark);
    tl.position.set(-3.3, 0.95, 0);
    const tr = new THREE.Mesh(this.tankGeo.track, this.dark);
    tr.position.set(3.3, 0.95, 0);
    const turret = new THREE.Group();
    turret.position.y = 3.7;
    const tm = new THREE.Mesh(this.tankGeo.turret, this.olive);
    const bm = new THREE.Mesh(this.tankGeo.barrel, this.dark);
    bm.position.set(0, 0.2, 1.2);
    bm.rotation.x = -0.12;
    turret.add(tm, bm);
    g.add(bodyM, tl, tr, turret);
    g.traverse((o) => {
      o.renderOrder = 6; // after the kaiju (see World)
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const x = roadX[i];
    const z = roadZ[j];
    g.position.set(x, 0, z);
    this.group.add(g);
    this.tanks.push({
      g,
      turret,
      x,
      z,
      y: 0,
      heading: 0,
      turretYaw: 0,
      ni: i,
      nj: j,
      pi: i,
      pj: j,
      state: 'drive',
      fireCd: rand(2, 4),
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      t: 0,
      stun: 0,
    });
  }

  spawnHeli(): void {
    const kp = this.env.kaiju.position;
    const a = rand(0, Math.PI * 2);
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.heliGeo.body, this.heliMat);
    const cockpit = new THREE.Mesh(this.heliGeo.body, this.glass);
    cockpit.scale.set(0.8, 0.6, 0.45);
    cockpit.position.set(0, 0.7, 3.2);
    const boom = new THREE.Mesh(this.heliGeo.boom, this.heliMat);
    boom.position.y = 0.5;
    const fin = new THREE.Mesh(this.heliGeo.fin, this.heliMat);
    fin.position.set(0, 1.6, -11);
    const rotor = new THREE.Group();
    rotor.position.y = 2.6;
    const b1 = new THREE.Mesh(this.heliGeo.blade, this.dark);
    const b2 = new THREE.Mesh(this.heliGeo.blade, this.dark);
    b2.rotation.y = Math.PI / 2;
    rotor.add(b1, b2);
    const tailRotor = new THREE.Group();
    tailRotor.position.set(0.5, 1.4, -11.2);
    const tb = new THREE.Mesh(this.heliGeo.blade, this.dark);
    tb.scale.set(0.5, 1, 0.22);
    tb.rotation.z = Math.PI / 2;
    tailRotor.add(tb);
    const s1 = new THREE.Mesh(this.heliGeo.skid, this.dark);
    s1.position.set(-1.6, -2.3, 0);
    const s2 = new THREE.Mesh(this.heliGeo.skid, this.dark);
    s2.position.set(1.6, -2.3, 0);
    const p1 = new THREE.Mesh(this.heliGeo.pod, this.dark);
    p1.position.set(-2.6, -0.6, 0.5);
    const p2 = new THREE.Mesh(this.heliGeo.pod, this.dark);
    p2.position.set(2.6, -0.6, 0.5);
    g.add(body, cockpit, boom, fin, rotor, tailRotor, s1, s2, p1, p2);
    g.traverse((o) => {
      o.renderOrder = 6;
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    const pos = new THREE.Vector3(kp.x + Math.cos(a) * 320, 70, kp.z + Math.sin(a) * 320);
    g.position.copy(pos);
    this.group.add(g);
    this.helis.push({
      g,
      rotor,
      tailRotor,
      pos,
      vel: new THREE.Vector3(),
      orbit: a,
      orbitDir: Math.random() < 0.5 ? -1 : 1,
      radius: rand(78, 100),
      alt: rand(52, 68),
      fireCd: rand(4, 6),
      stun: 0,
      state: 'fly',
      yaw: 0,
      spin: 0,
      t: rand(0, 10),
      pod: 1,
    });
  }

  // ------------------------------------------------------------------
  // damage from the kaiju
  // ------------------------------------------------------------------

  /** Destroy units inside a sphere. Returns number destroyed. */
  damageSphere(x: number, y: number, z: number, r: number, force: number, dirX = 0, dirZ = 0): number {
    let n = 0;
    for (const t of this.tanks) {
      if (t.state !== 'drive' && t.state !== 'aim') continue;
      const d = Math.hypot(t.x - x, t.y + 2 - y, t.z - z);
      if (d < r + 4) {
        this.killTank(t, x, z, force, dirX, dirZ);
        n++;
      }
    }
    for (const h of this.helis) {
      if (h.state !== 'fly') continue;
      if (h.pos.distanceTo(_v.set(x, y, z)) < r + 6) {
        this.killHeli(h);
        n++;
      }
    }
    return n;
  }

  /** Destroy units near a line segment (breath beam). */
  damageSegment(a: THREE.Vector3, b: THREE.Vector3, r: number): number {
    let n = 0;
    const ab = _t.copy(b).sub(a);
    const len2 = Math.max(1e-6, ab.lengthSq());
    const distTo = (px: number, py: number, pz: number) => {
      const u = clamp(((px - a.x) * ab.x + (py - a.y) * ab.y + (pz - a.z) * ab.z) / len2, 0, 1);
      return Math.hypot(a.x + ab.x * u - px, a.y + ab.y * u - py, a.z + ab.z * u - pz);
    };
    for (const t of this.tanks) {
      if (t.state !== 'drive' && t.state !== 'aim') continue;
      if (distTo(t.x, t.y + 2, t.z) < r + 3) {
        this.killTank(t, a.x, a.z, 14, 0, 0);
        n++;
      }
    }
    for (const h of this.helis) {
      if (h.state !== 'fly') continue;
      if (distTo(h.pos.x, h.pos.y, h.pos.z) < r + 6) {
        this.killHeli(h);
        n++;
      }
    }
    return n;
  }

  /** Roar: stun helicopters, flip nearby tanks. */
  roar(x: number, z: number, radius: number): number {
    let n = 0;
    for (const h of this.helis) {
      if (h.state !== 'fly') continue;
      const d = Math.hypot(h.pos.x - x, h.pos.z - z);
      if (d < radius) h.stun = 3.2;
    }
    for (const t of this.tanks) {
      if (t.state !== 'drive' && t.state !== 'aim') continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < radius * 0.45) {
        this.killTank(t, x, z, 16, 0, 0);
        n++;
      } else if (d < radius) t.stun = 3;
    }
    return n;
  }

  private killTank(t: Tank, fromX: number, fromZ: number, force: number, dirX: number, dirZ: number): void {
    let ox = t.x - fromX;
    let oz = t.z - fromZ;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    t.state = 'flying';
    t.vx = (ox + dirX) * force * rand(0.6, 1.1);
    t.vz = (oz + dirZ) * force * rand(0.6, 1.1);
    t.vy = rand(10, 18) + force * 0.4;
    t.spin = rand(-4, 4);
    t.t = 0;
    this.env.fx.explosion(t.x, t.y + 2, t.z, 7);
    this.env.audio.explosion(t.x, t.z, 6);
    this.env.onUnitDestroyed('tank', t.x, t.y + 3, t.z);
  }

  private killHeli(h: Heli): void {
    h.state = 'falling';
    h.spin = rand(3, 6) * (Math.random() < 0.5 ? -1 : 1);
    h.vel.y = Math.min(h.vel.y, 4);
    this.env.fx.explosion(h.pos.x, h.pos.y, h.pos.z, 8);
    this.env.audio.explosion(h.pos.x, h.pos.z, 7);
    this.env.onUnitDestroyed('heli', h.pos.x, h.pos.y, h.pos.z);
  }

  // ------------------------------------------------------------------
  // update
  // ------------------------------------------------------------------

  update(dt: number): void {
    const kp = this.env.kaiju.position;
    const kDead = this.env.kaiju.dead;
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      const t = this.tanks[i];
      t.t += dt;
      if (t.state === 'flying') {
        t.vy -= GRAVITY * dt;
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        t.z += t.vz * dt;
        t.g.rotation.x += t.spin * dt;
        t.g.rotation.z += t.spin * 0.7 * dt;
        const ground = Math.max(0, this.env.terrainAt(t.x, t.z));
        if (t.y <= ground && t.vy < 0) {
          t.y = ground;
          t.state = 'wreck';
          t.t = 0;
          t.g.rotation.x = Math.round(t.g.rotation.x / Math.PI) * Math.PI;
          t.g.rotation.z = 0;
          t.g.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.burnt;
          });
          this.env.fx.explosion(t.x, 2, t.z, 9);
          this.env.fx.addPlume(t.x, 1, t.z, 4, 10, true);
          this.env.audio.explosion(t.x, t.z, 8);
        }
        t.g.position.set(t.x, t.y, t.z);
        continue;
      }
      if (t.state === 'wreck') {
        if (t.t > 14) {
          t.g.position.y -= dt * 0.8;
          if (t.t > 18) {
            this.group.remove(t.g);
            this.tanks.splice(i, 1);
          }
        }
        continue;
      }
      this.updateTank(t, dt, kp, kDead);
    }

    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      h.t += dt;
      if (h.state === 'gone') {
        this.group.remove(h.g);
        this.helis.splice(i, 1);
        continue;
      }
      this.updateHeli(h, dt, kp, kDead);
    }

    // projectiles
    const kaiju = this.env.kaiju;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      if (p.kind === 'missile') {
        kaiju.chestPosition(_t);
        _v.copy(_t).sub(p.pos).normalize();
        const sp = p.vel.length();
        const cur = p.vel.clone().normalize();
        const turn = Math.min(1, 1.7 * dt);
        cur.lerp(_v, turn).normalize();
        p.vel.copy(cur).multiplyScalar(Math.min(sp + 25 * dt, 75));
        this.env.fx.smoke.emit({
          x: p.pos.x,
          y: p.pos.y,
          z: p.pos.z,
          vx: rand(-0.5, 0.5),
          vy: rand(0.3, 1),
          vz: rand(-0.5, 0.5),
          life: rand(1.2, 2),
          size0: 1.2,
          size1: rand(4, 6),
          color0: 0xdad6d0,
          color1: 0x8a8682,
          alpha: 0.5,
          drag: 0.5,
          gravity: 0.2,
        });
      } else {
        p.vel.y -= 9.8 * dt;
      }
      p.pos.addScaledVector(p.vel, dt);
      this.env.fx.glow.emit({
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        life: 0.12,
        size0: p.kind === 'missile' ? 2.6 : 1.8,
        size1: 0.6,
        color0: p.kind === 'missile' ? 0xffc070 : 0xfff0a0,
        color1: 0xff6020,
        alpha: 1,
        drag: 0,
        spin: 0,
      });
      let explode = false;
      if (!kaiju.dead && kaiju.hitTest(p.pos, 1)) {
        this.env.onKaijuHit(p.dmg, p.pos.x, p.pos.y, p.pos.z);
        explode = true;
      } else if (p.pos.y <= Math.max(0, this.env.terrainAt(p.pos.x, p.pos.z)) || this.env.isSolidAt(p.pos.x, p.pos.y, p.pos.z) || p.life <= 0) {
        explode = true;
      }
      if (explode) {
        this.env.fx.explosion(p.pos.x, p.pos.y, p.pos.z, p.kind === 'missile' ? 4.5 : 3);
        this.projectiles.splice(i, 1);
      }
    }

    // rotor noise by proximity
    let nearest = Infinity;
    for (const h of this.helis) if (h.state !== 'gone') nearest = Math.min(nearest, h.pos.distanceTo(kp));
    this.env.audio.heli(nearest < 400 ? 1 - nearest / 400 : 0);
  }

  private updateTank(t: Tank, dt: number, kp: THREE.Vector3, kDead: boolean): void {
    const { roadX, roadZ } = this.env;
    t.stun = Math.max(0, t.stun - dt);
    const dist = Math.hypot(kp.x - t.x, kp.z - t.z);
    const tx = roadX[t.ni];
    const tz = roadZ[t.nj];
    const toX = tx - t.x;
    const toZ = tz - t.z;
    const toD = Math.hypot(toX, toZ);
    const inRange = dist < 150 && dist > 40 && !kDead;
    if (t.stun > 0) {
      t.state = 'aim';
    } else if (inRange && toD < 1.5) {
      t.state = 'aim';
    } else {
      t.state = 'drive';
    }
    if (t.state === 'drive' || (t.state === 'aim' && toD >= 1.5 && dist < 40)) {
      if (toD < 1.5) {
        // choose next node
        const nx = roadX.length;
        const nz = roadZ.length;
        const opts: [number, number][] = [];
        if (t.ni > 0) opts.push([t.ni - 1, t.nj]);
        if (t.ni < nx - 1) opts.push([t.ni + 1, t.nj]);
        if (t.nj > 0) opts.push([t.ni, t.nj - 1]);
        if (t.nj < nz - 1) opts.push([t.ni, t.nj + 1]);
        const retreat = dist < 55;
        let best = opts[0];
        let bestScore = Infinity;
        for (const o of opts) {
          const d = Math.hypot(roadX[o[0]] - kp.x, roadZ[o[1]] - kp.z);
          let score = retreat ? -d : Math.abs(d - MILITARY.tankRange);
          if (o[0] === t.pi && o[1] === t.pj) score += 40;
          score += rand(0, 12);
          if (score < bestScore) {
            bestScore = score;
            best = o;
          }
        }
        t.pi = t.ni;
        t.pj = t.nj;
        t.ni = best[0];
        t.nj = best[1];
      } else {
        const sp = MILITARY.tankSpeed * dt;
        const want = Math.atan2(toX, toZ);
        t.heading = approachAngle(t.heading, want, 2.5 * dt);
        const step = Math.min(sp, toD);
        t.x += (toX / toD) * step;
        t.z += (toZ / toD) * step;
      }
    }
    // turret & firing
    const aimYaw = Math.atan2(kp.x - t.x, kp.z - t.z) - t.heading;
    t.turretYaw = approachAngle(t.turretYaw, aimYaw, 1.6 * dt);
    t.fireCd -= dt;
    if (t.fireCd <= 0 && dist < 160 && !kDead && t.stun <= 0) {
      t.fireCd = rand(MILITARY.shellInterval[0], MILITARY.shellInterval[1]);
      this.fireShell(t);
    }
    t.g.position.set(t.x, 0, t.z);
    t.g.rotation.y = t.heading;
    t.turret.rotation.y = t.turretYaw;
    if (t.stun > 0) t.g.rotation.z = Math.sin(t.t * 30) * 0.05;
    else t.g.rotation.z = 0;
  }

  private fireShell(t: Tank): void {
    const yaw = t.heading + t.turretYaw;
    const mx = t.x + Math.sin(yaw) * 8;
    const mz = t.z + Math.cos(yaw) * 8;
    const my = 4.4;
    this.env.kaiju.chestPosition(_t);
    const sp = MILITARY.shellSpread;
    _t.x += rand(-sp, sp);
    _t.y += rand(-sp * 1.2, sp * 0.5);
    _t.z += rand(-sp, sp);
    const dx = _t.x - mx;
    const dy = _t.y - my;
    const dz = _t.z - mz;
    const d = Math.hypot(dx, dy, dz);
    const speed = 105;
    const T = d / speed;
    const vel = new THREE.Vector3((dx / d) * speed, (dy / d) * speed + 0.5 * 9.8 * T, (dz / d) * speed);
    this.projectiles.push({ kind: 'shell', pos: new THREE.Vector3(mx, my, mz), vel, life: 3, dmg: MILITARY.shellDamage });
    this.env.fx.glow.emit({ x: mx, y: my, z: mz, life: 0.12, size0: 5, size1: 2, color0: 0xfff0b0, color1: 0xff8030, alpha: 1 });
    this.env.fx.smokePuff(mx, my, mz, 3, false);
    this.env.audio.tankFire(mx, mz);
  }

  private updateHeli(h: Heli, dt: number, kp: THREE.Vector3, kDead: boolean): void {
    h.rotor.rotation.y += dt * 24;
    h.tailRotor.rotation.x += dt * 30;
    if (h.state === 'falling') {
      h.vel.y -= 18 * dt;
      h.vel.x *= 1 - dt * 0.3;
      h.vel.z *= 1 - dt * 0.3;
      h.pos.addScaledVector(h.vel, dt);
      h.yaw += h.spin * dt;
      h.g.rotation.set(0.3, h.yaw, 0.4);
      if (Math.random() < 0.7) this.env.fx.smokePuff(h.pos.x, h.pos.y, h.pos.z, 3, true);
      if (Math.random() < 0.5) this.env.fx.fire(h.pos.x, h.pos.y, h.pos.z, 4);
      const ground = Math.max(0, this.env.terrainAt(h.pos.x, h.pos.z));
      if (h.pos.y <= ground + 1 || this.env.isSolidAt(h.pos.x, h.pos.y, h.pos.z)) {
        this.env.fx.explosion(h.pos.x, h.pos.y, h.pos.z, 11);
        this.env.audio.explosion(h.pos.x, h.pos.z, 10);
        this.env.onCrash(h.pos.x, h.pos.y, h.pos.z);
        h.state = 'gone';
      }
      h.g.position.copy(h.pos);
      return;
    }
    h.stun = Math.max(0, h.stun - dt);
    if (h.stun > 0) {
      // wobbling, losing altitude
      h.yaw += dt * 3.5;
      h.vel.y = -7;
      h.vel.x *= 1 - dt;
      h.vel.z *= 1 - dt;
      h.pos.addScaledVector(h.vel, dt);
      h.g.rotation.set(Math.sin(h.t * 7) * 0.3, h.yaw, Math.cos(h.t * 5) * 0.35);
      h.g.position.copy(h.pos);
      const ground = Math.max(0, this.env.terrainAt(h.pos.x, h.pos.z));
      if (h.pos.y < ground + 6 || this.env.isSolidAt(h.pos.x, h.pos.y - 2, h.pos.z)) this.killHeli(h);
      return;
    }
    h.orbit += h.orbitDir * 0.22 * dt;
    const tx = kp.x + Math.cos(h.orbit) * h.radius;
    const tz = kp.z + Math.sin(h.orbit) * h.radius;
    const ty = h.alt + Math.sin(h.t * 0.6) * 5;
    const ax = (tx - h.pos.x) * 0.9 - h.vel.x * 1.1;
    const ay = (ty - h.pos.y) * 1.2 - h.vel.y * 1.4;
    const az = (tz - h.pos.z) * 0.9 - h.vel.z * 1.1;
    h.vel.x += ax * dt;
    h.vel.y += ay * dt;
    h.vel.z += az * dt;
    const sp = Math.hypot(h.vel.x, h.vel.z);
    if (sp > 34) {
      h.vel.x *= 34 / sp;
      h.vel.z *= 34 / sp;
    }
    h.pos.addScaledVector(h.vel, dt);
    const faceYaw = Math.atan2(kp.x - h.pos.x, kp.z - h.pos.z);
    h.yaw = approachAngle(h.yaw, faceYaw, 1.8 * dt);
    // bank based on velocity in local frame
    const fx = Math.sin(h.yaw);
    const fz = Math.cos(h.yaw);
    const fwd = h.vel.x * fx + h.vel.z * fz;
    const side = h.vel.x * fz - h.vel.z * fx;
    h.g.rotation.set(clamp(fwd * 0.012, -0.3, 0.3) + 0.08, h.yaw, clamp(-side * 0.02, -0.45, 0.45));
    h.g.position.copy(h.pos);

    h.fireCd -= dt;
    const dist = h.pos.distanceTo(kp);
    if (h.fireCd <= 0 && dist < 190 && !kDead) {
      h.fireCd = rand(MILITARY.missileInterval[0], MILITARY.missileInterval[1]);
      // one missile per salvo, alternating pods
      h.pod = -h.pod;
      const px = h.pos.x + Math.cos(h.yaw) * h.pod * 2.6;
      const pz = h.pos.z - Math.sin(h.yaw) * h.pod * 2.6;
      const vel = new THREE.Vector3(Math.sin(h.yaw) * 35, -4, Math.cos(h.yaw) * 35);
      this.projectiles.push({ kind: 'missile', pos: new THREE.Vector3(px, h.pos.y - 0.6, pz), vel, life: 4.5, dmg: MILITARY.missileDamage });
      this.env.audio.missile(h.pos.x, h.pos.z);
    }
  }

  /** For the minimap. */
  forEachUnit(cb: (kind: 'tank' | 'heli', x: number, z: number) => void): void {
    for (const t of this.tanks) if (t.state === 'drive' || t.state === 'aim') cb('tank', t.x, t.z);
    for (const h of this.helis) if (h.state === 'fly') cb('heli', h.pos.x, h.pos.z);
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
    this.projectiles = [];
  }
}
