import * as THREE from 'three';
import { BLOCK_CELLS, CHUNK, HARBOR_CELLS, ROAD_CELLS, WATER_LEVEL } from '../config';
import { Rng } from '../core/rng';
import type { CityLayout } from './cityGen';

/** Colour palette for the dusk ("magic hour") look. */
export const PALETTE = {
  zenith: new THREE.Color(0x1b2550),
  mid: new THREE.Color(0x6b5b92),
  horizon: new THREE.Color(0xf29a62),
  sun: new THREE.Color(0xffb070),
  groundSky: new THREE.Color(0x2c2430),
  fog: new THREE.Color(0x8f7488),
  sunLight: new THREE.Color(0xffc794),
  hemiSky: new THREE.Color(0x8ea0d8),
  hemiGround: new THREE.Color(0x5a4a40),
};

export const SUN_DIR = new THREE.Vector3(-0.78, 0.22, -0.58).normalize();

/** Depth of the harbour strip in metres (no background blocks there). */
const HARBOR_ROWS_M = HARBOR_CELLS * CHUNK;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  float len = max(length(vDir), 1e-4);
  vec3 d = vDir / len;
  float h = d.y;
  float t = clamp(h, 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, t));
  col = mix(col, uZenith, smoothstep(0.18, 0.75, t));
  float sd = max(dot(d, uSunDir), 0.0);
  float horizonBand = 1.0 - smoothstep(0.0, 0.35, abs(h));
  col += uSun * pow(sd, 6.0) * 0.55 * horizonBand;
  col += uSun * pow(sd, 48.0) * 0.9;
  col += vec3(1.0, 0.86, 0.62) * smoothstep(0.9990, 0.9996, sd) * 6.0;
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.08);
    float c = fbm(uv * 0.9 + vec2(uTime * 0.006, uTime * 0.002));
    float streak = fbm(vec2(uv.x * 0.35, uv.y * 2.2) + 7.0);
    c = smoothstep(0.52, 0.85, mix(c, streak, 0.45)) * smoothstep(0.02, 0.16, h) * (1.0 - smoothstep(0.55, 0.9, h));
    vec3 lit = mix(vec3(0.42, 0.30, 0.46), uSun * 1.25, clamp(pow(sd, 2.0) * 0.9 + 0.12, 0.0, 1.0));
    col = mix(col, lit, c * 0.75);
  } else {
    col = mix(uHorizon * 0.85, uGround, smoothstep(0.0, 0.12, -h));
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: PALETTE.zenith },
      uMid: { value: PALETTE.mid },
      uHorizon: { value: PALETTE.horizon },
      uSun: { value: PALETTE.sun },
      uGround: { value: PALETTE.groundSky },
      uSunDir: { value: SUN_DIR },
      uTime: { value: 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
}

// ---------------------------------------------------------------------------
// Ground with procedural roads / markings (MeshStandardMaterial patched).
// ---------------------------------------------------------------------------

export class Ground {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly scorchData: Uint8Array;
  private readonly scorchTex: THREE.DataTexture;
  private readonly scorchSize = 256;
  private scorchDirty = false;
  private readonly cellTex: THREE.DataTexture;

