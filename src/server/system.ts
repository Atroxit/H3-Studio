// Hardware detection, the official H3 model catalog, and the auto-tune recommendation the
// Setup Wizard applies to the ComfyUI provider.
//
// Two rules shape this file:
//   1. Every probe is best effort and time bounded. A machine with no GPU, no NVIDIA driver
//      and no ComfyUI must still get an answer, so nothing here throws.
//   2. The recommendation is a pure function of what was measured. That keeps it unit
//      testable and keeps the wizard from depending on the machine it runs on.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DetectedGpu,
  GpuVendor,
  HardwareTier,
  H3ModelVariant,
  H3PromptEnhancer,
  H3TextEncoderVariant,
  ModelCatalogEntry,
  ProviderConfig,
  RecommendedSettings,
  SystemProfile,
} from '../core/types';

const COMFY_STATS_TIMEOUT_MS = 1800;
const COMFY_MODEL_LIST_TIMEOUT_MS = 1800;
const NVIDIA_SMI_TIMEOUT_MS = 1500;
const WINDOWS_GPU_TIMEOUT_MS = 2500;
const MACOS_GPU_TIMEOUT_MS = 2500;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_SCANNED_FILES = 4000;
const MAX_SCAN_DEPTH = 2;
const GIB = 1024 ** 3;

/** The port and bind address the recommender writes, unless the provider already has its own. */
const DEFAULT_COMFY_PORT = 8188;
const DEFAULT_COMFY_LISTEN = '127.0.0.1';

/** RAM below this makes pinned memory a liability: the page lock starves the rest of the OS. */
const PINNED_MEMORY_MIN_RAM_GB = 28;

const MODEL_EXTENSIONS = new Set(['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.gguf']);

const H3_REPO_ROOT = 'https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main';
const DIFFUSION_SUBDIR = 'models/diffusion_models';
const TEXT_ENCODER_SUBDIR = 'models/text_encoders';
const VAE_SUBDIR = 'models/vae';

const W4A8_FILE = 'minimax_h3_image_pruned_w4a8.safetensors';
const INT8_DIFFUSION_FILE = 'minimax_h3_image_pruned_int8_convrot.safetensors';
const NVFP4_TEXT_ENCODER_FILE = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const INT8_TEXT_ENCODER_FILE = 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors';
const ENHANCER_27B_FILE = 'qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors';
const ENHANCER_9B_FILE = 'qwen3.5_9b_w4a8_gptq.safetensors';
const VAE_FILE = 'minimax_h3_image_vae_fp16.safetensors';

/** The environment switch that lets ROCm use the fast AOTriton flash attention kernels. */
export const ROCM_AOTRITON_ENV = 'TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL';

interface CatalogSeed {
  id: string;
  role: ModelCatalogEntry['role'];
  filename: string;
  label: string;
  sizeGb: number;
  tier: ModelCatalogEntry['tier'];
  /** Folder inside the Hugging Face repo, which is also the ComfyUI target subdirectory. */
  repoSubdir: string;
  targetSubdir: string;
  note: string;
}

/** The seven official MiniMax H3 Image files, in the order the wizard lists them. */
const H3_CATALOG: readonly CatalogSeed[] = [
  {
    id: 'h3-diffusion-w4a8',
    role: 'diffusion',
    filename: W4A8_FILE,
    label: 'H3 Image W4A8 (fast)',
    sizeGb: 11.69,
    tier: 'fast',
    repoSubdir: 'diffusion_models',
    targetSubdir: DIFFUSION_SUBDIR,
    note: 'Fast driver: roughly 100% of a 24 GB card, best quality per second.',
  },
  {
    id: 'h3-diffusion-int8',
    role: 'diffusion',
    filename: INT8_DIFFUSION_FILE,
    label: 'H3 Image INT8 ConvRot (max)',
    sizeGb: 19.54,
    tier: 'max',
    repoSubdir: 'diffusion_models',
    targetSubdir: DIFFUSION_SUBDIR,
    note: 'Highest quality diffusion build. Needs 24 GB or more to stay fully on the card.',
  },
  {
    id: 'h3-text-encoder-nvfp4',
    role: 'text_encoder',
    filename: NVFP4_TEXT_ENCODER_FILE,
    label: 'Qwen3-VL 32B NVFP4 AWQ (fast)',
    sizeGb: 14.61,
    tier: 'fast',
    repoSubdir: 'text_encoders',
    targetSubdir: TEXT_ENCODER_SUBDIR,
    note: 'Compact 14.6 GB build of the 32B H3 text encoder. Fits in 24 GB VRAM with zero offloading on both NVIDIA and AMD ROCm.',
  },
  {
    id: 'h3-text-encoder-int8',
    role: 'text_encoder',
    filename: INT8_TEXT_ENCODER_FILE,
    label: 'Qwen3-VL 32B INT8 ConvRot (max)',
    sizeGb: 25.28,
    tier: 'max',
    repoSubdir: 'text_encoders',
    targetSubdir: TEXT_ENCODER_SUBDIR,
    note: 'Vendor neutral INT8 build of the 32B H3 text encoder. Needs 30 GB or more.',
  },
  {
    id: 'h3-enhancer-27b',
    role: 'prompt_enhancer',
    filename: ENHANCER_27B_FILE,
    label: 'Qwen3.8 27B prompt enhancer (max)',
    sizeGb: 16.1,
    tier: 'max',
    repoSubdir: 'text_encoders',
    targetSubdir: TEXT_ENCODER_SUBDIR,
    note: 'Best caption expansion. Runs without a thinking section now, so it is fast too.',
  },
  {
    id: 'h3-enhancer-9b',
    role: 'prompt_enhancer',
    filename: ENHANCER_9B_FILE,
    label: 'Qwen3.5 9B prompt enhancer (fast)',
    sizeGb: 6.84,
    tier: 'fast',
    repoSubdir: 'text_encoders',
    targetSubdir: TEXT_ENCODER_SUBDIR,
    note: 'Light caption expansion for 16 GB cards and below.',
  },
  {
    id: 'h3-vae',
    role: 'vae',
    filename: VAE_FILE,
    label: 'H3 Image VAE (fp16)',
    sizeGb: 1.09,
    tier: 'required',
    repoSubdir: 'vae',
    targetSubdir: VAE_SUBDIR,
    note: 'Required for every H3 graph. Download it first.',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / GIB) * 10) / 10;
}

