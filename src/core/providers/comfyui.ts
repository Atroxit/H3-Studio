import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GeneratedItem,
  GenerationContext,
  GenerationOutcome,
  GenerationRequest,
  H3ModelVariant,
  H3PromptEnhancer,
  H3TextEncoderVariant,
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
const INTERRUPT_TIMEOUT_MS = 2000;
const DEFAULT_CLIENT_ID = 'h3-studio';
const MAX_BATCH = 4;
const MAX_POLL_PERCENT = 95;
const MAX_RANDOM_SEED = 2_147_483_647;
/** ComfyUI binary event ids on /ws: 1 is a preview frame, 4 the same frame plus metadata. */
const PREVIEW_IMAGE_EVENT = 1;
const PREVIEW_IMAGE_WITH_METADATA_EVENT = 4;
/** A preview larger than this is a mistake or an attack, not a denoise frame. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_MIME_BY_FORMAT: Readonly<Record<number, string>> = {
  1: 'image/jpeg',
  2: 'image/png',
};
/**
 * ComfyUI preview frames are a small binary protocol: a uint32 event id, then either a
 * format id or a metadata length, then the encoded image bytes. This is pure so the
 * socket handler and the unit suite can share it.
 */
export interface BinaryPreview {
  promptId?: string;
  nodeId?: string;
  dataUrl: string;
}

export function parseBinaryPreview(data: ArrayBuffer | Uint8Array): BinaryPreview | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventType = view.getUint32(0, false);

  if (eventType === PREVIEW_IMAGE_EVENT) {
    const mime = PREVIEW_MIME_BY_FORMAT[view.getUint32(4, false)];
    if (mime === undefined) return null;
    return encodePreview(mime, bytes.subarray(8));
  }

  if (eventType === PREVIEW_IMAGE_WITH_METADATA_EVENT) {
    const metaLength = view.getUint32(4, false);
    if (8 + metaLength >= bytes.byteLength) return null;
    let metadata: unknown;
    try {
      metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + metaLength))) as unknown;
    } catch {
      return null;
    }
    const record = isRecord(metadata) ? metadata : {};
    const mime = readMetadataString(record, 'image_type') ?? 'image/jpeg';
    const preview = encodePreview(mime, bytes.subarray(8 + metaLength));
    if (preview === null) return null;
    const promptId = readMetadataString(record, 'prompt_id');
    const nodeId = readMetadataString(record, 'node_id');
    return {
      ...preview,
      ...(promptId === undefined ? {} : { promptId }),
      ...(nodeId === undefined ? {} : { nodeId }),
    };
  }

  return null;
}

function encodePreview(mime: string, imageBytes: Uint8Array): BinaryPreview | null {
  if (imageBytes.byteLength === 0 || imageBytes.byteLength > MAX_PREVIEW_BYTES) return null;
  if (!mime.startsWith('image/')) return null;
  return { dataUrl: `data:${mime};base64,${Buffer.from(imageBytes).toString('base64')}` };
}

function readMetadataString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
const REFERENCE_CONDITIONING_CLASSES: readonly string[] = ['MiniMaxH3ImageConditioning', 'PH3ImageConditioning'];
const REFERENCE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const DEFAULT_REFERENCE_MIME = 'image/png';
const H3_UNET_BY_VARIANT: Readonly<Record<H3ModelVariant, string>> = {
  w4a8: 'minimax_h3_image_pruned_w4a8.safetensors',
  int8_convrot: 'minimax_h3_image_pruned_int8_convrot.safetensors',
};
const H3_UNET_NAMES: ReadonlySet<string> = new Set(Object.values(H3_UNET_BY_VARIANT));
/** The two official H3 prompt enhancer CLIP files, by the mode a request names. */
const H3_ENHANCER_BY_MODE: Readonly<Record<Exclude<H3PromptEnhancer, 'off'>, string>> = {
  'qwen3.5_9b': 'qwen3.5_9b_w4a8_gptq.safetensors',
  'qwen3.8_27b': 'qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors',
};
const H3_ENHANCER_NAMES: ReadonlySet<string> = new Set(Object.values(H3_ENHANCER_BY_MODE));
/**
 * The two official 32B text encoder builds, by the mode a request names. Only a CLIPLoader
 * that already loads one of these is retargeted, so the enhancer CLIPs (9B and 27B) stay.
 */
const H3_TEXT_ENCODER_BY_VARIANT: Readonly<Record<H3TextEncoderVariant, string>> = {
  nvfp4: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  int8: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
};
const H3_TEXT_ENCODER_NAMES: ReadonlySet<string> = new Set(Object.values(H3_TEXT_ENCODER_BY_VARIANT));
/**
 * A tight token budget per enhancer. Both models answer with the JSON caption directly, so
 * neither spends 25-35 s in a private thinking section: 1024 tokens cover the caption, where
 * the template's 8192 was sometimes minutes of runaway thinking.
 */
const H3_ENHANCER_TOKEN_BUDGET: Readonly<
  Record<Exclude<H3PromptEnhancer, 'off'>, { readonly thinking: boolean; readonly maxLength: number }>
> = {
  'qwen3.5_9b': { thinking: false, maxLength: 1024 },
  'qwen3.8_27b': { thinking: false, maxLength: 1024 },
};
/** The template sentence that asks the enhancer to reason before answering. */
const THINKING_FIRST_SENTENCE = 'Reason in the thinking section first.';
/**
 * Class names that make up the image pipeline. An enhancer subgraph that reaches any of them
 * would drag a diffusion model into RAM beside the enhancer, so extraction refuses it.
 */
const ENHANCER_SUBGRAPH_EXCLUDED_CLASSES: readonly string[] = [
  'UNETLoader',
  'VAELoader',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'ConditioningZeroOut',
  ...REFERENCE_CONDITIONING_CLASSES,
];

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
 * The enhancer a request really asks for. The named mode wins; the older boolean is kept
 * for callers that predate it. References do not bypass the enhancer: the edit expander
 * is vision aware, so it reads the attached pictures instead of the user's words alone.
 */
export function effectivePromptEnhancer(
  enhancePrompt: boolean | undefined,
  promptEnhancer?: H3PromptEnhancer,
): H3PromptEnhancer {
  return promptEnhancer ?? (enhancePrompt === true ? 'qwen3.5_9b' : 'off');
}

/**
 * The task prompt the enhancer runs when the request attaches reference pictures. ComfyUI's
 * official image edit workflow gives the expander the input images, so this template asks
 * the vision model to read every <Picture N> and write the finished image instead of only
 * restating the text. StringReplace still swaps {input text} for the user's instruction.
 */
