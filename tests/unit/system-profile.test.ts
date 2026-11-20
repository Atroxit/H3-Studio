// The pure half of hardware detection: tiers, the model catalog and the launch argv the
// Setup Wizard writes. Nothing here touches the machine, so every tier is pinned exactly.

import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '../../src/core/types';
import {
  applyProfileOverrides,
  buildLaunchArgs,
  cleanGpuName,
  mergeLaunchArgs,
  recommendForHardware,
  tierFor,
  vendorFromGpuName,
} from '../../src/server/system';

const W4A8 = 'minimax_h3_image_pruned_w4a8.safetensors';
const INT8_DIFFUSION = 'minimax_h3_image_pruned_int8_convrot.safetensors';
const NVFP4_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const INT8_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors';
const ENHANCER_27B = 'qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors';
const ENHANCER_9B = 'qwen3.5_9b_w4a8_gptq.safetensors';
const VAE = 'minimax_h3_image_vae_fp16.safetensors';

const EVERY_FILE = [
  W4A8,
  INT8_DIFFUSION,
  NVFP4_TEXT_ENCODER,
  INT8_TEXT_ENCODER,
  ENHANCER_27B,
  ENHANCER_9B,
  VAE,
];

function modelOf(models: readonly ModelCatalogEntry[], filename: string): ModelCatalogEntry {
  const found = models.find((entry) => entry.filename === filename);
  if (found === undefined) throw new Error(`missing catalog entry for ${filename}`);
  return found;
}

describe('hardware tiers', () => {
  it('classifies the usual VRAM sizes', () => {
    expect(tierFor(48)).toBe('extreme');
    expect(tierFor(32)).toBe('extreme');
    expect(tierFor(30)).toBe('extreme');
    expect(tierFor(24)).toBe('high');
    expect(tierFor(20)).toBe('high');
    expect(tierFor(16)).toBe('mid');
    expect(tierFor(14)).toBe('mid');
    expect(tierFor(12)).toBe('entry');
    expect(tierFor(8)).toBe('entry');
    expect(tierFor(null)).toBe('entry');
  });

  it('reads a vendor and a clean name out of what a probe returns', () => {
    expect(cleanGpuName('cuda:0 AMD Radeon RX 7900 XTX : native')).toBe('AMD Radeon RX 7900 XTX');
    expect(cleanGpuName('NVIDIA GeForce RTX 5090')).toBe('NVIDIA GeForce RTX 5090');
    expect(vendorFromGpuName('AMD Radeon RX 7900 XTX')).toBe('amd');
    expect(vendorFromGpuName('NVIDIA GeForce RTX 4090')).toBe('nvidia');
    expect(vendorFromGpuName('Apple M3 Max')).toBe('apple');
    expect(vendorFromGpuName('Intel(R) Arc(TM) A770 Graphics')).toBe('intel');
    expect(vendorFromGpuName('Some Accelerator')).toBe('unknown');
    // A ComfyUI device type is the fallback when the name says nothing.
    expect(vendorFromGpuName('Device 0', 'cuda')).toBe('nvidia');
    expect(vendorFromGpuName('Device 0', 'rocm')).toBe('amd');
  });
});

describe('recommendForHardware: extreme tier', () => {
  const { recommended, models } = recommendForHardware({
    vramGb: 32,
    ramTotalGb: 64,
    vendor: 'nvidia',
    installedFiles: EVERY_FILE,
  });

  it('picks the INT8 diffusion build, NVFP4 encoder and the 27B enhancer at 4K', () => {
    expect(recommended.tier).toBe('extreme');
    expect(recommended.tierLabel).toBe('Extreme');
    expect(recommended.modelVariant).toBe('int8_convrot');
    expect(recommended.textEncoderVariant).toBe('nvfp4');
    expect(recommended.promptEnhancer).toBe('qwen3.8_27b');
    expect(recommended.width).toBe(4096);
    expect(recommended.height).toBe(4096);
    expect(recommended.reserveVramGb).toBe(2);
    expect(recommended.previewMethod).toBe('latent2rgb');
  });

  it('keeps smart memory and pinned memory enabled', () => {
    expect(recommended.disablePinnedMemory).toBe(false);
    expect(recommended.disableSmartMemory).toBe(false);
    expect(recommended.cacheNone).toBe(false);
    expect(recommended.lowvram).toBe(false);
    expect(recommended.launchArgs).toEqual([
      '-u',
      'main.py',
      '--listen',
      '127.0.0.1',
      '--port',
      '8188',
      '--reserve-vram',
      '2',
      '--preview-method',
      'latent2rgb',
    ]);
    expect(recommended.launchEnv).toEqual({});
  });

  it('marks the extreme files it recommends as installed', () => {
    expect(modelOf(models, INT8_DIFFUSION).recommended).toBe(true);
    expect(modelOf(models, W4A8).recommended).toBe(false);
    expect(modelOf(models, NVFP4_TEXT_ENCODER).recommended).toBe(true);
    expect(modelOf(models, ENHANCER_27B).recommended).toBe(true);
    expect(modelOf(models, VAE).recommended).toBe(true);
    expect(modelOf(models, VAE).installed).toBe(true);
  });
});