/** Gigahertz-free formatting: one decimal is enough for a tier decision and readable. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- Hardware thresholds -------------------------------------------------------------

/**
 * The tier a card falls into. An unknown VRAM is treated as entry: the conservative plan
 * still runs, while the optimistic one might not fit at all.
 */
export function tierFor(vramGb: number | null): HardwareTier {
  if (vramGb === null || !Number.isFinite(vramGb) || vramGb <= 0) return 'entry';
  if (vramGb >= 30) return 'extreme';
  if (vramGb >= 20) return 'high';
  if (vramGb >= 14) return 'mid';
  return 'entry';
}

const VENDOR_PATTERNS: readonly (readonly [GpuVendor, RegExp])[] = [
  ['nvidia', /\b(nvidia|geforce|rtx|gtx|quadro|tesla|titan|a100|h100|blackwell|ada)\b/i],
  ['amd', /\b(amd|radeon|instinct|firepro|gfx\d*)\b/i],
  ['apple', /\b(apple|m1|m2|m3|m4)\b/i],
  ['intel', /\b(intel|arc|iris|uhd|xe)\b/i],
];

/** The vendor a device name advertises, or the one its ComfyUI device type implies. */
export function vendorFromGpuName(name: string, deviceType?: string): GpuVendor {
  for (const [vendor, pattern] of VENDOR_PATTERNS) {
    if (pattern.test(name)) return vendor;
  }
  switch ((deviceType ?? '').toLowerCase()) {
    case 'cuda':
      return 'nvidia';
    case 'rocm':
    case 'hip':
      return 'amd';
    case 'mps':
      return 'apple';
    case 'xpu':
      return 'intel';
    default:
      return 'unknown';
  }
}

/** Strips PyTorch's device wrapper: "cuda:0 AMD Radeon RX 7900 XTX : native". */
export function cleanGpuName(raw: string): string {
  return raw
    .replace(/^(?:cuda|rocm|hip|privateuseone|xpu|mps)\s*:\s*\d+\s+/i, '')
    .replace(/\s*:\s*(?:native|eager|compiled)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Launch arguments ----------------------------------------------------------------

export interface LaunchArgSettings {
  reserveVramGb: number;
  previewMethod: 'latent2rgb' | 'none';
  disablePinnedMemory: boolean;
  disableSmartMemory: boolean;
  cacheNone: boolean;
  lowvram: boolean;
}

/** The ComfyUI argv the recommender writes, in the order the studio starts the server. */
export function buildLaunchArgs(settings: LaunchArgSettings): string[] {
  const args = [
    '-u',
    'main.py',
    '--listen',
    DEFAULT_COMFY_LISTEN,
    '--port',
    String(DEFAULT_COMFY_PORT),
  ];
  if (settings.lowvram) args.push('--lowvram');
  if (settings.cacheNone) args.push('--cache-none');
  if (settings.disablePinnedMemory) args.push('--disable-pinned-memory');
  if (settings.disableSmartMemory) args.push('--disable-smart-memory');
  args.push('--reserve-vram', String(settings.reserveVramGb), '--preview-method', settings.previewMethod);
  return args;
}

/**
 * Flags whose value belongs to the user's setup, never to an auto-tune: they describe where
 * the user's ComfyUI answers, and rewriting them would point the studio at a port nothing
 * listens on.
 */
const PRESERVED_FLAGS: ReadonlySet<string> = new Set(['--port', '--listen']);

/** Flags the auto-tune owns, so the new plan replaces them instead of keeping old values. */
const TUNED_VALUE_FLAGS: ReadonlySet<string> = new Set([...PRESERVED_FLAGS, '--reserve-vram', '--preview-method']);
const TUNED_BARE_FLAGS: ReadonlySet<string> = new Set([
  '--lowvram',
  '--cache-none',
  '--disable-pinned-memory',
  '--disable-smart-memory',
]);

/** Collects one flag and the value that follows it, when that value is not another flag. */
function collectFlag(args: readonly string[], index: number, into: string[]): number {
  const arg = args[index];
  if (arg === undefined) return index;
  into.push(arg);
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) return index;
  into.push(value);
  return index + 1;
}

/**
 * Merges a recommended argv into the argv the provider already has.
 *
 * Three things survive a re-tune: the user's own `--port` and `--listen`, and any flag this
 * engine does not manage (`--extra-model-paths-config`, `--enable-cors-header`, ...). Flags
 * the plan owns are dropped first, so turning pinned memory back on is not undone by the old
 * `--disable-pinned-memory` still sitting in the file.
 */
export function mergeLaunchArgs(current: readonly string[], next: readonly string[]): string[] {
  const preserved: string[] = [];
  const extras: string[] = [];
  for (let index = 0; index < current.length; index += 1) {
    const arg = current[index];
    if (arg === undefined) continue;
    if (PRESERVED_FLAGS.has(arg)) {
      index = collectFlag(current, index, preserved);
      continue;
    }
    if (TUNED_VALUE_FLAGS.has(arg)) {
      const value = current[index + 1];
      if (value !== undefined && !value.startsWith('-')) index += 1;
      continue;
    }
    // The launcher's own interpreter flags and script name are part of every argv.
    if (arg === '-u' || arg === 'main.py' || TUNED_BARE_FLAGS.has(arg)) continue;
    extras.push(arg);
  }

  const merged: string[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const arg = next[index];
    if (arg === undefined) continue;
    // Only the user's own network flags are dropped here: every other tuned flag in the
    // recommended argv is exactly what this merge exists to write.
    if (PRESERVED_FLAGS.has(arg)) {
      const value = next[index + 1];
      if (value !== undefined && !value.startsWith('-')) index += 1;
      continue;
    }
    merged.push(arg);
  }
  return [...merged, ...extras, ...preserved];
}

// --- Runtime capability detection ----------------------------------------------------

/**
 * The ROCm build a PyTorch wheel was compiled for, from its local version tag
 * (`2.14.0+rocm10.2.0` -> `[10, 2]`). Returns null when the wheel is not a ROCm build or the
 * tag is not numeric.
 */
export function parseRocmVersion(
  pytorchVersion: string | null | undefined,
): readonly [number, number] | null {
  if (typeof pytorchVersion !== 'string') return null;
  const match = /\+rocm(\d+)\.(\d+)/i.exec(pytorchVersion);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return [major, minor] as const;
}

/** The PyTorch release a version string names: `2.14.0+rocm10.2.0` -> `[2, 14]`. */
function parsePytorchVersion(pytorchVersion: string): readonly [number, number] | null {
  const match = /^(\d+)\.(\d+)/.exec(pytorchVersion.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return [major, minor] as const;
}

function atLeast(version: readonly [number, number], minimum: readonly [number, number]): boolean {
  return version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1]);
}

