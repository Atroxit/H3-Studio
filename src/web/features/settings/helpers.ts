// Pure helpers for the Settings screen. The provider form, the launch env map and the
// hardware copy are all string in, string out, so nothing here needs a DOM to be reviewed.

import type {
  DetectedGpu,
  GpuVendor,
  HardwareTier,
  H3ModelVariant,
  H3PromptEnhancer,
  H3TextEncoderVariant,
  ModelCatalogEntry,
  ProviderCapabilities,
  ProviderConfig,
  ProviderKind,
  SystemProfile,
} from '../../../core/types';

export interface ProviderKindMeta {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  summary: string;
}

/** Mirrors defaultProviderConfigs in docs/api-contract.md, in the order Settings lists them. */
export const PROVIDER_KINDS: readonly ProviderKindMeta[] = [
  {
    kind: 'mock',
    label: 'Mock (offline)',
    defaultBaseUrl: 'mock://local',
    summary: 'An offline stand-in. No model and no network, so it is the quickest way to check the studio works.',
  },
  {
    kind: 'comfyui',
    label: 'ComfyUI',
    defaultBaseUrl: 'http://127.0.0.1:8188',
    summary: 'A local ComfyUI server, addressed by its HTTP port.',
  },
  {
    kind: 'openai-images',
    label: 'SGLang or vLLM image server',
    defaultBaseUrl: 'http://127.0.0.1:30000',
    summary: 'A server that accepts the OpenAI image generation request shape.',
  },
  {
    kind: 'a1111',
    label: 'Automatic1111 or Forge',
    defaultBaseUrl: 'http://127.0.0.1:7860',
    summary: 'The Automatic1111 or Forge web UI, addressed by its HTTP port.',
  },
];

/** The names the ComfyUI adapter substitutes inside string values of a workflow graph. */
export const WORKFLOW_PLACEHOLDERS = [
  'prompt',
  'negativePrompt',
  'width',
  'height',
  'seed',
  'steps',
  'cfg',
  'ckpt',
  'batch',
] as const;

/**
 * MiniMax H3 image generation is fixed: six sampling steps, guidance at 1, and a
 * negative prompt is rejected. The presets name the canvas sizes that matter, so a
 * user never has to guess which one is a draft and which one is the recommendation.
 */
