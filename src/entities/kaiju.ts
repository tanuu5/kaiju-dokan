import * as THREE from 'three';
import { KAIJU } from '../config';
import { approachAngle, clamp, damp, easeInOutSine, keyframes, lerp } from '../core/math';

// ---------------------------------------------------------------------------
// Events emitted by the kaiju each frame; the Game turns them into damage/FX.
// ---------------------------------------------------------------------------
export type KaijuEvent =
  | { type: 'step'; x: number; z: number; run: boolean; water: boolean }
  | { type: 'punch'; x: number; y: number; z: number; dirX: number; dirZ: number; big: boolean }
  | { type: 'tail'; points: THREE.Vector3[]; dirSign: number }
  | { type: 'stomp'; x: number; z: number; water: boolean }
  | { type: 'jump'; x: number; z: number }
  | { type: 'roar'; x: number; y: number; z: number }
  | { type: 'breathStart' }
  | { type: 'breathStop' }
  | { type: 'chargeStart' }
  | { type: 'swing'; big: boolean }
  | { type: 'body'; x: number; y: number; z: number; r: number; dirX: number; dirZ: number; speed: number };

export interface KaijuInput {
  /** Desired movement direction in world space (length 0..1). */
  moveX: number;
  moveZ: number;
  run: boolean;
  punch: boolean;
  tail: boolean;
  jump: boolean;
  roar: boolean;
  breath: boolean;
  /** Yaw the kaiju should face when attacking (camera forward). */
  aimYaw: number;
  /** World-space point the breath should hit. */
  aim: THREE.Vector3;
}

export interface KaijuEnv {
  terrainAt(x: number, z: number): number;
  colTop(x: number, z: number): number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

type Action = 'none' | 'punch' | 'smash' | 'tail' | 'jump' | 'roar' | 'intro' | 'dead';

const HIP_Y = 17.5;
/** World-space scale of the model (all local constants above are in unscaled units). */
const S = KAIJU.scale;
const TAIL_SEGS = 11;
const TAIL_LEN = 4.1;
const TAIL_REST = [-0.3, -0.2, -0.12, -0.04, 0.06, 0.1, 0.12, 0.1, 0.08, 0.05, 0.03];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const geoCache = new Map<string, THREE.BufferGeometry>();

function lumpySphere(seed: number, detail = 2, amount = 0.09): THREE.BufferGeometry {
  const key = `${seed}:${detail}:${amount}`;
  const cached = geoCache.get(key);
  if (cached) return cached;
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 5.3 + seed * 1.7) * Math.sin(v.y * 4.1 + seed * 2.3) * Math.sin(v.z * 6.2 + seed * 0.9);
    v.multiplyScalar(1 + n * amount);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geoCache.set(key, geo);
  return geo;
}

const plateGeo = (() => {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(0.32, 1, 0.85);
  g.translate(0, 0.75, 0);
  return g;
})();
const coneGeo = new THREE.ConeGeometry(1, 1, 5);

export class Kaiju {
  readonly root = new THREE.Group();
  readonly hp = { value: KAIJU.maxHp, max: KAIJU.maxHp };
  energy = 60;
  readonly vel = new THREE.Vector3();
  yaw = Math.PI;
  action: Action = 'none';
  actionT = 0;
  cdTail = 0;
  cdJump = 0;
  cdRoar = 0;
  breathState: 'off' | 'charge' | 'fire' | 'recover' = 'off';
  breathT = 0;
  airborne = false;
  dead = false;
  /** Seconds since last damage (for regen). */
  sinceHurt = 99;
  events: KaijuEvent[] = [];

  // skeleton
  private readonly tilt = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly jaw = new THREE.Group();
  private readonly shoulders: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private readonly elbows: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private readonly hips: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private readonly knees: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private readonly ankles: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private readonly tail: THREE.Group[] = [];
  private readonly mouthGlow: THREE.Mesh;
  private readonly hands: THREE.Group[] = [new THREE.Group(), new THREE.Group()];

  // materials
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly plateMat: THREE.MeshStandardMaterial;
  private readonly eyeMat: THREE.MeshStandardMaterial;
  private readonly allMats: THREE.Material[] = [];
  private readonly silMat: THREE.MeshBasicMaterial;

  // animation state
  private gait = 0;
  private lastStep = 0;
  private moveBlend = 0;
  private runBlend = 0;
  private t = 0;
  private yOffset = 0;
  private vy = 0;
  private punchSide = 0;
  private punchCombo = 0;
  private sincePunch = 9;
  private punchQueued = false;
  private punchHitDone = false;
  private punchAimPitch = 0;
  private punchTarget = new THREE.Vector3();
  private attackYaw = 0;
  private roarDone = false;
  private hurtFlash = 0;
  private headYawOff = 0;
  private headPitchOff = 0;
  private breathHeld = false;
  private tailSpinBase = 0;
  private deathT = 0;
  private landT = 9;
  private introT = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tailPoints: THREE.Vector3[] = [];