export const H3_EDIT_EXPANSION_PROMPT: string = `You are an image-edit prompt writer for MiniMax H3. You are given one or more input pictures, labeled <Picture 1>, <Picture 2>, and so on, plus a short user instruction.

input_text: {input text}

Read every attached picture carefully, then write the finished image.

Rules:
1. Inspect each picture: its subject, pose, framing, viewpoint, materials, colors, lighting, environment, and any visible text or graphic content.
2. Follow the user's instruction literally, then expand it into ONE dense, vivid English description of the intended finished image.
3. Say explicitly which element comes from which picture. Name <Picture 1>, <Picture 2>, and so on for every subject, identity, style, setting, palette, or lighting you carry over. When the instruction combines pictures, describe the combination: which subject keeps its identity, which picture supplies the background, which supplies the style, and how they are composited into one coherent frame.
4. Describe the full background and environment, lighting direction and quality, time of day, weather, surface materials, color palette, camera angle and lens, depth of field, and overall mood in concrete visual detail. Never leave a plain or blank background unless the user explicitly asks for one.
5. Preserve every hard fact from the instruction: named entities, text, counts, colors, style, and layout. Add plausible detail but never contradict the user.
6. Choose the aspect ratio from this list: 1:1, 5:4, 4:3, 3:2, 16:9, 21:9, 4:5, 3:4, 2:3, 9:16. Keep the source pictures' ratio when the instruction changes content rather than canvas; otherwise pick the ratio the described subject needs.

Reply with exactly one JSON object and nothing else: no markdown fence, no thinking tags, no commentary.

{"expanded_caption":"...","aspect_ratio":"..."}

expanded_caption must be one valid JSON string holding the description from the rules above. Every ASCII double quotation mark inside it must be serialized as the JSON escape sequence \\". Keep aspect_ratio to exactly one allowed ratio string. Do not add or omit keys.`;

/** The 1-based picture number of every reference image link in the conditioning nodes. */
function referenceImageLinks(graph: Record<string, unknown>): Map<number, string> {
  const links = new Map<number, string>();
  for (const node of Object.values(graph)) {
    const classType = nodeClassType(node);
    if (classType === null || !REFERENCE_CONDITIONING_CLASSES.includes(classType)) continue;
    for (const [key, value] of Object.entries(nodeInputs(node))) {
      const match = /^images\.image_(\d+)$/.exec(key);
      if (match === null) continue;
      const source = linkSource(value);
      if (source === null) continue;
      const index = Number(match[1]);
      if (!links.has(index)) links.set(index, source);
    }
  }
  return links;
}

/**
 * Makes the prompt enhancer vision aware for reference images and alterations: every
 * uploaded LoadImage is wired into TextGenerateV2 as images.image1, images.image2, ... (the
 * field names ComfyUI's nodes_textgen.py declares, without the underscore the conditioning
 * node uses), and the expander's task prompt becomes the reference & edit expansion prompt.
 * The graph is cloned: a template from options is shared across requests and runs.
 */
export function applyReferenceVision(
  graph: Record<string, unknown>,
  referenceCount: number,
): Record<string, unknown> {
  const links = referenceImageLinks(graph);
  const textGenerateIds = nodeIdsOfClassType(graph, 'TextGenerateV2');
  if (links.size === 0 || textGenerateIds.length === 0) return graph;

  const cloned: Record<string, unknown> = { ...graph };
  const cloneNode = (nodeId: string): Record<string, unknown> | null => {
    const node = cloned[nodeId];
    if (!isRecord(node) || !isRecord(node['inputs'])) return null;
    const copy = { ...node, inputs: { ...node['inputs'] } };
    cloned[nodeId] = copy;
    return copy;
  };

  for (const nodeId of textGenerateIds) {
    const node = cloneNode(nodeId);
    if (node === null) continue;
    const inputs = node['inputs'] as Record<string, unknown>;
    const pictures = Math.max(referenceCount, links.size);
    for (let picture = 1; picture <= pictures; picture += 1) {
      const source = links.get(picture);
      if (source === undefined) continue;
      inputs[`images.image${picture}`] = [source, 0];
    }
  }

  // The expander prompt is the PrimitiveStringMultiline StringReplace substitutes into.
  for (const node of Object.values(graph)) {
    if (nodeClassType(node) !== 'StringReplace') continue;
    const taskNodeId = linkSource(nodeInputs(node)['string']);
    if (taskNodeId === null) continue;
    const taskNode = cloned[taskNodeId];
    if (nodeClassType(taskNode) !== 'PrimitiveStringMultiline') continue;
    const copy = cloneNode(taskNodeId);
    if (copy === null) continue;
    (copy['inputs'] as Record<string, unknown>)['value'] = H3_EDIT_EXPANSION_PROMPT;
  }

  return cloned;
}

/**
 * Turns the graph's prompt enhancer on or off, and picks which enhancer CLIP it loads.
 * The H3 template routes the prompt through a ComfySwitchNode whose switch picks the raw
 * prompt or the expansion, and two CLIPLoader files back the fast and the dedicated 27B
 * enhancer. The graph is cloned: a template from options is shared across requests and
 * runs.
 *
 * `hasReferences` is accepted but no longer bypasses the enhancer: the reference aware
 * expander inspects the attached pictures, so an alteration can be enhanced too.
 */
