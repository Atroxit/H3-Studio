import type {
  GeneratedItem,
  GenerationContext,
  GenerationOutcome,
  GenerationRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
  SizePreset,
} from '../types';

/** One node of a ComfyUI API format workflow. */
export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** API format workflow: node id to node. */
export type WorkflowGraph = Record<string, WorkflowNode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ComfyUIError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ComfyUIError';
    this.code = code;
  }
}

const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7;
const DEFAULT_CHECKPOINT = 'v1-5-pruned-emaonly.safetensors';
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CLIENT_ID = 'h3-studio';
const MAX_BATCH = 4;
const MAX_POLL_PERCENT = 95;
const MAX_RANDOM_SEED = 2_147_483_647;

/** A standard text to image pipeline. Placeholders are replaced per request. */
export const defaultWorkflowTemplate: WorkflowGraph = {
  '3': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: '{{ckpt}}' },
  },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '{{prompt}}', clip: ['3', 1] },
  },
  '5': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '{{negativePrompt}}', clip: ['3', 1] },
  },
  '6': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch}}' },
  },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['3', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  },
  '8': {
    class_type: 'VAEDecode',
    inputs: { samples: ['7', 0], vae: ['3', 2] },
  },
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'h3-studio', images: ['8', 0] },
  },
};

type Replacement = string | number;

const CAPABILITY_FIELDS: readonly string[] = [
  'seed',
  'negativePrompt',
  'adjustableSteps',
  'fixedSteps',
  'guidance',
  'maxReferenceImages',
  'maxBatch',
  'arbitrarySize',
  'sizeMultiple',
  'presets',
  'outputFormats',
  'streamingProgress',
  'notes',
];

const PRESET_FIELDS: readonly string[] = ['id', 'label', 'width', 'height'];

/** A standard text to image graph can do all of this. */
function baseCapabilities(): ProviderCapabilities {
  return {
    seed: true,
    negativePrompt: true,
    adjustableSteps: true,
    fixedSteps: null,
    guidance: true,
    maxReferenceImages: 0,
    maxBatch: MAX_BATCH,
    arbitrarySize: true,
    sizeMultiple: 8,
    presets: [
      { id: '512x512', label: '512 x 512', width: 512, height: 512 },
      { id: '768x768', label: '768 x 768', width: 768, height: 768 },
      { id: '832x1216', label: '832 x 1216', width: 832, height: 1216 },
      { id: '1216x832', label: '1216 x 832', width: 1216, height: 832 },
    ],
    outputFormats: ['png'],
    streamingProgress: true,
    notes: [
      'Reference images need a different graph, so this adapter does not accept them.',
      'Progress is polled from the ComfyUI history endpoint, not streamed by the server.',
    ],
  };
}

function invalidCapability(field: string, expected: string): ComfyUIError {
  return new ComfyUIError(`ComfyUI options.capabilities.${field} must be ${expected}`, 'invalid_capabilities');
}

function readBooleanCapability(field: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw invalidCapability(field, 'a boolean');
}

function readPositiveIntegerCapability(field: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw invalidCapability(field, 'a positive integer');
}

function readReferenceCountCapability(field: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw invalidCapability(field, 'a non negative integer');
}

function readFixedStepsCapability(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw invalidCapability('fixedSteps', 'a positive integer or null');
}

function readStringListCapability(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidCapability(field, 'an array of strings');
  const entries: unknown[] = value;
  const strings: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw invalidCapability(field, 'an array of strings');
    strings.push(entry);
  }
  return strings;
}

function readPresetsCapability(value: unknown): SizePreset[] {
  if (!Array.isArray(value)) {
    throw invalidCapability('presets', 'an array of size presets with id, label, width and height');
  }
  const entries: unknown[] = value;
  return entries.map((entry, index) => {
    const field = `presets[${index}]`;
    if (!isRecord(entry)) throw invalidCapability(field, 'an object with id, label, width and height');
    for (const key of Object.keys(entry)) {
      if (!PRESET_FIELDS.includes(key)) {
        throw new ComfyUIError(
          `ComfyUI options.capabilities.${field}.${key} is not a size preset field. Use id, label, width or height`,
          'invalid_capabilities',
        );
      }
    }
    const id = entry['id'];
    const label = entry['label'];
    if (typeof id !== 'string' || id.length === 0) throw invalidCapability(`${field}.id`, 'a non empty string');
    if (typeof label !== 'string' || label.length === 0) {
      throw invalidCapability(`${field}.label`, 'a non empty string');
    }
    return {
      id,
      label,
      width: readPositiveIntegerCapability(`${field}.width`, entry['width']),
      height: readPositiveIntegerCapability(`${field}.height`, entry['height']),
    };
  });
}

