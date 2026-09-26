/** Keyboard + mouse state with per-frame edge detection and pointer-lock handling. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly mouseDown = [false, false, false];
  private readonly mousePressed = [false, false, false];
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** Called when pointer lock is lost while the game wanted it (e.g. Esc). */
  onUnlock: (() => void) | null = null;
  /** Any key / button pressed this frame (used to skip cut-scenes). */
  anyPressed = false;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    if (!this.down.has(e.code)) {
      this.pressed.add(e.code);
      this.anyPressed = true;
    }
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.mouseDown.fill(false);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button > 2) return;
    this.mouseDown[e.button] = true;
    this.mousePressed[e.button] = true;
    this.anyPressed = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button > 2) return;
    this.mouseDown[e.button] = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.locked) {
      // clamp spikes some browsers produce right after locking
      this.mouseDX += Math.max(-200, Math.min(200, e.movementX));
      this.mouseDY += Math.max(-200, Math.min(200, e.movementY));
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  private onLockChange = () => {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.el;
    if (was && !this.locked) {
      this.mouseDown.fill(false);
      this.onUnlock?.();
    }
  };

  requestLock(): void {
    if (this.locked) return;
    try {
      const r = (this.el as HTMLElement & { requestPointerLock: (o?: unknown) => Promise<void> | void }).requestPointerLock();
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
    } catch {
      /* pointer lock unavailable: keyboard camera still works */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  mouse(button: number): boolean {
    return this.mouseDown[button];
  }

  mouseWasPressed(button: number): boolean {
    return this.mousePressed[button];
  }

  endFrame(): void {
    this.pressed.clear();
    this.mousePressed.fill(false);
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.anyPressed = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.el.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
  }
}
