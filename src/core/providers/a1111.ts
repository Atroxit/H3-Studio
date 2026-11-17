// Adapter for Automatic1111 and Forge.
// Requests are sequential and single image (batch_size: 1) so every item can report progress.

import type {
  GeneratedItem,
  GenerationContext,
  GenerationOutcome,
  GenerationRequest,
  ItemFailure,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
  SizePreset,
} from '../types';

const TXT2IMG_PATH = '/sdapi/v1/txt2img';
const OPTIONS_PATH = '/sdapi/v1/options';
const DEFAULT_SAMPLER = 'Euler a';
const RANDOM_SEED = -1;
const SIZE_MULTIPLE = 8;
const MAX_BATCH = 8;

const PRESETS: SizePreset[] = [
  { id: '512x512', label: '512x512', width: 512, height: 512 },
  { id: '768x768', label: '768x768', width: 768, height: 768 },
  { id: '832x1216', label: '832x1216', width: 832, height: 1216 },
  { id: '1216x832', label: '1216x832', width: 1216, height: 832 },
];

interface ProviderError {
  message: string;
  code?: string;
}

interface HttpResult {
  ok: boolean;
  status: number;
  url: string;
  body: unknown;
}

type Attempt =
  | { kind: 'item'; item: GeneratedItem }
  | { kind: 'fatal'; failure: ItemFailure }
  | { kind: 'aborted' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.trim();
  if (cleaned === '') return null;
  const bytes = Buffer.from(cleaned, 'base64');
  return bytes.length === 0 ? null : new Uint8Array(bytes);
}

function readProviderError(value: unknown): ProviderError | null {
  if (typeof value === 'string') {
    const message = value.trim();
    return message === '' ? null : { message };
  }
  if (!isRecord(value)) return null;
  const rawMessage = value.message ?? value.msg ?? value.detail ?? value.error;
  const message =
    typeof rawMessage === 'string' && rawMessage.trim() !== '' ? rawMessage : 'Automatic1111 reported an error';
  const rawCode = value.code ?? value.status;
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  return code === undefined ? { message } : { message, code };
}

function topLevelError(body: unknown): ProviderError | null {
  if (!isRecord(body)) return null;
  if (body.error !== undefined && body.error !== null) {
    const parsed = readProviderError(body.error);
    if (parsed !== null) return parsed;
  }
  if (body.detail !== undefined && body.detail !== null) {
    const parsed = readProviderError(body.detail);
    if (parsed !== null) return parsed;
  }
  return null;
}

