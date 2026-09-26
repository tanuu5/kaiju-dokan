// Procedural sound effects and music built with the Web Audio API.
// No external audio files are used.

import { clamp } from './math';

interface Voice {
  gain: GainNode;
  stop: (t: number) => void;
}

const MIDI = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverbSend!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private shaper!: WaveShaperNode;
  private lx = 0;
  private lz = 0;
  private rx = 1;
  private rz = 0;
  private volume = 0.8;
  musicOn = true;
  private musicTimer: number | null = null;
  private nextNote = 0;
  private step = 0;
  private breathVoice: Voice | null = null;
  private chargeVoice: Voice | null = null;
  private heliGain: GainNode | null = null;
  private sirenGain: GainNode | null = null;
  private lastPlayed = new Map<string, number>();
  private active = 0;

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 10;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    comp.connect(this.master);
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(comp);
    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 0.32 : 0;
    this.music.connect(comp);

    // noise buffers
    const len = ctx.sampleRate * 3;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      last = (last + 0.02 * r) / 1.02;
      b[i] = last * 3.5;
    }

    // reverb
    const conv = ctx.createConvolver();
    const irLen = Math.floor(ctx.sampleRate * 2.6);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    conv.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.55;
    this.reverbSend.connect(conv);
    conv.connect(comp);

    // shared distortion curve
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.2);
    }
    this.shaper.curve = curve;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (this.ctx) this.music.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 0.2);
  }

  /** Camera position and right vector for simple stereo panning / distance falloff. */
  setListener(x: number, z: number, rightX: number, rightZ: number): void {
    this.lx = x;
    this.lz = z;
    this.rx = rightX;
    this.rz = rightZ;
  }

  // ------------------------------------------------------------------
  // building blocks
  // ------------------------------------------------------------------

  private out(x: number | null, z: number | null, level: number, reverb = 0): { node: AudioNode; gain: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    let g = level;
    let pan = 0;
    if (x !== null && z !== null) {
      const dx = x - this.lx;
      const dz = z - this.lz;
      const d = Math.hypot(dx, dz);
      g *= clamp(1.4 / (1 + d / 110), 0.06, 1);
      pan = d > 1 ? clamp((dx * this.rx + dz * this.rz) / d, -1, 1) * 0.75 : 0;
    }
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.sfx);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      p.connect(s);
      s.connect(this.reverbSend);
    }
    return { node: p, gain: g };
  }

  private noise(brown: boolean, t: number, dur: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.white;
    src.loop = true;
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
    return src;
  }

  private env(t: number, peak: number, attack: number, decay: number, curve = 3): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, decay / curve);
    return g;
  }

  private thump(dest: AudioNode, t: number, f0: number, f1: number, dur: number, level: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.env(t, level, 0.006, dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur * 1.6);
  }

  private filtered(dest: AudioNode, t: number, brown: boolean, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, level: number, attack = 0.005): void {
    const ctx = this.ctx!;
    const src = this.noise(brown, t, dur * 1.5);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.env(t, level, attack, dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
  }

  private throttle(key: string, minGap: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const last = this.lastPlayed.get(key) ?? -1;
    if (now - last < minGap) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  private track(dur: number): boolean {
    if (this.active > 24) return false;
    this.active++;
    window.setTimeout(() => this.active--, dur * 1000);
    return true;
  }

  // ------------------------------------------------------------------
  // sound effects
  // ------------------------------------------------------------------

  footstep(x: number, z: number, power: number, water: boolean): void {
    const o = this.out(x, z, 0.9 * power, 0.25);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.thump(o.node, t, 62, 28, 0.5, o.gain);
    this.filtered(o.node, t, true, 0.35, 'lowpass', 260, 90, 0.7, o.gain * 0.9);
    if (water) this.filtered(o.node, t, false, 0.6, 'bandpass', 1400, 500, 0.8, o.gain * 0.35, 0.02);
  }

  impact(x: number, z: number, size: number): void {
    if (!this.throttle('impact', 0.04)) return;
    const o = this.out(x, z, 0.8, 0.35);
    if (!o || !this.track(0.8)) return;
    const t = this.ctx!.currentTime;
    this.thump(o.node, t, 120, 38, 0.35, o.gain);
    this.filtered(o.node, t, false, 0.3 + size * 0.02, 'bandpass', 1300, 220, 0.9, o.gain * 0.9);
    for (let i = 0; i < 6; i++) this.filtered(o.node, t + 0.03 + Math.random() * 0.4, false, 0.05, 'bandpass', 1500 + Math.random() * 2500, 900, 3, o.gain * 0.25);
  }

  crumble(x: number, z: number, size: number): void {
    if (!this.throttle('crumble', 0.12)) return;
    const dur = clamp(1.2 + size * 0.05, 1.2, 3.8);
    const o = this.out(x, z, clamp(0.45 + size * 0.015, 0.45, 1.0), 0.6);
    if (!o || !this.track(dur)) return;
    const t = this.ctx!.currentTime;
    const ctx = this.ctx!;
    const src = this.noise(true, t, dur + 0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(160, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain, t + 0.08);
    g.gain.setValueAtTime(o.gain, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.node);
    this.thump(o.node, t, 55, 25, 0.9, o.gain * 0.9);
    const clicks = Math.round(10 + size * 0.4);
    for (let i = 0; i < Math.min(34, clicks); i++) {
      const ct = t + Math.random() * dur * 0.85;
      this.filtered(o.node, ct, false, 0.04 + Math.random() * 0.05, 'bandpass', 900 + Math.random() * 3000, 500, 2.5, o.gain * 0.3 * Math.random());
    }
  }

  explosion(x: number, z: number, size: number): void {
    if (!this.throttle('explosion', 0.05)) return;
    const o = this.out(x, z, clamp(0.6 + size * 0.03, 0.6, 1.1), 0.5);
    if (!o || !this.track(1.5)) return;
    const t = this.ctx!.currentTime;
    this.filtered(o.node, t, true, 1.0 + size * 0.03, 'lowpass', 3200, 140, 0.8, o.gain * 1.2, 0.004);
    this.thump(o.node, t, 80, 26, 0.7, o.gain);
    this.filtered(o.node, t, false, 0.25, 'highpass', 2500, 1500, 0.7, o.gain * 0.35, 0.002);
  }

  swing(big: boolean): void {
    const o = this.out(null, null, big ? 0.35 : 0.22);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const ctx = this.ctx!;
    const src = this.noise(false, t, 0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(big ? 900 : 1400, t + 0.15);
    f.frequency.exponentialRampToValueAtTime(250, t + 0.4);
    const g = this.env(t, o.gain, 0.08, 0.35);
    src.connect(f);
    f.connect(g);
    g.connect(o.node);
  }

  roar(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = this.out(null, null, 0.9, 0.9);
    if (!o) return;
    const t = ctx.currentTime;
    const dur = 2.3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(o.gain, t + 0.14);
    env.gain.setValueAtTime(o.gain * 0.9, t + 1.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // growl amplitude modulation
    const am = ctx.createGain();
    am.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 34;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.3;
    lfo.connect(lfoG);
    lfoG.connect(am.gain);
    lfo.start(t);
    lfo.stop(t + dur);
    const pre = ctx.createGain();
    pre.gain.value = 0.35;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.shaper.curve;
    pre.connect(shaper);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 3;
    f1.frequency.setValueAtTime(600, t);
    f1.frequency.linearRampToValueAtTime(950, t + 0.4);
    f1.frequency.linearRampToValueAtTime(520, t + dur);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 4;
    f2.frequency.setValueAtTime(1150, t);
    f2.frequency.linearRampToValueAtTime(1600, t + 0.4);
    f2.frequency.linearRampToValueAtTime(900, t + dur);
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 400;
    shaper.connect(f1);
    shaper.connect(f2);
    shaper.connect(low);
    const mix = ctx.createGain();
    mix.gain.value = 1.2;
    f1.connect(mix);
    f2.connect(mix);
    low.connect(mix);
    mix.connect(am);
    am.connect(env);
    env.connect(o.node);
    for (const det of [1, 1.07, 0.94, 0.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(90 * det, t);
      osc.frequency.linearRampToValueAtTime(150 * det, t + 0.3);
      osc.frequency.linearRampToValueAtTime(125 * det, t + 1.3);
      osc.frequency.linearRampToValueAtTime(70 * det, t + dur);
      osc.connect(pre);
      osc.start(t);
      osc.stop(t + dur);
    }
    const breath = this.noise(false, t, dur);
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 1700;
    bf.Q.value = 0.8;
    const bg = ctx.createGain();
    bg.gain.value = 0.35;
    breath.connect(bf);
    bf.connect(bg);
    bg.connect(env);
  }

  chargeStart(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.chargeStop();
    const o = this.out(null, null, 0.22, 0.3);
    if (!o) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain, t + 0.35);
    osc.connect(g);
    g.connect(o.node);
    osc.start(t);
    this.chargeVoice = {
      gain: g,
      stop: (tt) => {
        g.gain.cancelScheduledValues(tt);
        g.gain.setTargetAtTime(0.0001, tt, 0.05);
        osc.stop(tt + 0.3);
      },
    };
  }

  chargeStop(): void {
    if (this.chargeVoice && this.ctx) this.chargeVoice.stop(this.ctx.currentTime);
    this.chargeVoice = null;
  }

  breathStart(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.chargeStop();
    this.breathStop();
    const o = this.out(null, null, 0.7, 0.4);
    if (!o) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain, t + 0.12);
    g.connect(o.node);
    const n1 = ctx.createBufferSource();
    n1.buffer = this.brown;
    n1.loop = true;
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 520;
    f1.Q.value = 0.6;
    n1.connect(f1);
    f1.connect(g);
    const n2 = ctx.createBufferSource();
    n2.buffer = this.white;
    n2.loop = true;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'highpass';
    f2.frequency.value = 2800;
    const g2 = ctx.createGain();
    g2.gain.value = 0.12;
    n2.connect(f2);
    f2.connect(g2);
    g2.connect(g);
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 58;
    const hf = ctx.createBiquadFilter();
    hf.type = 'lowpass';
    hf.frequency.value = 320;
    const hg = ctx.createGain();
    hg.gain.value = 0.35;
    hum.connect(hf);
    hf.connect(hg);
    hg.connect(g);
    n1.start(t);
    n2.start(t);
    hum.start(t);
    this.breathVoice = {
      gain: g,
      stop: (tt) => {
        g.gain.cancelScheduledValues(tt);
        g.gain.setTargetAtTime(0.0001, tt, 0.08);
        n1.stop(tt + 0.5);
        n2.stop(tt + 0.5);
        hum.stop(tt + 0.5);
      },
    };
  }

  breathStop(): void {
    this.chargeStop();
    if (this.breathVoice && this.ctx) this.breathVoice.stop(this.ctx.currentTime);
    this.breathVoice = null;
  }

  tankFire(x: number, z: number): void {
    const o = this.out(x, z, 0.5, 0.3);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.thump(o.node, t, 170, 55, 0.25, o.gain);
    this.filtered(o.node, t, false, 0.18, 'bandpass', 1800, 600, 0.8, o.gain * 0.8, 0.002);
  }

  missile(x: number, z: number): void {
    const o = this.out(x, z, 0.3, 0.2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.filtered(o.node, t, false, 0.9, 'bandpass', 1500, 500, 1.5, o.gain, 0.05);
  }

  hit(x: number, z: number): void {
    if (!this.throttle('hit', 0.05)) return;
    const o = this.out(x, z, 0.45, 0.2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.thump(o.node, t, 300, 90, 0.15, o.gain);
    this.filtered(o.node, t, false, 0.2, 'highpass', 2000, 1200, 0.7, o.gain * 0.6, 0.002);
  }

  /** Continuous rotor noise; volume 0..1 by proximity. */
  heli(volume: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.heliGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.brown;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 420;
      const am = ctx.createGain();
      am.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 13;
      const lg = ctx.createGain();
      lg.gain.value = 0.5;
      lfo.connect(lg);
      lg.connect(am.gain);
      this.heliGain = ctx.createGain();
      this.heliGain.gain.value = 0;
      src.connect(f);
      f.connect(am);
      am.connect(this.heliGain);
      this.heliGain.connect(this.sfx);
      src.start();
      lfo.start();
    }
    this.heliGain.gain.setTargetAtTime(clamp(volume, 0, 1) * 0.5, ctx.currentTime, 0.2);
  }

  siren(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.sirenGain) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 480;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.16;
      const lg = ctx.createGain();
      lg.gain.value = 140;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = 482;
      lg.connect(osc2.frequency);
      this.sirenGain = ctx.createGain();
      this.sirenGain.gain.value = 0;
      osc.connect(this.sirenGain);
      osc2.connect(this.sirenGain);
      this.sirenGain.connect(this.reverbSend);
      const dry = ctx.createGain();
      dry.gain.value = 0.3;
      this.sirenGain.connect(dry);
      dry.connect(this.sfx);
      osc.start();
      osc2.start();
      lfo.start();
    }
    this.sirenGain.gain.setTargetAtTime(on ? 0.045 : 0, ctx.currentTime, 1.2);
  }

  ui(): void {
    const o = this.out(null, null, 0.15);
    if (!o) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(990, t + 0.06);
    const g = this.env(t, o.gain, 0.005, 0.12);
    osc.connect(g);
    g.connect(o.node);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  jingle(success: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = this.out(null, null, 0.4, 0.4);
    if (!o) return;
    const t = ctx.currentTime;
    const notes = success ? [62, 65, 69, 74, 77, 81] : [69, 65, 62, 57];
    notes.forEach((n, i) => {
      const tt = t + i * (success ? 0.11 : 0.22);
      for (const type of ['triangle', 'sawtooth'] as OscillatorType[]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = MIDI(n);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 2200;
        const g = this.env(tt, o.gain * (type === 'sawtooth' ? 0.25 : 0.6), 0.01, success && i === notes.length - 1 ? 1.4 : 0.35);
        osc.connect(f);
        f.connect(g);
        g.connect(o.node);
        osc.start(tt);
        osc.stop(tt + 2);
      }
    });
    this.thump(o.node, t, 90, 40, 0.6, o.gain);
  }

  // ------------------------------------------------------------------
  // music: taiko + bass ostinato (original pattern)
  // ------------------------------------------------------------------

  startMusic(): void {
    const ctx = this.ctx;
    if (!ctx || this.musicTimer !== null) return;
    this.nextNote = ctx.currentTime + 0.1;
    this.step = 0;
    this.musicTimer = window.setInterval(() => this.schedule(), 25);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const spb = 60 / 132 / 4; // 16th notes
    while (this.nextNote < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextNote);
      this.nextNote += spb;
      this.step = (this.step + 1) % 128;
    }
  }

  private playStep(step: number, t: number): void {
    const ctx = this.ctx!;
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const dest = this.music;
    // taiko
    const kick = [0, 3, 6, 8, 11, 14];
    const fill = bar % 4 === 3 ? [12, 13, 14, 15] : [];
    if (kick.includes(s) || fill.includes(s)) {
      const lvl = s === 0 ? 0.9 : fill.includes(s) ? 0.55 : 0.6;
      this.thump(dest, t, 110, 45, 0.28, lvl);
      this.filtered(dest, t, true, 0.12, 'lowpass', 900, 200, 0.7, lvl * 0.5, 0.002);
    }
    if (s === 4 || s === 12) this.filtered(dest, t, false, 0.08, 'bandpass', 2600, 1800, 1.5, 0.18, 0.001);
    // bass ostinato in D minor (8th notes)
    if (s % 2 === 0) {
      const riffs = [
        [38, 38, 41, 38, 36, 38, 43, 41],
        [38, 38, 41, 38, 45, 43, 41, 40],
      ];
      const riff = riffs[bar % 2];
      const note = riff[(s / 2) % 8];
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = MIDI(note);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(700, t);
      f.frequency.exponentialRampToValueAtTime(180, t + 0.2);
      f.Q.value = 4;
      const g = this.env(t, 0.32, 0.01, 0.22);
      osc.connect(f);
      f.connect(g);
      g.connect(dest);
      osc.start(t);
      osc.stop(t + 0.4);
    }
    // brass-ish stab every 2 bars
    if (s === 0 && bar % 2 === 0) {
      for (const n of [50, 53, 57]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = MIDI(n + (bar % 8 >= 4 ? -2 : 0));
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1100;
        const g = this.env(t, 0.07, 0.04, 0.9);
        osc.connect(f);
        f.connect(g);
        g.connect(dest);
        osc.start(t);
        osc.stop(t + 1.3);
      }
    }
  }

  stopLoops(): void {
    this.breathStop();
    this.heli(0);
    this.siren(false);
  }
}
