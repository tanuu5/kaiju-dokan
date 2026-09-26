// Gameplay rules for one run of a stage: world simulation, attacks -> damage, scoring,
// enemy waves, timer and objectives. No DOM / WebGL access, so it also runs headless
// (see src/sim and tests/sim.test.ts). Presentation goes through the Feedback interface.

import * as THREE from 'three';
import { ENERGY_GAIN, KAIJU, SCORE } from '../config';
import type { AudioSys } from '../core/audio';
import { clamp, damp, formatInt } from '../core/math';
import { rand, randPick } from '../core/rng';
import type { KaijuEvent, KaijuInput } from '../entities/kaiju';
import type { SfxOpts } from '../fx/sfxText';
import type { StageDef } from '../stages/stages';
import type { BuildingState, RayHit } from '../world/buildings';
import { ScoreKeeper } from './scoring';
import { World, type WorldHooks } from './world';

/** Presentation hooks. The browser Game implements them; simulations use NO_FEEDBACK. */
export interface Feedback {
  /** Camera shake (adds trauma, 0..1). */
  shake(amount: number): void;
  fovKick(amount: number): void;
  /** Brief slow-motion on heavy hits. */
  hitStop(seconds: number): void;
  /** Screen flash (0..1). */
  flash(amount: number): void;
  /** Onomatopoeia / score pop-up at a world position. */
  text(text: string, x: number, y: number, z: number, opts?: SfxOpts): void;
  banner(text: string, cls?: string, duration?: number): void;
  /** Red damage vignette. */
  hurt(amount: number): void;
  /** Distance from the camera to a point (used to scale shake). */
  cameraDistance(x: number, y: number, z: number): number;
}

export const NO_FEEDBACK: Feedback = {
  shake() {},
  fovKick() {},
  hitStop() {},
  flash() {},
  text() {},
  banner() {},
  hurt() {},
  cameraDistance: () => 150,
};

export type SessionStatus = 'running' | 'dead' | 'timeup';

const TXT = {
  punch: ['ドカッ!', 'バキィ!', 'ドゴッ!', 'ボコォ!'],
  smash: ['ドゴォォン!!', 'ズガァン!!'],
  stomp: ['ズドォォン!!', 'ドシィィン!!'],
  collapse: ['ガラガラ…', 'ズズーン…', 'ドドドド…', 'ゴゴゴゴ…'],
  topple: ['ズガァァン!!', 'ドッシャーン!!'],
  boom: ['ボカーン!', 'ドカーン!'],
  roar: ['ギャオオオン!!', 'グオオオオ!!'],
  breath: ['ゴォォォッ!!'],
  tail: ['バキバキッ!', 'ブォン!'],
  hit: ['カン!', 'ドン!'],
  body: ['メキメキ…', 'バリバリ!'],
};

export class Session {
  readonly world: World;
  readonly score = new ScoreKeeper();
  timeLeft: number;
  elapsed = 0;
  cleared = false;
  /** True while the intro cut-scene plays (the roar there has no gameplay effect). */
  intro = true;
  /** Where the breath should hit. The Game fills it from the camera ray; bots set it directly. */
  readonly aim = new THREE.Vector3();
  readonly beamEnd = new THREE.Vector3();
  readonly mouth = new THREE.Vector3();
  /** 0..1, eased "is aiming the breath" factor (the camera uses it). */
  aimBlend = 0;

  private waveIndex = 0;
  private reinforceT = 0;
  private breathTick = 0;
  private breathHitT = 0;
  private breathTextT = 0;
  private bodyTextT = 0;
  private tailHitThisSwing = false;
  private readonly tmp = new THREE.Vector3();
  private readonly ray: RayHit = { t: 0, x: 0, y: 0, z: 0, building: -1 };

  constructor(
    readonly stage: StageDef,
    private readonly audio: AudioSys,
    private readonly fb: Feedback = NO_FEEDBACK,
  ) {
    const hooks: WorldHooks = {
      onChunks: (n) => this.onChunks(n),
      onCollapse: (b, x, z) => this.onCollapse(b, x, z),
      onImpact: (x, y, z, size) => this.onToppleImpact(x, y, z, size),
      onFinish: (b, x, z, r) => this.onCollapseFinish(b, x, z, r),
      onKaijuHit: (dmg, x, y, z) => this.onKaijuHit(dmg, x, y, z),
      onUnitDestroyed: (kind, x, y, z) => this.onUnitDestroyed(kind, x, y, z),
      onCrash: (x, y, z) => this.onHeliCrash(x, y, z),
      onCarDestroyed: (x, y, z) => this.onCarDestroyed(x, y, z),
      onSplash: (x, z, s) => this.world.fx.splash(x, -1, z, s, 5),
    };
    this.world = new World(stage, hooks, audio);
    this.timeLeft = stage.timeLimit;
    this.world.kaiju.startIntro(this.world.city.kaijuStart.x, this.world.city.kaijuStart.z);
  }

