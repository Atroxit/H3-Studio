import { describe, expect, it } from 'vitest';
import type { SizePreset } from '../../src/core/types';
import { ratioOf, sizeTier, tieredPresetsForRatio } from '../../src/web/features/generate/helpers';

function preset(width: number, height: number): SizePreset {
  return { id: `${width}x${height}`, label: `${width} x ${height}`, width, height };
}

const HERO_4_3 = preset(4736, 3552);
const HERO_16_9 = preset(5472, 3072);
const HERO_9_16 = preset(3072, 5472);
const SQUARE_1K = preset(1024, 1024);
const SQUARE_2K = preset(2048, 2048);
const SQUARE_4K = preset(4096, 4096);

function expectSynthesized(preset_: SizePreset, ratio: string): void {
  expect(preset_.width % 32).toBe(0);
  expect(preset_.height % 32).toBe(0);
  expect(ratioOf(preset_.width, preset_.height)).toBe(ratio);
  expect(preset_.id).toBe(`${preset_.width}x${preset_.height}`);
  expect(preset_.label).toBe(`${preset_.width}×${preset_.height}`);
}

describe('sizeTier', () => {
  it('uses the same longest-side cuts as the inspector labels', () => {
    expect(sizeTier(preset(1024, 1024))).toBe('1K');
    expect(sizeTier(preset(1280, 720))).toBe('1K');
    expect(sizeTier(preset(2048, 1536))).toBe('2K');
    expect(sizeTier(preset(2560, 1440))).toBe('2K');
    expect(sizeTier(preset(4096, 4096))).toBe('4K');
  });
});

describe('tieredPresetsForRatio', () => {
  it('keeps a single 4:3 hero preset and synthesizes the cheaper tiers', () => {
    const tiers = tieredPresetsForRatio([HERO_4_3], '4:3', 32, true);

    expect(tiers).toHaveLength(3);
    expect(tiers[2]).toBe(HERO_4_3);
    expectSynthesized(tiers[0]!, '4:3');
    expectSynthesized(tiers[1]!, '4:3');
    expect(tiers[0]!.width * tiers[0]!.height).toBeLessThan(tiers[1]!.width * tiers[1]!.height);
    expect(tiers[1]!.width * tiers[1]!.height).toBeLessThan(tiers[2]!.width * tiers[2]!.height);
  });

  it('keeps a single 16:9 hero preset and synthesizes the cheaper tiers', () => {
    const tiers = tieredPresetsForRatio([HERO_16_9], '16:9', 32, true);

    expect(tiers).toHaveLength(3);
    expect(tiers[2]).toBe(HERO_16_9);
    expectSynthesized(tiers[0]!, '16:9');
    expectSynthesized(tiers[1]!, '16:9');
  });

  it('keeps a single 9:16 hero preset and synthesizes the cheaper tiers', () => {
    const tiers = tieredPresetsForRatio([HERO_9_16], '9:16', 32, true);

    expect(tiers).toHaveLength(3);
    expect(tiers[2]).toBe(HERO_9_16);
    expectSynthesized(tiers[0]!, '9:16');
    expectSynthesized(tiers[1]!, '9:16');
  });

  it('returns the three 1:1 provider presets unchanged, in tier order', () => {
    const presets = [SQUARE_1K, SQUARE_2K, SQUARE_4K];
    const tiers = tieredPresetsForRatio(presets, '1:1', 32, true);

    expect(tiers).toEqual([SQUARE_1K, SQUARE_2K, SQUARE_4K]);
    expect(tiers[0]).toBe(SQUARE_1K);
    expect(tiers[2]).toBe(SQUARE_4K);
  });

  it('orders provider presets by tier even when the provider lists them differently', () => {
    const tiers = tieredPresetsForRatio([SQUARE_4K, SQUARE_1K, SQUARE_2K], '1:1', 32, true);

    expect(tiers).toEqual([SQUARE_1K, SQUARE_2K, SQUARE_4K]);
  });

  it('prefers the provider preset closest to the tier pixel count', () => {
    const smaller = preset(1024, 1024);
    const larger = preset(1152, 1152);
    const tiers = tieredPresetsForRatio([larger, smaller, SQUARE_2K, SQUARE_4K], '1:1', 32, true);

    expect(tiers[0]).toBe(smaller);
  });

  it('leaves a provider that only takes its own presets untouched', () => {
    const presets = [HERO_4_3];
    const tiers = tieredPresetsForRatio(presets, '4:3', 32, false);

    expect(tiers).toEqual(presets);
  });
});
