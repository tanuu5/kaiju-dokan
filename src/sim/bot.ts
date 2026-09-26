import type { KaijuInput } from '../entities/kaiju';
import type { Session } from '../game/session';

/**
 * A simple "rampage" AI used for balance simulations and smoke tests:
 * walk to the nearest standing building and wreck it with every move available.
 * It is deliberately efficient (never wanders), so it plays better than a casual human.
 */
export class RampageBot {
  private t = 0;

  input(s: Session): KaijuInput {
    const w = s.world;
    const k = w.kaiju;
    const p = k.position;
    let best = null;
    let bd = Infinity;
    for (const b of w.buildings.list) {
      if (b.state !== 0 || !b.countable) continue;
      const d = Math.hypot(b.cx - p.x, b.cz - p.z) - b.h * 0.3;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    const inp: KaijuInput = {
      moveX: 0,
      moveZ: 0,
      run: false,
      punch: false,
      tail: false,
      jump: false,
      roar: false,
      breath: false,
      aimYaw: k.yaw,
      aim: s.aim,
    };
    if (!best) return inp;
    const dx = best.cx - p.x;
    const dz = best.cz - p.z;
    const dist = Math.hypot(dx, dz);
    inp.aimYaw = Math.atan2(dx, dz);
    s.aim.set(best.cx, best.h * 2, best.cz);
    if (dist > 28) {
      inp.moveX = dx / dist;
      inp.moveZ = dz / dist;
      inp.run = dist > 60;
      return inp;
    }
    this.t++;
    const c = this.t % 90;
    if (c === 1 || c === 25 || c === 49) inp.punch = true;
    if (k.cdTail <= 0 && this.t % 45 === 10) inp.tail = true;
    if (k.cdJump <= 0 && this.t % 70 === 30) inp.jump = true;
    if (k.energy > 70 || k.breathing) inp.breath = k.energy > 5;
    if (k.cdRoar <= 0 && w.military.aliveHelis > 1) inp.roar = true;
    return inp;
  }
}