  /** End the intro (or skip it) and hand control to the player. */
  startPlaying(): void {
    const k = this.world.kaiju;
    if (k.action === 'intro') {
      k.action = 'none';
      k.position.y = this.world.terrainAt(k.position.x, k.position.z);
    }
    this.intro = false;
  }

  /** Advance the world simulation (used in every state, `kin` null = no control). */
  updateWorld(dt: number, kin: KaijuInput | null): void {
    const w = this.world;
    const k = w.kaiju;
    const aiming = kin !== null && (k.charging || k.breathing);
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * damp(5, dt);
    if (aiming) k.aimHead(this.aim);
    const events = k.update(dt, kin, { terrainAt: (x, z) => w.terrainAt(x, z), colTop: (x, z) => w.buildings.colTop(x, z), bounds: w.kaijuBounds });
    for (const e of events) this.handleEvent(e);

    k.mouthPosition(this.mouth);
    if (k.breathing) this.updateBreath(dt);
    w.beam.update(dt, k.breathing, this.mouth, this.beamEnd);

    w.military.update(dt);
    w.traffic.update(dt, k.position.x, k.position.z);
    w.trees.update(dt);
    w.buildings.update(dt);
    w.debris.update(dt, w.debrisWorld);
    w.fx.update(dt);
    w.ground.update();
    w.flashes.update(dt);
    this.score.update(dt);
    this.breathTextT -= dt;
    this.bodyTextT -= dt;
  }

