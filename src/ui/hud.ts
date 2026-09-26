import { formatInt, formatTime } from '../core/math';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

export interface HudState {
  hp: number;
  hpMax: number;
  energy: number;
  energyMax: number;
  time: number;
  destruction: number;
  goal: number;
  score: number;
  buildings: number;
  combo: number;
  multiplier: number;
  cdTail: number;
  cdJump: number;
  cdRoar: number;
  crosshair: boolean;
}

/** DOM heads-up display. Only touches the DOM when values change. */
export class Hud {
  readonly root = $('hud');
  private readonly hpFill = $('hp-fill');
  private readonly hpBar = this.hpFill.parentElement!;
  private readonly energyFill = $('energy-fill');
  private readonly energyBar = this.energyFill.parentElement!;
  private readonly timer = $('timer');
  private readonly pct = $('destruction-pct');
  private readonly destFill = $('destruction-fill');
  private readonly destBar = this.destFill.parentElement!;
  private readonly goalMarker = $('goal-marker');
  private readonly goalPct = $('goal-pct');
  private readonly score = $('score');
  private readonly buildings = $('buildings-count');
  private readonly combo = $('combo');
  private readonly crosshair = $('crosshair');
  private readonly banner = $('banner');
  private readonly vignette = $('damage-vignette');
  private readonly cdTail = $('cd-tail');
  private readonly cdJump = $('cd-jump');
  private readonly cdRoar = $('cd-roar');
  private readonly hint = $('controls-hint');
  private readonly cache = new Map<string, string | number | boolean>();
  private comboShown = 0;
  private vignetteLevel = 0;

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  toggleHint(): void {
    this.hint.classList.toggle('hidden');
  }

  setGoal(goal: number): void {
    this.goalMarker.style.left = `${goal * 100}%`;
    this.goalPct.textContent = String(Math.round(goal * 100));
  }

  private set(key: string, value: string | number | boolean, apply: () => void): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    apply();
  }

  update(s: HudState, dt: number): void {
    const hpK = Math.max(0, s.hp / s.hpMax);
    this.set('hp', Math.round(hpK * 400), () => {
      this.hpFill.style.transform = `scaleX(${hpK.toFixed(3)})`;
      this.hpBar.classList.toggle('low', hpK < 0.3);
    });
    const enK = Math.max(0, s.energy / s.energyMax);
    this.set('en', Math.round(enK * 400), () => {
      this.energyFill.style.transform = `scaleX(${enK.toFixed(3)})`;
      this.energyBar.classList.toggle('full', enK > 0.99);
    });
    const tt = formatTime(s.time);
    this.set('time', tt, () => {
      this.timer.textContent = tt;
      this.timer.classList.toggle('hurry', s.time <= 30);
    });
    const pct = Math.floor(s.destruction * 100);
    this.set('pct', pct, () => {
      this.pct.textContent = String(pct);
      this.destFill.style.transform = `scaleX(${Math.min(1, s.destruction).toFixed(3)})`;
      this.destBar.classList.toggle('cleared', s.destruction >= s.goal);
    });
    this.set('score', Math.round(s.score), () => (this.score.textContent = formatInt(s.score)));
    this.set('bld', s.buildings, () => (this.buildings.textContent = String(s.buildings)));
    this.set('cdt', s.cdTail > 0, () => this.cdTail.classList.toggle('cooling', s.cdTail > 0));
    this.set('cdj', s.cdJump > 0, () => this.cdJump.classList.toggle('cooling', s.cdJump > 0));
    this.set('cdr', s.cdRoar > 0, () => this.cdRoar.classList.toggle('cooling', s.cdRoar > 0));
    this.set('xh', s.crosshair, () => this.crosshair.classList.toggle('hidden', !s.crosshair));

    if (s.combo >= 2) {
      if (s.combo !== this.comboShown) {
        this.combo.innerHTML = `<div class="combo-num">${s.combo}</div><div class="combo-word">COMBO</div><div class="combo-mult">×${s.multiplier.toFixed(1)}</div>`;
        this.combo.classList.add('show');
        this.combo.classList.remove('bump');
        void this.combo.offsetWidth;
        this.combo.classList.add('bump');
        this.comboShown = s.combo;
      }
    } else if (this.comboShown !== 0) {
      this.combo.classList.remove('show');
      this.comboShown = 0;
    }

    this.vignetteLevel = Math.max(0, this.vignetteLevel - dt * 2.5);
    const lowHp = hpK < 0.25 ? 0.35 + Math.sin(performance.now() / 200) * 0.1 : 0;
    const v = Math.max(this.vignetteLevel, lowHp);
    this.set('vig', Math.round(v * 50), () => (this.vignette.style.opacity = v.toFixed(2)));
  }

  hurt(amount: number): void {
    this.vignetteLevel = Math.min(1, this.vignetteLevel + amount);
  }

  /** Big centred message. */
  showBanner(text: string, cls = '', duration = 2.2): void {
    const el = document.createElement('div');
    el.className = `banner-item ${cls}`;
    el.textContent = text;
    this.banner.appendChild(el);
    while (this.banner.children.length > 2) this.banner.removeChild(this.banner.firstChild!);
    window.setTimeout(() => el.classList.add('out'), duration * 1000);
    window.setTimeout(() => el.remove(), duration * 1000 + 450);
  }

  clearBanners(): void {
    this.banner.innerHTML = '';
  }

  reset(): void {
    this.cache.clear();
    this.comboShown = 0;
    this.combo.classList.remove('show');
    this.vignetteLevel = 0;
    this.clearBanners();
  }
}
