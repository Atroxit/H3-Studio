// Adapter for servers that speak the OpenAI style image API: SGLang with vllm-omni,
// vLLM-Omni, and the hosted MiniMax endpoint.
// Requests are sequential and single image (n: 1) so every item can report progress.

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
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

const GENERATIONS_PATH = '/v1/images/generations';
const EDITS_PATH = '/v1/images/edits';
const MODELS_PATH = '/v1/models';
const FALLBACK_MODEL = 'default';
const SIZE_MULTIPLE = 8;
const MAX_BATCH = 10;

const SAFETY_PATTERN = /safety|content[_ -]?filter|content[_ -]?policy|moderation|policy|refused|blocked/i;

const PRESETS: SizePreset[] = [
  { id: '1024x1024', label: '1024x1024', width: 1024, height: 1024 },
  { id: '1344x768', label: '1344x768', width: 1344, height: 768 },
  { id: '768x1344', label: '768x1344', width: 768, height: 1344 },
  { id: '1536x864', label: '1536x864', width: 1536, height: 864 },
  { id: '864x1536', label: '864x1536', width: 864, height: 1536 },
];

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

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

interface ReferencePart {
  filename: string;
  mimeType: string;
  // Narrowed to ArrayBuffer so the bytes are a valid BlobPart.
  bytes: Uint8Array<ArrayBuffer>;
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
  const rawMessage = value.message ?? value.msg ?? value.status_msg ?? value.detail;
  const message =
    typeof rawMessage === 'string' && rawMessage.trim() !== '' ? rawMessage : 'Provider reported an error';
  const rawCode = value.code ?? value.status_code;
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  return code === undefined ? { message } : { message, code };
}

function readRevisedPrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const revised = value.revised_prompt;
  return typeof revised === 'string' && revised.trim() !== '' ? revised : undefined;
}

function topLevelError(body: unknown): ProviderError | null {
  if (!isRecord(body)) return null;
  if (body.error !== undefined && body.error !== null) {
    const parsed = readProviderError(body.error);
    if (parsed !== null) return parsed;
  }
  const baseResp = body.base_resp;
  if (!isRecord(baseResp)) return null;
  const statusCode = baseResp.status_code;
  const failed =
    (typeof statusCode === 'number' && statusCode !== 0) ||
    (typeof statusCode === 'string' && statusCode !== '' && statusCode !== '0');
  return failed ? readProviderError(baseResp) ?? { message: 'Provider reported an error' } : null;
}

function isSafetyRefusal(failure: ProviderError): boolean {
  return SAFETY_PATTERN.test(`${failure.code ?? ''} ${failure.message}`);
}