  constructor(private readonly city: CityLayout) {
    const { gridW, gridD } = city;
    const cellData = new Uint8Array(gridW * gridD * 4);
    for (let i = 0; i < gridW * gridD; i++) {
      cellData[i * 4] = city.cellType[i];
      cellData[i * 4 + 3] = 255;
    }
    this.cellTex = new THREE.DataTexture(cellData, gridW, gridD, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.cellTex.magFilter = THREE.NearestFilter;
    this.cellTex.minFilter = THREE.NearestFilter;
    this.cellTex.needsUpdate = true;

    this.scorchData = new Uint8Array(this.scorchSize * this.scorchSize * 4);
    this.scorchTex = new THREE.DataTexture(this.scorchData, this.scorchSize, this.scorchSize, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.scorchTex.magFilter = THREE.LinearFilter;
    this.scorchTex.minFilter = THREE.LinearFilter;
    this.scorchTex.needsUpdate = true;

    const P = (BLOCK_CELLS + ROAD_CELLS) * CHUNK;
    const uniforms = {
      uCellTex: { value: this.cellTex },
      uScorch: { value: this.scorchTex },
      uOrigin: { value: new THREE.Vector2(city.originX, city.originZ) },
      uGrid: { value: new THREE.Vector2(gridW, gridD) },
      uCell: { value: CHUNK },
      uPeriod: { value: P },
      uRoadW: { value: ROAD_CELLS * CHUNK },
    };

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWPos;
uniform sampler2D uCellTex;
uniform sampler2D uScorch;
uniform vec2 uOrigin;
uniform vec2 uGrid;
uniform float uCell;
uniform float uPeriod;
uniform float uRoadW;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  vec2 p = vWPos.xz;
  vec2 g = (p - uOrigin) / uCell;
  float inGrid = step(0.0, g.x) * step(0.0, g.y) * step(g.x, uGrid.x) * step(g.y, uGrid.y);
  vec2 cidx = clamp(floor(g), vec2(0.0), uGrid - 1.0);
  float type = floor(texture2D(uCellTex, (cidx + 0.5) / uGrid).r * 255.0 + 0.5);
  float n = gNoise(p * 0.35) * 0.5 + gNoise(p * 1.7) * 0.5;
  vec3 col = vec3(0.28, 0.30, 0.22) * (0.85 + 0.3 * n);
  vec2 lp = mod(p - uOrigin, uPeriod);
  // outside the playable grid the street pattern simply continues
  if (inGrid < 0.5) type = (lp.x < uRoadW || lp.y < uRoadW) ? 1.0 : 0.0;
  {
    float hw = uRoadW * 0.5;
    if (abs(type - 1.0) < 0.5) {
      bool inNS = lp.x < uRoadW;
      bool inEW = lp.y < uRoadW;
      float dx = abs(lp.x - hw);
      float dz = abs(lp.y - hw);
      col = vec3(0.13, 0.13, 0.15) * (0.85 + 0.3 * n);
      float walk = hw - 1.8;
      bool sidewalk = false;
      if (inNS && !inEW) sidewalk = dx > walk;
      else if (inEW && !inNS) sidewalk = dz > walk;
      else if (inNS && inEW) sidewalk = dx > walk && dz > walk;
      if (sidewalk) {
        col = vec3(0.46, 0.44, 0.42) * (0.9 + 0.15 * n);
        float tile = step(0.94, fract((inNS ? p.y : p.x) / 1.5));
        col *= 1.0 - tile * 0.25;
      } else {
        if (inNS && !inEW) {
          float along = p.y;
          float center = (1.0 - step(0.12, dx)) * step(0.5, fract(along / 7.0));
          col = mix(col, vec3(0.85, 0.72, 0.35), center);
          float cw = step(uRoadW, lp.y) * (1.0 - step(uRoadW + 3.2, lp.y)) + step(uPeriod - 3.2, lp.y);
          col = mix(col, vec3(0.82), cw * step(0.5, fract(p.x / 1.1)) * step(dx, walk - 0.3));
        } else if (inEW && !inNS) {
          float along = p.x;
          float center = (1.0 - step(0.12, dz)) * step(0.5, fract(along / 7.0));
          col = mix(col, vec3(0.85, 0.72, 0.35), center);
          float cw = step(uRoadW, lp.x) * (1.0 - step(uRoadW + 3.2, lp.x)) + step(uPeriod - 3.2, lp.x);
          col = mix(col, vec3(0.82), cw * step(0.5, fract(p.y / 1.1)) * step(dz, walk - 0.3));
        }
      }
    } else if (abs(type - 2.0) < 0.5) {
      col = vec3(0.20, 0.34, 0.15) * (0.75 + 0.45 * n);
      float path = 1.0 - smoothstep(0.6, 1.2, abs(fract((p.x + p.y) / 22.0) - 0.5) * 22.0);
      col = mix(col, vec3(0.55, 0.48, 0.38), path * 0.8);
    } else if (abs(type - 4.0) < 0.5) {
      col = vec3(0.62, 0.57, 0.50) * (0.9 + 0.12 * n);
      vec2 tl = fract(p / 2.0);
      col *= 1.0 - 0.18 * (step(0.93, tl.x) + step(0.93, tl.y));
    } else if (abs(type - 3.0) < 0.5) {
      col = vec3(0.40, 0.40, 0.40) * (0.85 + 0.25 * n);
      vec2 tl = fract(p / 8.0);
      col = mix(col, vec3(0.75, 0.62, 0.2), (step(0.97, tl.x) + step(0.985, tl.y)) * 0.6);
    } else {
      col = vec3(0.42, 0.41, 0.40) * (0.85 + 0.2 * n);
      vec2 tl = fract(p / 4.0);
      col *= 1.0 - 0.12 * (step(0.96, tl.x) + step(0.96, tl.y));
    }
  }
  vec2 suv = (p - uOrigin) / (uGrid * uCell);
  float scorch = texture2D(uScorch, suv).r * inGrid;
  col = mix(col, vec3(0.03, 0.025, 0.02), scorch * 0.85);
  // fade fine markings in the distance to avoid shimmering
  col = mix(col, vec3(0.22, 0.22, 0.23), smoothstep(380.0, 950.0, length(vViewPosition)) * 0.85);
  diffuseColor.rgb = col;
}`,
        );
    };
    this.material = mat;

    const size = 4000;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // shift so the plane ends at the shore (the sea lies to the south)
    geo.translate(0, 0, city.shoreZ - size / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ground';
  }

  /** Paint a burn mark on the ground (0..1 strength). */
  scorch(x: number, z: number, radius: number, strength = 0.6): void {
    const S = this.scorchSize;
    const w = this.city.gridW * CHUNK;
    const d = this.city.gridD * CHUNK;
    const u = ((x - this.city.originX) / w) * S;
    const v = ((z - this.city.originZ) / d) * S;
    const ru = (radius / w) * S;
    const rv = (radius / d) * S;
    const u0 = Math.max(0, Math.floor(u - ru));
    const u1 = Math.min(S - 1, Math.ceil(u + ru));
    const v0 = Math.max(0, Math.floor(v - rv));
    const v1 = Math.min(S - 1, Math.ceil(v + rv));
    for (let yy = v0; yy <= v1; yy++) {
      for (let xx = u0; xx <= u1; xx++) {
        const dx = (xx + 0.5 - u) / Math.max(ru, 0.5);
        const dy = (yy + 0.5 - v) / Math.max(rv, 0.5);
        const f = 1 - Math.sqrt(dx * dx + dy * dy);
        if (f <= 0) continue;
        const i = (yy * S + xx) * 4;
        this.scorchData[i] = Math.min(255, this.scorchData[i] + Math.round(f * strength * 255 * (0.7 + Math.random() * 0.6)));
      }
    }
    this.scorchDirty = true;
  }

  update(): void {
    if (this.scorchDirty) {
      this.scorchTex.needsUpdate = true;
      this.scorchDirty = false;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.cellTex.dispose();
    this.scorchTex.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sea
// ---------------------------------------------------------------------------

const WATER_VERT = /* glsl */ `
varying vec3 vWPos;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform float uShoreZ;
varying vec3 vWPos;
#include <fog_pars_fragment>
void main() {
  vec2 p = vWPos.xz;
  float t = uTime;
  vec2 grad = vec2(0.0);
  grad += vec2(0.9, 0.4) * cos(dot(p, vec2(0.09, 0.04)) + t * 1.2);
  grad += vec2(-0.5, 0.8) * cos(dot(p, vec2(-0.05, 0.11)) + t * 1.5) * 0.7;
  grad += vec2(0.3, -0.9) * cos(dot(p, vec2(0.21, -0.17)) + t * 2.3) * 0.35;
  grad += vec2(0.7, 0.7) * cos(dot(p, vec2(0.37, 0.31)) + t * 3.1) * 0.2;
  vec3 n = normalize(vec3(-grad.x * 0.12, 1.0, -grad.y * 0.12));
  vec3 toCam = cameraPosition - vWPos;
  vec3 V = toCam / max(length(toCam), 1e-3);
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uHorizon, uZenith, clamp(R.y * 2.5, 0.0, 1.0));
  vec3 col = mix(uDeep, sky, 0.18 + 0.72 * fres);
  float spec = pow(max(dot(R, uSunDir), 0.0), 220.0);
  col += uSun * spec * 4.0;
  float dz = vWPos.z - uShoreZ;
  float foam = (1.0 - smoothstep(0.0, 5.0, dz)) * (0.55 + 0.45 * sin(dz * 2.2 - t * 2.4));
  col = mix(col, vec3(0.8, 0.78, 0.75), clamp(foam, 0.0, 1.0) * 0.45);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <fog_fragment>
}`;

export function createWater(city: CityLayout): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x0d2a3a) },
        uZenith: { value: PALETTE.zenith },
        uHorizon: { value: PALETTE.horizon },
        uSun: { value: PALETTE.sun },
        uSunDir: { value: SUN_DIR },
        uShoreZ: { value: city.shoreZ },
      },
    ]),
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    fog: true,
  });
  const geo = new THREE.PlaneGeometry(2400, 1400, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, WATER_LEVEL, city.shoreZ + 700);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  return mesh;
}

/** Concrete quay wall along the shore so the land edge doesn't look paper-thin. */
export function createQuay(city: CityLayout): THREE.Mesh {
  const w = city.bounds.maxX - city.bounds.minX + 800;
  const geo = new THREE.BoxGeometry(w, 7, 3);
  geo.translate(0, -3.5 + 0.02, city.shoreZ - 1.5);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6f6a66, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Background scenery (skyline + mountains). Not interactive.
// ---------------------------------------------------------------------------

export function createScenery(city: CityLayout, seed: number): THREE.Group {
  const rng = new Rng(seed ^ 0x5eed);
  const group = new THREE.Group();
  group.name = 'scenery';

  // distant skyline: dark silhouettes with a few lit windows (world-space window grid)
  const count = 900;
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkyW;\nvarying vec3 vSkyN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSkyN = normal;\nvSkyW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkyW;\nvarying vec3 vSkyN;\nfloat skyHash(vec2 p) { return fract(sin(dot(p, vec2(27.17, 91.43))) * 43758.5453); }')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if (abs(vSkyN.y) < 0.5) {
  float horiz = abs(vSkyN.x) > 0.5 ? vSkyW.z : vSkyW.x;
  vec2 cell = vec2(floor(horiz / 3.2), floor(vSkyW.y / 3.8));
  vec2 f = vec2(fract(horiz / 3.2), fract(vSkyW.y / 3.8));
  float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.8) * step(4.0, vSkyW.y);
  float lit = step(skyHash(cell + floor(vSkyW.xz / 40.0)), 0.16);
  totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * win * lit * 0.9;
}`,
      );
  };
  const inst = new THREE.InstancedMesh(box, mat, count);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const { minX, maxX, minZ } = city.bounds;
  // continue the block grid outside the playable area (north / east / west; the sea is south)
  const P = (BLOCK_CELLS + ROAD_CELLS) * CHUNK;
  const lot = BLOCK_CELLS * CHUNK;
  const road = ROAD_CELLS * CHUNK;
  const blocks: [number, number, number][] = [];
  for (let bz = -9; bz * P + city.originZ < city.shoreZ - HARBOR_ROWS_M; bz++) {
    for (let bx = -8; bx < 8 + Math.ceil((maxX - minX) / P); bx++) {
      const x0 = city.originX + bx * P + road;
      const z0 = city.originZ + bz * P + road;
      const inside = x0 + lot > minX && x0 < maxX && z0 + lot > minZ;
      if (inside) continue;
      const cx = x0 + lot / 2;
      const cz = z0 + lot / 2;
      const dist = Math.max(minX - cx, cx - maxX, minZ - cz, 0);
      if (dist > 620) continue;
      blocks.push([x0, z0, dist]);
    }
  }
  let n = 0;
  for (const [x0, z0, dist] of blocks) {
    const k = rng.int(1, 3);
    for (let i = 0; i < k && n < count; i++) {
      const w = rng.range(10, lot / (k > 1 ? 1.6 : 1.1));
      const d = rng.range(10, lot * 0.9);
      const x = x0 + rng.range(w / 2, lot - w / 2);
      const z = z0 + rng.range(d / 2, lot - d / 2);
      const far = Math.min(1, dist / 400);
      const h = rng.range(8, 20) + rng.range(0, 45) * far * (rng.chance(0.2) ? 1.6 : 0.6);
      m.makeScale(w, h, d);
      m.setPosition(x, 0, z);
      inst.setMatrixAt(n, m);
      col.setHex(rng.pick([0x2e3342, 0x353847, 0x2a3040, 0x3b3a45, 0x282d3a]));
      inst.setColorAt(n, col);
      n++;
    }
  }
  inst.count = n;
  inst.receiveShadow = false;
  inst.castShadow = false;
  group.add(inst);

  // mountains far north / east / west (unfogged, manually hazed)
  const mountMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: false, fog: false });
  const layers = [
    { r: 1650, c: 0x8c7590, h: [90, 170], n: 10 },
    { r: 1300, c: 0x725f82, h: [60, 120], n: 12 },
  ];
  for (const L of layers) {
    for (let i = 0; i < L.n; i++) {
      const a = -Math.PI * 0.95 + (i / (L.n - 1)) * Math.PI * 0.9 + rng.range(-0.08, 0.08);
      const hgt = rng.range(L.h[0], L.h[1]);
      const geo = new THREE.ConeGeometry(rng.range(300, 460), hgt, 7, 1);
      const mesh = new THREE.Mesh(geo, mountMat.clone());
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(L.c);
      mesh.position.set(Math.cos(a) * L.r, hgt / 2 - 15, Math.sin(a) * L.r);
      mesh.rotation.y = rng.range(0, Math.PI);
      group.add(mesh);
    }
  }
  return group;
}