  /** Timer, enemy waves and objectives while playing. */
  updateRules(dt: number): SessionStatus {
    this.elapsed += dt;
    this.timeLeft -= dt;
    this.spawnWaves(dt);
    if (!this.cleared && this.world.buildings.destructionRatio >= this.stage.goal) {
      this.cleared = true;
      this.fb.banner('目標達成！ STAGE CLEAR!', 'gold', 3);
      this.fb.flash(1);
      this.audio.jingle(true);
    }
    if (Math.floor(this.timeLeft) === 30 && Math.floor(this.timeLeft + dt) === 31) this.fb.banner('残り30秒！', 'alert', 1.6);
    if (this.world.kaiju.dead) return 'dead';
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      return 'timeup';
    }
    return 'running';
  }

  teleport(x: number, z: number): void {
    const k = this.world.kaiju;
    k.position.set(x, this.world.terrainAt(x, z), z);
  }

  dispose(): void {
    this.world.dispose();
  }

  // ------------------------------------------------------------------
  // attacks
  // ------------------------------------------------------------------

  private updateBreath(dt: number): void {
    const w = this.world;
    const m = this.mouth;
    const d = this.tmp.copy(this.aim).sub(m);
    const len = d.length();
    if (len < 1e-3) return;
    d.divideScalar(len);
    let t = Math.min(KAIJU.breathRange, len + 20);
    let hitGround = false;
    if (w.buildings.raycast(m.x, m.y, m.z, d.x, d.y, d.z, t, this.ray)) t = this.ray.t;
    if (d.y < -1e-4) {
      const tg = (w.terrainAt(m.x, m.z) - m.y) / d.y;
      if (tg > 0 && tg < t) {
        t = tg;
        hitGround = true;
      }
    }
    this.beamEnd.set(m.x + d.x * t, m.y + d.y * t, m.z + d.z * t);
    const e = this.beamEnd;
    this.breathTick -= dt;
    this.breathHitT -= dt;
    if (Math.random() < 0.7) w.fx.fire(e.x, e.y, e.z, rand(4, 8));
    if (Math.random() < 0.35) w.fx.sparks(e.x, e.y, e.z, 3, 18);
    if (this.breathTick <= 0) {
      this.breathTick = 0.07;
      const n = w.buildings.damageSphere(e.x, e.y, e.z, 6.5, { force: 17, dirX: d.x, dirY: 0.3, dirZ: d.z, srcX: m.x, srcZ: m.z, soot: 0.45 });
      w.military.damageSegment(m, e, 4);
      const cars = w.traffic.damageSphere(e.x, e.y, e.z, 9, 14);
      w.trees.damageSphere(e.x, e.y, e.z, 8, true);
      if (hitGround || e.y < 3) w.ground.scorch(e.x, e.z, 7, 0.35);
      if (n > 0 || cars > 0) {
        if (this.breathHitT <= 0) {
          this.breathHitT = 0.45;
          this.score.hit();
        }
        this.fb.shake(0.05);
      }
      if (Math.random() < 0.3) w.fx.smokePuff(e.x, e.y + 2, e.z, 5, true);
    }
    this.fb.shake(dt * 0.25);
    if (this.breathTextT <= 0) {
      this.breathTextT = 1.6;
      this.fb.text(randPick(TXT.breath), e.x, e.y + 8, e.z, { size: 50, cls: 'red' });
    }
  }

  private handleEvent(e: KaijuEvent): void {
    const w = this.world;
    const k = w.kaiju;
    const kp = k.position;
    const fb = this.fb;
    switch (e.type) {
      case 'step': {
        fb.shake((e.run ? 0.22 : 0.14) * clamp(140 / fb.cameraDistance(kp.x, kp.y, kp.z), 0.4, 1.2));
        this.audio.footstep(e.x, e.z, e.run ? 1.1 : 0.8, e.water);
        if (e.water) {
          w.fx.splash(e.x, -1, e.z, 9, 16);
        } else {
          w.fx.dust(e.x, 1, e.z, 5, e.run ? 6 : 3, 0x9d9184, 1.5);
          const n = w.buildings.damageSphere(e.x, 2, e.z, 7, { force: 7, scaleY: 0.9, srcX: kp.x, srcZ: kp.z, debris: 0.7 });
          if (n > 0) this.score.keepAlive();
          w.traffic.damageSphere(e.x, 1, e.z, 7, 9);
          w.military.damageSphere(e.x, 2, e.z, 6, 8);
          const trees = w.trees.damageSphere(e.x, 0, e.z, 6);
          if (trees > 0) this.score.add(trees * SCORE.tree);
        }
        break;
      }
      case 'body': {
        const n = w.buildings.damageSphere(e.x, e.y, e.z, e.r, {
          force: 8 + e.speed * 0.6,
          dirX: e.dirX,
          dirZ: e.dirZ,
          srcX: kp.x,
          srcZ: kp.z,
          debris: 0.55,
        });
        if (n > 0) {
          fb.shake(0.06);
          this.score.keepAlive();
          if (this.bodyTextT <= 0 && n >= 3) {
            this.bodyTextT = 1.2;
            fb.text(randPick(TXT.body), e.x, e.y + 6, e.z, { size: 34, cls: 'white' });
          }
        }
        w.traffic.damageSphere(e.x, 1, e.z, e.r, 10);
        w.military.damageSphere(e.x, 2, e.z, e.r * 0.8, 10, e.dirX, e.dirZ);
        w.trees.damageSphere(e.x, 0, e.z, e.r);
        break;
      }
      case 'punch': {
        const r = (e.big ? 11 : 8.5) * KAIJU.scale;
        const n = w.buildings.damageSphere(e.x, e.y, e.z, r, {
          force: e.big ? 20 : 15,
          dirX: e.dirX,
          dirY: e.big ? -0.5 : 0.15,
          dirZ: e.dirZ,
          srcX: kp.x,
          srcZ: kp.z,
          soot: 0.15,
        });
        const units = w.military.damageSphere(e.x, e.y, e.z, r + 2, 16, e.dirX, e.dirZ);
        const cars = w.traffic.damageSphere(e.x, e.y, e.z, r + 4, 16);
        w.trees.damageSphere(e.x, e.y, e.z, r);
        if (n > 0 || units > 0 || cars > 0) {
          fb.hitStop(e.big ? 0.1 : 0.055);
          fb.shake(e.big ? 0.65 : 0.35);
          fb.fovKick(e.big ? 5 : 2.5);
          this.audio.impact(e.x, e.z, n);
          this.score.hit();
          fb.text(randPick(e.big ? TXT.smash : TXT.punch), e.x, e.y + 4, e.z, { size: e.big ? 74 : 56, cls: e.big ? 'red' : 'hot' });
          w.fx.sparks(e.x, e.y, e.z, 10, 20);
          w.fx.dust(e.x, e.y, e.z, 6, 5);
          if (e.big) {
            w.flashes.flash(e.x, e.y, e.z, 1100);
            fb.flash(0.4);
          }
        }
        break;
      }
      case 'tail': {
        let total = 0;
        for (let i = 0; i < e.points.length; i++) {
          const p = e.points[i];
          const tx = -(p.z - kp.z);
          const tz = p.x - kp.x;
          const tl = Math.hypot(tx, tz) || 1;
          total += w.buildings.damageSphere(p.x, p.y, p.z, 6.5, {
            force: 15,
            dirX: tx / tl,
            dirZ: tz / tl,
            srcX: kp.x,
            srcZ: kp.z,
            debris: 0.5,
          });
          if (i % 2 === 0) {
            w.traffic.damageSphere(p.x, p.y, p.z, 7, 16);
            w.military.damageSphere(p.x, p.y, p.z, 6, 16, tx / tl, tz / tl);
            w.trees.damageSphere(p.x, p.y, p.z, 6);
          }
        }
        if (total > 0) {
          fb.shake(0.12);
          this.score.keepAlive();
          if (!this.tailHitThisSwing) {
            this.tailHitThisSwing = true;
            this.score.hit();
            this.audio.impact(kp.x, kp.z, total);
            const p = e.points[e.points.length - 3];
            fb.text(randPick(TXT.tail), p.x, p.y + 8, p.z, { size: 52, cls: 'hot' });
          }
        }
        break;
      }
      case 'swing':
        this.tailHitThisSwing = false;
        this.audio.swing(e.big);
        break;
      case 'jump':
        this.audio.swing(true);
        w.fx.dust(e.x, 1, e.z, 8, 8);
        break;
      case 'stomp': {
        const R = 26;
        fb.shake(0.9);
        fb.fovKick(7);
        fb.hitStop(0.08);
        fb.flash(0.5);
        this.audio.footstep(e.x, e.z, 1.8, e.water);
        this.audio.explosion(e.x, e.z, 10);
        if (e.water) {
          w.fx.splash(e.x, -1, e.z, 18, 50);
        } else {
          w.fx.dustRing(e.x, e.z, R, 64);
          w.fx.dust(e.x, 2, e.z, 12, 12);
          w.ground.scorch(e.x, e.z, 10, 0.25);
        }
        const n = w.buildings.damageSphere(e.x, 0, e.z, R, { force: 20, scaleY: 0.5, srcX: e.x, srcZ: e.z, dirY: 0.8 });
        const units = w.military.damageSphere(e.x, 2, e.z, R + 6, 18);
        const cars = w.traffic.damageSphere(e.x, 1, e.z, R + 10, 18);
        const trees = w.trees.damageSphere(e.x, 0, e.z, R + 6);
        this.score.add(trees * SCORE.tree);
        if (n > 0 || units > 0 || cars > 0) this.score.hit();
        fb.text(randPick(TXT.stomp), e.x, 12, e.z, { size: 84, cls: 'red', life: 1.1 });
        break;
      }
      case 'roar': {
        this.audio.roar();
        fb.shake(0.55);
        fb.text(randPick(TXT.roar), e.x, e.y + 10, e.z, { size: 72, cls: 'white', life: 1.4, rot: rand(-6, 6) });
        if (!this.intro) {
          const units = w.military.roar(kp.x, kp.z, 120);
          const cars = w.traffic.damageSphere(kp.x, 1, kp.z, 55, 14);
          if (units + cars > 0) this.score.hit();
          k.addEnergy(12);
          w.fx.dustRing(kp.x, kp.z, 30, 48);
        }
        break;
      }
      case 'chargeStart':
        this.audio.chargeStart();
        break;
      case 'breathStart':
        this.audio.breathStart();
        this.breathTextT = 0;
        break;
      case 'breathStop':
        this.audio.breathStop();
        break;
    }
  }

  // ------------------------------------------------------------------
  // world callbacks
  // ------------------------------------------------------------------

  private onChunks(n: number): void {
    this.score.add(n * SCORE.chunk);
    this.world.kaiju.addEnergy(n * ENERGY_GAIN.chunk);
    this.score.keepAlive();
  }

  private onCollapse(b: BuildingState, x: number, z: number): void {
    const w = this.world;
    this.score.hit();
    const pts = this.score.add(SCORE.collapsePerFloor * b.h + b.spec.value);
    w.kaiju.addEnergy(ENERGY_GAIN.collapse);
    w.kaiju.heal(KAIJU.healPerCollapse);
    if (b.countable) this.score.stats.buildings++;
    const top = b.h * 4;
    this.fb.text(randPick(TXT.collapse), x, top * 0.7 + 6, z, { size: 40 + Math.min(40, b.h * 2.5), cls: 'white', life: 1.3 });
    this.fb.text(`+${formatInt(pts)}`, x, top * 0.7 - 2, z, { cls: 'score', life: 1.1, rot: 0 });
    this.audio.crumble(x, z, b.total / 4);
    const d = this.fb.cameraDistance(x, 10, z);
    this.fb.shake(clamp((0.15 + b.h * 0.02) * (160 / Math.max(40, d)), 0.05, 0.5));
    if (b.spec.name) {
      this.score.stats.landmarks++;
      this.fb.banner(`${b.spec.name} 撃破！ +${formatInt(pts)}`, 'gold', 2.4);
      this.fb.flash(0.6);
      w.flashes.flash(x, 20, z, 2200);
    }
  }

  private onToppleImpact(x: number, y: number, z: number, size: number): void {
    const d = this.fb.cameraDistance(x, y, z);
    this.fb.shake(clamp((0.3 + size * 0.008) * (180 / Math.max(40, d)), 0.1, 0.8));
    this.audio.crumble(x, z, size);
    this.audio.explosion(x, z, size * 0.2);
    this.fb.text(randPick(TXT.topple), x, 14, z, { size: 70, cls: 'red', life: 1.1 });
    this.world.flashes.flash(x, 4, z, 1500);
  }

  private onCollapseFinish(b: BuildingState, x: number, z: number, r: number): void {
    const w = this.world;
    w.fx.addPlume(x, 0, z, r * 0.7, 16 + b.h * 1.3, Math.random() < 0.55);
    w.ground.scorch(x, z, r * 1.1, 0.3);
  }

  private onKaijuHit(dmg: number, x: number, y: number, z: number): void {
    this.world.kaiju.damage(dmg);
    this.fb.hurt(0.3);
    this.audio.hit(x, z);
    this.fb.shake(0.1);
    if (Math.random() < 0.35) this.fb.text(randPick(TXT.hit), x, y, z, { size: 26, cls: 'white', life: 0.6 });
  }

  private onUnitDestroyed(kind: 'tank' | 'heli', x: number, y: number, z: number): void {
    this.score.hit();
    const pts = this.score.add(kind === 'tank' ? SCORE.tank : SCORE.heli);
    if (kind === 'tank') this.score.stats.tanks++;
    else this.score.stats.helis++;
    this.world.kaiju.addEnergy(ENERGY_GAIN.vehicle);
    this.fb.text(randPick(TXT.boom), x, y + 6, z, { size: 46, cls: 'hot' });
    this.fb.text(`+${formatInt(pts)}`, x, y, z, { cls: 'score', rot: 0 });
    this.world.flashes.flash(x, y, z, 700);
  }

  private onHeliCrash(x: number, y: number, z: number): void {
    const w = this.world;
    w.buildings.damageSphere(x, y, z, 7, { force: 12, soot: 0.6, srcX: x, srcZ: z });
    w.traffic.damageSphere(x, y, z, 10, 12);
    w.trees.damageSphere(x, y, z, 9, true);
    if (y < 4) w.ground.scorch(x, z, 8, 0.5);
    w.fx.addPlume(x, Math.max(0, y - 2), z, 4, 12, true);
  }

  private onCarDestroyed(x: number, y: number, z: number): void {
    this.score.stats.cars++;
    const pts = this.score.add(SCORE.car);
    this.world.kaiju.addEnergy(ENERGY_GAIN.vehicle * 0.3);
    if (Math.random() < 0.5) this.fb.text(`+${pts}`, x, y + 3, z, { cls: 'score', rot: 0, life: 0.8 });
  }

  private spawnWaves(dt: number): void {
    const w = this.world;
    const waves = this.stage.waves;
    while (this.waveIndex < waves.length && this.elapsed >= waves[this.waveIndex].time) {
      const wave = waves[this.waveIndex++];
      for (let i = 0; i < wave.tanks; i++) if (w.military.aliveTanks < this.stage.maxTanks) w.military.spawnTank();
      for (let i = 0; i < wave.helis; i++) if (w.military.aliveHelis < this.stage.maxHelis) w.military.spawnHeli();
      if (wave.message) this.fb.banner(wave.message, 'alert', 2.2);
      this.audio.siren(true);
    }
    // gentle reinforcement so the pressure never disappears completely
    this.reinforceT += dt;
    if (this.waveIndex > 0 && this.reinforceT > 11) {
      this.reinforceT = 0;
      const wantTanks = Math.min(this.stage.maxTanks, 1 + this.waveIndex);
      const wantHelis = this.waveIndex >= 3 ? Math.min(this.stage.maxHelis, this.waveIndex - 1) : 0;
      if (w.military.aliveTanks < wantTanks) w.military.spawnTank();
      if (w.military.aliveHelis < wantHelis) w.military.spawnHeli();
    }
    if (this.waveIndex > 0 && w.military.aliveTanks + w.military.aliveHelis === 0) this.audio.siren(false);
  }
}
