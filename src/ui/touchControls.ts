// On-screen controls for phones / tablets: a floating joystick (left half), camera drag
// (right half) and action buttons. Uses Pointer Events so multi-touch works everywhere.

export type TouchAction = 'punch' | 'tail' | 'jump' | 'breath' | 'roar';

export interface TouchFrame {
  /** Joystick like a gamepad stick: x right, y down, length 0..1. */
  moveX: number;
  moveY: number;
  /** Stick pushed to the rim. */
  run: boolean;
  /** Camera drag this frame (CSS pixels). */
  camDX: number;
  camDY: number;
  /** Became pressed this frame. */
  pressed: Set<TouchAction>;
  /** Currently held. */
  held: Set<TouchAction>;
  pause: boolean;
  /** Any tap this frame (skip cut-scenes). */
  tap: boolean;
}

const STICK_RADIUS = 56;
const RUN_THRESHOLD = 0.95;

/** Joystick vector from a drag offset (pure; unit tested). */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number; run: boolean } {
  const len = Math.hypot(dx, dy);
  if (!(len > 4)) return { x: 0, y: 0, run: false };
  const k = Math.min(1, len / radius) / len;
  const x = dx * k;
  const y = dy * k;
  return { x, y, run: Math.hypot(x, y) >= RUN_THRESHOLD };
}

export class TouchControls {
  enabled = false;
  private readonly layer: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly buttons = new Map<TouchAction, HTMLElement>();
  private stickId: number | null = null;
  private stickOx = 0;
  private stickOy = 0;
  private stickDx = 0;
  private stickDy = 0;
  private camId: number | null = null;
  private camX = 0;
  private camY = 0;
  private camDX = 0;
  private camDY = 0;
  private readonly pressed = new Set<TouchAction>();
  private readonly held = new Set<TouchAction>();
  private readonly buttonPointers = new Map<number, TouchAction>();
  private pausePressed = false;
  private tapped = false;

  constructor(root: HTMLElement) {
    this.layer = root.querySelector('#touch-layer')!;
    this.base = root.querySelector('#touch-stick')!;
    this.knob = root.querySelector('#touch-stick .knob')!;
    root.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => this.buttons.set(b.dataset.act as TouchAction, b));

    this.layer.addEventListener('pointerdown', this.onLayerDown);
    this.layer.addEventListener('pointermove', this.onLayerMove);
    this.layer.addEventListener('pointerup', this.onLayerUp);
    this.layer.addEventListener('pointercancel', this.onLayerUp);
    for (const [act, el] of this.buttons) {
      el.addEventListener('pointerdown', (e) => {
        if (!this.accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        capture(el, e.pointerId);
        this.buttonPointers.set(e.pointerId, act);
        this.pressed.add(act);
        this.held.add(act);
        this.tapped = true;
        el.classList.add('active');
      });
      const release = (e: PointerEvent) => {
        if (this.buttonPointers.get(e.pointerId) !== act) return;
        this.buttonPointers.delete(e.pointerId);
        this.held.delete(act);
        el.classList.remove('active');
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    root.querySelector('#touch-pause')?.addEventListener('pointerdown', (e) => {
      if (!this.accepts(e as PointerEvent)) return;
      e.preventDefault();
      e.stopPropagation();
      this.pausePressed = true;
    });
    // iOS Safari: several fingers on the controls must not pinch-zoom the page
    const active = () => this.enabled && !root.classList.contains('hidden');
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => {
        if (active()) e.preventDefault();
      });
    }
    document.addEventListener(
      'touchmove',
      (e) => {
        if (active() && e.touches.length > 1) e.preventDefault();
      },
      { passive: false },
    );
  }

  /** Touch and pen only: a mouse click switches the game back to mouse controls instead. */
  private accepts(e: PointerEvent): boolean {
    return this.enabled && e.pointerType !== 'mouse';
  }

  private onLayerDown = (e: PointerEvent) => {
    if (!this.accepts(e)) return;
    e.preventDefault();
    this.tapped = true;
    const w = window.innerWidth;
    if (e.clientX < w * 0.5 && this.stickId === null) {
      this.stickId = e.pointerId;
      // keep the whole joystick on screen
      this.stickOx = Math.min(Math.max(e.clientX, STICK_RADIUS + 12), w - STICK_RADIUS - 12);
      this.stickOy = Math.min(Math.max(e.clientY, STICK_RADIUS + 12), window.innerHeight - STICK_RADIUS - 12);
      this.stickDx = e.clientX - this.stickOx;
      this.stickDy = e.clientY - this.stickOy;
      capture(this.layer, e.pointerId);
      this.drawStick(true);
    } else if (this.camId === null) {
      this.camId = e.pointerId;
      this.camX = e.clientX;
      this.camY = e.clientY;
      capture(this.layer, e.pointerId);
    }
  };

  private onLayerMove = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickDx = e.clientX - this.stickOx;
      this.stickDy = e.clientY - this.stickOy;
      this.drawStick(true);
    } else if (e.pointerId === this.camId) {
      this.camDX += e.clientX - this.camX;
      this.camDY += e.clientY - this.camY;
      this.camX = e.clientX;
      this.camY = e.clientY;
    }
  };

  private onLayerUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stickDx = 0;
      this.stickDy = 0;
      this.drawStick(false);
    } else if (e.pointerId === this.camId) {
      this.camId = null;
    }
  };

  private drawStick(active: boolean): void {
    this.base.classList.toggle('active', active);
    if (!active) {
      this.base.style.removeProperty('left');
      this.base.style.removeProperty('top');
      this.knob.style.transform = '';
      return;
    }
    const v = stickVector(this.stickDx, this.stickDy);
    this.base.style.left = `${this.stickOx}px`;
    this.base.style.top = `${this.stickOy}px`;
    this.knob.style.transform = `translate(${(v.x * STICK_RADIUS).toFixed(1)}px, ${(v.y * STICK_RADIUS).toFixed(1)}px)`;
    this.knob.classList.toggle('run', v.run);
  }

  /** Read and reset this frame's input. */
  consume(): TouchFrame {
    const v = stickVector(this.stickDx, this.stickDy);
    const f: TouchFrame = {
      moveX: v.x,
      moveY: v.y,
      run: v.run,
      camDX: this.camDX,
      camDY: this.camDY,
      pressed: new Set(this.pressed),
      held: new Set(this.held),
      pause: this.pausePressed,
      tap: this.tapped,
    };
    this.pressed.clear();
    this.camDX = 0;
    this.camDY = 0;
    this.pausePressed = false;
    this.tapped = false;
    return f;
  }

  /** Release everything (e.g. when the game pauses). */
  reset(): void {
    this.stickId = null;
    this.camId = null;
    this.stickDx = this.stickDy = 0;
    this.camDX = this.camDY = 0;
    this.pressed.clear();
    this.held.clear();
    this.buttonPointers.clear();
    for (const el of this.buttons.values()) el.classList.remove('active');
    this.drawStick(false);
  }

  /** Dim buttons that can't be used right now. */
  setStates(s: { tail: boolean; jump: boolean; roar: boolean; breath: boolean; breathFull: boolean }): void {
    this.buttons.get('tail')?.classList.toggle('cooling', !s.tail);
    this.buttons.get('jump')?.classList.toggle('cooling', !s.jump);
    this.buttons.get('roar')?.classList.toggle('cooling', !s.roar);
    this.buttons.get('breath')?.classList.toggle('cooling', !s.breath);
    this.buttons.get('breath')?.classList.toggle('ready', s.breathFull);
  }
}

/** Keep receiving a finger's moves even when it slides off the element (best effort). */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* pointer already gone */
  }
}
