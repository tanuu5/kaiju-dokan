import { CHUNK } from '../config';
import type { CityLayout } from '../world/cityGen';
import { CELL } from '../world/cityGen';
import type { BuildingState } from '../world/buildings';

/** North-up minimap of the whole city. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private readonly scale: number;
  private readonly ox: number;
  private readonly oz: number;
  private frame = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly city: CityLayout,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const worldW = city.gridW * CHUNK;
    const worldD = city.gridD * CHUNK + 90; // include some sea
    this.scale = Math.min(W / worldW, canvas.height / worldD);
    this.ox = (W - worldW * this.scale) / 2;
    this.oz = (canvas.height - worldD * this.scale) / 2;

    // static background
    this.bg = document.createElement('canvas');
    this.bg.width = canvas.width;
    this.bg.height = canvas.height;
    const b = this.bg.getContext('2d')!;
    b.fillStyle = '#1d3a4a';
    b.fillRect(0, 0, W, canvas.height);
    const cs = CHUNK * this.scale;
    for (let k = 0; k < city.gridD; k++) {
      for (let i = 0; i < city.gridW; i++) {
        const t = city.cellType[i + k * city.gridW];
        b.fillStyle = t === CELL.ROAD ? '#2a2a30' : t === CELL.PARK ? '#2f4a2a' : t === CELL.HARBOR ? '#4a4a4a' : t === CELL.PLAZA ? '#5a544c' : '#3c3b3a';
        b.fillRect(this.ox + i * cs, this.oz + k * cs, cs + 0.5, cs + 0.5);
      }
    }
  }

  private mx(x: number): number {
    return this.ox + (x - this.city.originX) * this.scale;
  }

  private mz(z: number): number {
    return this.oz + (z - this.city.originZ) * this.scale;
  }

  draw(
    buildings: BuildingState[],
    kaiju: { x: number; z: number; yaw: number },
    camYaw: number,
    units: (cb: (kind: 'tank' | 'heli', x: number, z: number) => void) => void,
  ): void {
    this.frame++;
    if (this.frame % 3 !== 0) return;
    const c = this.ctx;
    c.drawImage(this.bg, 0, 0);
    const cs = CHUNK * this.scale;
    for (const b of buildings) {
      const x = this.mx(b.x0);
      const z = this.mz(b.z0);
      if (b.state === 0) {
        const k = b.aliveCount / Math.max(1, b.total);
        c.fillStyle = k > 0.75 ? '#b9b3a8' : '#9a8062';
      } else {
        c.fillStyle = '#5a2a1c';
      }
      c.fillRect(x, z, b.w * cs, b.d * cs);
    }
    // camera view wedge
    const kx = this.mx(kaiju.x);
    const kz = this.mz(kaiju.z);
    const fx = -Math.sin(camYaw);
    const fz = -Math.cos(camYaw);
    c.fillStyle = 'rgba(255, 220, 150, 0.12)';
    c.beginPath();
    c.moveTo(kx, kz);
    const a = Math.atan2(fz, fx);
    c.arc(kx, kz, 60, a - 0.5, a + 0.5);
    c.closePath();
    c.fill();
    // units
    units((kind, x, z) => {
      c.fillStyle = kind === 'tank' ? '#ff4a3a' : '#ff9a3a';
      const px = this.mx(x);
      const pz = this.mz(z);
      if (kind === 'tank') c.fillRect(px - 2.5, pz - 2.5, 5, 5);
      else {
        c.beginPath();
        c.arc(px, pz, 3.5, 0, Math.PI * 2);
        c.fill();
      }
    });
    // kaiju arrow
    c.save();
    c.translate(kx, kz);
    c.rotate(-kaiju.yaw + Math.PI);
    c.fillStyle = '#ffd23d';
    c.strokeStyle = '#1a0800';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(6, 6);
    c.lineTo(0, 3);
    c.lineTo(-6, 6);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();
  }
}