/**
 * Whether this PyTorch build can run ComfyUI's DynamicVRAM, mirroring the gate in ComfyUI's
 * `main.py`: PyTorch 2.8 or newer, and on AMD a ROCm 7.14 or newer wheel. Keeping the gate in
 * one place means the recommender only relaxes the memory flags when the runtime supports it.
 */
export function supportsDynamicVram(
  vendor: GpuVendor,
  pytorchVersion: string | null | undefined,
): boolean {
  if (typeof pytorchVersion !== 'string' || pytorchVersion.length === 0) return false;
  const torch = parsePytorchVersion(pytorchVersion);
  if (torch === null || !atLeast(torch, [2, 8])) return false;
  if (vendor === 'nvidia') return true;
  if (vendor === 'amd') {
    const rocm = parseRocmVersion(pytorchVersion);
    if (rocm === null) return false;
    return atLeast(rocm, [7, 14]);
  }
  return false;
}

// --- Model catalog -------------------------------------------------------------------

function catalogEntry(
  seed: CatalogSeed,
  installed: ReadonlySet<string>,
  recommended: ReadonlySet<string>,
  usableVramGb: number | null,
): ModelCatalogEntry {
  const isInstalled = installed.has(seed.filename);
  return {
    id: seed.id,
    role: seed.role,
    filename: seed.filename,
    label: seed.label,
    sizeGb: seed.sizeGb,
    tier: seed.tier,
    installed: isInstalled,
    recommended: recommended.has(seed.filename),
    fitsVram: usableVramGb !== null && seed.sizeGb <= usableVramGb,
    downloadUrl: `${H3_REPO_ROOT}/${seed.repoSubdir}/${seed.filename}`,
    targetSubdir: seed.targetSubdir,
    note: seed.note,
  };
}

// --- The recommendation --------------------------------------------------------------

export interface HardwareInput {
  /** VRAM in gibibytes, or null when nothing could measure it. */
  vramGb: number | null;
  ramTotalGb: number;
  vendor: GpuVendor;
  /** Model filenames ComfyUI or a local model folder reports, in any path form. */
  installedFiles?: readonly string[];
  /** The `torch.__version__` ComfyUI reports, which decides whether DynamicVRAM can run. */
  pytorchVersion?: string | null;
}

export interface HardwareRecommendation {
  recommended: RecommendedSettings;
  models: ModelCatalogEntry[];
}

function enhancerFileFor(mode: H3PromptEnhancer): string | null {
  if (mode === 'qwen3.8_27b') return ENHANCER_27B_FILE;
  if (mode === 'qwen3.5_9b') return ENHANCER_9B_FILE;
  return null;
}

function diffusionFileFor(variant: H3ModelVariant): string {
  return variant === 'w4a8' ? W4A8_FILE : INT8_DIFFUSION_FILE;
}

/**
 * The 32B encoder is the one phase that decides whether a 24 GB card offloads. NVFP4 (14.6 GB)
 * fits entirely in VRAM on every vendor, AMD included, and measured ~3.5x faster than the
 * 25.3 GB INT8 build which has to stream over PCIe. Only a 30 GB class card can hold INT8
 * outright, so that is where INT8 is preferred.
 */