function toFailure(failure: ProviderError, retryable: boolean): ItemFailure {
  const result: ItemFailure = {
    message: failure.message,
    retryable: retryable && !isSafetyRefusal(failure),
  };
  if (failure.code !== undefined) result.code = failure.code;
  return result;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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

async function loadReferences(paths: string[]): Promise<ReferencePart[]> {
  const parts: ReferencePart[] = [];
  for (const path of paths) {
    const bytes = new Uint8Array(await readFile(path));
    parts.push({
      filename: basename(path),
      mimeType: MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream',
      bytes,
    });
  }
  return parts;
}

export class OpenAIImagesAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: 'openai-images' = 'openai-images';
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.label = config.label;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const url = joinUrl(this.config.baseUrl, MODELS_PATH);
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
      negativePrompt: false,
      adjustableSteps: false,
      fixedSteps: null,
      guidance: false,
      maxReferenceImages: 0,
      maxBatch: MAX_BATCH,
      arbitrarySize: true,
      sizeMultiple: SIZE_MULTIPLE,
      presets: PRESETS,
      outputFormats: ['png'],
      streamingProgress: false,
      notes: ['Hosted MiniMax rejects the seed parameter; self hosted SGLang or vLLM servers accept it.'],
    };
  }

  async generate(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationOutcome> {
    const startedAt = new Date().toISOString();
    const references = request.referenceIds ?? [];
    const items: GeneratedItem[] = [];
    let revisedPrompt: string | undefined;
    let haltedBy: ItemFailure | null = null;

    for (let index = 0; index < request.count; index += 1) {
      if (ctx.signal.aborted) break;
      ctx.onEvent({ type: 'progress', index, stage: 'requesting' });
      const attempt = await this.attempt(index, request, references, ctx.signal);
      if (attempt.kind === 'aborted') break;
      if (attempt.kind === 'fatal') {
        haltedBy = attempt.failure;
        break;
      }
      items.push(attempt.item);
      ctx.onEvent({ type: 'item', index, item: attempt.item });
      if (attempt.item.revisedPrompt !== undefined) revisedPrompt = attempt.item.revisedPrompt;
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

    const outcome: GenerationOutcome = {
      providerId: this.id,
      items,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    if (revisedPrompt !== undefined) outcome.revisedPrompt = revisedPrompt;
    return outcome;
  }

  private async attempt(
    index: number,
    request: GenerationRequest,
    references: string[],
    signal: AbortSignal,
  ): Promise<Attempt> {
    const itemStarted = Date.now();
    let parts: ReferencePart[] = [];
    if (references.length > 0) {
      try {
        parts = await loadReferences(references);
      } catch (error) {
        return {
          kind: 'fatal',
          failure: {
            message: `Could not read reference image: ${describeError(error)}`,
            code: 'reference_unreadable',
            retryable: false,
          },
        };
      }
    }

    let result: HttpResult;
    try {
      result =
        parts.length > 0
          ? await this.postForm(EDITS_PATH, this.editForm(request, parts), signal)
          : await this.postJson(GENERATIONS_PATH, this.generationPayload(request), signal);
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      return {
        kind: 'fatal',
        failure: { message: `Could not reach ${this.config.baseUrl}: ${describeError(error)}`, retryable: true },
      };
    }

    if (parts.length > 0 && (result.status === 404 || result.status === 405)) {
      return {
        kind: 'fatal',
        failure: {
          message: `The server does not implement image edits (HTTP ${result.status} from ${result.url})`,
          code: 'edits_not_supported',
          retryable: false,
        },
      };
    }

    if (!result.ok) {
      const providerError = topLevelError(result.body) ??
        readProviderError(result.body) ?? { message: `HTTP ${result.status} from ${result.url}` };
      return { kind: 'fatal', failure: toFailure(providerError, retryableStatus(result.status)) };
    }

    const carried = topLevelError(result.body);
    if (carried !== null) return { kind: 'fatal', failure: toFailure(carried, true) };

    return this.itemFromBody(index, request, result.body, itemStarted);
  }

  private itemFromBody(index: number, request: GenerationRequest, body: unknown, itemStarted: number): Attempt {
    const bodyRecord = isRecord(body) ? body : {};
    const entries = Array.isArray(bodyRecord.data) ? bodyRecord.data : null;
    if (entries === null) {
      return { kind: 'fatal', failure: { message: 'Image response contained no data array', retryable: true } };
    }
    const entry = entries[0];
    if (entry === undefined) {
      return { kind: 'fatal', failure: { message: 'Image response contained no items', retryable: true } };
    }
    const record = isRecord(entry) ? entry : {};

    if (record.error !== undefined && record.error !== null) {
      const providerError = readProviderError(record.error);
      if (providerError !== null) {
        return {
          kind: 'item',
          item: {
            index,
            ok: false,
            failure: toFailure(providerError, true),
            durationMs: Date.now() - itemStarted,
          },
        };
      }
    }

    if (typeof record.b64_json !== 'string') {
      return {
        kind: 'fatal',
        failure: { message: 'Image response item had no b64_json payload', retryable: true },
      };
    }
    const bytes = decodeBase64(record.b64_json);
    if (bytes === null) {
      return {
        kind: 'fatal',
        failure: { message: 'Image response item had an empty base64 payload', retryable: true },
      };
    }

    const item: GeneratedItem = {
      index,
      ok: true,
      bytes,
      width: request.width,
      height: request.height,
      seed: request.seed,
      durationMs: Date.now() - itemStarted,
    };
    const revisedPrompt = readRevisedPrompt(record) ?? readRevisedPrompt(bodyRecord);
    if (revisedPrompt !== undefined) item.revisedPrompt = revisedPrompt;
    return { kind: 'item', item };
  }

  private model(): string {
    const configured = this.config.model?.trim();
    return configured !== undefined && configured !== '' ? configured : FALLBACK_MODEL;
  }

  private generationPayload(request: GenerationRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.model(),
      prompt: request.prompt,
      size: `${request.width}x${request.height}`,
      n: 1,
      response_format: 'b64_json',
    };
    if (request.seed !== undefined) payload.seed = request.seed;
    return payload;
  }

  private editForm(request: GenerationRequest, parts: ReferencePart[]): FormData {
    const form = new FormData();
    form.set('model', this.model());
    form.set('prompt', request.prompt);
    form.set('size', `${request.width}x${request.height}`);
    form.set('n', '1');
    form.set('response_format', 'b64_json');
    if (request.seed !== undefined) form.set('seed', String(request.seed));
    for (const part of parts) {
      form.append('image', new Blob([part.bytes], { type: part.mimeType }), part.filename);
    }
    return form;
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

  private async postForm(path: string, form: FormData, signal: AbortSignal): Promise<HttpResult> {
    const url = joinUrl(this.config.baseUrl, path);
    const response = await fetch(url, { method: 'POST', headers: this.headers(), body: form, signal });
    return { ok: response.ok, status: response.status, url, body: await readJsonBody(response) };
  }
}

export function createOpenAIImagesAdapter(config: ProviderConfig): OpenAIImagesAdapter {
  return new OpenAIImagesAdapter(config);
}
