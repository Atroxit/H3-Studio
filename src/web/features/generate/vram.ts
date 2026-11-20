// A pure VRAM budget for the H3 pipeline. MiniMax H3 runs its phases sequentially and hands
// memory off between them, so the peak is the largest single stage, never the sum.

import type { H3ModelVariant, H3PromptEnhancer, H3TextEncoderVariant } from '../../../core/types';

export type VramStageId = 'enhancer' | 'textEncoder' | 'diffusion';
export type VramStatus = 'ok' | 'tight' | 'offload' | 'oom';

export interface VramEstimateInput {
  width: number;
  height: number;
  modelVariant: H3ModelVariant;
  textEncoderVariant: H3TextEncoderVariant;
  promptEnhancer: H3PromptEnhancer;
  referenceCount: number;
  gpuVramGb: number | null;
  systemRamGb?: number | null;
}

export interface VramStageEstimate {
  id: VramStageId;
  label: string;
  gb: number;
}

export interface VramEstimate {
  /** Peak sequential VRAM needed across all active pipeline phases (GB, rounded to 1 decimal). */
  peakGb: number;
  /** Detected GPU VRAM (GB) if known, or null if unknown. */
  gpuVramGb: number | null;
  /** Which sequential stage drives the peak. */
  peakStage: VramStageEstimate;
  /** All active pipeline stages (for hover breakdown tooltip). */
  stages: VramStageEstimate[];
  /** Fill percentage (0..100, clamped) relative to gpuVramGb (or relative to 24 GB fallback scale when gpuVramGb is null). */
  fillPercent: number;
  /** How many GB overflow VRAM into system RAM (0 when it fits). */
  offloadGb: number;
  /** Semantic status driving bar colour and badge text. */
  status: VramStatus;
  /** Compact human-readable status label (e.g. "Fits in VRAM", "Tight fit", "Offloads ~3.1 GB", "OOM risk"). */
  statusLabel: string;
  /** Multi-stage summary string for hover tooltip. */
  breakdownTitle: string;
}

/** Higher wins a tie, so the heaviest downstream stage names the peak. */
const STAGE_PRIORITY: Record<VramStageId, number> = {
  enhancer: 0,
  textEncoder: 1,
  diffusion: 2,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1024;
}

/** The GB fallback scale used when the machine's VRAM is unknown. */
const FALLBACK_VRAM_GB = 24;

export function estimateVram(input: VramEstimateInput): VramEstimate {
  const width = safeDimension(input.width);
  const height = safeDimension(input.height);
  const refs = Math.max(0, Math.min(4, Math.trunc(input.referenceCount)));
  const mp = (width * height) / 1_000_000;

  const stages: VramStageEstimate[] = [];

  if (input.promptEnhancer !== 'off') {
    const gb =
      input.promptEnhancer === 'qwen3.8_27b'
        ? 16.1 + 2.2 + refs * 0.4
        : 6.2 + 1.4 + refs * 0.3;
    stages.push({ id: 'enhancer', label: 'Prompt enhancer', gb: round1(gb) });
  }

  const encoderGb =
    input.textEncoderVariant === 'int8' ? 25.3 + 1.8 + refs * 0.4 : 14.6 + 1.8 + refs * 0.4;
  const textEncoderStage: VramStageEstimate = {
    id: 'textEncoder',
    label: 'Text encoder',
    gb: round1(encoderGb),
  };
  stages.push(textEncoderStage);

  const weightsGb = input.modelVariant === 'int8_convrot' ? 19.5 : 11.7;
  const diffusionGb =
    weightsGb + 2.2 + 0.65 * mp + refs * (0.4 + 0.08 * Math.min(mp, 16));
  stages.push({ id: 'diffusion', label: 'Diffusion + VAE', gb: round1(diffusionGb) });

  let peakStage = textEncoderStage;
  for (const stage of stages) {
    if (
      stage.gb > peakStage.gb ||
      (stage.gb === peakStage.gb && STAGE_PRIORITY[stage.id] > STAGE_PRIORITY[peakStage.id])
    ) {
      peakStage = stage;
    }
  }
  const peakGb = peakStage.gb;

  const gpuVramGb =
    input.gpuVramGb !== null && Number.isFinite(input.gpuVramGb) && input.gpuVramGb > 0
      ? input.gpuVramGb
      : null;

  let fillPercent: number;
  let offloadGb = 0;
  let status: VramStatus;
  let statusLabel: string;

  if (gpuVramGb === null) {
    fillPercent = Math.max(4, Math.min(100, Math.round((peakGb / FALLBACK_VRAM_GB) * 100)));
    status = 'ok';
    statusLabel = 'Est. peak';
  } else {
    const ratio = peakGb / gpuVramGb;
    fillPercent = Math.max(4, Math.min(100, Math.round(ratio * 100)));
    offloadGb = peakGb > gpuVramGb ? round1(peakGb - gpuVramGb) : 0;

    const systemRamGb = input.systemRamGb ?? null;
    if (offloadGb > 0) {
      if (systemRamGb !== null && systemRamGb > 0 && offloadGb > systemRamGb * 0.65) {
        status = 'oom';
        statusLabel = 'OOM risk';
      } else {
        status = 'offload';
        statusLabel = `Offloads ~${offloadGb.toFixed(1)} GB`;
      }
    } else if (ratio >= 0.85) {
      status = 'tight';
      statusLabel = 'Tight fit';
    } else {
      status = 'ok';
      statusLabel = 'Fits in VRAM';
    }
  }

  const breakdownTitle = [
    'Sequential peak (models hand off between phases)',
    ...stages.map((stage) => `${stage.label}: ${stage.gb.toFixed(1)} GB`),
  ].join('\n');

  return {
    peakGb,
    gpuVramGb,
    peakStage,
    stages,
    fillPercent,
    offloadGb,
    status,
    statusLabel,
    breakdownTitle,
  };
}

/** A GPU size as the user reads it: whole numbers stay whole, fractions keep one decimal. */
export function formatVramGb(gb: number): string {
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}
