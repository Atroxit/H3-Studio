import { describe, expect, it } from 'vitest';
import { estimateVram, formatVramGb, type VramEstimateInput } from '../../src/web/features/generate/vram';

function input(overrides: Partial<VramEstimateInput> = {}): VramEstimateInput {
  return {
    width: 2048,
    height: 2048,
    modelVariant: 'w4a8',
    textEncoderVariant: 'nvfp4',
    promptEnhancer: 'off',
    referenceCount: 0,
    gpuVramGb: 24,
    systemRamGb: 64,
    ...overrides,
  };
}

describe('estimateVram', () => {
  it('peaks on one stage instead of summing the sequential pipeline', () => {
    const estimate = estimateVram(input());
    const total = estimate.stages.reduce((sum, stage) => sum + stage.gb, 0);

    expect(estimate.stages.map((stage) => stage.id)).toEqual(['textEncoder', 'diffusion']);
    expect(estimate.peakGb).toBe(estimate.peakStage.gb);
    expect(estimate.peakGb).toBeLessThan(total);
  });

  it('reports a comfortable w4a8 + nvfp4 fit at 2048 x 2048 on 24 GB', () => {
    const estimate = estimateVram(input());

    expect(estimate.status).toBe('ok');
    expect(estimate.statusLabel).toBe('Fits in VRAM');
    expect(estimate.peakStage.label).toBe('Diffusion + VAE');
    expect(estimate.peakGb).toBeCloseTo(16.6, 1);
    expect(estimate.offloadGb).toBe(0);
    expect(estimate.fillPercent).toBe(69);
  });

  it('offloads when the int8 text encoder drives the peak', () => {
    const estimate = estimateVram(input({ textEncoderVariant: 'int8' }));

    expect(estimate.status).toBe('offload');
    expect(estimate.peakStage.id).toBe('textEncoder');
    expect(estimate.peakStage.label).toBe('Text encoder');
    expect(estimate.peakGb).toBe(27.1);
    expect(estimate.offloadGb).toBe(3.1);
    expect(estimate.statusLabel).toBe('Offloads ~3.1 GB');
  });

  it('offloads when a 16 MP canvas makes diffusion the peak', () => {
    const estimate = estimateVram(
      input({ width: 4096, height: 4096, modelVariant: 'int8_convrot' }),
    );

    expect(estimate.status).toBe('offload');
    expect(estimate.peakStage.id).toBe('diffusion');
    expect(estimate.peakStage.label).toBe('Diffusion + VAE');
    expect(estimate.peakStage.gb).toBeGreaterThan(32);
    expect(estimate.peakGb).toBeGreaterThan(24);
    expect(estimate.offloadGb).toBeGreaterThan(0);
  });

  it('adds the prompt enhancer stage only when enabled, and it can be the peak', () => {
    const off = estimateVram(input({ width: 1024, height: 1024, promptEnhancer: 'off' }));
    const on = estimateVram(input({ width: 1024, height: 1024, promptEnhancer: 'qwen3.8_27b' }));

    expect(off.stages.map((stage) => stage.id)).toEqual(['textEncoder', 'diffusion']);
    expect(on.stages.map((stage) => stage.id)).toEqual(['enhancer', 'textEncoder', 'diffusion']);
    expect(on.peakStage.id).toBe('enhancer');
    expect(on.peakStage.gb).toBe(18.3);
    expect(on.peakGb).toBeGreaterThan(off.peakGb);
    expect(on.breakdownTitle).toContain('Prompt enhancer: 18.3 GB');
  });

  it('raises every stage as reference images are attached', () => {
    const none = estimateVram(input({ referenceCount: 0 }));
    const four = estimateVram(input({ referenceCount: 4 }));

    for (const stage of four.stages) {
      const before = none.stages.find((candidate) => candidate.id === stage.id);
      expect(before).toBeDefined();
      expect(stage.gb).toBeGreaterThan(before?.gb ?? Infinity);
    }
  });

  it('falls back to a 24 GB scale when the GPU is unknown', () => {
    const estimate = estimateVram(input({ gpuVramGb: null }));
    const expectedFill = Math.round((estimate.peakGb / 24) * 100);

    expect(estimate.gpuVramGb).toBeNull();
    expect(estimate.status).toBe('ok');
    expect(estimate.statusLabel).toBe('Est. peak');
    expect(estimate.offloadGb).toBe(0);
    expect(estimate.fillPercent).toBe(expectedFill);
    expect(Number.isFinite(estimate.peakGb)).toBe(true);
    expect(estimate.fillPercent).toBeGreaterThanOrEqual(4);
    expect(estimate.fillPercent).toBeLessThanOrEqual(100);
  });

  it('flags OOM when the overflow exceeds the spare system RAM', () => {
    const estimate = estimateVram(
      input({ textEncoderVariant: 'int8', systemRamGb: 4 }),
    );

    expect(estimate.status).toBe('oom');
    expect(estimate.statusLabel).toBe('OOM risk');
    expect(estimate.offloadGb).toBeGreaterThan(4 * 0.65);
  });

  it('builds a per-stage hover breakdown in pipeline order', () => {
    const estimate = estimateVram(input({ promptEnhancer: 'qwen3.5_9b' }));

    expect(estimate.breakdownTitle.split('\n')).toEqual([
      'Sequential peak (models hand off between phases)',
      'Prompt enhancer: 7.6 GB',
      'Text encoder: 16.4 GB',
      'Diffusion + VAE: 16.6 GB',
    ]);
  });

  it('clamps unusable dimensions instead of producing NaN', () => {
    const estimate = estimateVram(input({ width: 0, height: Number.NaN }));

    expect(estimate.peakGb).toBe(estimateVram(input({ width: 1024, height: 1024 })).peakGb);
    expect(Number.isNaN(estimate.fillPercent)).toBe(false);
  });
});

describe('formatVramGb', () => {
  it('keeps whole sizes whole and fractions to one decimal', () => {
    expect(formatVramGb(24)).toBe('24');
    expect(formatVramGb(11.7)).toBe('11.7');
  });
});