function chooseTextEncoder(tier: HardwareTier, installed: ReadonlySet<string>): H3TextEncoderVariant {
  if (tier === 'extreme') {
    if (!installed.has(INT8_TEXT_ENCODER_FILE) && installed.has(NVFP4_TEXT_ENCODER_FILE)) {
      return 'nvfp4';
    }
    return 'int8';
  }
  if (installed.has(NVFP4_TEXT_ENCODER_FILE) || !installed.has(INT8_TEXT_ENCODER_FILE)) {
    return 'nvfp4';
  }
  // Only the INT8 file is on disk: point Apply at it rather than at a missing file.
  return 'int8';
}

function chooseEnhancer(tier: HardwareTier, installed: ReadonlySet<string>): H3PromptEnhancer {
  if (tier === 'entry') return installed.has(ENHANCER_9B_FILE) ? 'qwen3.5_9b' : 'off';
  if (tier === 'mid') return 'qwen3.5_9b';
  if (installed.has(ENHANCER_27B_FILE)) return 'qwen3.8_27b';
  if (installed.has(ENHANCER_9B_FILE)) return 'qwen3.5_9b';
  return 'qwen3.8_27b';
}

interface TierPlan {
  tierLabel: string;
  summary: string;
  width: number;
  height: number;
  modelVariant: H3ModelVariant;
  reserveVramGb: number;
  previewMethod: 'latent2rgb' | 'none';
  disablePinnedMemory: boolean;
  disableSmartMemory: boolean;
  cacheNone: boolean;
  lowvram: boolean;
  notes: string[];
}

function planFor(
  tier: HardwareTier,
  ramTotalGb: number,
  vramGb: number | null,
  dynamicVram: boolean,
): TierPlan {
  const vramText = vramGb === null ? 'an unknown amount of VRAM' : `${round1(vramGb)} GB of VRAM`;
  switch (tier) {
    case 'extreme':
      return {
        tierLabel: 'Extreme',
        summary: `With ${vramText} this machine can run the INT8 ConvRot build at 4K, keeping smart memory and pinned memory on.`,
        width: 4096,
        height: 4096,
        modelVariant: 'int8_convrot',
        reserveVramGb: 2,
        previewMethod: 'latent2rgb',
        disablePinnedMemory: false,
        disableSmartMemory: false,
        cacheNone: false,
        lowvram: false,
        notes: [
          'Default canvas is 4096 x 4096: lower it to 2048 x 2048 for quicker drafts.',
          'Smart memory and pinned memory stay enabled, so repeat runs load faster.',
          'Reserve 2 GB so the desktop and the browser keep a working framebuffer.',
        ],
      };
    case 'high': {
      const pinnedWarning = ramTotalGb < PINNED_MEMORY_MIN_RAM_GB;
      const pinnedNote = pinnedWarning
        ? `Pinned memory is disabled because this machine has only ${round1(ramTotalGb)} GB of RAM.`
        : `Pinned memory stays on: ${round1(ramTotalGb)} GB of RAM is enough to speed up PCIe loads.`;
      return {
        tierLabel: 'High',
        summary: `With ${vramText} the W4A8 build fills the card at 2048 x 2048, the sweet spot for 24 GB GPUs.`,
        width: 2048,
        height: 2048,
        modelVariant: 'w4a8',
        reserveVramGb: 4,
        previewMethod: 'latent2rgb',
        disablePinnedMemory: pinnedWarning,
        // On a DynamicVRAM capable build, smart memory and the prompt cache make repeat runs
        // cheap and keep 16 MP renders off the VRAM cliff, so they stay on.
        disableSmartMemory: !dynamicVram,
        cacheNone: !dynamicVram,
        lowvram: false,
        notes: dynamicVram
          ? [
              'W4A8 diffusion (11.7 GB) and NVFP4 text encoder (14.6 GB) each fit inside a 24 GB card with zero RAM offloading.',
              pinnedNote,
              'DynamicVRAM is active on this PyTorch build, so smart memory and caching stay enabled: repeat runs are faster and 4096 x 4096 (16 MP) stays safe on a 24 GB card.',
              'The default canvas stays at 2048 x 2048 for quick drafts; raise it to 4096 x 4096 for finals.',
            ]
          : [
              'W4A8 diffusion (11.7 GB) and NVFP4 text encoder (14.6 GB) each fit inside a 24 GB card with zero RAM offloading.',
              pinnedNote,
              'The 4 MP canvas is the largest that stays fast; 4096 x 4096 needs a 30 GB class card.',
            ],
      };
    }
    case 'mid':
      return {
        tierLabel: 'Mid',
        summary: `With ${vramText} the W4A8 build fits at 2048 x 2048 if smart memory and pinned memory stay off.`,
        width: 2048,
        height: 2048,
        modelVariant: 'w4a8',
        reserveVramGb: 3,
        previewMethod: 'latent2rgb',
        disablePinnedMemory: true,
        disableSmartMemory: true,
        cacheNone: true,
        lowvram: false,
        notes: [
          'The 9B prompt enhancer is the safe choice at this size; the 27B enhancer needs 24 GB.',
          'Smart memory and pinned memory are disabled so the weights fit the card.',
          'Reserve 3 GB for the desktop compositor.',
        ],
      };
    default:
      return {
        tierLabel: 'Entry',
        summary: `With ${vramText} H3 runs in low VRAM mode: 2048 x 2048 works, and 1024 x 1024 stays the fastest draft.`,
        width: 2048,
        height: 2048,
        modelVariant: 'w4a8',
        reserveVramGb: 2,
        previewMethod: 'latent2rgb',
        disablePinnedMemory: true,
        disableSmartMemory: true,
        cacheNone: true,
        lowvram: true,
        notes: [
          'Low VRAM mode offloads weights to system RAM between steps, so expect slower runs.',
          '1024 x 1024 is a draft size: use it to explore, then render the keeper at 2048 x 2048.',
          'The 32B text encoder is the largest file here; download the NVFP4 build where it is supported.',
        ],
      };
  }
}