export function applyPromptEnhancer(
  graph: Record<string, unknown>,
  enhancePrompt: boolean | undefined,
  _hasReferences: boolean,
  promptEnhancer?: H3PromptEnhancer,
): Record<string, unknown> {
  if (promptEnhancer === undefined && enhancePrompt === undefined) return graph;
  const effective = effectivePromptEnhancer(enhancePrompt, promptEnhancer);
  const wanted = effective !== 'off';
  const enhancerClip = effective === 'off' ? null : H3_ENHANCER_BY_MODE[effective];
  // An enhancer that runs without a thinking section must not be asked for one, so its
  // system prompt loses the sentence that requests private reasoning.
  const stripThinking = effective !== 'off' && !H3_ENHANCER_TOKEN_BUDGET[effective].thinking;
  const systemPromptIds = stripThinking ? enhancerSystemPromptIds(graph) : new Set<string>();
  const cloned: Record<string, unknown> = {};
  let changed = false;
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!isRecord(node)) {
      cloned[nodeId] = node;
      continue;
    }
    const inputs = node['inputs'];
    if (nodeClassType(node) === 'ComfySwitchNode' && isRecord(inputs) && typeof inputs['switch'] === 'boolean') {
      if (inputs['switch'] !== wanted) changed = true;
      cloned[nodeId] = { ...node, inputs: { ...inputs, switch: wanted } };
      continue;
    }
    if (
      enhancerClip !== null &&
      nodeClassType(node) === 'CLIPLoader' &&
      isRecord(inputs) &&
      typeof inputs['clip_name'] === 'string' &&
      H3_ENHANCER_NAMES.has(inputs['clip_name'])
    ) {
      if (inputs['clip_name'] !== enhancerClip) changed = true;
      cloned[nodeId] = { ...node, inputs: { ...inputs, clip_name: enhancerClip } };
      continue;
    }
    if (wanted && nodeClassType(node) === 'TextGenerateV2' && isRecord(inputs)) {
      const budget = H3_ENHANCER_TOKEN_BUDGET[effective];
      if (inputs['thinking'] !== budget.thinking || inputs['max_length'] !== budget.maxLength) {
        changed = true;
      }
      cloned[nodeId] = {
        ...node,
        inputs: { ...inputs, thinking: budget.thinking, max_length: budget.maxLength },
      };
      continue;
    }
    if (
      systemPromptIds.has(nodeId) &&
      nodeClassType(node) === 'PrimitiveStringMultiline' &&
      isRecord(inputs) &&
      typeof inputs['value'] === 'string' &&
      inputs['value'].includes(THINKING_FIRST_SENTENCE)
    ) {
      changed = true;
      cloned[nodeId] = {
        ...node,
        inputs: {
          ...inputs,
          value: inputs['value'].replaceAll(THINKING_FIRST_SENTENCE, '').trimStart(),
        },
      };
      continue;
    }
    cloned[nodeId] = node;
  }
  return changed ? cloned : graph;
}

/** The PrimitiveStringMultiline node ids wired into a TextGenerateV2 system_prompt. */
function enhancerSystemPromptIds(graph: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(graph)) {
    if (nodeClassType(node) !== 'TextGenerateV2') continue;
    const source = linkSource(nodeInputs(node)['system_prompt']);
    if (source !== null) ids.add(source);
  }
  return ids;
}

/**
 * Picks the diffusion model the graph loads. Only a UNETLoader whose unet_name is one of
 * the official H3 files is retargeted, so a generic ComfyUI graph keeps its own model.
 * The graph is cloned: a template from options is shared across requests and runs.
 */
export function applyModelVariant(
  graph: Record<string, unknown>,
  variant: H3ModelVariant | undefined,
): Record<string, unknown> {
  if (variant === undefined) return graph;
  const target = H3_UNET_BY_VARIANT[variant];
  const cloned: Record<string, unknown> = {};
  let changed = false;
  for (const [nodeId, node] of Object.entries(graph)) {
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    if (
      nodeClassType(node) === 'UNETLoader' &&
      isRecord(node) &&
      isRecord(inputs) &&
      typeof inputs['unet_name'] === 'string' &&
      H3_UNET_NAMES.has(inputs['unet_name'])
    ) {
      cloned[nodeId] = { ...node, inputs: { ...inputs, unet_name: target } };
      changed = true;
      continue;
    }
    cloned[nodeId] = node;
  }
  return changed ? cloned : graph;
}

/**
 * Picks the 32B H3 text encoder build the graph loads. Only a CLIPLoader whose clip_name is
 * one of the two official H3 32B files is retargeted, so the 9B and 27B prompt enhancer
 * loaders keep their own weights. The graph is cloned when it actually changes.
 */
export function applyTextEncoderVariant(
  graph: Record<string, unknown>,
  variant: H3TextEncoderVariant | undefined,
): Record<string, unknown> {
  if (variant === undefined) return graph;
  const target = H3_TEXT_ENCODER_BY_VARIANT[variant];
  const cloned: Record<string, unknown> = {};
  let changed = false;
  for (const [nodeId, node] of Object.entries(graph)) {
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    if (
      nodeClassType(node) === 'CLIPLoader' &&
      isRecord(node) &&
      isRecord(inputs) &&
      typeof inputs['clip_name'] === 'string' &&
      H3_TEXT_ENCODER_NAMES.has(inputs['clip_name'])
    ) {
      if (inputs['clip_name'] !== target) changed = true;
      cloned[nodeId] = { ...node, inputs: { ...inputs, clip_name: target } };
      continue;
    }
    cloned[nodeId] = node;
  }
  return changed ? cloned : graph;
}

/** The node ids whose class_type matches, in graph order. */
function nodeIdsOfClassType(graph: Record<string, unknown>, classType: string): string[] {
  return Object.entries(graph)
    .filter(([, node]) => nodeClassType(node) === classType)
    .map(([nodeId]) => nodeId);
}

/** The node id a graph link points at, or null when the value is not a link. */
function linkSource(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const source = value[0];
  if (typeof source === 'string') return source;
  return typeof source === 'number' && Number.isFinite(source) ? String(source) : null;
}

/** Every node id referenced from one input value, including nested link arrays. */
function linkSourcesIn(value: unknown, into: string[]): void {
  const source = linkSource(value);
  if (source !== null) {
    into.push(source);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) linkSourcesIn(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) linkSourcesIn(item, into);
  }
}

/** Every node reachable backwards from one node through its inputs, including itself. */
function collectDependencies(graph: Record<string, unknown>, startId: string): Set<string> {
  const collected = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const nodeId = queue.pop();
    if (nodeId === undefined || collected.has(nodeId) || !isRecord(graph[nodeId])) continue;
    collected.add(nodeId);
    const sources: string[] = [];
    for (const value of Object.values(nodeInputs(graph[nodeId]))) linkSourcesIn(value, sources);
    for (const source of sources) {
      if (!collected.has(source)) queue.push(source);
    }
  }
  return collected;
}

/** True when the graph has a node of that class. */
function graphHasNodeClass(graph: Record<string, unknown>, classType: string): boolean {
  return Object.values(graph).some((node) => nodeClassType(node) === classType);
}

export interface EnhancerSubgraph {
  graph: Record<string, unknown>;
  /** The PreviewAny node that prints the extracted caption. */
  outputNodeId: string;
}