/** Applies one override field, or throws when the name or the shape is not one this contract knows. */
function assignCapability(override: Partial<ProviderCapabilities>, field: string, value: unknown): void {
  switch (field) {
    case 'seed':
    case 'negativePrompt':
    case 'adjustableSteps':
    case 'guidance':
    case 'arbitrarySize':
    case 'streamingProgress':
      override[field] = readBooleanCapability(field, value);
      return;
    case 'fixedSteps':
      override.fixedSteps = readFixedStepsCapability(value);
      return;
    case 'maxReferenceImages':
      override.maxReferenceImages = readReferenceCountCapability(field, value);
      return;
    case 'maxBatch':
    case 'sizeMultiple':
      override[field] = readPositiveIntegerCapability(field, value);
      return;
    case 'presets':
      override.presets = readPresetsCapability(value);
      return;
    case 'outputFormats':
      override.outputFormats = readStringListCapability(field, value);
      return;
    case 'notes':
      override.notes = readStringListCapability(field, value);
      return;
    default:
      throw new ComfyUIError(
        `ComfyUI options.capabilities.${field} is not a capability. Use one of: ${CAPABILITY_FIELDS.join(', ')}`,
        'invalid_capabilities',
      );
  }
}

function readCapabilityOverride(options: Record<string, unknown>): Partial<ProviderCapabilities> {
  const raw = options['capabilities'];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new ComfyUIError(
      'ComfyUI options.capabilities must be an object of capability fields',
      'invalid_capabilities',
    );
  }
  const override: Partial<ProviderCapabilities> = {};
  for (const [field, value] of Object.entries(raw)) {
    assignCapability(override, field, value);
  }
  return override;
}

/**
 * The capabilities of the model this provider serves: the text to image defaults with
 * options.capabilities merged over them field by field. A typo or a wrong type throws, so
 * the inspector never quietly renders controls the served model does not have.
 */
function comfyuiCapabilities(options: Record<string, unknown>): ProviderCapabilities {
  return { ...baseCapabilities(), ...readCapabilityOverride(options) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error('ComfyUI generation was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function readPositiveNumber(options: Record<string, unknown>, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toGraph(value: unknown, source: string): WorkflowGraph {
  if (!isRecord(value)) {
    throw new ComfyUIError(`${source} must be a JSON object of node id to node`, 'invalid_template');
  }
  const graph: WorkflowGraph = {};
  for (const [nodeId, node] of Object.entries(value)) {
    const classType = isRecord(node) ? node['class_type'] : undefined;
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    if (typeof classType !== 'string' || !isRecord(inputs)) {
      throw new ComfyUIError(`${source} node ${nodeId} needs class_type and inputs`, 'invalid_template');
    }
    graph[nodeId] = { class_type: classType, inputs };
  }
  return graph;
}

function templateFromOptions(options: Record<string, unknown>): WorkflowGraph {
  const raw = options['workflowTemplate'];
  if (raw === undefined || raw === null || raw === '') return defaultWorkflowTemplate;
  if (typeof raw !== 'string') {
    throw new ComfyUIError('ComfyUI options.workflowTemplate must be a JSON string', 'invalid_template');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ComfyUIError(
      `ComfyUI options.workflowTemplate is not valid JSON: ${errorMessage(error)}`,
      'invalid_template',
    );
  }
  return toGraph(parsed, 'ComfyUI options.workflowTemplate');
}

function substituteString(text: string, replacements: Record<string, Replacement>): Replacement {
  const exact = /^\{\{(\w+)\}\}$/.exec(text);
  if (exact) {
    const key = exact[1] ?? '';
    const value = replacements[key];
    if (typeof value === 'number' || typeof value === 'string') return value;
    return text;
  }
  let result = text;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(`{{${key}}}`).join(String(value));
  }
  return result;
}

function substituteValue(value: unknown, replacements: Record<string, Replacement>): unknown {
  if (typeof value === 'string') return substituteString(value, replacements);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, replacements));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = substituteValue(item, replacements);
    }
    return result;
  }
  return value;
}

