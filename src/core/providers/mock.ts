import { synthImage } from '../png';
import type {
  GeneratedItem,
  GenerationContext,
  GenerationOutcome,
  GenerationRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
} from '../types';

const MIN_COUNT = 1;
const MAX_COUNT = 10;
const SIZE_MULTIPLE = 8;
const FAIL_ONE_TOKEN = 'FAIL_ONE';
/** Nominal per item cost. Fixed rather than measured so an outcome is reproducible byte for byte. */
const ITEM_LATENCY_MS = 30;

const CAPABILITIES: ProviderCapabilities = {
  seed: true,
  negativePrompt: true,
  adjustableSteps: true,
  fixedSteps: null,
  guidance: true,
  maxReferenceImages: 4,
  maxBatch: MAX_COUNT,
  arbitrarySize: true,
  sizeMultiple: SIZE_MULTIPLE,
  presets: [
    { id: 'square-512', label: 'Square 512', width: 512, height: 512 },
    { id: 'landscape-768', label: 'Landscape 768 x 512', width: 768, height: 512 },
    { id: 'portrait-512', label: 'Portrait 512 x 768', width: 512, height: 768 },
  ],
  outputFormats: ['png'],
  streamingProgress: true,
  notes: [
    'Offline stand-in: images are synthesised gradients, not model output.',
    `A prompt containing ${FAIL_ONE_TOKEN} fails item 0 with a retryable error.`,
  ],
};

/** Resolves false instead of rejecting when the signal aborts, so no AbortError escapes the adapter. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertSize(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value % SIZE_MULTIPLE !== 0) {
    throw new RangeError(
      `mock provider expects ${name} to be a positive multiple of ${SIZE_MULTIPLE}, received ${value}`,
    );
  }
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    throw new RangeError(
      `mock provider expects count between ${MIN_COUNT} and ${MAX_COUNT}, received ${count}`,
    );
  }
}

function buildItem(request: GenerationRequest, index: number, seed: number): GeneratedItem {
  // A batch fails its first item so partial failure paths are testable. A single image
  // request is allowed to succeed, which is what makes retrying one failed image meaningful.
  if (index === 0 && request.count > 1 && request.prompt.includes(FAIL_ONE_TOKEN)) {
    return {
      index,
      ok: false,
      failure: {
        message: `Mock failure for item ${index}: the prompt contains ${FAIL_ONE_TOKEN}`,
        code: 'mock_forced_failure',
        retryable: true,
      },
    };
  }
  return {
    index,
    ok: true,
    bytes: synthImage({ width: request.width, height: request.height, seed, label: request.prompt }),
    width: request.width,
    height: request.height,
    seed,
    durationMs: ITEM_LATENCY_MS,
  };
}

async function mockGenerate(
  config: ProviderConfig,
  request: GenerationRequest,
  ctx: GenerationContext,
): Promise<GenerationOutcome> {
  assertCount(request.count);
  assertSize('width', request.width);
  assertSize('height', request.height);

  const startedAt = new Date().toISOString();
  const seedBase = request.seed ?? 0;
  const items: GeneratedItem[] = [];

  for (let index = 0; index < request.count; index += 1) {
    if (ctx.signal.aborted) {
      break;
    }
    const seed = seedBase + index;
    ctx.onEvent({ type: 'progress', index, stage: 'rendering', step: 0, totalSteps: 1, percent: 0 });
    const finished = await delay(ITEM_LATENCY_MS, ctx.signal);
    if (!finished) {
      break;
    }
    ctx.onEvent({ type: 'progress', index, stage: 'encoding', step: 1, totalSteps: 1, percent: 100 });
    const item = buildItem(request, index, seed);
    items.push(item);
    ctx.onEvent({ type: 'item', index, item });
  }

  return {
    providerId: config.id,
    items,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function createMockAdapter(config: ProviderConfig): ProviderAdapter {
  return {
    id: config.id,
    label: config.label,
    kind: 'mock',
    health: async () => ({ ok: true, detail: `Offline mock provider, no network at ${config.baseUrl}` }),
    capabilities: async () => ({ ...CAPABILITIES }),
    generate: (request, ctx) => mockGenerate(config, request, ctx),
  };
}
