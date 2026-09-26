import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, QUALITY_LEVELS, QUALITY_PRESETS } from '../src/game/settings';

describe('normalizeSettings', () => {
  it('returns defaults for missing or broken data', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ quality: 'ultra', sens: 'fast', shake: NaN })).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates the v1 master volume into both volume sliders', () => {
    const s = normalizeSettings({ sens: 1.4, invert: true, volume: 0.3, music: false });
    expect(s.musicVolume).toBe(0.3);
    expect(s.sfxVolume).toBe(0.3);
    expect(s.sens).toBe(1.4);
    expect(s.invert).toBe(true);
    expect(s.music).toBe(false);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
  });

  it('clamps out-of-range numbers', () => {
    const s = normalizeSettings({ sens: 99, shake: -1, musicVolume: 2, sfxVolume: -3 });
    expect(s.sens).toBe(2.5);
    expect(s.shake).toBe(0);
    expect(s.musicVolume).toBe(1);
    expect(s.sfxVolume).toBe(0);
  });

  it('keeps valid values', () => {
    const s = normalizeSettings({ quality: 'low', shake: 0.25, showFps: true, musicVolume: 0.5, sfxVolume: 0.9 });
    expect(s).toMatchObject({ quality: 'low', shake: 0.25, showFps: true, musicVolume: 0.5, sfxVolume: 0.9 });
  });
});

describe('quality presets', () => {
  it('get cheaper from high to low', () => {
    const [low, medium, high] = QUALITY_LEVELS.map((q) => QUALITY_PRESETS[q]);
    expect(low.pixelRatio).toBeLessThan(medium.pixelRatio);
    expect(medium.pixelRatio).toBeLessThan(high.pixelRatio);
    expect(low.shadowMap).toBe(0);
    expect(low.debris).toBeLessThan(medium.debris);
    expect(medium.debris).toBeLessThanOrEqual(high.debris);
  });
});
