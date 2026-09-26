import * as THREE from 'three';

interface Item {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
  size: number;
  rot: number;
  rise: number;
  active: boolean;
}

export interface SfxOpts {
  size?: number;
  cls?: 'hot' | 'red' | 'white' | 'score';
  life?: number;
  rot?: number;
}

const _v = new THREE.Vector3();
const MAX_BIG = 5;
const MAX_SCORE = 6;

/** Manga-style onomatopoeia ("ドカン！") and score pop-ups projected from world space. */
export class SfxText {
  private readonly items: Item[] = [];
  /** Font-size multiplier (smaller on phones). */
  private scale = 1;

  setScale(s: number): void {
    this.scale = s;
  }

  constructor(layer: HTMLElement, pool = 24) {
    for (let i = 0; i < pool; i++) {
      const el = document.createElement('div');
      el.className = 'sfx';
      el.style.display = 'none';
      layer.appendChild(el);
      this.items.push({ el, x: 0, y: 0, z: 0, t: 0, life: 1, size: 40, rot: 0, rise: 0, active: false });
    }
  }

  spawn(text: string, x: number, y: number, z: number, o: SfxOpts = {}): void {
    const isScore = o.cls === 'score';
    // keep the screen readable: at most MAX_BIG onomatopoeia / MAX_SCORE pop-ups at once
    const same = this.items.filter((i) => i.active && (i.el.classList.contains('score') === isScore));
    let it: Item | undefined;
    if (same.length >= (isScore ? MAX_SCORE : MAX_BIG)) {
      it = same.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    } else {
      it = this.items.find((i) => !i.active);
      if (!it) it = this.items.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    }
    const j = isScore ? 3 : 6;
    it.active = true;
    it.x = x + (Math.random() * 2 - 1) * j;
    it.y = y + (Math.random() * 2 - 1) * j * 0.6;
    it.z = z + (Math.random() * 2 - 1) * j;
    it.t = 0;
    it.life = o.life ?? 0.9;
    it.size = (o.size ?? 44) * this.scale;
    it.rot = o.rot ?? (Math.random() * 2 - 1) * 12;
    it.rise = o.cls === 'score' ? 60 : 26;
    it.el.textContent = text;
    it.el.className = `sfx ${o.cls ?? 'hot'}`;
    it.el.style.fontSize = `${it.size}px`;
    it.el.style.display = 'block';
  }

  update(dt: number, camera: THREE.Camera, w: number, h: number): void {
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt;
      const u = it.t / it.life;
      if (u >= 1) {
        it.active = false;
        it.el.style.display = 'none';
        continue;
      }
      _v.set(it.x, it.y, it.z).project(camera);
      if (_v.z > 1 || _v.z < -1) {
        it.el.style.opacity = '0';
        continue;
      }
      const sx = (_v.x * 0.5 + 0.5) * w;
      const sy = (-_v.y * 0.5 + 0.5) * h - u * it.rise;
      const pop = u < 0.08 ? 0.3 + (u / 0.08) * 1.1 : u < 0.2 ? 1.4 - ((u - 0.08) / 0.12) * 0.4 : 1;
      const alpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
      it.el.style.opacity = alpha.toFixed(3);
      it.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) rotate(${it.rot.toFixed(1)}deg) scale(${pop.toFixed(3)})`;
    }
  }

  clear(): void {
    for (const it of this.items) {
      it.active = false;
      it.el.style.display = 'none';
    }
  }
}