/**
 * The heart of the Setup Wizard: what to run and how to start it, from measurements alone.
 * Nothing in here reads the machine, so the unit suite can pin every tier.
 */
export function recommendForHardware(input: HardwareInput): HardwareRecommendation {
  const vramGb = input.vramGb !== null && Number.isFinite(input.vramGb) ? input.vramGb : null;
  const ramTotalGb = Number.isFinite(input.ramTotalGb) && input.ramTotalGb > 0 ? input.ramTotalGb : 0;
  const vendor: GpuVendor = input.vendor;
  const installed = new Set(
    (input.installedFiles ?? []).map((filename) => path.basename(filename.trim())).filter((name) => name.length > 0),
  );

  const tier = tierFor(vramGb);
  const dynamicVram = supportsDynamicVram(vendor, input.pytorchVersion);
  const plan = planFor(tier, ramTotalGb, vramGb, dynamicVram);
  const textEncoderVariant = chooseTextEncoder(tier, installed);
  const promptEnhancer = chooseEnhancer(tier, installed);
  const launchArgs = buildLaunchArgs({
    reserveVramGb: plan.reserveVramGb,
    previewMethod: plan.previewMethod,
    disablePinnedMemory: plan.disablePinnedMemory,
    disableSmartMemory: plan.disableSmartMemory,
    cacheNone: plan.cacheNone,
    lowvram: plan.lowvram,
  });
  const launchEnv: Record<string, string> = vendor === 'amd' ? { [ROCM_AOTRITON_ENV]: '1' } : {};

  const notes = [...plan.notes];
  if (vendor === 'amd') {
    notes.push('ROCm: TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 is set so flash attention kernels are used.');
  }
  if (installed.size === 0) {
    notes.push('No H3 model file was found yet. Download the recommended files before the first run.');
  }
  if (tier !== 'extreme' && textEncoderVariant === 'int8') {
    notes.push(
      'Only the 25.3 GB INT8 text encoder is installed; downloading the 14.6 GB NVFP4 AWQ text encoder avoids RAM offloading.',
    );
  }
  if (vramGb === null) {
    notes.push('The GPU memory size could not be read, so this plan is the conservative one.');
  }

  // Step 2 always points at the encoder that should be on disk, even when Apply has to use
  // the INT8 fallback for now, so the NVFP4 upgrade stays visible.
  const recommendedEncoderFile =
    tier === 'extreme' ? INT8_TEXT_ENCODER_FILE : NVFP4_TEXT_ENCODER_FILE;
  const recommendedFiles = new Set<string>([
    diffusionFileFor(plan.modelVariant),
    recommendedEncoderFile,
    VAE_FILE,
  ]);
  const enhancerFile = enhancerFileFor(promptEnhancer);
  if (enhancerFile !== null) recommendedFiles.add(enhancerFile);

  const usableVramGb = vramGb === null ? null : Math.max(0, vramGb - plan.reserveVramGb);
  const models = H3_CATALOG.map((seed) => catalogEntry(seed, installed, recommendedFiles, usableVramGb));

  return {
    recommended: {
      tier,
      tierLabel: plan.tierLabel,
      summary: plan.summary,
      width: plan.width,
      height: plan.height,
      modelVariant: plan.modelVariant,
      textEncoderVariant,
      promptEnhancer,
      reserveVramGb: plan.reserveVramGb,
      previewMethod: plan.previewMethod,
      disablePinnedMemory: plan.disablePinnedMemory,
      disableSmartMemory: plan.disableSmartMemory,
      cacheNone: plan.cacheNone,
      lowvram: plan.lowvram,
      launchArgs,
      launchEnv,
      notes,
    },
    models,
  };
}

// --- Overrides the wizard may apply --------------------------------------------------

export interface ProfileOverrides {
  reserveVramGb?: number;
  previewMethod?: 'latent2rgb' | 'none';
  disablePinnedMemory?: boolean;
  /** true adds the ROCm flash attention env var, false removes it, absent keeps detection's choice. */
  rocmFlashAttention?: boolean;
}

/** Rebuilds a recommendation with the user's explicit overrides on top of it. */
export function applyProfileOverrides(
  recommended: RecommendedSettings,
  overrides: ProfileOverrides,
): RecommendedSettings {
  const reserveVramGb = overrides.reserveVramGb ?? recommended.reserveVramGb;
  const previewMethod = overrides.previewMethod ?? recommended.previewMethod;
  const disablePinnedMemory = overrides.disablePinnedMemory ?? recommended.disablePinnedMemory;
  const launchArgs = buildLaunchArgs({
    reserveVramGb,
    previewMethod,
    disablePinnedMemory,
    disableSmartMemory: recommended.disableSmartMemory,
    cacheNone: recommended.cacheNone,
    lowvram: recommended.lowvram,
  });
  const launchEnv: Record<string, string> = { ...recommended.launchEnv };
  if (overrides.rocmFlashAttention === true) launchEnv[ROCM_AOTRITON_ENV] = '1';
  if (overrides.rocmFlashAttention === false) delete launchEnv[ROCM_AOTRITON_ENV];
  return {
    ...recommended,
    reserveVramGb,
    previewMethod,
    disablePinnedMemory,
    launchArgs,
    launchEnv,
  };
}

