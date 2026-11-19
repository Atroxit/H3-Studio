import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_CLIENT_ID = 'h3-studio';
const MAX_BATCH = 4;
const MAX_POLL_PERCENT = 95;
const MAX_RANDOM_SEED = 2_147_483_647;
const REFERENCE_CONDITIONING_CLASSES: readonly string[] = ['MiniMaxH3ImageConditioning', 'PH3ImageConditioning'];
const REFERENCE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const DEFAULT_REFERENCE_MIME = 'image/png';

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

/** A model with fixed sampling declares its step count in options.capabilities.fixedSteps. */
function fixedStepsFromOptions(options: Record<string, unknown>): number | null {
  const capabilities = options['capabilities'];
  if (!isRecord(capabilities)) return null;
  const fixedSteps = capabilities['fixedSteps'];
  return typeof fixedSteps === 'number' && Number.isInteger(fixedSteps) && fixedSteps > 0 ? fixedSteps : null;
}

function templateHasBatchPlaceholder(template: WorkflowGraph): boolean {
  return JSON.stringify(template).includes('{{batch}}');
}

function nodeClassType(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const classType = node['class_type'];
  return typeof classType === 'string' ? classType : null;
}

/** True when the graph has the conditioning node that accepts reference image slots. */
function templateSupportsReferences(template: WorkflowGraph): boolean {
  return Object.values(template).some((node) => {
    const classType = nodeClassType(node);
    return classType !== null && REFERENCE_CONDITIONING_CLASSES.includes(classType);
  });
}

/**
 * Uploads one local file to ComfyUI's input directory and returns the name the graph
 * refers to. ComfyUI answers with a name and an optional subfolder, and a LoadImage
 * node addresses the two joined.
 */
async function uploadReferenceImage(
  baseUrl: string,
  filePath: string,
  signal: AbortSignal,
): Promise<string> {
  const bytes = await readFile(filePath);
  const mimeType = REFERENCE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? DEFAULT_REFERENCE_MIME;
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mimeType }), path.basename(filePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const response = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal });
  const text = await response.text();
  if (!response.ok) {
    throw new ComfyUIError(`ComfyUI POST /upload/image failed with HTTP ${response.status}`, 'http');
  }
  const payload = parseJson(text);
  const name = isRecord(payload) ? payload['name'] : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    throw new ComfyUIError('ComfyUI POST /upload/image returned no image name', 'bad_response');
  }
  const subfolder = isRecord(payload) ? payload['subfolder'] : undefined;
  return typeof subfolder === 'string' && subfolder.length > 0 ? `${subfolder}/${name}` : name;
}

/**
 * Adds one LoadImage node per uploaded reference and wires it to the MiniMax H3 image
 * conditioning node, which takes references as images.image_1, images.image_2 and so on.
 * The graph is cloned: a template from options is shared across requests and runs.
 */
export function attachReferenceImages(
  graph: Record<string, unknown>,
  uploadedNames: readonly string[],
): Record<string, unknown> {
  if (uploadedNames.length === 0) return graph;

  const nodeIds = Object.keys(graph);
  const conditioningIds = nodeIds.filter((nodeId) => {
    const classType = nodeClassType(graph[nodeId]);
    return classType !== null && REFERENCE_CONDITIONING_CLASSES.includes(classType);
  });
  if (conditioningIds.length === 0) {
    throw new ComfyUIError(
      'This ComfyUI workflow does not have a reference image conditioning node',
      'unsupported_references',
    );
  }

  const cloned: Record<string, unknown> = {};
  for (const nodeId of nodeIds) {
    const node = graph[nodeId];
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    cloned[nodeId] = isRecord(node) && isRecord(inputs) ? { ...node, inputs: { ...inputs } } : node;
  }

  const taken = new Set(nodeIds);
  const loadNodeIds = uploadedNames.map((uploadedName, position) => {
    let counter = position + 1;
    let nodeId = `ref_image_${counter}`;
    while (taken.has(nodeId)) {
      counter += 1;
      nodeId = `ref_image_${counter}`;
    }
    taken.add(nodeId);
    cloned[nodeId] = { class_type: 'LoadImage', inputs: { image: uploadedName, upload: 'image' } };
    return nodeId;
  });

  for (const nodeId of conditioningIds) {
    const node = cloned[nodeId];
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    if (!isRecord(node) || !isRecord(inputs)) continue;
    loadNodeIds.forEach((loadNodeId, index) => {
      inputs[`images.image_${index + 1}`] = [loadNodeId, 0];
    });
  }

  return cloned;
}

/**
 * H3 reads a reference image from a <Picture N> token in the prompt. A plain alteration
 * instruction names no picture, so the first one is added; a prompt that already names a
 * picture is left exactly as the user wrote it.
 */