function toFailure(failure: ProviderError, retryable: boolean): ItemFailure {
  const result: ItemFailure = { message: failure.message, retryable };
  if (failure.code !== undefined) result.code = failure.code;
  return result;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function readSeedFromInfo(info: unknown): number | undefined {
  let parsed: unknown = info;
  if (typeof info === 'string') {
    try {
      parsed = JSON.parse(info) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;
  const seed = parsed.seed;
  return typeof seed === 'number' && Number.isFinite(seed) ? seed : undefined;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class A1111Adapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: 'a1111' = 'a1111';
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const url = joinUrl(this.config.baseUrl, OPTIONS_PATH);
    try {
      const response = await fetch(url, { headers: this.headers() });
      if (response.ok) return { ok: true };
      return { ok: false, detail: `HTTP ${response.status} from ${url}` };
    } catch (error) {
      return { ok: false, detail: describeError(error) };
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      seed: true,
      negativePrompt: true,
      adjustableSteps: true,
      fixedSteps: null,
      guidance: true,
      maxReferenceImages: 0,
      maxBatch: MAX_BATCH,
      arbitrarySize: true,
      sizeMultiple: SIZE_MULTIPLE,
      presets: PRESETS,
      outputFormats: ['png'],
      streamingProgress: false,
      notes: [],
    };
  }

  async generate(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationOutcome> {
    const startedAt = new Date().toISOString();
    const items: GeneratedItem[] = [];
    let haltedBy: ItemFailure | null = null;

    for (let index = 0; index < request.count; index += 1) {
      if (ctx.signal.aborted) break;
      ctx.onEvent({ type: 'progress', index, stage: 'requesting' });
      const attempt = await this.attempt(index, request, ctx.signal);
      if (attempt.kind === 'aborted') break;
      if (attempt.kind === 'fatal') {
        haltedBy = attempt.failure;
        break;
      }
      items.push(attempt.item);
      ctx.onEvent({ type: 'item', index, item: attempt.item });
    }

    // A request level failure applies to every index the batch never reached, so the
    // caller sees one failed item per requested image rather than silent gaps.
    if (haltedBy !== null) {
      for (let index = items.length; index < request.count; index += 1) {
        const item: GeneratedItem = { index, ok: false, failure: haltedBy };
        items.push(item);
        ctx.onEvent({ type: 'item', index, item });
      }
    }

    return {
      providerId: this.id,
      items,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  private async attempt(index: number, request: GenerationRequest, signal: AbortSignal): Promise<Attempt> {
    const itemStarted = Date.now();
    let result: HttpResult;
    try {
      result = await this.postJson(TXT2IMG_PATH, this.txt2imgPayload(request), signal);
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      return {
        kind: 'fatal',
        failure: { message: `Could not reach ${this.config.baseUrl}: ${describeError(error)}`, retryable: true },
      };
    }

    if (!result.ok) {
      if (result.status === 404) {
        return {
          kind: 'fatal',
          failure: {
            message: `No Automatic1111 or Forge API at ${result.url}; the server is not running or is not A1111`,
            code: 'not_a1111',
            retryable: false,
          },
        };
      }
      const providerError = topLevelError(result.body) ??
        readProviderError(result.body) ?? { message: `HTTP ${result.status} from ${result.url}` };
      return { kind: 'fatal', failure: toFailure(providerError, retryableStatus(result.status)) };
    }

    const carried = topLevelError(result.body);
    if (carried !== null) return { kind: 'fatal', failure: toFailure(carried, true) };

    const record = isRecord(result.body) ? result.body : {};
    const images = Array.isArray(record.images) ? record.images : null;
    const first = images?.[0];
    if (typeof first !== 'string') {
      return {
        kind: 'fatal',
        failure: { message: 'Automatic1111 returned no image data', code: 'no_images', retryable: true },
      };
    }
    const bytes = decodeBase64(first);
    if (bytes === null) {
      return {
        kind: 'fatal',
        failure: { message: 'Automatic1111 returned an empty base64 image', code: 'empty_image', retryable: true },
      };
    }

    const item: GeneratedItem = {
      index,
      ok: true,
      bytes,
      width: request.width,
      height: request.height,
      durationMs: Date.now() - itemStarted,
    };
    const seed = readSeedFromInfo(record.info) ?? request.seed;
    if (seed !== undefined) item.seed = seed;
    return { kind: 'item', item };
  }

  private samplerName(): string {
    const configured = this.config.options?.samplerName;
    return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_SAMPLER;
  }

  private txt2imgPayload(request: GenerationRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      width: request.width,
      height: request.height,
      batch_size: 1,
      seed: request.seed ?? RANDOM_SEED,
      sampler_name: this.samplerName(),
    };
    if (request.steps !== undefined) payload.steps = request.steps;
    if (request.guidance !== undefined) payload.cfg_scale = request.guidance;
    return payload;
  }

  private headers(): Record<string, string> {
    const apiKey = this.config.apiKey;
    return apiKey !== undefined && apiKey !== '' ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  private async postJson(path: string, payload: unknown, signal: AbortSignal): Promise<HttpResult> {
    const url = joinUrl(this.config.baseUrl, path);
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    return { ok: response.ok, status: response.status, url, body: await readJsonBody(response) };
  }
}

export function createA1111Adapter(config: ProviderConfig): A1111Adapter {
  return new A1111Adapter(config);
}
