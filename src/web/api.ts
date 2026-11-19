// The typed client for the HTTP contract in docs/api-contract.md.
// One function per endpoint, JSON in and out, and a typed error for every failure.

import type {
  BatchRecord,
  GenerationEvent,
  H3ModelVariant,
  Preset,
  ProviderCapabilities,
  ProviderConfig,
  ReferenceImage,
} from '../core/types';

export interface StudioStats {
  batchCount: number;
  imageCount: number;
  bytes: number;
  providerCount: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

export interface OkResponse {
  ok: boolean;
}

export interface BatchIdResponse {
  batchId: string;
}

export interface GenerationBody {
  providerId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  referenceIds?: string[];
  enhancePrompt?: boolean;
  modelVariant?: H3ModelVariant;
}

export interface ReferenceBody {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface ExportBody {
  imageIds: string[];
  format: ExportFormat;
}

export type ExportFormat = 'png' | 'jpeg';

export interface ImageQuery {
  download?: boolean;
  format?: ExportFormat;
}

/** An API failure with the HTTP status and the server error code, when there is one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusMessage(status: number): string {
  if (status === 0) return 'The studio server is not reachable.';
  return `The studio server answered with status ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorFromBody(body: unknown, status: number): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const { error } = body;
    const message = typeof error.message === 'string' ? error.message : statusMessage(status);
    const code = typeof error.code === 'string' ? error.code : null;
    return new ApiError(message, status, code);
  }
  return new ApiError(statusMessage(status), status);
}

async function send(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) throw errorFromBody(await readJson(response), response.status);
  return readJson(response);
}

async function sendBlob(path: string, init: RequestInit): Promise<Blob> {
  const response = await fetch(path, init);
  if (!response.ok) throw errorFromBody(await readJson(response), response.status);
  return response.blob();
}

export async function getHealth(): Promise<HealthResponse> {
  return (await send('GET', '/api/health')) as HealthResponse;
}

export async function listProviders(): Promise<ProviderConfig[]> {
  return (await send('GET', '/api/providers')) as ProviderConfig[];
}

export async function createProvider(input: Omit<ProviderConfig, 'id'>): Promise<ProviderConfig> {
  return (await send('POST', '/api/providers', input)) as ProviderConfig;
}

/** The id travels in the path, so the body is a partial config without one. */
export async function updateProvider(id: string, patch: Partial<Omit<ProviderConfig, 'id'>>): Promise<ProviderConfig> {
  return (await send('PATCH', `/api/providers/${encodeURIComponent(id)}`, patch)) as ProviderConfig;
}

export async function deleteProvider(id: string): Promise<OkResponse> {
  return (await send('DELETE', `/api/providers/${encodeURIComponent(id)}`)) as OkResponse;
}

export async function checkProviderHealth(id: string): Promise<ProviderHealth> {
  return (await send('GET', `/api/providers/${encodeURIComponent(id)}/health`)) as ProviderHealth;
}

export async function getProviderCapabilities(id: string): Promise<ProviderCapabilities> {
  return (await send('GET', `/api/providers/${encodeURIComponent(id)}/capabilities`)) as ProviderCapabilities;
}

export async function uploadReference(input: ReferenceBody): Promise<ReferenceImage> {
  return (await send('POST', '/api/references', input)) as ReferenceImage;
}

export async function startGeneration(body: GenerationBody): Promise<BatchIdResponse> {
  return (await send('POST', '/api/generations', body)) as BatchIdResponse;
}

export async function listBatches(limit?: number): Promise<BatchRecord[]> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return (await send('GET', `/api/batches${query}`)) as BatchRecord[];
}

export async function getBatch(id: string): Promise<BatchRecord> {
  return (await send('GET', `/api/batches/${encodeURIComponent(id)}`)) as BatchRecord;
}

export async function deleteBatch(id: string): Promise<OkResponse> {
  return (await send('DELETE', `/api/batches/${encodeURIComponent(id)}`)) as OkResponse;
}

export async function retryBatch(id: string, indices: number[]): Promise<BatchIdResponse> {
  return (await send('POST', `/api/batches/${encodeURIComponent(id)}/retry`, { indices })) as BatchIdResponse;
}

export function imageUrl(id: string, query: ImageQuery = {}): string {
  const params = new URLSearchParams();
  if (query.download === true) params.set('download', '1');
  if (query.format !== undefined) params.set('format', query.format);
  const search = params.toString();
  return `/api/images/${encodeURIComponent(id)}${search.length > 0 ? `?${search}` : ''}`;
}

/** Image bytes are never inlined in JSON, so this endpoint returns a Blob. */
export async function fetchImage(id: string, query: ImageQuery = {}): Promise<Blob> {
  return sendBlob(imageUrl(id, query), { method: 'GET' });
}

export async function exportImages(body: ExportBody): Promise<Blob> {
  return sendBlob('/api/export', {
    method: 'POST',
    headers: { Accept: 'application/zip', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listPresets(): Promise<Preset[]> {
  return (await send('GET', '/api/presets')) as Preset[];
}

export async function createPreset(input: Omit<Preset, 'id' | 'createdAt'>): Promise<Preset> {
  return (await send('POST', '/api/presets', input)) as Preset;
}

export async function deletePreset(id: string): Promise<OkResponse> {
  return (await send('DELETE', `/api/presets/${encodeURIComponent(id)}`)) as OkResponse;
}

export async function getStats(): Promise<StudioStats> {
  return (await send('GET', '/api/stats')) as StudioStats;
}

type ProgressEvent = Extract<GenerationEvent, { type: 'progress' }>;
type ItemEvent = Extract<GenerationEvent, { type: 'item' }>;

type StreamEvent =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'item'; event: ItemEvent }
  | { type: 'batch'; batch: BatchRecord };

export interface GenerationStreamHandlers {
  onProgress?: (event: ProgressEvent) => void;
  onItem?: (event: ItemEvent) => void;
  /** Called once for the final batch, after which the stream is closed. */
  onBatch?: (batch: BatchRecord) => void;
  onError?: (error: Error) => void;
}

function parseStreamEvent(raw: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  // The server writes the shapes from src/core/types.ts, so once the
  // discriminator matches the payload is trusted as written.
  if (value.type === 'progress') return { type: 'progress', event: value as unknown as ProgressEvent };
  if (value.type === 'item') return { type: 'item', event: value as unknown as ItemEvent };
  if (value.type === 'batch') return { type: 'batch', batch: value.batch as unknown as BatchRecord };
  return null;
}

/**
 * Opens the server sent events stream for a batch.
 * Returns an unsubscribe function that closes the stream.
 */
export function openGenerationEvents(batchId: string, handlers: GenerationStreamHandlers): () => void {
  const source = new EventSource(`/api/generations/${encodeURIComponent(batchId)}/events`);
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (message: MessageEvent<string>): void => {
    if (closed) return;
    const parsed = parseStreamEvent(message.data);
    if (parsed === null) return;
    if (parsed.type === 'progress') {
      handlers.onProgress?.(parsed.event);
      return;
    }
    if (parsed.type === 'item') {
      handlers.onItem?.(parsed.event);
      return;
    }
    // The batch event ends the stream, so close before handing over: a throwing
    // consumer must not leave the connection open.
    close();
    handlers.onBatch?.(parsed.batch);
  };

  source.onerror = (): void => {
    if (closed) return;
    close();
    handlers.onError?.(new Error('The generation event stream closed before the batch finished.'));
  };

  return close;
}
