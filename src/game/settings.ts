// Player settings: graphics quality presets, camera, audio and comfort options.
// Pure data + validation (unit tested); the Game applies them.

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  /** Upper bound for devicePixelRatio. */
  pixelRatio: number;
  /** Shadow map size, 0 = no shadows. */
  shadowMap: number;
  /** MSAA samples of the main render target (0 = off). */
  msaa: number;
  bloom: boolean;
  /** Pool sizes (applied when a new run starts). */
  debris: number;
  smoke: number;
  glow: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { label: '低', pixelRatio: 1, shadowMap: 0, msaa: 0, bloom: false, debris: 2200, smoke: 3500, glow: 2500 },
  medium: { label: '中', pixelRatio: 1.5, shadowMap: 2048, msaa: 4, bloom: true, debris: 4500, smoke: 6000, glow: 4000 },
  high: { label: '高', pixelRatio: 2, shadowMap: 4096, msaa: 4, bloom: true, debris: 6000, smoke: 8000, glow: 5000 },
};

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

export interface Settings {
  quality: QualityLevel;
  /** Camera sensitivity multiplier. */
  sens: number;
  invert: boolean;
  musicVolume: number;
  sfxVolume: number;
  /** BGM on/off (M key). */
  music: boolean;
  /** Screen shake / FOV kick strength, 0 (off) .. 1 (full). */
  shake: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  sens: 1,
  invert: false,
  musicVolume: 0.8,
  sfxVolume: 0.8,
  music: true,
  shake: 0.7,
  showFps: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function isQualityLevel(v: unknown): v is QualityLevel {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * Turn whatever was stored (possibly an older version, or garbage) into complete, valid settings.
 * v1 stored a single master `volume`; it now seeds both volume sliders.
 */
export function normalizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const legacyVolume = typeof r.volume === 'number' ? r.volume : undefined;
  return {
    quality: isQualityLevel(r.quality) ? r.quality : defaults.quality,
    sens: num(r.sens, defaults.sens, 0.3, 2.5),
    invert: bool(r.invert, defaults.invert),
    musicVolume: num(r.musicVolume ?? legacyVolume, defaults.musicVolume, 0, 1),
    sfxVolume: num(r.sfxVolume ?? legacyVolume, defaults.sfxVolume, 0, 1),
    music: bool(r.music, defaults.music),
    shake: num(r.shake, defaults.shake, 0, 1),
    showFps: bool(r.showFps, defaults.showFps),
  };
}
