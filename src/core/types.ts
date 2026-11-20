// The contract every provider adapter and every surface shares.
// One rule: nothing here may assume MiniMax. H3 is the reference provider, not the only one.

export type ProviderKind = 'mock' | 'comfyui' | 'openai-images' | 'a1111';

/** The diffusion model a request runs: the fast 11.7 GB weights or the 19.5 GB INT8 build. */
export type H3ModelVariant = 'w4a8' | 'int8_convrot';

/** Which prompt enhancer the graph runs, when its template offers one. */
export type H3PromptEnhancer = 'off' | 'qwen3.5_9b' | 'qwen3.8_27b';

/** Which quantisation of the 32B Qwen3-VL H3 text encoder the graph loads. */
export type H3TextEncoderVariant = 'nvfp4' | 'int8';

export interface SizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** What a provider can actually do. The UI renders controls from this, never from assumptions. */
export interface ProviderCapabilities {
  seed: boolean;
  negativePrompt: boolean;
  adjustableSteps: boolean;
  fixedSteps: number | null;
  guidance: boolean;
  maxReferenceImages: number;
  maxBatch: number;
  arbitrarySize: boolean;
  sizeMultiple: number;
  presets: SizePreset[];
  outputFormats: string[];
  streamingProgress: boolean;
  notes: string[];
}

/** The groups the prompt theme picker sorts tags into. */
export type PromptThemeCategory = 'style' | 'mood' | 'lighting' | 'camera' | 'custom';

/** One preset prompt chunk the composer can append to the prompt with a single tag. */
export interface PromptTheme {
  id: string;
  name: string;
  category: PromptThemeCategory;
  /** Prompt text chunk appended when this theme tag is active. */
  snippet: string;
  /** True for shipped defaults; false or omitted for user-created themes. */
  builtIn?: boolean;
}

/** A theme as it was applied to one batch, so the record reads without the theme store. */
export interface AppliedPromptTheme {
  id: string;
  name: string;
}

export interface ReferenceImage {
  id: string;
  filename: string;
  mimeType: string;
  /** Path on disk. Adapters read it; nothing else needs to. */
  path: string;
}

export interface GenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  referenceIds?: string[];
  /** Runs the graph's prompt enhancer, when the graph has one and no reference image is in play. */
  enhancePrompt?: boolean;
  /** Which enhancer CLIP the graph loads: the fast 9B build or the dedicated 27B H3 PE. */
  promptEnhancer?: H3PromptEnhancer;
  /** Picks the H3 diffusion model when the graph loads one of the official variants. */
  modelVariant?: H3ModelVariant;
  /** Picks the H3 32B text encoder build: the NVFP4 AWQ file or the INT8 ConvRot file. */
  textEncoderVariant?: H3TextEncoderVariant;
  extra?: Record<string, unknown>;
}

export interface ItemFailure {
  message: string;
  code?: string;
  retryable: boolean;
}

export interface GeneratedItem {
  index: number;
  ok: boolean;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  seed?: number;
  durationMs?: number;
  failure?: ItemFailure;
  revisedPrompt?: string;
}

export type GenerationEvent =
  | {
      type: 'progress';
      index: number;
      stage: string;
      /** A human readable line about the node doing the work right now. */
      detail?: string;
      step?: number;
      totalSteps?: number;
      percent?: number;
      /** True when ComfyUI reported cached nodes, so the pipeline is already warm. */
      cached?: boolean;
    }
  /** A low resolution frame streamed while ComfyUI denoises. Never persisted. */
  | { type: 'preview'; index: number; dataUrl: string }
  | { type: 'item'; index: number; item: GeneratedItem };

export interface GenerationContext {
  signal: AbortSignal;
  onEvent: (event: GenerationEvent) => void;
}