// --- Probing: commands ---------------------------------------------------------------

/** Runs a command and returns its stdout, or null when it failed, hung or is missing. */
function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stdout = '';
    const childRef: { current: ChildProcess | null } = { current: null };
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (childRef.current !== null && value === null) {
        try {
          childRef.current.kill();
        } catch {
          // A process that already exited needs no kill.
        }
      }
      resolve(value);
    };
    try {
      const child = spawn(command, [...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      childRef.current = child;
      timer = setTimeout(() => finish(null), timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length >= MAX_COMMAND_OUTPUT_BYTES) return;
        stdout += chunk.slice(0, MAX_COMMAND_OUTPUT_BYTES - stdout.length);
      });
      child.on('error', () => finish(null));
      child.on('close', () => finish(stdout.trim().length > 0 ? stdout : null));
    } catch {
      finish(null);
    }
  });
}

/** nvidia-smi answers in well under a second and needs no WMI, so it is tried first. */
async function detectGpuWithNvidiaSmi(): Promise<DetectedGpu | null> {
  const output = await runCommand(
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    NVIDIA_SMI_TIMEOUT_MS,
  );
  if (output === null) return null;
  let best: DetectedGpu | null = null;
  for (const line of output.split(/\r?\n/)) {
    const [namePart, memoryPart] = line.split(',');
    const name = (namePart ?? '').trim();
    if (name.length === 0) continue;
    const memoryMiB = Number.parseFloat((memoryPart ?? '').trim());
    const vramGb = Number.isFinite(memoryMiB) && memoryMiB > 0 ? round1(memoryMiB / 1024) : null;
    if (best === null || (vramGb ?? 0) > (best.vramGb ?? 0)) {
      best = { name, vendor: vendorFromGpuName(name), vramGb, source: 'nvidia-smi' };
    }
  }
  return best;
}

/** Windows drivers that are not a real discrete GPU, so their VRAM must not win the scan. */
const VIRTUAL_GPU_PATTERN = /(microsoft basic|remote|rdp|parsec|virtual|idd|displaylink|spacedesk)/i;

function decodeRegistryString(value: string): string {
  const match = /^\[([0-9,\s]+)\]$/u.exec(value.trim());
  if (match === null || match[1] === undefined) return value.trim();
  const bytes: number[] = [];
  for (const part of match[1].split(',')) {
    const byte = Number.parseInt(part.trim(), 10);
    if (!Number.isFinite(byte) || byte < 0 || byte > 255) continue;
    if (byte === 0) break;
    bytes.push(byte);
  }
  try {
    return Buffer.from(bytes).toString('utf16le').trim();
  } catch {
    return value.trim();
  }
}

/**
 * The class registry key stores the real 64 bit VRAM size as HardwareInformation.qwMemorySize.
 * WMI's AdapterRAM saturates at 4 GB, which is why it is not used here.
 */
const WINDOWS_GPU_SCRIPT = [
  "$keys = @('HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}')",
  'foreach ($key in $keys) {',
  '  if (-not (Test-Path $key)) { continue }',
  '  Get-ChildItem $key -ErrorAction SilentlyContinue | ForEach-Object {',
  '    $entry = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  "    if ($entry.DriverDesc -and $entry.'HardwareInformation.qwMemorySize') {",
  "      Write-Output ('{0}|{1}|{2}' -f $entry.DriverDesc, $entry.'HardwareInformation.qwMemorySize', $_.PSChildName)",
  '    }',
  '  }',
  '}',
].join('; ');