/**
 * Splits the prompt enhancer out of a full H3 graph into a graph of its own. ComfyUI eagerly
 * executes every leaf loader of a graph, so the full template loads the 29 GB Qwen3-VL encoder
 * and the 14-20 GB H3 UNet before the enhancer runs. Running the enhancer alone first, then the
 * image graph with the finished caption, keeps only one large model in RAM at a time.
 *
 * The subgraph is the transitive closure of the switch's on_true input: JsonExtractString,
 * TextGenerateV2, its CLIPLoader, the system and task prompts, StringReplace, and every wired
 * LoadImage reference. A PreviewAny prints the extracted caption. Anything that would pull the
 * diffusion pipeline in (a UNETLoader, the conditioning node, a sampler or the VAE) makes the
 * graph non isolatable, and the caller keeps the single pass path.
 */
export function extractEnhancerSubgraph(fullGraph: Record<string, unknown>): EnhancerSubgraph | null {
  const switchId = Object.keys(fullGraph).find(
    (nodeId) =>
      nodeClassType(fullGraph[nodeId]) === 'ComfySwitchNode' &&
      nodeInputs(fullGraph[nodeId])['switch'] === true,
  );
  if (switchId === undefined) return null;
  const onTrue = linkSource(nodeInputs(fullGraph[switchId])['on_true']);
  if (onTrue === null) return null;

  const ids = collectDependencies(fullGraph, onTrue);
  const classes = new Set<string>();
  for (const nodeId of ids) {
    const classType = nodeClassType(fullGraph[nodeId]);
    if (classType !== null) classes.add(classType);
  }
  if (!classes.has('TextGenerateV2')) return null;
  if (ENHANCER_SUBGRAPH_EXCLUDED_CLASSES.some((excluded) => classes.has(excluded))) return null;

  const graph: Record<string, unknown> = {};
  for (const nodeId of ids) {
    const node = fullGraph[nodeId];
    graph[nodeId] = isRecord(node) ? { ...node, inputs: { ...nodeInputs(node) } } : node;
  }

  // Reuse the graph's own PreviewAny when it has one, so the node id the history reports is
  // the same the rest of the adapter already knows.
  const previewIds = Object.keys(fullGraph).filter((nodeId) => nodeClassType(fullGraph[nodeId]) === 'PreviewAny');
  let outputNodeId = previewIds.find((nodeId) => !ids.has(nodeId)) ?? previewIds[0];
  if (outputNodeId === undefined) {
    outputNodeId = 'enhancer_preview';
    while (ids.has(outputNodeId)) outputNodeId = `_${outputNodeId}`;
  }
  const previewNode = fullGraph[outputNodeId];
  graph[outputNodeId] = {
    class_type: 'PreviewAny',
    inputs: { ...(isRecord(previewNode) ? nodeInputs(previewNode) : {}), source: [onTrue, 0] },
  };

  return { graph, outputNodeId };
}

/**
 * Fans one sampler out into `count` samplers, each with its own seed, sharing everything
 * upstream of the sampler: the conditioning, the text encode, the model and the latent.
 * A multi image batch therefore costs one text encode instead of one per image.
 *
 * Only a graph shaped like a single linear pipeline is expanded: one KSampler feeding one
 * VAEDecode feeding one SaveImage. Anything else returns null, so a template this helper
 * does not understand keeps the sequential path it had before.
 */
export interface MultiSeedExpansion {
  graph: Record<string, unknown>;
  /** Maps each KSampler node id to the 0-based batch slot index. */
  samplerSlots: Map<string, number>;
  /** SaveImage node ids in slot order 0..count-1. */
  saveNodeIds: string[];
}

export function expandMultiSeedGraph(
  graph: Record<string, unknown>,
  count: number,
  baseSeed: number,
): MultiSeedExpansion | null {
  if (count <= 1) return null;

  const samplerIds = nodeIdsOfClassType(graph, 'KSampler');
  const decodeIds = nodeIdsOfClassType(graph, 'VAEDecode');
  const saveIds = nodeIdsOfClassType(graph, 'SaveImage');
  if (samplerIds.length !== 1 || decodeIds.length !== 1 || saveIds.length !== 1) return null;
  const samplerId = samplerIds[0];
  const decodeId = decodeIds[0];
  const saveId = saveIds[0];
  if (samplerId === undefined || decodeId === undefined || saveId === undefined) return null;

  const decodeNode = graph[decodeId];
  const saveNode = graph[saveId];
  const decodeInputs = isRecord(decodeNode) ? decodeNode['inputs'] : undefined;
  const saveInputs = isRecord(saveNode) ? saveNode['inputs'] : undefined;
  if (!isRecord(decodeInputs) || !isRecord(saveInputs)) return null;
  if (linkSource(decodeInputs['samples']) !== samplerId) return null;
  if (linkSource(saveInputs['images']) !== decodeId) return null;

  const cloned: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    const inputs = isRecord(node) ? node['inputs'] : undefined;
    cloned[nodeId] = isRecord(node) && isRecord(inputs) ? { ...node, inputs: { ...inputs } } : node;
  }

  const samplerNode = cloned[samplerId];
  if (!isRecord(samplerNode) || !isRecord(samplerNode['inputs'])) return null;
  const samplerInputs = samplerNode['inputs'];

  const taken = new Set(Object.keys(cloned));
  const uniqueNodeId = (base: string): string => {
    let counter = 1;
    let candidate = base;
    while (taken.has(candidate)) {
      counter += 1;
      candidate = `${base}_${counter}`;
    }
    taken.add(candidate);
    return candidate;
  };

  const samplerSlots = new Map<string, number>();
  samplerSlots.set(samplerId, 0);
  const saveNodeIds: string[] = [saveId];

  for (let slot = 1; slot < count; slot += 1) {
    const samplerNodeId = uniqueNodeId(`batch_sampler_${slot}`);
    cloned[samplerNodeId] = {
      class_type: 'KSampler',
      inputs: { ...samplerInputs, seed: baseSeed + slot },
    };
    const decodeNodeId = uniqueNodeId(`batch_decode_${slot}`);
    cloned[decodeNodeId] = {
      class_type: 'VAEDecode',
      inputs: { ...decodeInputs, samples: [samplerNodeId, 0] },
    };
    const saveNodeId = uniqueNodeId(`batch_save_${slot}`);
    cloned[saveNodeId] = {
      class_type: 'SaveImage',
      inputs: { ...saveInputs, images: [decodeNodeId, 0] },
    };
    samplerSlots.set(samplerNodeId, slot);
    saveNodeIds.push(saveNodeId);
  }

  return { graph: cloned, samplerSlots, saveNodeIds };
}

/** `<Picture 1>`, `<Picture 2>`, and so on, joined into one readable list. */
function pictureList(count: number): string {
  const pictures = Array.from({ length: Math.max(1, count) }, (_unused, index) => `<Picture ${index + 1}>`);
  if (pictures.length <= 2) return pictures.join(', ');
  return `${pictures.slice(0, -1).join(', ')}, and ${pictures[pictures.length - 1]}`;
}