function substituteWorkflow(
  template: WorkflowGraph,
  replacements: Record<string, Replacement>,
): Record<string, unknown> {
  const result = substituteValue(template, replacements);
  if (!isRecord(result)) {
    throw new ComfyUIError('ComfyUI workflow substitution did not produce an object', 'invalid_template');
  }
  return result;
}

function resolveSeed(seed: number | undefined): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed);
  return Math.floor(Math.random() * MAX_RANDOM_SEED);
}

function clampBatch(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.min(MAX_BATCH, Math.max(1, Math.trunc(count)));
}

function buildReplacements(
  request: GenerationRequest,
  options: Record<string, unknown>,
  config: ProviderConfig,
  seed: number,
): Record<string, Replacement> {
  const checkpoint = readString(options, 'ckptName') ?? config.model ?? DEFAULT_CHECKPOINT;
  return {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? '',
    width: request.width,
    height: request.height,
    seed,
    steps: request.steps ?? DEFAULT_STEPS,
    cfg: request.guidance ?? DEFAULT_CFG,
    ckpt: checkpoint,
    batch: clampBatch(request.count),
  };
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ComfyUIError(`ComfyUI sent a response that is not JSON: ${errorMessage(error)}`, 'bad_response');
  }
}

function describeNodeErrorItem(item: unknown): string {
  if (typeof item === 'string') return item;
  if (isRecord(item)) {
    const parts = [item['message'], item['details']].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) return parts.join(' ');
  }
  const json = JSON.stringify(item);
  return typeof json === 'string' ? json : String(item);
}

function describeNodeError(entry: unknown): string {
  if (isRecord(entry) && Array.isArray(entry['errors']) && entry['errors'].length > 0) {
    return entry['errors'].map(describeNodeErrorItem).join(', ');
  }
  return describeNodeErrorItem(entry);
}

function nodeError(promptId: string | undefined, nodeErrors: unknown): ComfyUIError {
  const details = isRecord(nodeErrors)
    ? Object.entries(nodeErrors)
        .map(([nodeId, entry]) => `node ${nodeId}: ${describeNodeError(entry)}`)
        .join('; ')
    : describeNodeError(nodeErrors);
  const where = promptId === undefined ? '' : ` for prompt ${promptId}`;
  return new ComfyUIError(`ComfyUI rejected the workflow${where} (${details})`, 'node_error');
}

function hasNodeErrors(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

async function queuePrompt(
  baseUrl: string,
  clientId: string,
  graph: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal,
  });
  const payload = parseJson(await response.text());
  const promptId = isRecord(payload) && typeof payload['prompt_id'] === 'string' ? payload['prompt_id'] : undefined;
  const nodeErrors = isRecord(payload) ? payload['node_errors'] : undefined;
  if (hasNodeErrors(nodeErrors)) throw nodeError(promptId, nodeErrors);
  if (!response.ok) {
    throw new ComfyUIError(`ComfyUI POST /prompt failed with HTTP ${response.status}`, 'http');
  }
  if (promptId === undefined) {
    throw new ComfyUIError('ComfyUI POST /prompt returned no prompt_id', 'bad_response');
  }
  return promptId;
}

interface ComfyImageRef {
  filename: string;
  subfolder: string;
}

