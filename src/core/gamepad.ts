// Gamepad API (standard mapping) polled once per frame.

/** Standard-mapping button indices (Xbox letters; PlayStation equivalents in comments). */
export const PAD = {
  A: 0, // ×
  B: 1, // ○
  X: 2, // □
  Y: 3, // △
  LB: 4, // L1
  RB: 5, // R1
  LT: 6, // L2
  RT: 7, // R2
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export const STICK_DEADZONE = 0.15;
/** Analog triggers count as held above this value. */
export const TRIGGER_THRESHOLD = 0.35;

/**
 * Radial dead zone that rescales the remaining range, so output grows smoothly from 0
 * just outside the dead zone to 1 at full tilt. Pure function (unit tested).
 */
export function applyDeadzone(x: number, y: number, dz = STICK_DEADZONE): [number, number] {
  const m = Math.hypot(x, y);
  if (!(m > dz)) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

/**
 * Left stick -> camera-relative world direction (stick up = away from the camera).
 * Returns a vector with length 0..1. Pure function (unit tested).
 */
export function stickToWorld(sx: number, sy: number, forwardX: number, forwardZ: number, rightX: number, rightZ: number): [number, number] {
  const fwd = -sy;
  let x = forwardX * fwd + rightX * sx;
  let z = forwardZ * fwd + rightZ * sx;
  const l = Math.hypot(x, z);
  if (l > 1) {
    x /= l;
    z /= l;
  }
  return [x, z];
}

export class GamepadInput {
  connected = false;
  /** Sticks after the dead zone (-1..1). Y is down-positive like the raw API. */
  lx = 0;
  ly = 0;
  rx = 0;
  ry = 0;
  onConnect: ((id: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  private held: boolean[] = [];
  private prev: boolean[] = [];

  /** Read the first connected pad. Call once per frame before querying. */
  poll(): void {
    let pad: Gamepad | null = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          break;
        }
      }
    } catch {
      pad = null; // blocked by permissions policy etc.
    }
    this.prev = this.held;
    if (!pad) {
      if (this.connected) {
        this.connected = false;
        this.onDisconnect?.();
      }
      this.held = [];
      this.lx = this.ly = this.rx = this.ry = 0;
      return;
    }
    if (!this.connected) {
      this.connected = true;
      this.prev = [];
      this.onConnect?.(pad.id);
    }
    this.held = pad.buttons.map((b, i) => b.pressed || b.value > (i === PAD.LT || i === PAD.RT ? TRIGGER_THRESHOLD : 0.5));
    [this.lx, this.ly] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    [this.rx, this.ry] = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
  }

  down(button: number): boolean {
    return this.held[button] === true;
  }

  /** Became pressed this frame. */
  pressed(button: number): boolean {
    return this.held[button] === true && this.prev[button] !== true;
  }

  /** Any button pressed this frame (skip cut-scenes). */
  get anyPressed(): boolean {
    for (let i = 0; i < this.held.length; i++) if (this.held[i] && !this.prev[i]) return true;
    return false;
  }
}