/**
 * H3 reads a reference image from a <Picture N> token in the prompt. A prompt that already
 * names a picture is left exactly as the user wrote it. With the enhancer on, the vision
 * aware expander sees every attached picture, so the raw instruction is passed through
 * untouched. With it off, a single reference is an edit of that picture, while several
 * references are named as sources so H3 does not lock onto the first background alone.
 */
export function formatReferencePrompt(
  prompt: string,
  template: WorkflowGraph,
  hasReferences: boolean,
  referenceCount = 1,
  enhancerOn = false,
): string {
  if (!hasReferences) return prompt;
  const h3Conditioning = Object.values(template).some(
    (node) => nodeClassType(node) === 'MiniMaxH3ImageConditioning',
  );
  if (!h3Conditioning) return prompt;
  const trimmed = prompt.trim();
  if (/<Picture\s+\d+>/i.test(prompt)) return prompt;
  // The vision aware expander reads every attached picture, so the raw instruction is
  // passed through exactly as the user wrote it.
  if (enhancerOn) return prompt;
  if (referenceCount > 1) return `Using ${pictureList(referenceCount)} as references: ${trimmed}`;
  return `Edit <Picture 1>. ${trimmed}`;
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

/** The graph one request runs: template, references, enhancer and model variant applied. */
function graphForRequest(
  template: WorkflowGraph,
  request: GenerationRequest,
  options: Record<string, unknown>,
  config: ProviderConfig,
  seed: number,
  uploadedRefs: readonly string[],
): Record<string, unknown> {
  const referenced = attachReferenceImages(
    substituteWorkflow(template, buildReplacements(request, options, config, seed)),
    uploadedRefs,
  );
  // The vision aware expander only makes sense when the enhancer actually runs, so an
  // off switch keeps the plain graph the user asked for.
  const enhancerOn = effectivePromptEnhancer(request.enhancePrompt, request.promptEnhancer) !== 'off';
  const vision = enhancerOn && uploadedRefs.length > 0
    ? applyReferenceVision(referenced, uploadedRefs.length)
    : referenced;
  return applyTextEncoderVariant(
    applyModelVariant(
      applyPromptEnhancer(vision, request.enhancePrompt, uploadedRefs.length > 0, request.promptEnhancer),
      request.modelVariant,
    ),
    request.textEncoderVariant,
  );
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
  | {
      state: 'done';
      images: ComfyImageRef[];
      /** The same images, keyed by the SaveImage node that produced them. */
      imagesByNode: Record<string, ComfyImageRef[]>;
      /** PreviewAny style text output, keyed by the node that printed it. */
      textsByNode: Record<string, string[]>;
    };

interface ExecutionErrorDetails {
  nodeType?: string;
  nodeId?: string;
  exceptionMessage?: string;
}

/** The images one node's output entry carries, in order. */
function imagesFromOutput(output: unknown): ComfyImageRef[] {
  if (!isRecord(output) || !Array.isArray(output['images'])) return [];
  const images: ComfyImageRef[] = [];
  for (const image of output['images']) {
    if (!isRecord(image) || typeof image['filename'] !== 'string') continue;
    const subfolder = typeof image['subfolder'] === 'string' ? image['subfolder'] : '';
    images.push({ filename: image['filename'], subfolder });
  }
  return images;
}

function imagesFromEntry(entry: unknown): ComfyImageRef[] {
  const outputs = isRecord(entry) ? entry['outputs'] : undefined;
  if (!isRecord(outputs)) return [];
  const images: ComfyImageRef[] = [];
  for (const output of Object.values(outputs)) images.push(...imagesFromOutput(output));
  return images;
}

/** The text lines one node's output entry carries, in order. */
function textsFromOutput(output: unknown): string[] {
  if (!isRecord(output)) return [];
  const raw = output['text'];
  if (typeof raw === 'string') return raw.trim().length === 0 ? [] : [raw];
  if (!Array.isArray(raw)) return [];
  const texts: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) texts.push(entry);
  }
  return texts;
}

/** Every text output of the history entry, keyed by the node that printed it. */
function textsByNodeFromEntry(entry: unknown): Record<string, string[]> {
  const outputs = isRecord(entry) ? entry['outputs'] : undefined;
  if (!isRecord(outputs)) return {};
  const byNode: Record<string, string[]> = {};
  for (const [nodeId, output] of Object.entries(outputs)) {
    const texts = textsFromOutput(output);
    if (texts.length > 0) byNode[nodeId] = texts;
  }
  return byNode;
}

/** Every image of the history entry, keyed by the node that saved it. */
function imagesByNodeFromEntry(entry: unknown): Record<string, ComfyImageRef[]> {
  const outputs = isRecord(entry) ? entry['outputs'] : undefined;
  if (!isRecord(outputs)) return {};
  const byNode: Record<string, ComfyImageRef[]> = {};
  for (const [nodeId, output] of Object.entries(outputs)) {
    const images = imagesFromOutput(output);
    if (images.length > 0) byNode[nodeId] = images;
  }
  return byNode;
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
  return {
    state: 'done',
    images: imagesFromEntry(entry),
    imagesByNode: imagesByNodeFromEntry(entry),
    textsByNode: textsByNodeFromEntry(entry),
  };
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

/** The same host and port, spoken over a WebSocket. */
function websocketBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}

/**
 * Aborting a wait must stop the work, not just stop watching it. This is best effort:
 * a backend that is already unreachable has nothing to interrupt.
 */
async function interruptPrompt(baseUrl: string, promptId: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
      signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS),
    });
  } catch {
    // The generation is failing on the abort anyway, so a lost interrupt changes nothing.
  }
}

/** The friendly stage a node belongs to, from its class name. */
function stageForClassType(classType: string | null): string {
  if (classType === null) return 'sampling';
  const lowered = classType.toLowerCase();
  // Saving before loading: SaveImage and PreviewImage both mention "image".
  if (lowered.includes('saveimage') || lowered.includes('previewimage')) return 'saving';
  if (lowered.includes('decode')) return 'decoding';
  if (lowered.includes('sampler')) return 'sampling';
  if (lowered.startsWith('textgenerate')) return 'enhancing';
  // Every loader blocks the graph before it can encode anything, so it is its own stage.
  if (lowered.includes('loader') || lowered.includes('loadimage')) return 'loading';
  if (
    lowered.includes('encode') ||
    lowered.includes('conditioning') ||
    lowered.includes('text')
  ) {
    return 'encoding';
  }
  return 'sampling';
}