describe('recommendForHardware: high tier', () => {
  const amdFiles = [W4A8, INT8_TEXT_ENCODER, ENHANCER_9B, VAE];

  it('tunes a 24 GB AMD card with ROCm flash attention and W4A8', () => {
    const { recommended } = recommendForHardware({
      vramGb: 24,
      ramTotalGb: 64,
      vendor: 'amd',
      installedFiles: amdFiles,
    });

    expect(recommended.tier).toBe('high');
    expect(recommended.tierLabel).toBe('High');
    expect(recommended.modelVariant).toBe('w4a8');
    expect(recommended.width).toBe(2048);
    expect(recommended.height).toBe(2048);
    expect(recommended.reserveVramGb).toBe(4);
    expect(recommended.previewMethod).toBe('latent2rgb');
    expect(recommended.cacheNone).toBe(true);
    expect(recommended.disableSmartMemory).toBe(true);
    expect(recommended.lowvram).toBe(false);

    // ROCm needs the AOTriton switch to reach the fast attention kernels.
    expect(recommended.launchEnv).toEqual({ TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1' });
    expect(recommended.launchArgs).toContain('--cache-none');
    expect(recommended.launchArgs).toContain('--disable-smart-memory');
    expect(recommended.launchArgs.slice(recommended.launchArgs.indexOf('--reserve-vram'))).toEqual([
      '--reserve-vram',
      '4',
      '--preview-method',
      'latent2rgb',
    ]);
  });

  it('keeps pinned memory on when the machine has enough RAM', () => {
    const { recommended } = recommendForHardware({
      vramGb: 24,
      ramTotalGb: 64,
      vendor: 'amd',
      installedFiles: amdFiles,
    });
    expect(recommended.disablePinnedMemory).toBe(false);
    expect(recommended.launchArgs).not.toContain('--disable-pinned-memory');
    expect(recommended.notes.join(' ')).toContain('Pinned memory stays on');
  });

  it('disables pinned memory when system RAM is short', () => {
    const { recommended } = recommendForHardware({
      vramGb: 24,
      ramTotalGb: 16,
      vendor: 'amd',
      installedFiles: amdFiles,
    });
    expect(recommended.disablePinnedMemory).toBe(true);
    expect(recommended.launchArgs).toContain('--disable-pinned-memory');
  });

  it('falls back from NVFP4 to INT8 when the NVFP4 encoder is not installed', () => {
    const { recommended, models } = recommendForHardware({
      vramGb: 24,
      ramTotalGb: 64,
      vendor: 'nvidia',
      installedFiles: [W4A8, INT8_TEXT_ENCODER, ENHANCER_9B, VAE],
    });
    expect(recommended.textEncoderVariant).toBe('int8');
    expect(modelOf(models, INT8_TEXT_ENCODER).recommended).toBe(true);
    expect(modelOf(models, NVFP4_TEXT_ENCODER).recommended).toBe(false);
    // The 27B enhancer is missing too, so the 9B build is what runs.
    expect(recommended.promptEnhancer).toBe('qwen3.5_9b');
    expect(recommended.launchEnv).toEqual({});
  });

  it('prefers NVFP4 and the 27B enhancer when both are installed on NVIDIA', () => {
    const { recommended } = recommendForHardware({
      vramGb: 24,
      ramTotalGb: 64,
      vendor: 'nvidia',
      installedFiles: EVERY_FILE,
    });
    expect(recommended.textEncoderVariant).toBe('nvfp4');
    expect(recommended.promptEnhancer).toBe('qwen3.8_27b');
  });
});

describe('recommendForHardware: mid and entry tiers', () => {
  it('tunes a 16 GB card with the 9B enhancer and a tighter reserve', () => {
    const { recommended } = recommendForHardware({
      vramGb: 16,
      ramTotalGb: 32,
      vendor: 'nvidia',
      installedFiles: [W4A8, NVFP4_TEXT_ENCODER, ENHANCER_9B, VAE],
    });

    expect(recommended.tier).toBe('mid');
    expect(recommended.modelVariant).toBe('w4a8');
    expect(recommended.textEncoderVariant).toBe('nvfp4');
    expect(recommended.promptEnhancer).toBe('qwen3.5_9b');
    expect(recommended.width).toBe(2048);
    expect(recommended.reserveVramGb).toBe(3);
    expect(recommended.disablePinnedMemory).toBe(true);
    expect(recommended.disableSmartMemory).toBe(true);
    expect(recommended.cacheNone).toBe(true);
    expect(recommended.lowvram).toBe(false);
    expect(recommended.launchArgs).toContain('--disable-pinned-memory');
    expect(recommended.launchArgs).not.toContain('--lowvram');
    expect(recommended.launchEnv).toEqual({});
  });

  it('runs a 12 GB card in low VRAM mode with the enhancer off', () => {
    const { recommended, models } = recommendForHardware({
      vramGb: 12,
      ramTotalGb: 32,
      vendor: 'nvidia',
      installedFiles: [W4A8, INT8_TEXT_ENCODER, VAE],
    });

    expect(recommended.tier).toBe('entry');
    expect(recommended.modelVariant).toBe('w4a8');
    expect(recommended.textEncoderVariant).toBe('int8');
    expect(recommended.promptEnhancer).toBe('off');
    expect(recommended.lowvram).toBe(true);
    expect(recommended.reserveVramGb).toBe(2);
    expect(recommended.launchArgs).toContain('--lowvram');
    expect(recommended.launchArgs).toContain('--cache-none');
    expect(recommended.launchArgs).toContain('--disable-pinned-memory');
    expect(recommended.launchArgs).toContain('--disable-smart-memory');
    // No enhancer file is recommended when the enhancer is off.
    expect(modelOf(models, ENHANCER_9B).recommended).toBe(false);
    expect(recommended.notes.join(' ')).toContain('1024 x 1024');
  });

  it('turns the 9B enhancer on at 12 GB when it is installed', () => {
    const { recommended } = recommendForHardware({
      vramGb: 12,
      ramTotalGb: 32,
      vendor: 'amd',
      installedFiles: [W4A8, ENHANCER_9B, VAE],
    });
    expect(recommended.promptEnhancer).toBe('qwen3.5_9b');
    expect(recommended.launchEnv).toEqual({ TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1' });
  });

  it('stays conservative when the VRAM size is unknown', () => {
    const { recommended, models } = recommendForHardware({
      vramGb: null,
      ramTotalGb: 16,
      vendor: 'unknown',
      installedFiles: [],
    });
    expect(recommended.tier).toBe('entry');
    expect(recommended.lowvram).toBe(true);
    expect(recommended.notes.join(' ')).toContain('could not be read');
    expect(recommended.notes.join(' ')).toContain('No H3 model file was found');
    // Nothing can be claimed to fit an unknown card.
    expect(models.every((entry) => entry.fitsVram === false)).toBe(true);
    expect(models.every((entry) => entry.installed === false)).toBe(true);
  });
});

describe('the official H3 model catalog', () => {
  const { models } = recommendForHardware({
    vramGb: 24,
    ramTotalGb: 64,
    vendor: 'nvidia',
    installedFiles: [W4A8, NVFP4_TEXT_ENCODER, ENHANCER_27B, VAE],
  });

  it('lists all seven files with their sizes, roles and download URLs', () => {
    expect(models).toHaveLength(7);
    expect(models.map((entry) => entry.filename).sort()).toEqual([...EVERY_FILE].sort());

    const w4a8 = modelOf(models, W4A8);
    expect(w4a8.sizeGb).toBe(11.69);
    expect(w4a8.role).toBe('diffusion');
    expect(w4a8.tier).toBe('fast');
    expect(w4a8.targetSubdir).toBe('models/diffusion_models');
    expect(w4a8.downloadUrl).toBe(
      'https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/diffusion_models/minimax_h3_image_pruned_w4a8.safetensors',
    );

    expect(modelOf(models, INT8_TEXT_ENCODER).sizeGb).toBe(25.28);
    expect(modelOf(models, ENHANCER_9B).sizeGb).toBe(6.84);
    expect(modelOf(models, VAE)).toMatchObject({ role: 'vae', tier: 'required', sizeGb: 1.09 });
    expect(modelOf(models, VAE).targetSubdir).toBe('models/vae');
  });

  it('reports what is installed and what fits beside the reserve', () => {
    expect(modelOf(models, W4A8).installed).toBe(true);
    expect(modelOf(models, INT8_DIFFUSION).installed).toBe(false);
    expect(modelOf(models, ENHANCER_9B).installed).toBe(false);
    // 24 GB minus the 4 GB reserve leaves room for W4A8, not for the 25 GB encoder.
    expect(modelOf(models, W4A8).fitsVram).toBe(true);
    expect(modelOf(models, INT8_TEXT_ENCODER).fitsVram).toBe(false);
  });
});

describe('launch arguments', () => {
  it('builds the argv from the booleans it is given', () => {
    expect(
      buildLaunchArgs({
        reserveVramGb: 2,
        previewMethod: 'none',
        disablePinnedMemory: true,
        disableSmartMemory: true,
        cacheNone: true,
        lowvram: true,
      }),
    ).toEqual([
      '-u',
      'main.py',
      '--listen',
      '127.0.0.1',
      '--port',
      '8188',
      '--lowvram',
      '--cache-none',
      '--disable-pinned-memory',
      '--disable-smart-memory',
      '--reserve-vram',
      '2',
      '--preview-method',
      'none',
    ]);
  });

  it('keeps a custom --port and --listen, and flags the plan does not manage', () => {
    const merged = mergeLaunchArgs(
      ['-u', 'main.py', '--listen', '0.0.0.0', '--port', '9000', '--extra-model-paths-config', 'paths.yaml'],
      ['-u', 'main.py', '--listen', '127.0.0.1', '--port', '8188', '--cache-none'],
    );
    expect(merged).toEqual([
      '-u',
      'main.py',
      '--cache-none',
      '--extra-model-paths-config',
      'paths.yaml',
      '--listen',
      '0.0.0.0',
      '--port',
      '9000',
    ]);
    expect(merged.filter((arg) => arg === '--port')).toHaveLength(1);
  });

  it('drops flags the new plan owns instead of keeping stale values', () => {
    const merged = mergeLaunchArgs(
      ['-u', 'main.py', '--disable-pinned-memory', '--disable-smart-memory', '--reserve-vram', '8'],
      ['-u', 'main.py', '--cache-none', '--reserve-vram', '2', '--preview-method', 'latent2rgb'],
    );
    expect(merged).toEqual([
      '-u',
      'main.py',
      '--cache-none',
      '--reserve-vram',
      '2',
      '--preview-method',
      'latent2rgb',
    ]);
  });

  it('adds a preserved flag the recommended argv does not carry', () => {
    expect(mergeLaunchArgs(['--port', '9000'], ['-u', 'main.py'])).toEqual([
      '-u',
      'main.py',
      '--port',
      '9000',
    ]);
  });

  it('copies the recommended argv when nothing needs preserving', () => {
    const next = ['-u', 'main.py', '--cache-none'];
    const merged = mergeLaunchArgs(['-u', 'main.py'], next);
    expect(merged).toEqual(next);
    expect(merged).not.toBe(next);
  });

  it('keeps a bare --listen flag', () => {
    expect(mergeLaunchArgs(['--listen'], ['-u', 'main.py'])).toEqual(['-u', 'main.py', '--listen']);
  });
});

describe('profile overrides', () => {
  const base = recommendForHardware({
    vramGb: 24,
    ramTotalGb: 64,
    vendor: 'amd',
    installedFiles: [W4A8, INT8_TEXT_ENCODER, VAE],
  }).recommended;

  it('applies the reserve and preview overrides to the argv', () => {
    const tuned = applyProfileOverrides(base, { reserveVramGb: 6, previewMethod: 'none' });
    expect(tuned.reserveVramGb).toBe(6);
    expect(tuned.previewMethod).toBe('none');
    expect(tuned.launchArgs.slice(tuned.launchArgs.indexOf('--reserve-vram'))).toEqual([
      '--reserve-vram',
      '6',
      '--preview-method',
      'none',
    ]);
  });

  it('turns the ROCm flash attention switch off when asked', () => {
    expect(base.launchEnv).toEqual({ TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1' });
    expect(applyProfileOverrides(base, { rocmFlashAttention: false }).launchEnv).toEqual({});
    expect(applyProfileOverrides(base, { rocmFlashAttention: true }).launchEnv).toEqual({
      TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1',
    });
  });

  it('leaves everything else alone without overrides', () => {
    const untouched = applyProfileOverrides(base, {});
    expect(untouched.launchArgs).toEqual(base.launchArgs);
    expect(untouched.launchEnv).toEqual(base.launchEnv);
    expect(untouched.modelVariant).toBe(base.modelVariant);
  });
});
