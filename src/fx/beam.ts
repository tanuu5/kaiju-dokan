import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uLen;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uAlpha;
uniform float uSoft;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float ln = max(length(vN), 1e-4);
  float lv = max(length(vV), 1e-4);
  float facing = abs(dot(vN / ln, vV / lv));
  float rim = pow(clamp(facing, 0.0, 1.0), uSoft);
  float along = vUv.y * uLen;
  float n1 = sin(along * 0.33 - uTime * 38.0) * 0.5 + 0.5;
  float n2 = sin(along * 0.85 - uTime * 61.0 + vUv.x * 12.566) * 0.5 + 0.5;
  float flick = 0.65 + 0.35 * n1 * n2;
  float endFade = smoothstep(0.0, 0.015, vUv.y) * (1.0 - smoothstep(0.985, 1.0, vUv.y));
  vec3 col = mix(uColorB, uColorA, n2 * rim);
  gl_FragColor = vec4(max(col * flick * rim * endFade * uAlpha, vec3(0.0)), 1.0);
}`;

/** Magma breath beam: two additive cylinders (hot core + orange glow) and an impact light. */
export class Beam {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  readonly mouthLight: THREE.PointLight;
  private readonly core: THREE.Mesh;
  private readonly outer: THREE.Mesh;
  private readonly coreMat: THREE.ShaderMaterial;
  private readonly outerMat: THREE.ShaderMaterial;
  private readonly dir = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private intensity = 0;
  private t = 0;

  constructor() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    geo.translate(0, 0.5, 0);
    const mk = (a: number, b: number, soft: number) =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uLen: { value: 1 },
          uColorA: { value: new THREE.Color(a) },
          uColorB: { value: new THREE.Color(b) },
          uAlpha: { value: 0 },
          uSoft: { value: soft },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
    this.coreMat = mk(0xfff4d0, 0xffb040, 1.2);
    this.outerMat = mk(0xff9a30, 0xd02a08, 2.2);
    this.core = new THREE.Mesh(geo, this.coreMat);
    this.outer = new THREE.Mesh(geo, this.outerMat);
    this.core.frustumCulled = false;
    this.outer.frustumCulled = false;
    this.core.renderOrder = 4;
    this.outer.renderOrder = 4;
    this.group.add(this.outer, this.core);
    this.group.visible = false;
    this.light = new THREE.PointLight(0xff7a30, 0, 160, 2);
    this.mouthLight = new THREE.PointLight(0xff9040, 0, 90, 2);
    this.group.add(this.light);
  }

  /** Call every frame while firing; `on` fades the beam in/out. */
  update(dt: number, on: boolean, from: THREE.Vector3, to: THREE.Vector3): void {
    this.t += dt;
    this.intensity += ((on ? 1 : 0) - this.intensity) * Math.min(1, dt * (on ? 14 : 8));
    const vis = this.intensity > 0.01;
    this.group.visible = vis;
    this.light.intensity = vis ? this.intensity * 2600 * (0.85 + Math.random() * 0.3) : 0;
    this.mouthLight.intensity = vis ? this.intensity * 700 : 0;
    if (!vis) return;
    this.dir.copy(to).sub(from);
    const len = Math.max(0.1, this.dir.length());
    this.dir.divideScalar(len);
    this.q.setFromUnitVectors(this.up, this.dir);
    for (const [m, r] of [
      [this.core, 1.6],
      [this.outer, 4.2],
    ] as const) {
      m.position.copy(from);
      m.quaternion.copy(this.q);
      const wob = 1 + Math.sin(this.t * 50) * 0.08;
      m.scale.set(r * this.intensity * wob, len, r * this.intensity * wob);
    }
    for (const mat of [this.coreMat, this.outerMat]) {
      mat.uniforms.uTime.value = this.t;
      mat.uniforms.uLen.value = len;
      mat.uniforms.uAlpha.value = this.intensity * (mat === this.coreMat ? 1.6 : 1.1);
    }
    this.light.position.copy(to).addScaledVector(this.dir, -4);
    this.mouthLight.position.copy(from);
  }

  dispose(): void {
    this.core.geometry.dispose();
    this.coreMat.dispose();
    this.outerMat.dispose();
  }
}

/** Short-lived point lights for big explosions (fixed pool: no shader recompiles). */
export class FlashLights {
  readonly group = new THREE.Group();
  private readonly lights: THREE.PointLight[] = [];
  private readonly life: number[] = [];
  private readonly peak: number[] = [];
  private next = 0;

  constructor(n = 3) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 160, 2);
      this.lights.push(l);
      this.life.push(0);
      this.peak.push(0);
      this.group.add(l);
    }
  }

  flash(x: number, y: number, z: number, power: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.lights.length;
    this.lights[i].position.set(x, y + 6, z);
    this.life[i] = 1;
    this.peak[i] = power;
  }

  update(dt: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      this.life[i] = Math.max(0, this.life[i] - dt * 2.2);
      const k = this.life[i];
      this.lights[i].intensity = k * k * this.peak[i];
    }
  }
}