async function detectGpuWithWindowsRegistry(): Promise<DetectedGpu | null> {
  const output = await runCommand(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_GPU_SCRIPT],
    WINDOWS_GPU_TIMEOUT_MS,
  );
  if (output === null) return null;
  let bestName = '';
  let bestBytes = 0;
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [namePart, memoryPart, indexPart] = line.split('|');
    const name = decodeRegistryString(namePart ?? '');
    if (name.length === 0 || VIRTUAL_GPU_PATTERN.test(name)) continue;
    const key = `${name}#${(indexPart ?? '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = Number.parseInt((memoryPart ?? '').trim(), 10);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestName = name;
    }
  }
  if (bestName.length === 0) return null;
  return {
    name: bestName,
    vendor: vendorFromGpuName(bestName),
    vramGb: roundGb(bestBytes),
    source: 'windows',
  };
}

async function detectGpuWithMacOs(): Promise<DetectedGpu | null> {
  const output = await runCommand('system_profiler', ['SPDisplaysDataType'], MACOS_GPU_TIMEOUT_MS);
  if (output === null) return null;
  const nameMatch = /Chipset Model:\s*(.+)/i.exec(output);
  const name = nameMatch?.[1]?.trim() ?? '';
  if (name.length === 0) return null;
  const vramMatch = /VRAM \(Total\):\s*([\d.]+)\s*(GB|MB)/i.exec(output);
  let vramGb: number | null = null;
  if (vramMatch !== null && vramMatch[1] !== undefined) {
    const amount = Number.parseFloat(vramMatch[1]);
    if (Number.isFinite(amount) && amount > 0) {
      vramGb = round1(vramMatch[2]?.toUpperCase() === 'MB' ? amount / 1024 : amount);
    }
  }
  return { name, vendor: vendorFromGpuName(name, 'mps'), vramGb, source: 'macos' };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

// --- Probing: ComfyUI ----------------------------------------------------------------

interface ComfyStats {
  version: string | null;
  pytorchVersion: string | null;
  gpu: DetectedGpu | null;
  ramTotalGb: number | null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseComfyStats(raw: unknown): ComfyStats | null {
  if (!isRecord(raw)) return null;
  const system = isRecord(raw['system']) ? raw['system'] : {};
  const devices = Array.isArray(raw['devices']) ? raw['devices'] : [];
  let device: Record<string, unknown> | null = null;
  let deviceVram = -1;
  for (const candidate of devices) {
    if (!isRecord(candidate)) continue;
    const type = typeof candidate['type'] === 'string' ? candidate['type'].toLowerCase() : '';
    if (type === 'cpu') continue;
    const vram = typeof candidate['vram_total'] === 'number' ? candidate['vram_total'] : 0;
    if (vram > deviceVram) {
      deviceVram = vram;
      device = candidate;
    }
  }
  const ramTotal =
    typeof system['ram_total'] === 'number' && system['ram_total'] > 0 ? system['ram_total'] : null;
  let gpu: DetectedGpu | null = null;
  if (device !== null) {
    const rawName = typeof device['name'] === 'string' ? device['name'] : '';
    const name = cleanGpuName(rawName);
    if (name.length > 0) {
      const type = typeof device['type'] === 'string' ? device['type'] : undefined;
      gpu = {
        name,
        vendor: vendorFromGpuName(name, type),
        vramGb: deviceVram > 0 ? roundGb(deviceVram) : null,
        source: 'comfyui',
      };
    }
  }
  return {
    version: readString(system, 'comfyui_version'),
    pytorchVersion: readString(system, 'pytorch_version'),
    gpu,
    ramTotalGb: ramTotal === null ? null : roundGb(ramTotal),
  };
}

/** Reads the filename choices a ComfyUI loader node offers: /object_info/<class>. */
async function fetchComfyFileList(
  baseUrl: string,
  nodeClass: string,
  inputName: string,
): Promise<string[]> {
  const raw = await fetchJson(`${baseUrl}/object_info/${nodeClass}`, COMFY_MODEL_LIST_TIMEOUT_MS);
  if (!isRecord(raw)) return [];
  const node = raw[nodeClass];
  if (!isRecord(node)) return [];
  const input = isRecord(node['input']) ? node['input'] : null;
  const required = input !== null && isRecord(input['required']) ? input['required'] : null;
  const field = required === null ? undefined : required[inputName];
  if (!Array.isArray(field)) return [];
  const choices = field[0];
  if (!Array.isArray(choices)) return [];
  const names: string[] = [];
  for (const choice of choices) {
    if (typeof choice === 'string' && choice.length > 0) names.push(choice);
  }
  return names;
}

// --- Probing: local model folders ----------------------------------------------------

interface ScannedModels {
  diffusion: string[];
  textEncoders: string[];
  vaes: string[];
}

type ModelCategory = keyof ScannedModels;

function emptyScan(): ScannedModels {
  return { diffusion: [], textEncoders: [], vaes: [] };
}

/** The ComfyUI subfolders worth scanning, and where their files belong in the catalog. */
const LOCAL_MODEL_SUBDIRS: readonly (readonly [string, ModelCategory])[] = [
  [path.join('models', 'diffusion_models'), 'diffusion'],
  [path.join('models', 'unet'), 'diffusion'],
  [path.join('models', 'text_encoders'), 'textEncoders'],
  [path.join('models', 'clip'), 'textEncoders'],
  [path.join('models', 'vae'), 'vaes'],
];

function categoryForPath(value: string): ModelCategory | null {
  const lower = value.toLowerCase();
  if (lower.includes('vae')) return 'vaes';
  if (lower.includes('text_encoders') || lower.includes('clip') || lower.includes('text-encoder')) {
    return 'textEncoders';
  }
  if (lower.includes('diffusion') || lower.includes('unet')) return 'diffusion';
  return null;
}

async function listModelFiles(directory: string, depth: number, into: string[]): Promise<void> {
  if (into.length >= MAX_SCANNED_FILES) return;
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (into.length >= MAX_SCANNED_FILES) return;
    if (entry.isDirectory()) {
      if (depth > 0) await listModelFiles(path.join(directory, entry.name), depth - 1, into);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    into.push(entry.name);
  }
}

/**
 * Reads extra_model_paths.yaml far enough to find the folders ComfyUI loads models from. A
 * full YAML parser is not worth a dependency here: only path values that name a model
 * category are kept, and unreadable files are simply ignored.
 */
function parseExtraModelPaths(raw: string, cwd: string): { directory: string; category: ModelCategory }[] {
  const found: { directory: string; category: ModelCategory }[] = [];
  let basePath = cwd;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/u, '');
    if (line.trim().length === 0) continue;
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon).trim();
    let value = colon === -1 ? line.trim() : line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'base_path' || key.toLowerCase() === 'basePath') {
      value = value.replace(/^['"]|['"]$/gu, '');
      if (value.length > 0) basePath = path.resolve(cwd, value);
      continue;
    }
    if (value.length === 0 || value === '|' || value === '>') continue;
    value = value.replace(/^['"]|['"]$/gu, '');
    if (value.length === 0) continue;
    const category = categoryForPath(value) ?? categoryForPath(key);
    if (category === null) continue;
    found.push({ directory: path.resolve(basePath, value), category });
  }
  return found;
}

async function scanLocalModels(cwd: string | null): Promise<ScannedModels> {
  const scan = emptyScan();
  const targets: { directory: string; category: ModelCategory }[] = [];
  if (cwd !== null) {
    for (const [subdir, category] of LOCAL_MODEL_SUBDIRS) {
      targets.push({ directory: path.join(cwd, subdir), category });
    }
    try {
      const raw = await readFile(path.join(cwd, 'extra_model_paths.yaml'), 'utf8');
      targets.push(...parseExtraModelPaths(raw, cwd));
    } catch {
      // No extra paths file, or one we cannot read: the default folders still count.
    }
  }
  for (const target of targets) {
    const files: string[] = [];
    await listModelFiles(target.directory, MAX_SCAN_DEPTH, files);
    if (files.length === 0) continue;
    scan[target.category].push(...files);
  }
  return scan;
}

// --- Detection -----------------------------------------------------------------------

export interface ProviderSource {
  list(): ProviderConfig[];
}

function normalizeBaseUrl(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  const trimmed = baseUrl.trim().replace(/\/+$/u, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** The ComfyUI provider to probe: an enabled one first, then any configured one. */
function comfyProviderOf(providers: readonly ProviderConfig[]): ProviderConfig | null {
  const comfy = providers.filter((config) => config.kind === 'comfyui');
  return comfy.find((config) => config.enabled !== false) ?? comfy[0] ?? null;
}

function mergeFiles(...lists: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const name of list) {
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

function osName(): string {
  const type = os.type();
  const release = os.release();
  return release.length > 0 ? `${type} ${release}` : type;
}

/**
 * One hardware detection run. Every step degrades instead of failing: ComfyUI may be off,
 * the driver query may be missing, and the machine may have no model files at all.
 */
export async function detectSystemProfile(settings: ProviderSource): Promise<SystemProfile> {
  const providers = settings.list();
  const comfy = comfyProviderOf(providers);
  const baseUrl = comfy === null ? null : normalizeBaseUrl(comfy.baseUrl);

  const [statsRaw, unets, clips, vaes] = await Promise.all([
    baseUrl === null ? Promise.resolve(null) : fetchJson(`${baseUrl}/system_stats`, COMFY_STATS_TIMEOUT_MS),
    baseUrl === null ? Promise.resolve<string[]>([]) : fetchComfyFileList(baseUrl, 'UNETLoader', 'unet_name'),
    baseUrl === null ? Promise.resolve<string[]>([]) : fetchComfyFileList(baseUrl, 'CLIPLoader', 'clip_name'),
    baseUrl === null ? Promise.resolve<string[]>([]) : fetchComfyFileList(baseUrl, 'VAELoader', 'vae_name'),
  ]);
  const stats = parseComfyStats(statsRaw);

  const cwd = comfy?.launch?.cwd !== undefined && comfy.launch.cwd.trim().length > 0 ? comfy.launch.cwd : null;
  const scanned = await scanLocalModels(cwd);

  const ramTotalGb = roundGb(os.totalmem());
  const ramFreeGb = roundGb(os.freemem());

  let gpu: DetectedGpu | null = stats?.gpu ?? null;
  if (gpu === null) gpu = await detectGpuWithNvidiaSmi();
  if (gpu === null && process.platform === 'win32') gpu = await detectGpuWithWindowsRegistry();
  if (gpu === null && process.platform === 'darwin') gpu = await detectGpuWithMacOs();
  if (gpu !== null && gpu.vramGb === null && gpu.vendor === 'apple') {
    // Apple Silicon has no separate VRAM: the GPU shares system memory with the CPU.
    gpu = { ...gpu, vramGb: ramTotalGb > 0 ? round1(ramTotalGb * 0.7) : null };
  }
  if (gpu === null) {
    gpu = { name: 'Unknown GPU', vendor: 'unknown', vramGb: null, source: 'unknown' };
  }

  const detectedModels = {
    diffusion: mergeFiles(unets, scanned.diffusion),
    textEncoders: mergeFiles(clips, scanned.textEncoders),
    vaes: mergeFiles(vaes, scanned.vaes),
  };
  const installedFiles = mergeFiles(
    detectedModels.diffusion,
    detectedModels.textEncoders,
    detectedModels.vaes,
  );

  const { recommended, models } = recommendForHardware({
    vramGb: gpu.vramGb,
    ramTotalGb: stats?.ramTotalGb ?? ramTotalGb,
    vendor: gpu.vendor,
    installedFiles,
    pytorchVersion: stats?.pytorchVersion ?? null,
  });

  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() ?? 'Unknown CPU';

  return {
    detectedAt: new Date().toISOString(),
    os: osName(),
    arch: process.arch,
    cpuModel: cpuModel.length > 0 ? cpuModel : 'Unknown CPU',
    cpuCores: cpus.length,
    ramTotalGb,
    ramFreeGb,
    gpu,
    comfyui: {
      reachable: stats !== null,
      baseUrl,
      version: stats?.version ?? null,
      pytorchVersion: stats?.pytorchVersion ?? null,
      detectedModels,
    },
    models,
    recommended,
    currentLaunch:
      comfy?.launch === undefined
        ? null
        : { args: [...(comfy.launch.args ?? [])], env: { ...(comfy.launch.env ?? {}) } },
  };
}