export const H3_IMAGE_CAPABILITIES: ProviderCapabilities = {
  seed: true,
  negativePrompt: false,
  adjustableSteps: false,
  fixedSteps: 6,
  guidance: false,
  maxReferenceImages: 4,
  maxBatch: 4,
  arbitrarySize: true,
  sizeMultiple: 32,
  presets: [
    { id: '2048x2048', label: '2048×2048 (4 MP · Recommended)', width: 2048, height: 2048 },
    { id: '1024x1024', label: '1024×1024 (Draft · low anatomy)', width: 1024, height: 1024 },
    { id: '4096x4096', label: '4096×4096 (16 MP · Hero)', width: 4096, height: 4096 },
    { id: '4736x3552', label: '4736×3552 (4:3)', width: 4736, height: 3552 },
    { id: '3552x4736', label: '3552×4736 (3:4)', width: 3552, height: 4736 },
    { id: '5472x3072', label: '5472×3072 (16:9)', width: 5472, height: 3072 },
    { id: '3072x5472', label: '3072×5472 (9:16)', width: 3072, height: 5472 },
  ],
  outputFormats: ['png'],
  streamingProgress: true,
  notes: [
    'H3 fixes 6 steps and guidance 1, and it rejects a negative prompt.',
    'H3 alters an existing image from up to 4 reference images, named in the prompt as <Picture 1> and so on.',
    'Batches above one run as sequential single image prompts.',
  ],
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

export function findProvider(providers: ProviderConfig[], kind: ProviderKind): ProviderConfig | null {
  return providers.find((candidate) => candidate.kind === kind) ?? null;
}

const FALLBACK_KIND: ProviderKindMeta = {
  kind: 'comfyui',
  label: 'ComfyUI',
  defaultBaseUrl: 'http://127.0.0.1:8188',
  summary: 'A local ComfyUI server, addressed by its HTTP port.',
};

export function providerKindMeta(kind: ProviderKind): ProviderKindMeta {
  return PROVIDER_KINDS.find((meta) => meta.kind === kind) ?? FALLBACK_KIND;
}

/** The saved graph, or an empty string: the adapter falls back to its own graph. */
export function savedWorkflowTemplate(existing: ProviderConfig | null): string {
  const raw = existing?.options?.['workflowTemplate'];
  return typeof raw === 'string' ? raw : '';
}

export function savedCapabilityOverride(existing: ProviderConfig | null): Record<string, unknown> | null {
  const raw = existing?.options?.['capabilities'];
  return isRecord(raw) ? raw : null;
}

/** The saved ComfyUI timeout in seconds, with the adapter default of 900 s. */
export function savedTimeoutSeconds(existing: ProviderConfig | null): string {
  const raw = existing?.options?.['timeoutMs'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? String(raw / 1000) : '900';
}

export function sameJson(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Arguments are edited as text: space separated, one per line, or a JSON array. */
export function formatLaunchArguments(args: readonly string[] | undefined): string {
  if (args === undefined || args.length === 0) return '';
  // A single argument that itself contains a space would be torn apart by a space split,
  // so that case is written as the JSON array the parser also accepts.
  return args.some((arg) => /\s/.test(arg)) ? JSON.stringify(args) : args.join(' ');
}

/** Null when a JSON array is malformed, so the field can say so instead of guessing. */
export function parseLaunchArguments(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const args: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') return null;
      args.push(entry);
    }
    return args;
  }
  if (trimmed.includes('\n')) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return trimmed.split(/\s+/);
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedEnv {
  env: Record<string, string>;
  /** The first line that is not KEY=VALUE, or null when the whole map parsed. */
  problem: string | null;
}

/**
 * Reads an env map written as KEY=VALUE lines. Blank lines and # comments are skipped, a
 * value may contain '=' and may be quoted, and an invalid key is reported rather than
 * handed to spawn.
 */
export function parseEnvLines(text: string): ParsedEnv {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) {
      return { env: {}, problem: `"${line}" is not KEY=VALUE.` };
    }
    const key = line.slice(0, equals).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      return { env: {}, problem: `"${key}" is not a valid environment variable name.` };
    }
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && /^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    env[key] = value;
  }
  return { env, problem: null };
}

