import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TreeSpec } from './cityGen';

interface Tree {
  x: number;
  z: number;
  s: number;
  yaw: number;
  fall: number; // 0..1
  fallTarget: number;
  dirX: number;
  dirZ: number;
  down: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function treeGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 5);
  trunk.translate(0, 1.6, 0);
  const crown = new THREE.IcosahedronGeometry(2.6, 0);
  crown.scale(1, 1.25, 1);
  crown.translate(0, 5.2, 0);
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
  paint(trunk, 0.35, 0.24, 0.16);
  paint(crown, 1, 1, 1);
  const trunkNI = trunk.toNonIndexed();
  const crownNI = crown.index ? crown.toNonIndexed() : crown;
  const g = mergeGeometries([trunkNI, crownNI])!;
  g.computeVertexNormals();
  return g;
}

/** Instanced street / park trees that get knocked flat. */
export class Trees {
  readonly mesh: THREE.InstancedMesh;
  private readonly trees: Tree[] = [];
  private dirty = true;

  constructor(specs: TreeSpec[]) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true, flatShading: true });
    this.mesh = new THREE.InstancedMesh(treeGeometry(), mat, Math.max(1, specs.length));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    specs.forEach((s, i) => {
      this.trees.push({ x: s.x, z: s.z, s: s.s, yaw: Math.random() * Math.PI * 2, fall: 0, fallTarget: 0, dirX: 1, dirZ: 0, down: false });
      _c.setHSL(0.24 + Math.random() * 0.1, 0.45 + Math.random() * 0.2, 0.22 + Math.random() * 0.1);
      this.mesh.setColorAt(i, _c);
    });
    this.mesh.count = specs.length;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Knock down trees inside a sphere. Returns how many fell. */
  damageSphere(x: number, y: number, z: number, r: number, burn = false): number {
    if (y - r > 9) return 0;
    let n = 0;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      if (t.down) continue;
      const dx = t.x - x;
      const dz = t.z - z;
      if (dx * dx + dz * dz > (r + 2) * (r + 2)) continue;
      const l = Math.hypot(dx, dz) || 1;
      t.dirX = dx / l;
      t.dirZ = dz / l;
      t.down = true;
      t.fallTarget = 1;
      if (burn) {
        this.mesh.setColorAt(i, _c.setHex(0x1b1714));
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      }
      n++;
    }
    if (n > 0) this.dirty = true;
    return n;
  }

  update(dt: number): void {
    let moving = this.dirty;
    for (const t of this.trees) {
      if (t.fall < t.fallTarget) {
        t.fall = Math.min(t.fallTarget, t.fall + dt * 2.5);
        moving = true;
      }
    }
    if (!moving) return;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const a = t.fall * t.fall * 1.45;
      _axis.set(t.dirZ, 0, -t.dirX);
      _q.setFromAxisAngle(_axis, a);
      _q2.setFromAxisAngle(UP, t.yaw);
      _q.multiply(_q2);
      _p.set(t.x, 0, t.z);
      _s.setScalar(t.s * (t.down ? 1 - t.fall * 0.25 : 1));
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