/** Null means the history entry is not ready yet. */
function imagesFromHistory(history: unknown, promptId: string): ComfyImageRef[] | null {
  if (!isRecord(history) || !Object.hasOwn(history, promptId)) return null;
  const entry = history[promptId];
  const outputs = isRecord(entry) ? entry['outputs'] : undefined;
  if (!isRecord(outputs)) return [];
  const images: ComfyImageRef[] = [];
  for (const output of Object.values(outputs)) {
    if (!isRecord(output) || !Array.isArray(output['images'])) continue;
    for (const image of output['images']) {
      if (!isRecord(image) || typeof image['filename'] !== 'string') continue;
      const subfolder = typeof image['subfolder'] === 'string' ? image['subfolder'] : '';
      images.push({ filename: image['filename'], subfolder });
    }
  }
  return images;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pollPercent(polls: number): number {
  return Math.min(MAX_POLL_PERCENT, polls * 10);
}

interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

async function waitForImages(
  baseUrl: string,
  promptId: string,
  pollOptions: PollOptions,
  ctx: GenerationContext,
): Promise<ComfyImageRef[]> {
  const deadline = Date.now() + pollOptions.timeoutMs;
  let polls = 0;
  for (;;) {
    throwIfAborted(ctx.signal);
    if (polls > 0 && Date.now() >= deadline) {
      throw new ComfyUIError(
        `ComfyUI timed out after ${pollOptions.timeoutMs} ms waiting for prompt ${promptId} (${polls} polls)`,
        'timeout',
      );
    }
    polls += 1;
    ctx.onEvent({ type: 'progress', index: 0, stage: 'sampling', percent: pollPercent(polls) });
    const response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new ComfyUIError(`ComfyUI GET /history failed with HTTP ${response.status}`, 'http');
    }
    const images = imagesFromHistory(parseJson(await response.text()), promptId);
    if (images !== null) return images;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ComfyUIError(
        `ComfyUI timed out after ${pollOptions.timeoutMs} ms waiting for prompt ${promptId} (${polls} polls)`,
        'timeout',
      );
    }
    await sleep(Math.min(pollOptions.intervalMs, remaining), ctx.signal);
  }
}

async function fetchImageBytes(
  baseUrl: string,
  image: ComfyImageRef,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: 'output',
  });
  const response = await fetch(`${baseUrl}/view?${query.toString()}`, { signal });
  if (!response.ok) {
    throw new ComfyUIError(`ComfyUI view ${image.filename} failed with HTTP ${response.status}`, 'http');
  }
  return new Uint8Array(await response.arrayBuffer());
}

function failedItem(index: number, message: string, code: string, retryable: boolean): GeneratedItem {
  return { index, ok: false, failure: { message, code, retryable } };
}

async function health(baseUrl: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`);
    if (!response.ok) {
      return { ok: false, detail: `ComfyUI system_stats responded with HTTP ${response.status}` };
    }
    await response.arrayBuffer();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `ComfyUI is not reachable: ${errorMessage(error)}` };
  }
}

export function createComfyUIAdapter(config: ProviderConfig): ProviderAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const options = config.options ?? {};
  const clientId = readString(options, 'clientId') ?? DEFAULT_CLIENT_ID;
  const pollOptions: PollOptions = {
    intervalMs: readPositiveNumber(options, 'pollIntervalMs', DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: readPositiveNumber(options, 'timeoutMs', DEFAULT_TIMEOUT_MS),
  };

  async function generate(
    request: GenerationRequest,
    ctx: GenerationContext,
  ): Promise<GenerationOutcome> {
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    throwIfAborted(ctx.signal);
    const seed = resolveSeed(request.seed);
    const template = templateFromOptions(options);
    const graph = substituteWorkflow(template, buildReplacements(request, options, config, seed));
    const promptId = await queuePrompt(baseUrl, clientId, graph, ctx.signal);
    const images = await waitForImages(baseUrl, promptId, pollOptions, ctx);
    const items: GeneratedItem[] = [];
    for (const [index, image] of images.entries()) {
      try {
        const bytes = await fetchImageBytes(baseUrl, image, ctx.signal);
        items.push({ index, ok: true, bytes, seed, durationMs: Date.now() - startedMs });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const message = `ComfyUI image ${image.filename} could not be fetched: ${errorMessage(error)}`;
        items.push(failedItem(index, message, 'image_fetch', true));
      }
    }
    if (items.length === 0) {
      items.push(failedItem(0, `ComfyUI finished prompt ${promptId} without returning an image`, 'no_images', false));
    }
    return {
      providerId: config.id,
      items,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  return {
    id: config.id,
    label: config.label,
    kind: 'comfyui',
    health: () => health(baseUrl),
    capabilities: async () => comfyuiCapabilities(options),
    generate,
  };
}