function nodeInputs(node: unknown): Record<string, unknown> {
  if (!isRecord(node)) return {};
  const inputs = node['inputs'];
  return isRecord(inputs) ? inputs : {};
}

function nodeInputString(inputs: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = inputs[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** True when a lowercase filename contains a token, not merely a substring of another word. */
function hasToken(filename: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(filename);
}

/**
 * The line the loading view shows under the stage: specific enough that a slow run still
 * tells the user which model or node is holding the GPU. The slot arguments describe a
 * multi image batch, so one sampler can say "image 2 of 4".
 */
export function detailForNode(
  node: unknown,
  _nodeId: string,
  _graph: Record<string, unknown>,
  slot = 0,
  totalSlots = 1,
): string | undefined {
  const classType = nodeClassType(node);
  if (classType === null) return undefined;
  const lowered = classType.toLowerCase();
  const inputs = nodeInputs(node);

  // CLIPLoader: the H3 graphs load either the enhancer or a Qwen text encoder here.
  if (lowered.includes('clip') && lowered.includes('loader')) {
    const name = (nodeInputString(inputs, ['clip_name', 'clip_name1', 'clip_name2', 'ckpt_name']) ?? '').toLowerCase();
    if (name.includes('qwen3.8') || name.includes('qwen3.5') || hasToken(name, 'pe')) {
      return 'Loading prompt enhancer model';
    }
    if (name.includes('qwen3vl')) return 'Loading Qwen3-VL text encoder';
    return 'Loading text encoder';
  }

  if (lowered.startsWith('textgenerate')) return 'Rewriting & expanding prompt';

  if (lowered.includes('unetloader') || lowered.includes('checkpointloader')) {
    const name = (nodeInputString(inputs, ['unet_name', 'ckpt_name', 'model_name']) ?? '').toLowerCase();
    if (name.includes('w4a8')) return 'Loading MiniMax H3 weights (W4A8)';
    if (name.includes('int8')) return 'Loading MiniMax H3 weights (INT8)';
    if (name.includes('minimax') || hasToken(name, 'h3')) return 'Loading MiniMax H3 weights';
    return 'Loading diffusion model';
  }

  if (lowered.includes('vaeloader')) return 'Loading VAE decoder';
  if (lowered.includes('loadimage')) return 'Preparing reference image';
  if (lowered.includes('conditioning') || lowered.includes('encode')) {
    return 'Encoding prompt & canvas conditioning';
  }
  if (lowered.includes('sampler')) {
    return totalSlots > 1 ? `Denoising image ${slot + 1} of ${totalSlots}` : 'Denoising latent image';
  }
  if (lowered.includes('decode')) return 'Decoding latent to full-resolution pixels';
  if (lowered.includes('saveimage') || lowered.includes('previewimage')) return 'Writing PNG output';
  return undefined;
}

export interface ProgressWatch {
  /** Ties the socket to its prompt, once the server has answered with an id. */
  bind(promptId: string): void;
  /** True once real step progress arrived, so polling stops guessing at a percentage. */
  sawProgress(): boolean;
  close(): void;
}

/**
 * Listens to ComfyUI's own progress socket. Every failure here is silent: the polling
 * loop is the completion mechanism, so a backend, a proxy or a test without WebSocket
 * support only loses the finer progress, never the generation.
 */
export function createProgressWatch(
  wsUrl: string,
  graph: Record<string, unknown>,
  ctx: GenerationContext,
  index: number,
  samplerSlots?: ReadonlyMap<string, number>,
): ProgressWatch {
  const nodeStages = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(graph)) {
    nodeStages.set(nodeId, stageForClassType(nodeClassType(node)));
  }
  const totalSlots = samplerSlots === undefined ? 1 : Math.max(1, samplerSlots.size);

  let promptId: string | null = null;
  let sawProgress = false;
  // A shared prompt runs its samplers one after another, so the executing node decides
  // which tile the step progress belongs to.
  let activeIndex = index;
  let activeStage = 'sampling';
  let socket: WebSocket | null = null;
  try {
    const SocketConstructor = globalThis.WebSocket;
    if (typeof SocketConstructor === 'function') socket = new SocketConstructor(wsUrl);
  } catch {
    socket = null;
  }
  if (socket !== null) {
    try {
      socket.binaryType = 'arraybuffer';
    } catch {
      // A socket implementation without binary support still gives us text progress.
    }
  }

  const close = (): void => {
    const current = socket;
    socket = null;
    if (current === null) return;
    try {
      current.close();
    } catch {
      // A socket that already closed needs nothing.
    }
  };

  const nodeDetail = (nodeId: string): string | undefined => {
    const slot = samplerSlots?.get(nodeId) ?? activeIndex;
    return detailForNode(graph[nodeId], nodeId, graph, slot, totalSlots);
  };

  const emitPreview = (buffer: ArrayBuffer | Uint8Array): void => {
    const preview = parseBinaryPreview(buffer);
    if (preview === null) return;
    if (promptId !== null && preview.promptId !== undefined && preview.promptId !== promptId) return;
    if (preview.nodeId !== undefined) {
      const slot = samplerSlots?.get(preview.nodeId);
      if (slot !== undefined) activeIndex = slot;
    }
    ctx.onEvent({ type: 'preview', index: activeIndex, dataUrl: preview.dataUrl });
  };

  const handleMessage = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const type = parsed['type'];
    const payload = parsed['data'];
    if (!isRecord(payload)) return;
    const messagePrompt = payload['prompt_id'];
    if (promptId !== null && typeof messagePrompt === 'string' && messagePrompt !== promptId) return;

    if (type === 'executing') {
      const node = payload['node'];
      const nodeId =
        typeof node === 'string'
          ? node
          : typeof node === 'number' && Number.isFinite(node)
            ? String(node)
            : null;
      // A null node means the prompt finished. History polling reports the completion.
      if (nodeId === null || nodeId.length === 0) return;
      const slot = samplerSlots?.get(nodeId);
      if (slot !== undefined) activeIndex = slot;
      activeStage = nodeStages.get(nodeId) ?? 'sampling';
      const detail = nodeDetail(nodeId);
      ctx.onEvent({
        type: 'progress',
        index: activeIndex,
        stage: activeStage,
        ...(detail === undefined ? {} : { detail }),
      });
      return;
    }

    if (type === 'execution_cached') {
      const nodes = payload['nodes'];
      if (!sawProgress && Array.isArray(nodes) && nodes.length > 0) {
        ctx.onEvent({
          type: 'progress',
          index: activeIndex,
          stage: 'preparing',
          detail: 'Models warm in VRAM',
          cached: true,
        });
      }
      return;
    }

    if (type === 'progress') {
      const value = payload['value'];
      const max = payload['max'];
      if (typeof value !== 'number' || typeof max !== 'number') return;
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
      sawProgress = true;
      if (activeStage === 'enhancing') {
        ctx.onEvent({
          type: 'progress',
          index: activeIndex,
          stage: 'enhancing',
          detail: `Rewriting prompt (${value} / ${max} tokens)`,
        });
        return;
      }
      ctx.onEvent({
        type: 'progress',
        index: activeIndex,
        stage: 'sampling',
        detail: `Step ${value} of ${max}`,
        step: value,
        totalSteps: max,
        percent: Math.round((value / max) * 100),
      });
    }
  };

  if (socket !== null) {
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        handleMessage(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        emitPreview(data);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        emitPreview(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data
          .arrayBuffer()
          .then((buffer) => emitPreview(buffer))
          .catch(() => undefined);
      }
    });
    socket.addEventListener('error', close);
    socket.addEventListener('close', () => {
      socket = null;
    });
  }

  return {
    bind(next: string): void {
      promptId = next;
    },
    sawProgress: () => sawProgress,
    close,
  };
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
  watch: ProgressWatch,
): Promise<HistoryState> {
  const deadline = Date.now() + pollOptions.timeoutMs;
  let polls = 0;
  for (;;) {
    throwIfAborted(ctx.signal);
    if (polls > 0 && Date.now() >= deadline) {
      // A timed out prompt must not keep sampling in the background. interruptPrompt never
      // throws, so a lost interrupt cannot mask the timeout the user needs to see.
      await interruptPrompt(baseUrl, promptId);
      throw new ComfyUIError(
        `ComfyUI timed out after ${pollOptions.timeoutMs} ms waiting for prompt ${promptId} (${polls} polls)`,
        'timeout',
      );
    }
    polls += 1;
    // Real step counts win. The poll estimate only fills the gap before the socket
    // reports anything, so a WebSocket backend never shows a made up percentage.
    if (!watch.sawProgress()) {
      ctx.onEvent({ type: 'progress', index, stage: 'sampling', percent: pollPercent(polls) });
    }
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
      await interruptPrompt(baseUrl, promptId);
      throw new ComfyUIError(
        `ComfyUI timed out after ${pollOptions.timeoutMs} ms waiting for prompt ${promptId} (${polls} polls)`,
        'timeout',
      );
    }
    await sleep(Math.min(pollOptions.intervalMs, remaining), ctx.signal);
  }
}