  constructor() {
    this.root.name = 'kaiju';
    // a touch of emissive keeps the silhouette readable when the sun is behind the kaiju
    this.skin = new THREE.MeshStandardMaterial({ color: 0x55604f, roughness: 0.78, metalness: 0.05, flatShading: true, emissive: new THREE.Color(0x10140f) });
    const skinDark = new THREE.MeshStandardMaterial({ color: 0x3a4038, roughness: 0.85, flatShading: true, emissive: new THREE.Color(0x0b0d0a) });
    const belly = new THREE.MeshStandardMaterial({ color: 0x8f7458, roughness: 0.9, flatShading: true, emissive: new THREE.Color(0x140e08) });
    this.plateMat = new THREE.MeshStandardMaterial({
      color: 0x3a2722,
      roughness: 0.6,
      emissive: new THREE.Color(0xff5a1a),
      emissiveIntensity: 0.35,
      flatShading: true,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: new THREE.Color(0xffb030), emissiveIntensity: 2.2 });
    const claw = new THREE.MeshStandardMaterial({ color: 0xe0d6c2, roughness: 0.45, flatShading: true });
    const mouth = new THREE.MeshStandardMaterial({ color: 0x4a1410, roughness: 0.7, flatShading: true });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0 });
    this.allMats.push(this.skin, skinDark, belly, this.plateMat, this.eyeMat, claw, mouth);
    for (const m of this.allMats) {
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
    }
    this.silMat = new THREE.MeshBasicMaterial({
      color: 0xffa060,
      transparent: true,
      opacity: 0.2,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
      fog: false,
    });

    const blob = (parent: THREE.Object3D, mat: THREE.Material, rx: number, ry: number, rz: number, x: number, y: number, z: number, seed = 0, rot?: [number, number, number]) => {
      const m = new THREE.Mesh(lumpySphere(seed), mat);
      m.scale.set(rx, ry, rz);
      m.position.set(x, y, z);
      if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const cone = (parent: THREE.Object3D, mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, rot: [number, number, number]) => {
      const m = new THREE.Mesh(coneGeo, mat);
      m.scale.set(r, h, r);
      m.position.set(x, y, z);
      m.rotation.set(rot[0], rot[1], rot[2]);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const plate = (parent: THREE.Object3D, x: number, y: number, z: number, h: number, tiltX: number, rollZ = 0) => {
      const m = new THREE.Mesh(plateGeo, this.plateMat);
      m.scale.set(h * 0.72, h * 0.82, h * 0.72);
      m.position.set(x, y, z);
      m.rotation.set(tiltX, 0, rollZ);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // ---- hierarchy ----
    this.root.add(this.tilt);
    this.tilt.scale.setScalar(S);
    this.tilt.add(this.body);
    this.body.position.set(0, HIP_Y, 0);
    blob(this.body, this.skin, 7.2, 6.2, 7.5, 0, 0.5, -1.2, 1);

    this.body.add(this.torso);
    blob(this.torso, this.skin, 8.6, 10.8, 8.6, 0, 8, 0.5, 2);
    blob(this.torso, belly, 6.4, 9.2, 4.6, 0, 7, 5.2, 3);
    this.torso.add(this.chest);
    this.chest.position.set(0, 14, 2.2);
    blob(this.chest, this.skin, 8.2, 6.8, 7.6, 0, 0.5, 0.5, 4);
    blob(this.chest, belly, 5.8, 5.2, 4.2, 0, 0, 5.2, 5);

    // neck + head
    this.chest.add(this.neck);
    this.neck.position.set(0, 4.2, 3.2);
    blob(this.neck, this.skin, 4.6, 5.4, 4.8, 0, 2.2, 1.6, 6);
    this.neck.add(this.head);
    this.head.position.set(0, 5.6, 4.2);
    blob(this.head, this.skin, 4.3, 3.7, 5.4, 0, 1.0, 2.2, 7);
    blob(this.head, this.skin, 3.1, 2.5, 3.9, 0, -0.1, 7.3, 8);
    blob(this.head, skinDark, 1.6, 1.0, 2.6, 2.3, 2.6, 5.0, 9, [0.2, 0.25, 0.1]);
    blob(this.head, skinDark, 1.6, 1.0, 2.6, -2.3, 2.6, 5.0, 9, [0.2, -0.25, -0.1]);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(lumpySphere(0, 1, 0), this.eyeMat);
      eye.scale.set(0.75, 0.55, 0.75);
      eye.position.set(s * 2.55, 1.75, 6.5);
      this.head.add(eye);
      cone(this.head, claw, 0.9, 5.5, s * 2.4, 3.2, -1.2, [-1.1, 0, s * -0.35]);
      cone(this.head, claw, 0.6, 3.2, s * 3.2, 1.6, -0.8, [-1.35, 0, s * -0.9]);
    }
    // upper teeth
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 1]) cone(this.head, claw, 0.32, 1.3, s * (2.2 - i * 0.12), -2.0, 4.6 + i * 1.3, [Math.PI, 0, 0]);
    }
    this.head.add(this.jaw);
    this.jaw.position.set(0, -1.2, 1.8);
    blob(this.jaw, this.skin, 3.0, 1.35, 5.2, 0, -1.0, 4.4, 10);
    blob(this.jaw, mouth, 2.4, 0.6, 4.2, 0, -0.2, 4.6, 11);
    for (let i = 0; i < 4; i++) {
      for (const s of [-1, 1]) cone(this.jaw, claw, 0.3, 1.1, s * (2.0 - i * 0.12), 0.35, 3.2 + i * 1.4, [0, 0, 0]);
    }
    this.mouthGlow = new THREE.Mesh(lumpySphere(0, 1, 0), glow);
    this.mouthGlow.scale.set(2.2, 1.4, 2.2);
    this.mouthGlow.position.set(0, -1.0, 7.5);
    this.head.add(this.mouthGlow);

    // arms
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const sh = this.shoulders[s];
      sh.position.set(side * 7.4, 0.6, 2.8);
      this.chest.add(sh);
      blob(sh, this.skin, 3.1, 3.1, 3.1, 0, 0, 0, 12);
      blob(sh, this.skin, 2.7, 5.2, 2.7, 0, -4.2, 0, 13);
      const el = this.elbows[s];
      el.position.set(0, -8.4, 0);
      sh.add(el);
      blob(el, this.skin, 2.4, 4.6, 2.4, 0, -3.6, 0, 14);
      const hand = this.hands[s];
      hand.position.set(0, -7.6, 0.2);
      el.add(hand);
      blob(hand, skinDark, 2.5, 2.2, 2.7, 0, -0.6, 0.4, 15);
      for (let c = 0; c < 3; c++) cone(hand, claw, 0.45, 2.3, (c - 1) * 1.2, -2.4, 1.6, [2.4, 0, 0]);
    }

    // legs
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const hip = this.hips[s];
      hip.position.set(side * 6.0, -0.5, -0.4);
      this.body.add(hip);
      blob(hip, this.skin, 4.6, 6.4, 5.2, 0, -3.6, 1.0, 16);
      const knee = this.knees[s];
      knee.position.set(0, -8.0, 2.6);
      hip.add(knee);
      blob(knee, this.skin, 3.1, 4.9, 3.3, 0, -3.3, -0.9, 17);
      const ankle = this.ankles[s];
      ankle.position.set(0, -7.4, -1.6);
      knee.add(ankle);
      blob(ankle, skinDark, 3.7, 1.8, 5.4, 0, -0.6, 2.2, 18);
      for (let c = 0; c < 3; c++) cone(ankle, claw, 0.6, 2.0, (c - 1) * 1.8, -1.2, 7.0, [Math.PI / 2, 0, 0]);
    }

    // tail
    let parent: THREE.Object3D = this.body;
    for (let i = 0; i < TAIL_SEGS; i++) {
      const g = new THREE.Group();
      if (i === 0) g.position.set(0, 1.2, -6.2);
      else g.position.set(0, 0, -TAIL_LEN);
      parent.add(g);
      const r = lerp(5.4, 0.9, i / (TAIL_SEGS - 1));
      blob(g, this.skin, r, r * 0.88, TAIL_LEN * 0.78, 0, 0, -TAIL_LEN * 0.5, 20 + (i % 3));
      if (i < TAIL_SEGS - 1) plate(g, 0, r * 0.7, -TAIL_LEN * 0.5, lerp(3.6, 1.0, i / (TAIL_SEGS - 1)), -0.55);
      this.tail.push(g);
      this.tailPoints.push(new THREE.Vector3());
      parent = g;
    }

    // dorsal plates along the back
    const backPlates: [THREE.Object3D, number, number, number, number, number][] = [
      [this.neck, 0, 5.0, -2.0, 3.2, -0.4],
      [this.chest, 0, 5.5, -5.0, 4.8, -0.5],
      [this.chest, 2.6, 4.2, -5.6, 3.2, -0.5],
      [this.chest, -2.6, 4.2, -5.6, 3.2, -0.5],
      [this.torso, 0, 16.2, -6.4, 6.0, -0.55],
      [this.torso, 2.9, 14.2, -6.6, 4.2, -0.55],
      [this.torso, -2.9, 14.2, -6.6, 4.2, -0.55],
      [this.torso, 0, 11.2, -8.2, 6.4, -0.7],
      [this.torso, 3.0, 9.6, -7.8, 4.4, -0.7],
      [this.torso, -3.0, 9.6, -7.8, 4.4, -0.7],
      [this.torso, 0, 5.8, -8.6, 5.6, -0.85],
      [this.torso, 2.8, 4.4, -8.0, 3.6, -0.85],
      [this.torso, -2.8, 4.4, -8.0, 3.6, -0.85],
      [this.body, 0, 3.0, -6.6, 4.4, -1.0],
    ];
    for (const [p, x, y, z, h, tx] of backPlates) plate(p, x, y, z, h, tx, x === 0 ? 0 : -Math.sign(x) * 0.25);

    // silhouette copies (drawn only where the kaiju is hidden behind buildings).
    // The kaiju itself renders after all other opaque geometry so the stencil marks
    // exactly the pixels where it is really visible.
    const meshes: THREE.Mesh[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.mouthGlow) meshes.push(o as THREE.Mesh);
    });
    for (const m of meshes) {
      m.renderOrder = 5;
      const s = new THREE.Mesh(m.geometry, this.silMat);
      s.position.copy(m.position);
      s.rotation.copy(m.rotation);
      s.scale.copy(m.scale);
      s.renderOrder = 50;
      s.castShadow = false;
      m.parent!.add(s);
    }
  }

  get position(): THREE.Vector3 {
    return this.root.position;
  }

  get forwardX(): number {
    return Math.sin(this.yaw);
  }

  get forwardZ(): number {
    return Math.cos(this.yaw);
  }

  /** World position of the chest (enemy aim point). */
  chestPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.chest.getWorldPosition(out);
  }

  headPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.head.getWorldPosition(out);
  }

  /** World position of the mouth (breath origin). */
  mouthPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.mouthGlow.getWorldPosition(out);
  }

  /** True if a world point is inside the kaiju's rough hit volume. */
  hitTest(p: THREE.Vector3, pad = 0): boolean {
    const rp = this.root.position;
    const dx = p.x - rp.x;
    const dz = p.z - rp.z;
    // quick reject
    if (dx * dx + dz * dz > 70 * 70) return false;
    this.chest.getWorldPosition(this.tmp);
    if (this.tmp.distanceToSquared(p) < (9.5 * S + pad) ** 2) return true;
    this.torso.getWorldPosition(this.tmp);
    this.tmp.y += 7 * S;
    if (this.tmp.distanceToSquared(p) < (10 * S + pad) ** 2) return true;
    this.head.getWorldPosition(this.tmp);
    if (this.tmp.distanceToSquared(p) < (6.5 * S + pad) ** 2) return true;
    // legs: vertical capsule approx
    if (p.y < rp.y + HIP_Y * S && dx * dx + dz * dz < (8 * S + pad) ** 2) return true;
    return false;
  }

  damage(amount: number): void {
    if (this.dead || this.action === 'intro') return;
    this.hp.value = Math.max(0, this.hp.value - amount);
    this.hurtFlash = 1;
    this.sinceHurt = 0;
    if (this.hp.value <= 0) this.die();
  }

  heal(v: number): void {
    if (!this.dead) this.hp.value = Math.min(this.hp.max, this.hp.value + v);
  }

  addEnergy(v: number): void {
    this.energy = clamp(this.energy + v, 0, KAIJU.maxEnergy);
  }

  startIntro(x: number, z: number): void {
    this.root.position.set(x, -46 * S, z);
    this.yaw = Math.PI;
    this.action = 'intro';
    this.introT = 0;
    this.actionT = 0;
  }

  private die(): void {
    this.dead = true;
    this.action = 'dead';
    this.actionT = 0;
    this.deathT = 0;
    if (this.breathState === 'fire') this.events.push({ type: 'breathStop' });
    this.breathState = 'off';
  }

  // -------------------------------------------------------------------------
  update(dt: number, input: KaijuInput | null, env: KaijuEnv): KaijuEvent[] {
    this.events = [];
    this.t += dt;
    this.actionT += dt;
    this.sincePunch += dt;
    this.sinceHurt += dt;
    this.landT += dt;
    this.cdTail = Math.max(0, this.cdTail - dt);
    this.cdJump = Math.max(0, this.cdJump - dt);
    this.cdRoar = Math.max(0, this.cdRoar - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 5);
    if (!this.dead && this.sinceHurt > KAIJU.regenDelay) this.hp.value = Math.min(this.hp.max, this.hp.value + KAIJU.regenRate * dt);

    const pos = this.root.position;
    const ground = env.terrainAt(pos.x, pos.z);

    if (this.action === 'intro') {
      this.updateIntro(dt, ground);
      this.pose(dt, ground);
      return this.events;
    }
    if (this.action === 'dead') {
      this.deathT += dt;
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
      this.pose(dt, ground);
      return this.events;
    }

    const inp = input;
    // ---- action triggers ----
    if (inp) {
      if (inp.punch) {
        if (this.action === 'none') this.startPunch(inp, env);
        else if ((this.action === 'punch' && this.actionT > 0.2) || (this.action === 'smash' && this.actionT > 0.45)) this.punchQueued = true;
      }
      if (inp.tail && this.cdTail <= 0 && (this.action === 'none' || this.action === 'punch') && this.breathState === 'off') {
        this.action = 'tail';
        this.actionT = 0;
        this.cdTail = KAIJU.tailCooldown;
        this.tailSpinBase = this.yaw;
        this.events.push({ type: 'swing', big: true });
      }
      if (inp.jump && this.cdJump <= 0 && !this.airborne && (this.action === 'none' || this.action === 'punch')) {
        this.action = 'jump';
        this.actionT = 0;
        this.cdJump = KAIJU.jumpCooldown;
      }
      if (inp.roar && this.cdRoar <= 0 && this.action === 'none' && !this.airborne) {
        this.action = 'roar';
        this.actionT = 0;
        this.roarDone = false;
        this.cdRoar = KAIJU.roarCooldown;
      }
      this.breathHeld = inp.breath;
    } else {
      this.breathHeld = false;
    }

    // ---- breath state machine ----
    this.updateBreath(dt);

    // ---- movement ----
    let speed = 0;
    let dirX = 0;
    let dirZ = 0;
    if (inp) {
      const len = Math.hypot(inp.moveX, inp.moveZ);
      if (len > 0.05) {
        dirX = inp.moveX / len;
        dirZ = inp.moveZ / len;
        speed = (inp.run ? KAIJU.runSpeed : KAIJU.walkSpeed) * Math.min(1, len);
      }
    }
    let mul = 1;
    if (this.action === 'punch' || this.action === 'smash') mul = 0.45;
    else if (this.action === 'tail') mul = 0.3;
    else if (this.action === 'roar') mul = 0;
    else if (this.action === 'jump' && !this.airborne) mul = 0.2;
    if (this.breathState !== 'off') mul *= 0.35;
    speed *= mul;
    const running = !!inp?.run && speed > KAIJU.walkSpeed * 0.9;

    const tx = dirX * speed;
    const tz = dirZ * speed;
    const k = damp(this.airborne ? 2.5 : 5, dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;

    // facing
    const attacking = this.action === 'punch' || this.action === 'smash' || this.breathState !== 'off' || this.action === 'roar';
    if (this.action !== 'tail') {
      let targetYaw = this.yaw;
      if ((this.action === 'punch' || this.action === 'smash') && this.breathState === 'off') targetYaw = this.attackYaw;
      else if (attacking && inp) targetYaw = inp.aimYaw;
      else if (speed > 0.5) targetYaw = Math.atan2(dirX, dirZ);
      const turn = (running ? KAIJU.turnSpeed * 0.75 : KAIJU.turnSpeed) * (attacking ? 1.6 : 1) * dt;
      this.yaw = approachAngle(this.yaw, targetYaw, turn);
    }

    pos.x += this.vel.x * dt;
    pos.z += this.vel.z * dt;
    const b = env.bounds;
    pos.x = clamp(pos.x, b.minX, b.maxX);
    pos.z = clamp(pos.z, b.minZ, b.maxZ);

    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.moveBlend += ((hSpeed > 1 ? 1 : hSpeed) - this.moveBlend) * damp(6, dt);
    this.runBlend += ((running ? 1 : 0) - this.runBlend) * damp(4, dt);

    // gait + footsteps
    const groundNow = env.terrainAt(pos.x, pos.z);
    if (!this.airborne) {
      this.gait += (hSpeed * dt * Math.PI) / KAIJU.strideLength;
      const step = Math.floor((this.gait - Math.PI / 2) / Math.PI);
      if (step !== this.lastStep) {
        this.lastStep = step;
        if (hSpeed > 2) {
          const foot = step & 1 ? 1 : 0;
          const side = foot === 0 ? -1 : 1;
          const fx = pos.x + (Math.cos(this.yaw) * side * 6 + Math.sin(this.yaw) * 5) * S;
          const fz = pos.z + (-Math.sin(this.yaw) * side * 6 + Math.cos(this.yaw) * 5) * S;
          this.events.push({ type: 'step', x: fx, z: fz, run: running, water: groundNow < -1.5 });
        }
      }
      // bulldozing contact
      if (hSpeed > 2) {
        const fx = Math.sin(this.yaw);
        const fz = Math.cos(this.yaw);
        this.events.push({ type: 'body', x: pos.x + fx * 7 * S, y: 8 * S, z: pos.z + fz * 7 * S, r: 8.5 * S, dirX: fx, dirZ: fz, speed: hSpeed });
        this.events.push({ type: 'body', x: pos.x + fx * 9 * S, y: 24 * S, z: pos.z + fz * 9 * S, r: 9.5 * S, dirX: fx, dirZ: fz, speed: hSpeed });
      }
    }

    // ---- actions ----
    this.updateAction(inp, env);

    // vertical
    if (this.airborne) {
      this.vy -= 58 * dt;
      this.yOffset += this.vy * dt;
      if (this.yOffset <= 0) {
        this.yOffset = 0;
        this.airborne = false;
        this.vy = 0;
        this.landT = 0;
        this.events.push({ type: 'stomp', x: pos.x + Math.sin(this.yaw) * 3, z: pos.z + Math.cos(this.yaw) * 3, water: groundNow < -1.5 });
        this.action = 'none';
      }
    }
    pos.y = groundNow + this.yOffset;

    this.pose(dt, groundNow);
    return this.events;
  }

  private startPunch(inp: KaijuInput, env: KaijuEnv): void {
    const big = this.sincePunch < 0.45 && this.punchCombo >= 1;
    this.punchCombo = this.sincePunch < 0.45 ? this.punchCombo + 1 : 0;
    const isSmash = big && this.punchCombo % 3 === 2;
    this.action = isSmash ? 'smash' : 'punch';
    this.actionT = 0;
    this.punchHitDone = false;
    this.punchSide = 1 - this.punchSide;
    this.punchQueued = false;
    // soft auto-aim: swing towards the tallest structure within ±35° of the camera direction
    const p = this.root.position;
    let bestYaw = inp.aimYaw;
    let bestScore = 0;
    let top = 0;
    for (const off of [0, -0.3, 0.3, -0.6, 0.6]) {
      const yaw = inp.aimYaw + off;
      const sx = Math.sin(yaw);
      const sz = Math.cos(yaw);
      let t = 0;
      for (const d of [11, 15, 19, 23]) t = Math.max(t, env.colTop(p.x + sx * d * S, p.z + sz * d * S));
      const score = t > 0 ? t + 12 - Math.abs(off) * 14 : 0;
      if (score > bestScore) {
        bestScore = score;
        bestYaw = yaw;
        top = t;
      }
    }
    this.attackYaw = bestYaw;
    const fx = Math.sin(bestYaw);
    const fz = Math.cos(bestYaw);
    const ty = isSmash ? Math.max(4, Math.min(top - 3, 26 * S)) : clamp(top > 0 ? top - 5 : 20 * S, 7, 30 * S);
    const reach = (isSmash ? 15 : 17) * S;
    this.punchTarget.set(p.x + fx * reach, p.y + ty, p.z + fz * reach);
    this.punchAimPitch = clamp(Math.atan2(ty - 31 * S, reach - 3 * S), -0.9, 0.35);
    this.events.push({ type: 'swing', big: isSmash });
  }

  private updateAction(inp: KaijuInput | null, env: KaijuEnv): void {
    const p = this.root.position;
    switch (this.action) {
      case 'punch':
      case 'smash': {
        const hitAt = this.action === 'smash' ? 0.36 : 0.16;
        const dur = this.action === 'smash' ? 0.62 : 0.36;
        if (!this.punchHitDone && this.actionT >= hitAt) {
          this.punchHitDone = true;
          const fx = Math.sin(this.yaw);
          const fz = Math.cos(this.yaw);
          this.events.push({
            type: 'punch',
            x: this.punchTarget.x,
            y: this.punchTarget.y,
            z: this.punchTarget.z,
            dirX: fx,
            dirZ: fz,
            big: this.action === 'smash',
          });
        }
        if (this.actionT >= dur) {
          this.action = 'none';
          this.sincePunch = 0;
          if (this.punchQueued && inp) {
            this.punchQueued = false;
            this.startPunch(inp, env);
          }
        }
        break;
      }
      case 'tail': {
        const u = clamp((this.actionT - 0.08) / 0.62, 0, 1);
        this.yaw = this.tailSpinBase + easeInOutSine(u) * Math.PI * 2;
        if (this.actionT > 0.12 && this.actionT < 0.72) {
          for (let i = 2; i < TAIL_SEGS; i++) this.tail[i].getWorldPosition(this.tailPoints[i]);
          this.events.push({ type: 'tail', points: this.tailPoints.slice(2), dirSign: 1 });
        }
        if (this.actionT >= 0.9) {
          this.action = 'none';
          this.yaw = this.tailSpinBase;
        }
        break;
      }
      case 'jump': {
        if (!this.airborne && this.actionT >= 0.16) {
          this.airborne = true;
          this.vy = 27;
          this.yOffset = 0.01;
          this.events.push({ type: 'jump', x: p.x, z: p.z });
        }
        break;
      }
      case 'roar': {
        if (!this.roarDone && this.actionT >= 0.35) {
          this.roarDone = true;
          this.head.getWorldPosition(this.tmp);
          this.events.push({ type: 'roar', x: this.tmp.x, y: this.tmp.y, z: this.tmp.z });
        }
        if (this.actionT >= 1.8) this.action = 'none';
        break;
      }
      default:
        break;
    }
  }

  private updateBreath(dt: number): void {
    this.breathT += dt;
    const canStart = this.action === 'none' || this.action === 'punch';
    switch (this.breathState) {
      case 'off':
        if (this.breathHeld && canStart && this.energy > KAIJU.breathMinEnergy && !this.airborne) {
          this.breathState = 'charge';
          this.breathT = 0;
          this.events.push({ type: 'chargeStart' });
        }
        break;
      case 'charge':
        if (!this.breathHeld) {
          this.breathState = 'off';
          this.events.push({ type: 'breathStop' });
        } else if (this.breathT >= KAIJU.breathChargeTime) {
          this.breathState = 'fire';
          this.breathT = 0;
          this.events.push({ type: 'breathStart' });
        }
        break;
      case 'fire':
        this.energy = Math.max(0, this.energy - KAIJU.breathCost * dt);
        if (!this.breathHeld || this.energy <= 0) {
          this.breathState = 'recover';
          this.breathT = 0;
          this.events.push({ type: 'breathStop' });
        }
        break;
      case 'recover':
        if (this.breathT >= 0.3) this.breathState = 'off';
        break;
    }
  }

  get breathing(): boolean {
    return this.breathState === 'fire';
  }

  get charging(): boolean {
    return this.breathState === 'charge';
  }

  private updateIntro(dt: number, ground: number): void {
    this.introT += dt;
    const p = this.root.position;
    const u = clamp(this.introT / 4.2, 0, 1);
    p.y = lerp(-46 * S, ground, 1 - Math.pow(1 - u, 2.2));
    this.moveBlend = 0.25;
    this.gait += dt * 1.2;
    if (this.introT > 4.2 && !this.roarDone) {
      this.roarDone = true;
      this.head.getWorldPosition(this.tmp);
      this.events.push({ type: 'roar', x: this.tmp.x, y: this.tmp.y, z: this.tmp.z });
    }
    if (this.introT > 6.0) {
      this.action = 'none';
      this.roarDone = false;
      this.moveBlend = 0;
    }
  }

  get introProgress(): number {
    return this.introT;
  }

  // -------------------------------------------------------------------------
  // Procedural pose
  // -------------------------------------------------------------------------
  private pose(dt: number, _ground: number): void {
    const t = this.t;
    const mb = this.moveBlend;
    const rb = this.runBlend;
    const g = this.gait;
    this.root.rotation.y = this.yaw;

    // body bob / sway
    const bob = -Math.abs(Math.cos(g)) * (1.1 + rb * 0.8) * mb;
    const breathe = Math.sin(t * 1.7) * 0.25;
    let bodyY = HIP_Y + bob + breathe * (1 - mb);
    let torsoPitch = 0.2 + mb * 0.08 + rb * 0.12;
    let torsoTwist = Math.sin(g) * 0.1 * mb;
    let torsoRoll = 0;
    let headPitch = -0.12 + Math.sin(t * 0.9) * 0.04;
    let headYaw = Math.sin(t * 0.37) * 0.12 * (1 - mb);
    let jawOpen = 0.04 + Math.max(0, Math.sin(t * 0.8)) * 0.03;
    const armSwing = Math.sin(g) * 0.28 * mb;
    const sh = [
      { x: -0.3 + armSwing, z: -0.28, el: -0.75 },
      { x: -0.3 - armSwing, z: 0.28, el: -0.75 },
    ];
    // legs
    const legA = (0.42 + rb * 0.18) * mb;
    const legs = [0, 1].map((i) => {
      const ph = g + (i === 0 ? 0 : Math.PI);
      const thigh = -Math.sin(ph) * legA - 0.12;
      const knee = Math.max(0, Math.cos(ph)) * (0.75 + rb * 0.3) * mb + 0.22;
      return { thigh, knee };
    });

    // ---- action overlays ----
    const at = this.actionT;
    if (this.action === 'punch') {
      const s = this.punchSide;
      const other = 1 - s;
      const aim = this.punchAimPitch;
      sh[s].x = keyframes(
        [
          [0, sh[s].x],
          [0.08, 0.55],
          [0.16, -1.6 - aim],
          [0.24, -1.55 - aim],
          [0.36, sh[s].x],
        ],
        at,
      );
      sh[s].el = keyframes(
        [
          [0, -0.75],
          [0.08, -1.5],
          [0.16, -0.08],
          [0.24, -0.12],
          [0.36, -0.75],
        ],
        at,
      );
      sh[s].z = (s === 0 ? -1 : 1) * keyframes([[0, 0.28], [0.16, 0.05], [0.36, 0.28]], at);
      sh[other].x = keyframes([[0, sh[other].x], [0.16, 0.25], [0.36, sh[other].x]], at);
      const tw = (s === 0 ? 1 : -1) * keyframes([[0, 0], [0.08, -0.25], [0.16, 0.38], [0.36, 0]], at);
      torsoTwist += tw;
      torsoPitch += keyframes([[0, 0], [0.16, 0.12], [0.36, 0]], at);
      jawOpen = keyframes([[0, 0.05], [0.16, 0.35], [0.36, 0.05]], at);
    } else if (this.action === 'smash') {
      for (const s of [0, 1]) {
        sh[s].x = keyframes(
          [
            [0, sh[s].x],
            [0.24, -2.9],
            [0.36, -0.7],
            [0.46, -0.75],
            [0.62, sh[s].x],
          ],
          at,
        );
        sh[s].el = keyframes([[0, -0.75], [0.24, -0.4], [0.36, -0.15], [0.62, -0.75]], at);
        sh[s].z = (s === 0 ? -1 : 1) * keyframes([[0, 0.28], [0.24, 0.1], [0.36, 0.05], [0.62, 0.28]], at);
      }
      torsoPitch += keyframes([[0, 0], [0.24, -0.25], [0.36, 0.45], [0.46, 0.4], [0.62, 0]], at);
      bodyY += keyframes([[0, 0], [0.24, 0.5], [0.36, -2.5], [0.62, 0]], at);
      jawOpen = keyframes([[0, 0.05], [0.3, 0.5], [0.62, 0.05]], at);
    } else if (this.action === 'tail') {
      bodyY -= keyframes([[0, 0], [0.12, 1.8], [0.7, 1.8], [0.9, 0]], at);
      torsoPitch += keyframes([[0, 0], [0.12, 0.18], [0.7, 0.18], [0.9, 0]], at);
      for (const s of [0, 1]) {
        sh[s].z = (s === 0 ? -1 : 1) * keyframes([[0, 0.28], [0.15, 0.7], [0.7, 0.7], [0.9, 0.28]], at);
      }
    } else if (this.action === 'jump') {
      if (!this.airborne) {
        bodyY -= keyframes([[0, 0], [0.16, 3.2]], at);
        torsoPitch += 0.2;
      } else {
        for (const l of legs) {
          l.thigh = -0.55;
          l.knee = 1.1;
        }
        for (const s of [0, 1]) {
          sh[s].x = -1.8;
          sh[s].el = -0.6;
          sh[s].z = (s === 0 ? -1 : 1) * 0.6;
        }
        torsoPitch -= 0.1;
        jawOpen = 0.45;
      }
    } else if (this.action === 'roar') {
      const e = keyframes([[0, 0], [0.3, 1], [1.4, 1], [1.8, 0]], at);
      torsoPitch -= 0.35 * e;
      headPitch -= 0.55 * e;
      jawOpen = lerp(jawOpen, 0.85, e);
      headYaw += Math.sin(at * 28) * 0.04 * e;
      for (const s of [0, 1]) {
        sh[s].x = lerp(sh[s].x, -1.0, e);
        sh[s].z = (s === 0 ? -1 : 1) * lerp(0.28, 1.0, e);
        sh[s].el = lerp(sh[s].el, -0.4, e);
      }
    } else if (this.action === 'intro') {
      const e = clamp((this.introT - 4.0) / 0.4, 0, 1) * (1 - clamp((this.introT - 5.6) / 0.4, 0, 1));
      torsoPitch -= 0.35 * e;
      headPitch -= 0.6 * e;
      jawOpen = lerp(jawOpen, 0.85, e);
      for (const s of [0, 1]) sh[s].z = (s === 0 ? -1 : 1) * lerp(0.28, 1.0, e);
    }
    if (this.landT < 0.4) {
      const e = 1 - this.landT / 0.4;
      bodyY -= 4 * e * e;
      torsoPitch += 0.25 * e;
    }

    // breath pose: raise head, open jaw
    if (this.breathState !== 'off') {
      const e = this.breathState === 'charge' ? clamp(this.breathT / KAIJU.breathChargeTime, 0, 1) : this.breathState === 'recover' ? 1 - clamp(this.breathT / 0.3, 0, 1) : 1;
      jawOpen = lerp(jawOpen, this.breathState === 'charge' ? 0.25 : 0.7, e);
      torsoPitch += (this.breathState === 'charge' ? -0.15 : 0.05) * e;
      headPitch += this.headPitchOff * e;
      headYaw += this.headYawOff * e;
    }

    // hurt flinch
    torsoPitch -= this.hurtFlash * 0.12;
    torsoRoll += Math.sin(t * 40) * this.hurtFlash * 0.03;

    // death
    if (this.action === 'dead') {
      const u = clamp(this.deathT / 1.6, 0, 1);
      this.tilt.rotation.x = -easeInQuad(u) * 1.3;
      this.tilt.position.z = -easeInQuad(u) * 6;
      jawOpen = 0.7;
      headPitch = -0.5;
    } else {
      this.tilt.rotation.x = 0;
      this.tilt.position.z = 0;
    }

    // ---- apply ----
    const k = damp(18, dt);
    this.body.position.y += (bodyY - this.body.position.y) * k;
    this.body.position.x = Math.sin(g) * 0.5 * mb;
    this.body.rotation.z = Math.sin(g) * 0.05 * mb;
    this.torso.rotation.x += (torsoPitch - this.torso.rotation.x) * k;
    this.torso.rotation.y += (torsoTwist - this.torso.rotation.y) * k;
    this.torso.rotation.z = torsoRoll;
    this.neck.rotation.x = headPitch * 0.4 - torsoPitch * 0.35;
    this.head.rotation.x = headPitch * 0.6 - torsoPitch * 0.3;
    this.head.rotation.y = headYaw;
    this.neck.rotation.y = headYaw * 0.5;
    this.jaw.rotation.x += (jawOpen - this.jaw.rotation.x) * damp(20, dt);
    for (let s = 0; s < 2; s++) {
      const a = sh[s];
      const S = this.shoulders[s];
      S.rotation.x += (a.x - S.rotation.x) * damp(26, dt);
      S.rotation.z += (a.z - S.rotation.z) * damp(20, dt);
      const E = this.elbows[s];
      E.rotation.x += (a.el - E.rotation.x) * damp(26, dt);
      this.hands[s].rotation.x = -0.3;
    }
    for (let i = 0; i < 2; i++) {
      const L = legs[i];
      this.hips[i].rotation.x += (L.thigh - this.hips[i].rotation.x) * damp(20, dt);
      this.knees[i].rotation.x += (L.knee - this.knees[i].rotation.x) * damp(20, dt);
      this.ankles[i].rotation.x = -(this.hips[i].rotation.x + this.knees[i].rotation.x) * 0.9;
    }
    // tail
    const sway = 0.08 + 0.1 * mb;
    const spin = this.action === 'tail' ? Math.sin(clamp((this.actionT - 0.05) / 0.7, 0, 1) * Math.PI) : 0;
    for (let i = 0; i < TAIL_SEGS; i++) {
      const seg = this.tail[i];
      const f = i / (TAIL_SEGS - 1);
      seg.rotation.x = TAIL_REST[i] + Math.sin(t * 1.3 - i * 0.5) * 0.02 + spin * (i === 0 ? 0.35 : 0.02);
      seg.rotation.y = Math.sin(t * 1.4 + g * 0.5 - i * 0.55) * sway * (0.3 + f) - spin * 0.22;
    }

    // glow
    let glowK = 0.16 + Math.sin(t * 2.2) * 0.05;
    let mouthA = 0;
    if (this.breathState === 'charge') {
      const u = clamp(this.breathT / KAIJU.breathChargeTime, 0, 1);
      glowK = 0.5 + u * 3;
      mouthA = u * 0.6;
    } else if (this.breathState === 'fire') {
      glowK = 3.2 + Math.sin(t * 40) * 0.5;
      mouthA = 0.9;
    }
    if (this.energy >= KAIJU.maxEnergy - 0.5 && this.breathState === 'off') glowK += 0.22 + Math.sin(t * 5) * 0.14;
    this.plateMat.emissiveIntensity = glowK;
    (this.mouthGlow.material as THREE.MeshBasicMaterial).opacity = mouthA;
    this.skin.emissive.setRGB(0.0052 + this.hurtFlash * 0.22, 0.007 + this.hurtFlash * 0.02, 0.0048);
  }

  /** Aim the head towards a world point during breath (small offsets only). */
  aimHead(target: THREE.Vector3): void {
    this.neck.getWorldPosition(this.tmp);
    this.tmp2.copy(target).sub(this.tmp);
    const yawTo = Math.atan2(this.tmp2.x, this.tmp2.z);
    const flat = Math.hypot(this.tmp2.x, this.tmp2.z);
    const pitchTo = Math.atan2(this.tmp2.y, flat);
    this.headYawOff = clamp(yawDiff(this.yaw, yawTo), -0.5, 0.5);
    this.headPitchOff = clamp(-pitchTo - 0.1, -0.7, 0.9);
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material !== this.silMat) {
        const mat = m.material as THREE.Material;
        mat.dispose();
      }
    });
    this.silMat.dispose();
  }
}

function yawDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function easeInQuad(t: number): number {
  return t * t;
}
