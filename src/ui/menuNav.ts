import { PAD, type GamepadInput } from '../core/gamepad';

const REPEAT_DELAY = 0.38;
const REPEAT_RATE = 0.12;

/**
 * Gamepad navigation for the HTML menus: up/down (d-pad or left stick) moves a focus ring
 * through the buttons and inputs of the active menu, left/right adjusts sliders, A activates.
 */
export class MenuNav {
  private container: HTMLElement | null = null;
  private index = -1;
  private held = 0;
  private repeatT = 0;

  update(dt: number, container: HTMLElement | null, pad: GamepadInput): void {
    if (container !== this.container) {
      this.clear();
      this.container = container;
      this.index = -1;
      this.held = 0;
    }
    if (!container || !pad.connected) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>('button, input')).filter(
      (e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null,
    );
    if (items.length === 0) return;
    if (this.index < 0 || this.index >= items.length || !items[this.index].classList.contains('pad-focus')) this.focus(items, Math.max(0, Math.min(this.index, items.length - 1)));

    // one "direction key" at a time, with key-repeat
    let key = 0;
    if (pad.down(PAD.UP) || pad.ly < -0.6) key = 1;
    else if (pad.down(PAD.DOWN) || pad.ly > 0.6) key = 2;
    else if (pad.down(PAD.LEFT) || pad.lx < -0.6) key = 3;
    else if (pad.down(PAD.RIGHT) || pad.lx > 0.6) key = 4;
    let fire = false;
    if (key !== this.held) {
      this.held = key;
      this.repeatT = REPEAT_DELAY;
      fire = key !== 0;
    } else if (key !== 0) {
      this.repeatT -= dt;
      if (this.repeatT <= 0) {
        this.repeatT = REPEAT_RATE;
        fire = true;
      }
    }
    const el = items[this.index];
    if (fire) {
      const isRange = el instanceof HTMLInputElement && el.type === 'range';
      if ((key === 3 || key === 4) && isRange) {
        const input = el as HTMLInputElement;
        const step = Number(input.step) || 0.1;
        const next = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + (key === 4 ? step : -step)));
        input.value = String(Math.round(next / step) * step);
        input.dispatchEvent(new Event('input'));
      } else {
        const dir = key === 1 || key === 3 ? -1 : 1;
        this.focus(items, (this.index + dir + items.length) % items.length);
      }
    }
    if (pad.pressed(PAD.A)) items[this.index].click();
  }

  private focus(items: HTMLElement[], i: number): void {
    this.clear();
    this.index = i;
    const el = items[i];
    el.classList.add('pad-focus');
    el.focus({ preventScroll: false });
  }

  clear(): void {
    document.querySelectorAll('.pad-focus').forEach((e) => e.classList.remove('pad-focus'));
  }
}