export function formatReferencePrompt(
  prompt: string,
  template: WorkflowGraph,
  hasReferences: boolean,
): string {
  if (!hasReferences) return prompt;
  const h3Conditioning = Object.values(template).some(
    (node) => nodeClassType(node) === 'MiniMaxH3ImageConditioning',
  );
  if (!h3Conditioning) return prompt;
  if (/<Picture\s+\d+>/i.test(prompt)) return prompt;
  return `Edit <Picture 1>. ${prompt.trim()}`;
}

function buildReplacements(
  request: GenerationRequest,
  options: Record<string, unknown>,
  config: ProviderConfig,
  seed: number,
): Record<string, Replacement> {
  const checkpoint = readString(options, 'ckptName') ?? config.model ?? DEFAULT_CHECKPOINT;
  // A retry from /api/batches/:id/retry carries no steps, so a fixed step model must
  // still be sampled at its own step count instead of the generic default.
  const steps = request.steps ?? fixedStepsFromOptions(options) ?? DEFAULT_STEPS;
  return {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? '',
    width: request.width,
    height: request.height,
    seed,
    steps,
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

/** What one /history poll says about a prompt. */
type HistoryState =
  | { state: 'pending' }
  | { state: 'error'; message: string }
  | { state: 'done'; images: ComfyImageRef[] };

interface ExecutionErrorDetails {
  nodeType?: string;
  nodeId?: string;
  exceptionMessage?: string;
}

function imagesFromEntry(entry: unknown): ComfyImageRef[] {
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

/**
 * ComfyUI reports a runtime failure through history, not through POST /prompt: the entry
 * carries status_str "error" and a messages list of [eventType, payload] tuples. The
 * execution_error tuple names the node and the exception, which is what the user needs.
 */
function executionErrorDetails(status: Record<string, unknown>): ExecutionErrorDetails | null {
  const messages = status['messages'];
  if (!Array.isArray(messages)) return null;
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const eventType = entry[0];
    const payload = entry[1];
    if (eventType !== 'execution_error' || !isRecord(payload)) continue;
    const details: ExecutionErrorDetails = {};
    const nodeType = payload['node_type'];
    const nodeId = payload['node_id'];
    const exception = payload['exception_message'];
    if (typeof nodeType === 'string' && nodeType.length > 0) details.nodeType = nodeType;
    if (typeof nodeId === 'string' && nodeId.length > 0) details.nodeId = nodeId;
    if (typeof nodeId === 'number' && Number.isFinite(nodeId)) details.nodeId = String(nodeId);
    if (typeof exception === 'string' && exception.trim().length > 0) details.exceptionMessage = exception.trim();
    return details;
  }
  return null;
}

function executionErrorMessage(promptId: string, details: ExecutionErrorDetails | null): string {
  const fallback = `ComfyUI reported an execution error for prompt ${promptId}`;
  if (details === null) return fallback;
  const where = details.nodeType ?? (details.nodeId === undefined ? '' : `node ${details.nodeId}`);
  const nodeLabel =
    where.length === 0
      ? ''
      : details.nodeType !== undefined && details.nodeId !== undefined
        ? `${where} (node ${details.nodeId})`
        : where;
  const parts: string[] = [];
  if (nodeLabel.length > 0) parts.push(nodeLabel);
  if (details.exceptionMessage !== undefined) parts.push(details.exceptionMessage);
  if (parts.length === 0) return fallback;
  return `ComfyUI execution error in ${parts.join(': ')}`;
}

function historyState(history: unknown, promptId: string): HistoryState {
  if (!isRecord(history) || !Object.hasOwn(history, promptId)) return { state: 'pending' };
  const entry = history[promptId];
  const status = isRecord(entry) ? entry['status'] : undefined;
  if (isRecord(status) && status['status_str'] === 'error') {
    return { state: 'error', message: executionErrorMessage(promptId, executionErrorDetails(status)) };
  }
  return { state: 'done', images: imagesFromEntry(entry) };
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

async function waitForHistory(
  baseUrl: string,
  promptId: string,
  pollOptions: PollOptions,
  ctx: GenerationContext,
  index: number,
): Promise<HistoryState> {
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
    ctx.onEvent({ type: 'progress', index, stage: 'sampling', percent: pollPercent(polls) });
    const response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new ComfyUIError(`ComfyUI GET /history failed with HTTP ${response.status}`, 'http');
    }
    const state = historyState(parseJson(await response.text()), promptId);
    if (state.state !== 'pending') return state;
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

  /** Fetches every image of one finished prompt, emitting each item as it settles. */
  async function itemFromImage(
    index: number,
    image: ComfyImageRef,
    seed: number,
    startedMs: number,
    ctx: GenerationContext,
  ): Promise<GeneratedItem> {
    try {
      const bytes = await fetchImageBytes(baseUrl, image, ctx.signal);
      return { index, ok: true, bytes, seed, durationMs: Date.now() - startedMs };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const message = `ComfyUI image ${image.filename} could not be fetched: ${errorMessage(error)}`;
      return failedItem(index, message, 'image_fetch', true);
    }
  }

  /**
   * A template without {{batch}} runs one prompt per slot, sequentially. Everything already
   * finished is kept: a late slot failure is one retryable item, not a lost batch.
   */
  async function generateSlot(
    template: WorkflowGraph,
    request: GenerationRequest,
    slot: number,
    slotSeed: number,
    uploadedRefs: readonly string[],
    ctx: GenerationContext,
  ): Promise<GeneratedItem> {
    const slotStartedMs = Date.now();
    let promptId: string;
    try {
      const graph = attachReferenceImages(
        substituteWorkflow(
          template,
          buildReplacements({ ...request, count: 1 }, options, config, slotSeed),
        ),
        uploadedRefs,
      );
      promptId = await queuePrompt(baseUrl, clientId, graph, ctx.signal);
    } catch (error) {
      throwIfAborted(ctx.signal);
      if (!(error instanceof ComfyUIError)) throw error;
      return failedItem(slot, error.message, error.code, error.code !== 'invalid_template');
    }
    let images: ComfyImageRef[];
    try {
      const history = await waitForHistory(baseUrl, promptId, pollOptions, ctx, slot);
      if (history.state === 'error') return failedItem(slot, history.message, 'execution_error', true);
      images = history.state === 'done' ? history.images : [];
    } catch (error) {
      throwIfAborted(ctx.signal);
      if (!(error instanceof ComfyUIError)) throw error;
      return failedItem(slot, error.message, error.code, error.code !== 'invalid_template');
    }
    const image = images[0];
    if (image === undefined) {
      return failedItem(
        slot,
        `ComfyUI finished prompt ${promptId} without returning an image`,
        'no_images',
        true,
      );
    }
    return itemFromImage(slot, image, slotSeed, slotStartedMs, ctx);
  }

  async function generate(
    request: GenerationRequest,
    ctx: GenerationContext,
  ): Promise<GenerationOutcome> {
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    throwIfAborted(ctx.signal);
    const seed = resolveSeed(request.seed);
    const template = templateFromOptions(options);
    const items: GeneratedItem[] = [];
    const outcome = (): GenerationOutcome => ({
      providerId: config.id,
      items,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });

    // References need the H3 conditioning node, so a graph without one is rejected before
    // anything is uploaded: a wrong template should not leave files on the server.
    const referencePaths = request.referenceIds ?? [];
    let uploadedRefs: string[] = [];
    if (referencePaths.length > 0) {
      if (!templateSupportsReferences(template)) {
        throw new ComfyUIError(
          'This ComfyUI workflow does not have a reference image conditioning node',
          'unsupported_references',
        );
      }
      for (const filePath of referencePaths) {
        uploadedRefs.push(await uploadReferenceImage(baseUrl, filePath, ctx.signal));
      }
    }
    const effectiveRequest =
      uploadedRefs.length > 0
        ? { ...request, prompt: formatReferencePrompt(request.prompt, template, true) }
        : request;

    if (request.count > 1 && !templateHasBatchPlaceholder(template)) {
      for (let slot = 0; slot < request.count; slot += 1) {
        throwIfAborted(ctx.signal);
        const slotSeed = seed + slot;
        const item = await generateSlot(template, effectiveRequest, slot, slotSeed, uploadedRefs, ctx);
        items.push(item);
        ctx.onEvent({ type: 'item', index: slot, item });
      }
      return outcome();
    }

    const graph = attachReferenceImages(
      substituteWorkflow(template, buildReplacements(effectiveRequest, options, config, seed)),
      uploadedRefs,
    );
    const promptId = await queuePrompt(baseUrl, clientId, graph, ctx.signal);
    const history = await waitForHistory(baseUrl, promptId, pollOptions, ctx, 0);
    if (history.state === 'error') {
      const item = failedItem(0, history.message, 'execution_error', true);
      items.push(item);
      ctx.onEvent({ type: 'item', index: 0, item });
      return outcome();
    }
    if (history.state === 'done') {
      for (const [index, image] of history.images.entries()) {
        const item = await itemFromImage(index, image, seed, startedMs, ctx);
        items.push(item);
        ctx.onEvent({ type: 'item', index, item });
      }
    }
    if (items.length === 0) {
      const item = failedItem(0, `ComfyUI finished prompt ${promptId} without returning an image`, 'no_images', false);
      items.push(item);
      ctx.onEvent({ type: 'item', index: 0, item });
    }
    return outcome();
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