interface PromptRun {
  promptId: string;
  history: HistoryState;
}

/**
 * Queues one graph, streams its progress, and waits for its history entry. Aborting
 * here also tells ComfyUI to interrupt, so GPU sampling stops immediately.
 */
async function runPrompt(
  baseUrl: string,
  wsUrl: string,
  clientId: string,
  graph: Record<string, unknown>,
  pollOptions: PollOptions,
  ctx: GenerationContext,
  index: number,
  samplerSlots?: ReadonlyMap<string, number>,
): Promise<PromptRun> {
  const watch = createProgressWatch(wsUrl, graph, ctx, index, samplerSlots);
  let promptId: string | null = null;
  try {
    promptId = await queuePrompt(baseUrl, clientId, graph, ctx.signal);
    watch.bind(promptId);
    const history = await waitForHistory(baseUrl, promptId, pollOptions, ctx, index, watch);
    return { promptId, history };
  } catch (error) {
    if (promptId !== null && ctx.signal.aborted) await interruptPrompt(baseUrl, promptId);
    throw error;
  } finally {
    watch.close();
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

/**
 * The expanded prompt ComfyUI actually sent into the conditioning node. Node 18 (PreviewAny)
 * holds the final text of the graph, so it is what the user sees as the revised prompt.
 * Only an enhancer run counts: an untouched raw prompt is not a revision.
 */
function revisedPromptFrom(
  graph: Record<string, unknown>,
  history: HistoryState,
  request: GenerationRequest,
): string | undefined {
  if (effectivePromptEnhancer(request.enhancePrompt, request.promptEnhancer) === 'off') return undefined;
  if (history.state !== 'done') return undefined;
  const raw = request.prompt.trim();
  for (const nodeId of nodeIdsOfClassType(graph, 'PreviewAny')) {
    const text = history.textsByNode[nodeId]?.[0]?.trim();
    if (text === undefined || text.length === 0 || text === raw) continue;
    return text;
  }
  return undefined;
}

export function createComfyUIAdapter(config: ProviderConfig): ProviderAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const options = config.options ?? {};
  const clientId = readString(options, 'clientId') ?? DEFAULT_CLIENT_ID;
  const progressUrl = `${websocketBaseUrl(baseUrl)}/ws?clientId=${encodeURIComponent(clientId)}`;
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
  ): Promise<{ item: GeneratedItem; revisedPrompt: string | undefined }> {
    const slotStartedMs = Date.now();
    let run: PromptRun;
    let graph: Record<string, unknown>;
    try {
      graph = graphForRequest(
        template,
        { ...request, count: 1 },
        options,
        config,
        slotSeed,
        uploadedRefs,
      );
      run = await runPrompt(baseUrl, progressUrl, clientId, graph, pollOptions, ctx, slot);
    } catch (error) {
      throwIfAborted(ctx.signal);
      if (!(error instanceof ComfyUIError)) throw error;
      return {
        item: failedItem(slot, error.message, error.code, error.code !== 'invalid_template'),
        revisedPrompt: undefined,
      };
    }
    const revisedPrompt = revisedPromptFrom(graph, run.history, request);
    if (run.history.state === 'error') {
      return { item: failedItem(slot, run.history.message, 'execution_error', true), revisedPrompt };
    }
    const image = run.history.state === 'done' ? run.history.images[0] : undefined;
    if (image === undefined) {
      return {
        item: failedItem(
          slot,
          `ComfyUI finished prompt ${run.promptId} without returning an image`,
          'no_images',
          true,
        ),
        revisedPrompt,
      };
    }
    return { item: await itemFromImage(slot, image, slotSeed, slotStartedMs, ctx), revisedPrompt };
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
    let revisedPrompt: string | undefined;
    const outcome = (): GenerationOutcome => ({
      providerId: config.id,
      items,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
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
    const enhancer = effectivePromptEnhancer(request.enhancePrompt, request.promptEnhancer);
    const enhancerOn = enhancer !== 'off';
    const effectiveRequest =
      uploadedRefs.length > 0
        ? {
            ...request,
            prompt: formatReferencePrompt(
              request.prompt,
              template,
              true,
              uploadedRefs.length,
              enhancerOn,
            ),
          }
        : request;

    // Two phase enhancement: ComfyUI eagerly executes every leaf loader of one graph, so the
    // full H3 template would hold the Qwen3-VL encoder, the enhancer and the H3 UNet in RAM
    // together (50+ GB on a 32 GB machine). The enhancer runs alone first, then the image
    // graph runs with the extracted caption. Phase 2 keeps the switch off, and ComfyUI's
    // ComfySwitchNode marks on_true lazy, so node 16 (the enhancer CLIPLoader) never loads.
    let phaseRequest: GenerationRequest = effectiveRequest;
    if (enhancerOn) {
      const probeGraph = graphForRequest(
        template,
        { ...effectiveRequest, count: 1 },
        options,
        config,
        seed,
        uploadedRefs,
      );
      const enhancerRun = extractEnhancerSubgraph(probeGraph);
      const hasImagePipeline =
        graphHasNodeClass(probeGraph, 'UNETLoader') ||
        graphHasNodeClass(probeGraph, 'MiniMaxH3ImageConditioning');
      if (enhancerRun !== null && hasImagePipeline) {
        ctx.onEvent({
          type: 'progress',
          index: 0,
          stage: 'enhancing',
          detail:
            enhancer === 'qwen3.8_27b'
              ? 'Expanding prompt with Qwen3.8 27B'
              : 'Expanding prompt with Qwen3.5 9B',
        });
        let caption: string | undefined;
        try {
          const run = await runPrompt(
            baseUrl,
            progressUrl,
            clientId,
            enhancerRun.graph,
            pollOptions,
            ctx,
            0,
          );
          if (run.history.state === 'done') {
            caption = run.history.textsByNode[enhancerRun.outputNodeId]?.[0]?.trim();
          }
        } catch (error) {
          throwIfAborted(ctx.signal);
          if (!(error instanceof ComfyUIError)) throw error;
          // A failed enhancement must not fail the generation: the raw prompt still renders.
          caption = undefined;
        }
        if (caption !== undefined && caption.length > 0) {
          if (caption !== request.prompt.trim()) revisedPrompt = caption;
          phaseRequest = { ...effectiveRequest, prompt: caption, enhancePrompt: false, promptEnhancer: 'off' };
          ctx.onEvent({
            type: 'progress',
            index: 0,
            stage: 'encoding',
            detail: 'Prompt enhanced — loading Qwen3-VL encoder',
          });
        } else {
          // The expander produced nothing usable (for example malformed JSON), so render the
          // user's own words instead of failing the run.
          const fallbackPrompt =
            uploadedRefs.length > 0
              ? formatReferencePrompt(request.prompt, template, true, uploadedRefs.length, false)
              : request.prompt;
          phaseRequest = {
            ...request,
            prompt: fallbackPrompt,
            enhancePrompt: false,
            promptEnhancer: 'off',
          };
        }
      }
    }

    if (request.count > 1 && !templateHasBatchPlaceholder(template)) {
      // One prompt can carry the whole batch: every extra slot is a cloned sampler that
      // reuses the same text encode, which is the expensive part of a 2 to 4 image run.
      const baseGraph = graphForRequest(
        template,
        { ...phaseRequest, count: 1 },
        options,
        config,
        seed,
        uploadedRefs,
      );
      const expanded = expandMultiSeedGraph(baseGraph, request.count, seed);
      if (expanded !== null) {
        const run = await runPrompt(
          baseUrl,
          progressUrl,
          clientId,
          expanded.graph,
          pollOptions,
          ctx,
          0,
          expanded.samplerSlots,
        );
        revisedPrompt = revisedPromptFrom(expanded.graph, run.history, request) ?? revisedPrompt;
        if (run.history.state === 'error') {
          for (let slot = 0; slot < request.count; slot += 1) {
            const item = failedItem(slot, run.history.message, 'execution_error', true);
            items.push(item);
            ctx.onEvent({ type: 'item', index: slot, item });
          }
          return outcome();
        }
        if (run.history.state === 'done') {
          const imagesByNode = run.history.imagesByNode;
          for (let slot = 0; slot < request.count; slot += 1) {
            throwIfAborted(ctx.signal);
            const slotSeed = seed + slot;
            const saveNodeId = expanded.saveNodeIds[slot];
            const image = saveNodeId === undefined ? undefined : imagesByNode[saveNodeId]?.[0];
            const item =
              image === undefined
                ? failedItem(
                    slot,
                    `ComfyUI finished prompt ${run.promptId} without returning an image for slot ${slot}`,
                    'no_images',
                    true,
                  )
                : await itemFromImage(slot, image, slotSeed, startedMs, ctx);
            items.push(item);
            ctx.onEvent({ type: 'item', index: slot, item });
          }
        }
        return outcome();
      }
      // A graph this helper does not understand keeps the sequential path.
      for (let slot = 0; slot < request.count; slot += 1) {
        throwIfAborted(ctx.signal);
        const slotSeed = seed + slot;
        const { item, revisedPrompt: slotPrompt } = await generateSlot(
          template,
          phaseRequest,
          slot,
          slotSeed,
          uploadedRefs,
          ctx,
        );
        revisedPrompt = revisedPrompt ?? slotPrompt;
        items.push(item);
        ctx.onEvent({ type: 'item', index: slot, item });
      }
      return outcome();
    }

    const graph = graphForRequest(template, phaseRequest, options, config, seed, uploadedRefs);
    const run = await runPrompt(baseUrl, progressUrl, clientId, graph, pollOptions, ctx, 0);
    revisedPrompt = revisedPromptFrom(graph, run.history, request) ?? revisedPrompt;
    if (run.history.state === 'error') {
      const item = failedItem(0, run.history.message, 'execution_error', true);
      items.push(item);
      ctx.onEvent({ type: 'item', index: 0, item });
      return outcome();
    }
    if (run.history.state === 'done') {
      for (const [index, image] of run.history.images.entries()) {
        const item = await itemFromImage(index, image, seed, startedMs, ctx);
        items.push(item);
        ctx.onEvent({ type: 'item', index, item });
      }
    }
    if (items.length === 0) {
      const item = failedItem(
        0,
        `ComfyUI finished prompt ${run.promptId} without returning an image`,
        'no_images',
        false,
      );
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
