// Browser shell: renderer, post-processing, camera, input, HUD and screens.
// Gameplay rules live in Session (session.ts) so they can also run headless.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { KAIJU } from '../config';
import { AudioSys } from '../core/audio';
import { Input } from '../core/input';
import { clamp, formatInt } from '../core/math';
import { rand } from '../core/rng';
import type { KaijuInput } from '../entities/kaiju';
import { SfxText } from '../fx/sfxText';
import { STAGE1, type StageDef } from '../stages/stages';
import { Hud } from '../ui/hud';
import { Minimap } from '../ui/minimap';
import type { RayHit } from '../world/buildings';
import { createSkyMaterial, PALETTE, SUN_DIR } from '../world/environment';
import { CameraRig, DEFAULT_PITCH } from './cameraRig';
import { finalScore, rankFor, type ScoreKeeper } from './scoring';
import { Session, type Feedback } from './session';
import type { World } from './world';

type GameState = 'loading' | 'title' | 'intro' | 'playing' | 'paused' | 'dying' | 'result';

const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uFlash: { value: 0 },
    uVignette: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uFlash;
uniform float uVignette;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = vUv - 0.5;
  float v = 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
  vec3 col = max(c.rgb, vec3(0.0)) * v + vec3(1.0, 0.85, 0.6) * uFlash;
  gl_FragColor = vec4(col, c.a);
}`,
};

const STORAGE_KEY = 'kaiju-dokan-v1';
/** How long the "click to use the mouse" hint stays on screen. */
const LOCK_HINT_SECONDS = 5;

interface Settings {
  sens: number;
  invert: boolean;
  volume: number;
  music: boolean;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly input: Input;
  readonly audio = new AudioSys();
  readonly hud = new Hud();
  readonly stage: StageDef = STAGE1;
  session!: Session;
  state: GameState = 'loading';

  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly finalPass: ShaderPass;
  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly sun: THREE.DirectionalLight;
  private readonly sfx: SfxText;
  private readonly feedback: Feedback;
  private minimap!: Minimap;
  private hitStop = 0;
  private flash = 0;
  private lastTime = performance.now();
  private titleT = 0;
  private stateT = 0;
  private announcedClear = false;
  private readonly focus = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly ray: RayHit = { t: 0, x: 0, y: 0, z: 0, building: -1 };
  private settings: Settings = { sens: 1, invert: false, volume: 0.8, music: true };
  private best = { score: 0, rank: '' };
  private debug = false;
  private debugEl: HTMLElement;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  private lastW = 0;
  private lastH = 0;
  private lockHintShown = false;
  private lockHintT = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const params = new URLSearchParams(location.search);
    const low = params.get('quality') === 'low';
    this.debug = params.has('debug');
    this.debugEl = document.getElementById('debug-overlay')!;
    this.debugEl.classList.toggle('hidden', !this.debug);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, low ? 1 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.input = new Input(canvas);
    this.input.onUnlock = () => {
      if (this.state === 'playing') this.pause();
    };

    // ---- sky / lights / fog ----
    this.scene.fog = new THREE.Fog(PALETTE.fog, 230, 1350);
    this.skyMat = createSkyMaterial();
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    // environment map from the sky only
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.skyMat));
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 0.55);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(PALETTE.sunLight, 3.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -150;
    sc.right = 150;
    sc.top = 150;
    sc.bottom = -150;
    sc.near = 10;
    sc.far = 1200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    // ---- post ----
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: low ? 0 : 4, stencilBuffer: true });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.45, 0.4, 0.95);
    this.composer.addPass(this.bloom);
    this.finalPass = new ShaderPass(VIGNETTE_SHADER);
    this.composer.addPass(this.finalPass);
    this.composer.addPass(new OutputPass());

    this.sfx = new SfxText(document.getElementById('sfx-layer')!);
    this.feedback = {
      shake: (a) => this.rig.addTrauma(a),
      fovKick: (a) => this.rig.kickFov(a),
      hitStop: (s) => (this.hitStop = Math.max(this.hitStop, s)),
      flash: (a) => (this.flash = Math.max(this.flash, a)),
      text: (t, x, y, z, o) => this.sfx.spawn(t, x, y, z, o),
      banner: (t, cls, d) => this.hud.showBanner(t, cls, d),
      hurt: (a) => this.hud.hurt(a),
      cameraDistance: (x, y, z) => this.rig.camera.position.distanceTo(this.tmp.set(x, y, z)),
    };
    this.loadSettings();
    this.bindUi();
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    if (this.debug) (window as unknown as { __game: Game }).__game = this;
  }

  /** Shortcuts (also handy from the debug console). */
  get world(): World {
    return this.session.world;
  }

  get score(): ScoreKeeper {
    return this.session.score;
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  start(): void {
    this.newSession();
    this.toTitle();
    const btn = document.getElementById('btn-start') as HTMLButtonElement;
    btn.disabled = false;
    btn.textContent = 'ゲームスタート';
    requestAnimationFrame(this.loop);
  }

  private newSession(): void {
    if (this.session) this.session.dispose();
    this.session = new Session(this.stage, this.audio, this.feedback);
    this.scene.add(this.session.world.group);
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, this.session.world.city);
    this.hud.setGoal(this.stage.goal);
    this.announcedClear = false;
    this.sfx.clear();
  }

  private setState(s: GameState): void {
    this.state = s;
    this.stateT = 0;
  }

  private toTitle(): void {
    this.setState('title');
    this.input.exitLock();
    this.audio.stopLoops();
    this.audio.stopMusic();
    this.hud.show(false);
    this.hud.reset();
    show('title-screen', true);
    show('pause-screen', false);
    show('result-screen', false);
    this.rig.cinematic = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    document.querySelectorAll('.goal-inline').forEach((el) => (el.textContent = String(Math.round(this.stage.goal * 100))));
    const best = document.getElementById('title-best')!;
    best.textContent = this.best.score > 0 ? `ハイスコア ${formatInt(this.best.score)}（ランク ${this.best.rank}）` : '';
  }

  private beginRun(): void {
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMusic(this.settings.music);
    this.audio.ui();
    this.input.requestLock();
    show('title-screen', false);
    show('result-screen', false);
    show('pause-screen', false);
    this.hud.reset();
    this.hud.show(true);
    this.setState('intro');
    this.rig.cinematic = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.hud.showBanner(`STAGE ${this.stage.id}　${this.stage.name}`, '', 2.6);
    window.setTimeout(() => {
      if (this.state === 'intro') this.hud.showBanner(`街の破壊率 ${Math.round(this.stage.goal * 100)}% をめざせ！`, 'small', 2.4);
    }, 2400);
    const s = this.world.city.kaijuStart;
    this.world.fx.splash(s.x, -1, s.z, 18, 40);
  }

  retry(): void {
    this.newSession();
    this.beginRun();
  }

  private startPlaying(): void {
    this.session.startPlaying();
    this.setState('playing');
    this.rig.cinematic = null;
    this.rig.yaw = 0;
    this.rig.pitch = DEFAULT_PITCH;
    this.focusPoint(this.focus);
    this.rig.snapTo(this.focus);
    this.hud.clearBanners();
    this.hud.showBanner('START!', 'gold', 1.2);
    this.audio.startMusic();
    this.input.requestLock();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.audio.stopLoops();
    this.audio.breathStop();
    show('pause-screen', true);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    show('pause-screen', false);
    this.setState('playing');
    this.input.requestLock();
    this.lastTime = performance.now();
  }

  private finish(success: boolean): void {
    this.setState('result');
    this.input.exitLock();
    this.audio.stopLoops();
    this.audio.stopMusic();
    this.audio.jingle(success);
    const s = this.session;
    const b = s.world.buildings;
    const f = finalScore(s.score.score, success, s.timeLeft, b.destructionRatio, this.stage.goal);
    const rank = rankFor(f.total, success, this.stage.rank);
    const title = document.getElementById('result-title')!;
    title.textContent = success ? 'STAGE CLEAR!' : s.world.kaiju.dead ? 'GAME OVER' : 'TIME UP';
    title.classList.toggle('fail', !success);
    document.getElementById('result-rank')!.textContent = rank;
    const st = s.score.stats;
    const rows: [string, string][] = [
      ['破壊率', `${Math.floor(b.destructionRatio * 100)}%`],
      ['倒壊させたビル', `${b.collapsedCount} / ${b.countableTotal} 棟`],
      ['撃破した戦車 / ヘリ', `${st.tanks} / ${st.helis}`],
      ['ふっとばした車', `${st.cars} 台`],
      ['最大コンボ', `${s.score.maxCombo}`],
      ['破壊スコア', formatInt(f.base)],
    ];
    if (success) {
      rows.push(['クリアボーナス', `+${formatInt(f.clearBonus)}`]);
      if (f.timeBonus > 0) rows.push(['残り時間ボーナス', `+${formatInt(f.timeBonus)}`]);
      if (f.destructionBonus > 0) rows.push(['追加破壊ボーナス', `+${formatInt(f.destructionBonus)}`]);
    }
    const tbody = document.getElementById('result-rows')!;
    tbody.innerHTML = '';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
      tbody.appendChild(tr);
    }
    const tr = document.createElement('tr');
    tr.className = 'total';
    tr.innerHTML = `<td>TOTAL</td><td>${formatInt(f.total)}</td>`;
    tbody.appendChild(tr);
    const bestEl = document.getElementById('result-best')!;
    if (f.total > this.best.score) {
      this.best = { score: f.total, rank };
      this.saveSettings();
      bestEl.textContent = 'NEW RECORD!';
    } else {
      bestEl.textContent = this.best.score > 0 ? `ハイスコア ${formatInt(this.best.score)}` : '';
    }
    window.setTimeout(() => show('result-screen', true), success ? 1200 : 600);
  }

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------

  private bindUi(): void {
    const on = (id: string, fn: () => void) =>
      document.getElementById(id)!.addEventListener('click', () => {
        this.audio.ui();
        fn();
      });
    on('btn-start', () => {
      if (this.state === 'title') this.beginRun();
    });
    on('btn-resume', () => this.resume());
    on('btn-retry-pause', () => this.retry());
    on('btn-title-pause', () => {
      this.newSession();
      this.toTitle();
    });
    on('btn-retry', () => this.retry());
    on('btn-title', () => {
      this.newSession();
      this.toTitle();
    });
    const sens = document.getElementById('opt-sens') as HTMLInputElement;
    const inv = document.getElementById('opt-invert') as HTMLInputElement;
    const vol = document.getElementById('opt-volume') as HTMLInputElement;
    sens.value = String(this.settings.sens);
    inv.checked = this.settings.invert;
    vol.value = String(this.settings.volume);
    sens.addEventListener('input', () => {
      this.settings.sens = Number(sens.value);
      this.saveSettings();
    });
    inv.addEventListener('change', () => {
      this.settings.invert = inv.checked;
      this.saveSettings();
    });
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value);
      this.audio.setVolume(this.settings.volume);
      this.saveSettings();
    });
    // re-acquire pointer lock when clicking the canvas during play
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' || this.state === 'intro') this.input.requestLock();
    });
  }

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<{ settings: Settings; best: { score: number; rank: string } }>;
      if (d.settings) this.settings = { ...this.settings, ...d.settings };
      if (d.best) this.best = d.best;
    } catch {
      /* storage unavailable */
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: this.settings, best: this.best }));
    } catch {
      /* storage unavailable */
    }
  }

  private onResize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.lastW = w;
    this.lastH = h;
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(size.x / 2, size.y / 2);
    this.rig.resize(w / h);
  }

  // ------------------------------------------------------------------
  // main loop
  // ------------------------------------------------------------------

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dtReal = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.fpsAcc += dtReal;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    try {
      this.frame(dtReal);
    } catch (e) {
      console.error(e);
    }
    this.input.endFrame();
  };

  /** One frame of the whole game (public so debug tooling can step it manually). */
  frame(dtReal: number): void {
    if (!this.session) return;
    const w = this.world;
    // resize events can be missed while the page is hidden
    if (window.innerWidth !== this.lastW || window.innerHeight !== this.lastH) this.onResize();
    this.renderer.info.reset();
    this.stateT += dtReal;
    let dt = dtReal;
    if (this.hitStop > 0) {
      this.hitStop -= dtReal;
      dt = dtReal * 0.08;
    }

    // global keys
    if (this.input.wasPressed('KeyM')) {
      this.settings.music = !this.settings.music;
      this.audio.setMusic(this.settings.music);
      this.saveSettings();
    }
    if (this.input.wasPressed('KeyH')) this.hud.toggleHint();

    switch (this.state) {
      case 'title':
        this.updateTitle(dtReal);
        break;
      case 'intro':
        this.updateIntro(dt);
        break;
      case 'playing':
        if (this.input.wasPressed('KeyP') || this.input.wasPressed('Escape')) {
          this.input.exitLock();
          this.pause();
          break;
        }
        this.updatePlaying(dt, dtReal);
        break;
      case 'paused':
        if (this.input.wasPressed('KeyP')) this.resume();
        break;
      case 'dying':
        this.session.updateWorld(dt, null);
        if (this.stateT > 2.8) this.finish(false);
        break;
      case 'result':
        this.session.updateWorld(dt * 0.5, null);
        break;
      default:
        break;
    }

    // camera
    if (this.state === 'playing' || this.state === 'dying') {
      this.focusPoint(this.focus);
      this.rig.update(dtReal, this.focus, (x, y, z) => w.buildings.isSolidAt(x, y, z));
    } else if (this.state === 'result') {
      const kp = w.kaiju.position;
      this.titleT += dtReal;
      const a = this.titleT * 0.12;
      this.rig.cinematic = {
        pos: new THREE.Vector3(kp.x + Math.sin(a) * 110, 70, kp.z + Math.cos(a) * 110),
        look: new THREE.Vector3(kp.x, 25, kp.z),
      };
      this.rig.update(dtReal, this.focus, () => false);
    } else if (this.state !== 'paused') {
      this.rig.update(dtReal, this.focus, () => false);
    }

    // sky follows camera
    const cam = this.rig.camera;
    this.sky.position.copy(cam.position);
    this.skyMat.uniforms.uTime.value += dtReal;
    (w.water.material as THREE.ShaderMaterial).uniforms.uTime.value += dtReal;
    // shadow camera follows the action
    const kp = w.kaiju.position;
    const fx = this.state === 'title' ? 0 : kp.x;
    const fz = this.state === 'title' ? 0 : kp.z;
    const snap = 4;
    const sx = Math.round(fx / snap) * snap;
    const sz = Math.round(fz / snap) * snap;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + SUN_DIR.x * 500, SUN_DIR.y * 500, sz + SUN_DIR.z * 500);
    this.audio.setListener(cam.position.x, cam.position.z, this.rig.rightX, this.rig.rightZ);

    // post uniforms
    this.flash = Math.max(0, this.flash - dtReal * 4);
    this.finalPass.uniforms.uFlash.value = this.flash * 0.25;
    this.composer.render(dtReal);

    this.sfx.update(dtReal, cam, window.innerWidth, window.innerHeight);
    this.updateLockHint(dtReal);
    if (this.debug) this.updateDebug();
  }

  /**
   * "Click to control the camera with the mouse" hint: shown when play starts (or resumes)
   * without pointer lock, then fades out after LOCK_HINT_SECONDS.
   */
  private updateLockHint(dt: number): void {
    const unlocked = this.state === 'playing' && !this.input.locked;
    this.lockHintT = unlocked ? this.lockHintT + dt : 0;
    const want = unlocked && this.lockHintT < LOCK_HINT_SECONDS;
    if (want !== this.lockHintShown) {
      this.lockHintShown = want;
      document.getElementById('lock-hint')?.classList.toggle('visible', want);
    }
  }

  /** Camera orbit centre: a little ahead of the kaiju and over its right shoulder so attacks stay visible. */
  private focusPoint(out: THREE.Vector3): THREE.Vector3 {
    const k = this.world.kaiju;
    const S = KAIJU.scale;
    const aim = this.session.aimBlend;
    const ahead = 16 * S;
    const side = (10 + 8 * aim) * S;
    out.copy(k.position);
    out.y = Math.max(out.y, 0) + (26 + aim * 12) * S;
    out.x += this.rig.forwardX * ahead + this.rig.rightX * side;
    out.z += this.rig.forwardZ * ahead + this.rig.rightZ * side;
    return out;
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const a = this.titleT * 0.04 + 0.5;
    const r = 250;
    this.rig.cinematic = {
      pos: new THREE.Vector3(Math.sin(a) * r, 95, Math.cos(a) * r),
      look: new THREE.Vector3(0, 38, 0),
    };
    this.world.traffic.update(dt, 99999, 99999);
    this.world.fx.update(dt);
  }

  private updateIntro(dt: number): void {
    const w = this.world;
    const k = w.kaiju;
    const s = w.city.kaijuStart;
    this.session.updateWorld(dt, null);
    const t = k.introProgress;
    // cinematic: low shot from the harbour, then swing behind the kaiju
    const head = k.headPosition(this.tmp);
    const u = clamp((t - 4.6) / 1.4, 0, 1);
    const e = u * u * (3 - 2 * u);
    const p0 = new THREE.Vector3(s.x + 38, 9, s.z - 78);
    const l0 = new THREE.Vector3(s.x, Math.max(5, head.y - 4), s.z);
    // end pose == the gameplay camera's starting pose
    this.rig.yaw = 0;
    this.rig.pitch = DEFAULT_PITCH;
    const l1 = this.focusPoint(new THREE.Vector3());
    const cp = Math.cos(this.rig.pitch);
    const p1 = new THREE.Vector3(l1.x, l1.y + Math.sin(this.rig.pitch) * this.rig.distance, l1.z + cp * this.rig.distance);
    this.rig.cinematic = { pos: p0.lerp(p1, e), look: l0.lerp(l1, e) };
    if (t > 0.3 && t < 4.4 && Math.random() < 0.5) w.fx.splash(s.x + rand(-10, 10), -1, s.z + rand(-10, 10), rand(6, 12), 3);
    if ((this.input.anyPressed && this.stateT > 0.6) || k.action !== 'intro') this.startPlaying();
  }

  // ------------------------------------------------------------------
  // gameplay
  // ------------------------------------------------------------------

  /** Player input -> kaiju intent (camera-relative movement). Replaceable for bots / tests. */
  readKaijuInput(): KaijuInput {
    const inp = this.input;
    let mx = 0;
    let mz = 0;
    if (inp.isDown('KeyW')) mz += 1;
    if (inp.isDown('KeyS')) mz -= 1;
    if (inp.isDown('KeyA')) mx -= 1;
    if (inp.isDown('KeyD')) mx += 1;
    const fx = this.rig.forwardX;
    const fz = this.rig.forwardZ;
    const rx = this.rig.rightX;
    const rz = this.rig.rightZ;
    let wx = fx * mz + rx * mx;
    let wz = fz * mz + rz * mx;
    const l = Math.hypot(wx, wz);
    if (l > 1) {
      wx /= l;
      wz /= l;
    }
    return {
      moveX: wx,
      moveZ: wz,
      run: inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'),
      punch: inp.mouseWasPressed(0) || inp.wasPressed('KeyJ'),
      tail: inp.wasPressed('KeyE') || inp.wasPressed('KeyK'),
      jump: inp.wasPressed('Space'),
      roar: inp.wasPressed('KeyQ') || inp.wasPressed('KeyI'),
      breath: inp.mouse(2) || inp.isDown('KeyF') || inp.isDown('KeyL'),
      aimYaw: Math.atan2(fx, fz),
      aim: this.session.aim,
    };
  }

  private updatePlaying(dt: number, dtReal: number): void {
    const s = this.session;
    const w = s.world;
    const inp = this.input;
    // camera control
    const sens = 0.0024 * this.settings.sens;
    const inv = this.settings.invert ? -1 : 1;
    let dyaw = -inp.mouseDX * sens;
    let dpitch = inp.mouseDY * sens * 0.8 * inv;
    const ks = 1.9 * dtReal;
    if (inp.isDown('ArrowLeft')) dyaw += ks;
    if (inp.isDown('ArrowRight')) dyaw -= ks;
    if (inp.isDown('ArrowUp')) dpitch -= ks * 0.6 * inv;
    if (inp.isDown('ArrowDown')) dpitch += ks * 0.6 * inv;
    this.rig.rotate(dyaw, dpitch);
    if (inp.wheel !== 0) this.rig.zoom(inp.wheel);

    this.computeAim();
    s.updateWorld(dt, this.readKaijuInput());
    const status = s.updateRules(dt);

    if (s.cleared && !this.announcedClear) {
      this.announcedClear = true;
      window.setTimeout(() => {
        if (this.state === 'playing') this.hud.showBanner('時間いっぱい暴れてスコアを伸ばそう！（Enterで終了）', 'small', 3.5);
      }, 3000);
    }
    if (s.cleared && inp.wasPressed('Enter')) {
      this.finish(true);
      return;
    }
    if (status === 'timeup') {
      this.finish(s.cleared);
      return;
    }
    if (status === 'dead') {
      this.setState('dying');
      this.hud.showBanner('ドカゴン、力尽きる…', 'alert', 2.5);
      this.audio.stopMusic();
      return;
    }

    // HUD
    const k = w.kaiju;
    this.hud.update(
      {
        hp: k.hp.value,
        hpMax: k.hp.max,
        energy: k.energy,
        energyMax: KAIJU.maxEnergy,
        time: s.timeLeft,
        destruction: w.buildings.destructionRatio,
        goal: this.stage.goal,
        score: s.score.score,
        buildings: w.buildings.collapsedCount,
        combo: s.score.combo,
        multiplier: s.score.multiplier,
        cdTail: k.cdTail,
        cdJump: k.cdJump,
        cdRoar: k.cdRoar,
        crosshair: k.charging || k.breathing,
      },
      dtReal,
    );
    this.minimap.draw(w.buildings.list, { x: k.position.x, z: k.position.z, yaw: k.yaw }, this.rig.yaw, (cb) => w.military.forEachUnit(cb));
  }

  /** The breath aims where the screen centre points (camera ray, starting past the kaiju). */
  private computeAim(): void {
    const cam = this.rig.camera;
    const dir = cam.getWorldDirection(this.tmp);
    const start = cam.position.distanceTo(this.focus) * 0.95;
    const ox = cam.position.x + dir.x * start;
    const oy = cam.position.y + dir.y * start;
    const oz = cam.position.z + dir.z * start;
    let t = 700;
    if (this.world.buildings.raycast(ox, oy, oz, dir.x, dir.y, dir.z, 700, this.ray)) t = this.ray.t;
    if (dir.y < -1e-4) {
      const tg = -oy / dir.y;
      if (tg > 0 && tg < t) t = tg;
    }
    this.session.aim.set(ox + dir.x * t, oy + dir.y * t, oz + dir.z * t);
  }

  private updateDebug(): void {
    const w = this.world;
    const info = this.renderer.info;
    this.debugEl.textContent = [
      `fps ${this.fps.toFixed(0)}`,
      `calls ${info.render.calls} tris ${(info.render.triangles / 1000).toFixed(0)}k`,
      `debris ${w.debris.active}`,
      `particles ${w.fx.smoke.count}+${w.fx.glow.count}`,
      `destroyed ${(w.buildings.destructionRatio * 100).toFixed(1)}% (${w.buildings.collapsedCount}/${w.buildings.countableTotal})`,
      `state ${this.state}`,
    ].join('\n');
  }

  /** Debug helper (?debug): jump the kaiju somewhere. */
  teleport(x: number, z: number): void {
    this.session.teleport(x, z);
  }
}

function show(id: string, v: boolean): void {
  document.getElementById(id)?.classList.toggle('hidden', !v);
}