export interface GenerationOutcome {
  providerId: string;
  items: GeneratedItem[];
  startedAt: string;
  finishedAt: string;
  /** Prompt as rewritten by the provider, when it does that. Shown back to the user, never silently applied. */
  revisedPrompt?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  health(): Promise<{ ok: boolean; detail?: string }>;
  capabilities(): Promise<ProviderCapabilities>;
  generate(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationOutcome>;
}

/** How the studio starts a local backend it manages, instead of asking the user to. */
export interface ProviderLaunchConfig {
  enabled: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  /** How long to wait for the backend to answer its health check. Defaults to 60 s. */
  waitForHealthMs?: number;
  /**
   * Extra environment variables for the spawned process, merged over the studio's own
   * environment. This is how runtime switches reach the backend, for example
   * TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 on an AMD card.
   */
  env?: Record<string, string>;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** A provider the studio may use. Absent means enabled. False keeps it in settings but out of the way. */
  enabled?: boolean;
  /** A process the studio spawns on boot and stops on shutdown. */
  launch?: ProviderLaunchConfig;
  options?: Record<string, unknown>;
}

export type BatchStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';

export interface StoredImage {
  id: string;
  batchId: string;
  index: number;
  /** Filename inside the library directory. Bytes are always on disk: no provider URL is trusted to survive. */
  filename: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  providerId: string;
  createdAt: string;
  /** Wall clock time the provider spent producing this image, when it reports one. */
  durationMs?: number;
}

export interface BatchFailure {
  index: number;
  message: string;
  code?: string;
  retryable: boolean;
}

export interface BatchRecord {
  id: string;
  providerId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  requested: number;
  status: BatchStatus;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  seed?: number;
  revisedPrompt?: string;
  /** The H3 diffusion model this batch ran, when the provider picks one. */
  modelVariant?: H3ModelVariant;
  /** Whether the graph's prompt enhancer ran for this batch. */
  enhancePrompt?: boolean;
  /** Which enhancer CLIP the graph loaded for this batch. */
  promptEnhancer?: H3PromptEnhancer;
  /** The H3 32B text encoder build this batch ran, when the provider picks one. */
  textEncoderVariant?: H3TextEncoderVariant;
  /** The library image this batch altered, when it is an alteration. */
  sourceImageId?: string;
  /** Original prompt text before active prompt theme chunks were appended. */
  basePrompt?: string;
  /** Prompt themes appended when this batch was created. */
  appliedThemes?: AppliedPromptTheme[];
  images: StoredImage[];
  failures: BatchFailure[];
}

export interface Preset {
  id: string;
  name: string;
  prompt: string;
  width: number;
  height: number;
  count: number;
  createdAt: string;
}

export interface LibraryIndex {
  version: 1;
  batches: BatchRecord[];
  presets: Preset[];
}

/**
 * Hardware detection and auto-tuning. The Setup Wizard reads one SystemProfile and can apply
 * the recommended launch configuration to the ComfyUI provider, so nothing here assumes a
 * particular GPU vendor or model file is present.
 */
export type GpuVendor = 'amd' | 'nvidia' | 'apple' | 'intel' | 'unknown';

/** How much the machine can hold: the tiers the recommender picks between. */
export type HardwareTier = 'extreme' | 'high' | 'mid' | 'entry';

/** One graphics adapter, as far as it can be trusted. vramGb is null when nothing knew it. */
export interface DetectedGpu {
  name: string;
  vendor: GpuVendor;
  vramGb: number | null;
  source: 'comfyui' | 'nvidia-smi' | 'windows' | 'macos' | 'unknown';
}

/** One downloadable H3 file, with what the wizard needs to say about it. */
export interface ModelCatalogEntry {
  id: string;
  role: 'diffusion' | 'text_encoder' | 'prompt_enhancer' | 'vae';
  filename: string;
  label: string;
  sizeGb: number;
  /** fast loads quickly, max is the highest quality build, required is a fixed dependency. */
  tier: 'fast' | 'max' | 'required';
  installed: boolean;
  recommended: boolean;
  fitsVram: boolean;
  downloadUrl: string;
  targetSubdir: string;
  note: string;
}

/** What the wizard would write into the provider, plus the settings the UI applies. */
export interface RecommendedSettings {
  tier: HardwareTier;
  tierLabel: string;
  summary: string;
  width: number;
  height: number;
  modelVariant: H3ModelVariant;
  textEncoderVariant: H3TextEncoderVariant;
  promptEnhancer: H3PromptEnhancer;
  reserveVramGb: number;
  previewMethod: 'latent2rgb' | 'none';
  disablePinnedMemory: boolean;
  disableSmartMemory: boolean;
  cacheNone: boolean;
  lowvram: boolean;
  launchArgs: string[];
  launchEnv: Record<string, string>;
  notes: string[];
}

/** Everything one hardware detection run learned, in the shape the Setup Wizard renders. */
export interface SystemProfile {
  detectedAt: string;
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalGb: number;
  ramFreeGb: number;
  gpu: DetectedGpu;
  comfyui: {
    reachable: boolean;
    baseUrl: string | null;
    version: string | null;
    pytorchVersion: string | null;
    detectedModels: { diffusion: string[]; textEncoders: string[]; vaes: string[] };
  };
  models: ModelCatalogEntry[];
  recommended: RecommendedSettings;
  currentLaunch: { args: string[]; env: Record<string, string> } | null;
}