/** The inverse of parseEnvLines: one KEY=VALUE line per variable, sorted by key. */
export function formatEnvLines(env: Record<string, string> | undefined): string {
  if (env === undefined) return '';
  return Object.keys(env)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${env[key] ?? ''}`)
    .join('\n');
}

/**
 * Checks the text against the ComfyUI API format the adapter reads: an object of
 * node id to node, and every node carries a string class_type and an object inputs.
 * Empty is allowed, and nothing here ever throws: the first problem is returned.
 */
export function workflowTemplateProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the text does not parse';
    return `This is not valid JSON yet. ${detail}`;
  }
  if (!isRecord(parsed)) {
    return 'The graph must be a JSON object of node id to node, not a list or a single value.';
  }
  for (const [nodeId, node] of Object.entries(parsed)) {
    if (!isRecord(node)) return `Node ${nodeId} must be an object with class_type and inputs.`;
    const classType = node['class_type'];
    if (typeof classType !== 'string' || classType.length === 0) {
      return `Node ${nodeId} needs a class_type string, like "KSampler".`;
    }
    if (!isRecord(node['inputs'])) return `Node ${nodeId} needs an inputs object.`;
  }
  return null;
}

/** A short description of a saved override, read from the fields the studio can name. */
export function describeCapabilityOverride(override: Record<string, unknown>): string {
  const parts: string[] = [];
  const fixedSteps = override['fixedSteps'];
  if (typeof fixedSteps === 'number') parts.push(`${fixedSteps} fixed steps`);
  if (override['negativePrompt'] === false) parts.push('negative prompt off');
  if (override['guidance'] === false) parts.push('guidance off');
  const presets = override['presets'];
  if (Array.isArray(presets)) {
    parts.push(presets.length === 1 ? '1 size preset' : `${presets.length} size presets`);
  }
  if (parts.length === 0) {
    const count = Object.keys(override).length;
    return `Capability override active: ${count === 1 ? '1 field' : `${count} fields`} set.`;
  }
  return `Capability override active: ${parts.join(', ')}.`;
}

// --- Hardware copy -------------------------------------------------------------------

const TIER_LABELS: Readonly<Record<HardwareTier, string>> = {
  extreme: 'Extreme',
  high: 'High',
  mid: 'Mid',
  entry: 'Entry',
};

const TIER_HEADLINES: Readonly<Record<HardwareTier, string>> = {
  extreme: 'Extreme workstation',
  high: 'High-VRAM workstation',
  mid: 'Mid-range workstation',
  entry: 'Entry system',
};

const VENDOR_LABELS: Readonly<Record<GpuVendor, string>> = {
  amd: 'AMD ROCm',
  nvidia: 'NVIDIA CUDA',
  apple: 'Apple Metal',
  intel: 'Intel',
  unknown: 'CPU',
};

/** "24 GB", one decimal below ten, a whole number above it. */
export function formatGigabytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return 'Unknown';
  return value < 10 ? `${Math.round(value * 10) / 10} GB` : `${Math.round(value)} GB`;
}

export function vendorLabel(gpu: DetectedGpu): string {
  return VENDOR_LABELS[gpu.vendor];
}

/** The vendor words every GPU name repeats, so a pill can stay short. */
export function gpuShortName(gpu: DetectedGpu): string {
  if (gpu.vendor === 'unknown') return 'No GPU detected';
  return gpu.name.replace(/^(amd|nvidia|intel)\s+/iu, '').trim() || gpu.name;
}

export function tierLabel(tier: HardwareTier): string {
  return TIER_LABELS[tier];
}

export function tierHeadline(tier: HardwareTier, vramGb: number | null): string {
  const base = TIER_HEADLINES[tier];
  return vramGb === null ? base : `${base} (${formatGigabytes(vramGb)} VRAM)`;
}

/** The one line the Settings header shows: GPU, VRAM, RAM and tier, all measured. */
export function hardwarePillText(profile: SystemProfile): string {
  const parts: string[] = [gpuShortName(profile.gpu)];
  if (profile.gpu.vramGb !== null) parts.push(`${formatGigabytes(profile.gpu.vramGb)} VRAM`);
  parts.push(`${formatGigabytes(profile.ramTotalGb)} RAM`);
  parts.push(`${tierLabel(profile.recommended.tier)} Tier`);
  return parts.join(' · ');
}

export function modelPrecisionLabel(variant: H3ModelVariant): string {
  return variant === 'w4a8' ? 'Fast W4A8' : 'Max quality INT8 ConvRot';
}

export function textEncoderLabel(variant: H3TextEncoderVariant): string {
  return variant === 'nvfp4' ? 'Fast NVFP4 AWQ' : 'Max quality INT8 ConvRot';
}

export function promptEnhancerLabel(mode: H3PromptEnhancer): string {
  if (mode === 'qwen3.8_27b') return 'Best Qwen3.8 27B';
  if (mode === 'qwen3.5_9b') return 'Fast Qwen3.5 9B';
  return 'Off';
}

export function sizeLabel(width: number, height: number): string {
  return `${width} × ${height}`;
}

/** The catalog rows grouped in the order the wizard lists them. */
export const MODEL_ROLE_ORDER = ['diffusion', 'text_encoder', 'prompt_enhancer', 'vae'] as const;

export const MODEL_ROLE_LABELS: Readonly<Record<ModelCatalogEntry['role'], string>> = {
  diffusion: 'Diffusion model',
  text_encoder: 'Text encoder',
  prompt_enhancer: 'Prompt enhancer',
  vae: 'VAE',
};

export function modelsByRole(models: readonly ModelCatalogEntry[]): { role: ModelCatalogEntry['role']; entries: ModelCatalogEntry[] }[] {
  return MODEL_ROLE_ORDER.map((role) => ({
    role,
    entries: models.filter((entry) => entry.role === role),
  })).filter((group) => group.entries.length > 0);
}

export function installedModelCount(models: readonly ModelCatalogEntry[]): number {
  return models.filter((entry) => entry.installed).length;
}
