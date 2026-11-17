// Integration tests for the studio HTTP API from docs/api-contract.md.
// One real express app on a loopback socket, one temporary data directory, the mock
// provider only, and no traffic beyond the test's own socket.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthImage } from '../../src/core/png';
import { LibraryStore, createId } from '../../src/core/store';
import type {
  BatchRecord,
  Preset,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
  ReferenceImage,
} from '../../src/core/types';
import { createApp } from '../../src/server/app';
import { GenerationHub, type BatchStreamEvent } from '../../src/server/jobs';
import type { GenerationBody, StudioStats } from '../../src/web/api';

interface ApiResult<T> {
  status: number;
  body: T | null;
  headers: Headers;
}

type ItemStreamEvent = Extract<BatchStreamEvent, { type: 'item' }>;

let server: Server;
let baseUrl = '';
let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'h3-api-'));
  server = createServer(createApp({ dataDir }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server has no port.');
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
  await rm(dataDir, { recursive: true, force: true });
});

async function api<T>(method: string, requestPath: string, body?: unknown): Promise<ApiResult<T>> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${requestPath}`, init);
  const text = await response.text();
  let parsed: T | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function bodyOf<T>(result: ApiResult<T>): T {
  if (result.body === null) throw new Error(`Expected JSON, received status ${result.status}.`);
  return result.body;
}

interface ErrorEnvelope {
  message: string;
  code: string;
}

function errorOf(body: unknown): ErrorEnvelope {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error('Expected the contract error envelope.');
  }
  const envelope = body.error;
  if (typeof envelope !== 'object' || envelope === null) throw new Error('Expected an error object.');
  const message = 'message' in envelope && typeof envelope.message === 'string' ? envelope.message : '';
  const code = 'code' in envelope && typeof envelope.code === 'string' ? envelope.code : '';
  return { message, code };
}

async function startGeneration(body: GenerationBody): Promise<string> {
  const result = await api<{ batchId: string }>('POST', '/api/generations', body);
  expect(result.status).toBe(202);
  return bodyOf(result).batchId;
}

async function waitForSettled(batchId: string): Promise<BatchRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await api<BatchRecord>('GET', `/api/batches/${encodeURIComponent(batchId)}`);
    if (result.status === 200) {
      const batch = bodyOf(result);
      if (batch.status !== 'queued' && batch.status !== 'running') return batch;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Batch ${batchId} did not settle within ten seconds.`);
}

/** Reads the SSE stream until the closing batch event, then hangs up. */
async function readEvents(batchId: string): Promise<BatchStreamEvent[]> {
  const response = await fetch(`${baseUrl}/api/generations/${encodeURIComponent(batchId)}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const body = response.body;
  if (body === null) throw new Error('The event stream has no body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: BatchStreamEvent[] = [];
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (data.length > 0) events.push(JSON.parse(data) as BatchStreamEvent);
        boundary = buffer.indexOf('\n\n');
      }
      if (events.some((event) => event.type === 'batch')) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

function itemEventsOf(events: BatchStreamEvent[]): ItemStreamEvent[] {
  return events.filter((event): event is ItemStreamEvent => event.type === 'item');
}

function batchOf(events: BatchStreamEvent[]): BatchRecord {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === 'batch') return event.batch;
  }
  throw new Error('The stream ended without a batch event.');
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** Reads the entry count out of the end of central directory record. */
function zipEntryCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return view.getUint16(offset + 10, true);
  }
  throw new Error('No end of central directory record in the zip.');
}

describe('health and the provider surface', () => {
  it('reports health', async () => {
    const result = await api<{ ok: boolean; version: string }>('GET', '/api/health');
    expect(result.status).toBe(200);
    const health = bodyOf(result);
    expect(health.ok).toBe(true);
    expect(health.version.length).toBeGreaterThan(0);
  });

  it('lists the seeded providers', async () => {
    const result = await api<ProviderConfig[]>('GET', '/api/providers');
    expect(result.status).toBe(200);
    const providers = bodyOf(result);
    expect(providers.map((config) => config.kind).sort()).toEqual(['a1111', 'comfyui', 'mock', 'openai-images']);
    const mock = providers.find((config) => config.kind === 'mock');
    expect(mock?.enabled).toBe(true);
    expect(mock?.baseUrl).toBe('mock://local');
    for (const other of providers.filter((config) => config.kind !== 'mock')) {
      expect(other.enabled).toBe(false);
    }
  });

  it('creates, updates and deletes a provider', async () => {
    const created = await api<ProviderConfig>('POST', '/api/providers', {
      kind: 'a1111',
      label: 'Second A1111',
      baseUrl: 'http://127.0.0.1:7861',
      enabled: false,
    });
    expect(created.status).toBe(201);
    const provider = bodyOf(created);
    expect(provider.id.length).toBeGreaterThan(0);
    expect(provider.label).toBe('Second A1111');
    expect(provider.baseUrl).toBe('http://127.0.0.1:7861');

    const patched = await api<ProviderConfig>('PATCH', `/api/providers/${provider.id}`, {
      label: 'Renamed A1111',
      enabled: true,
    });
    expect(patched.status).toBe(200);
    const updated = bodyOf(patched);
    expect(updated.id).toBe(provider.id);
    expect(updated.label).toBe('Renamed A1111');
    expect(updated.enabled).toBe(true);
    expect(updated.kind).toBe('a1111');
    expect(updated.baseUrl).toBe('http://127.0.0.1:7861');

    const missing = await api('PATCH', '/api/providers/provider_missing', { label: 'Nope' });
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe('unknown_provider');

    const deleted = await api<{ ok: boolean }>('DELETE', `/api/providers/${provider.id}`);
    expect(deleted.status).toBe(200);
    expect(bodyOf(deleted).ok).toBe(true);

    const listed = bodyOf(await api<ProviderConfig[]>('GET', '/api/providers'));
    expect(listed.some((config) => config.id === provider.id)).toBe(false);

    const again = await api('DELETE', `/api/providers/${provider.id}`);
    expect(again.status).toBe(404);
    expect(errorOf(again.body).code).toBe('unknown_provider');
  });

  it('rejects a bad provider body with the contract error envelope', async () => {
    const bad = await api('POST', '/api/providers', { kind: 'nonsense', label: '', baseUrl: 42 });
    expect(bad.status).toBe(400);
    const error = errorOf(bad.body);
    expect(error.code).toBe('invalid_body');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"kind":',
    });
    expect(response.status).toBe(400);
    expect(errorOf(await response.json()).code).toBe('invalid_body');
  });

  it('reports capabilities and health for a provider', async () => {
    const capabilities = await api<ProviderCapabilities>('GET', '/api/providers/mock/capabilities');
    expect(capabilities.status).toBe(200);
    const caps = bodyOf(capabilities);
    expect(caps.maxBatch).toBe(10);
    expect(caps.sizeMultiple).toBe(8);
    expect(caps.maxReferenceImages).toBeGreaterThan(0);
    expect(caps.outputFormats).toEqual(['png']);

    const health = await api<{ ok: boolean; detail?: string }>('GET', '/api/providers/mock/health');
    expect(health.status).toBe(200);
    expect(bodyOf(health).ok).toBe(true);

    const unknown = await api('GET', '/api/providers/nope/capabilities');
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.body).code).toBe('unknown_provider');
  });
});

describe('references and generation', () => {
  it('uploads a reference and resolves its path for a generation', async () => {
    const png = synthImage({ width: 64, height: 64, seed: 3, label: 'reference' });
    const uploaded = await api<ReferenceImage>('POST', '/api/references', {
      filename: 'swatch.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from(png).toString('base64'),
    });
    expect(uploaded.status).toBe(201);
    const reference = bodyOf(uploaded);
    expect(reference.id.startsWith('ref_')).toBe(true);
    expect(reference.filename).toBe('swatch.png');
    expect(reference.mimeType).toBe('image/png');
    expect(path.isAbsolute(reference.path)).toBe(true);
    expect(reference.path.startsWith(dataDir)).toBe(true);
    expect(path.extname(reference.path)).toBe('.png');
    const stored = await readFile(reference.path);
    expect(Buffer.compare(stored, Buffer.from(png))).toBe(0);

    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'a reference driven plate',
      width: 256,
      height: 256,
      count: 1,
      referenceIds: [reference.id],
    });
    const batch = batchOf(await readEvents(batchId));
    expect(batch.status).toBe('complete');
    expect(batch.images).toHaveLength(1);

    const unknown = await api('POST', '/api/generations', {
      providerId: 'mock',
      prompt: 'a missing reference',
      width: 256,
      height: 256,
      count: 1,
      referenceIds: ['ref_missing'],
    });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown.body).code).toBe('unknown_reference');
  });

  it('rejects an unsupported reference mime type', async () => {
    const bad = await api('POST', '/api/references', {
      filename: 'loop.gif',
      mimeType: 'image/gif',
      dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body).code).toBe('unsupported_mime');
  });

  it('streams a three image generation and stores every image', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'three porcelain plates',
      width: 128,
      height: 96,
      count: 3,
      seed: 11,
    });
    const events = await readEvents(batchId);
    const items = itemEventsOf(events);
    expect(items).toHaveLength(3);
    expect(items.map((event) => event.index).sort((left, right) => left - right)).toEqual([0, 1, 2]);
    expect(items.every((event) => event.item.ok)).toBe(true);
    for (const event of items) {
      // Bytes stay in the store: an item event carries metadata only.
      expect(Object.keys(event.item).includes('bytes')).toBe(false);
    }
    expect(events.some((event) => event.type === 'progress')).toBe(true);

    const batch = batchOf(events);
    expect(batch.status).toBe('complete');
    expect(batch.requested).toBe(3);
    expect(batch.images).toHaveLength(3);

    for (const image of batch.images) {
      const response = await fetch(`${baseUrl}/api/images/${image.id}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/png');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(isPng(bytes)).toBe(true);
      expect(bytes.byteLength).toBe(image.bytes);
      expect(image.width).toBe(128);
      expect(image.height).toBe(96);
    }

    const [first] = batch.images;
    if (first === undefined) throw new Error('The batch stored no image.');
    const download = await fetch(`${baseUrl}/api/images/${first.id}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-disposition')).toContain('.png');

    const jpeg = await fetch(`${baseUrl}/api/images/${first.id}?format=jpeg`);
    expect(jpeg.status).toBe(415);
    expect(errorOf(await jpeg.json()).code).toBe('unsupported_format');

    const missing = await api('GET', '/api/images/img_missing');
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe('unknown_image');
  });

  it('records a partial batch when the mock provider fails one item', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'FAIL_ONE a lighthouse at dusk',
      width: 128,
      height: 128,
      count: 3,
    });
    const events = await readEvents(batchId);
    const batch = batchOf(events);
    expect(batch.status).toBe('partial');
    expect(batch.failures).toHaveLength(1);
    expect(batch.failures[0]?.index).toBe(0);
    expect(batch.failures[0]?.code).toBe('mock_forced_failure');
    expect(batch.failures[0]?.retryable).toBe(true);
    expect(batch.images).toHaveLength(2);

    const failedItems = itemEventsOf(events).filter((event) => !event.item.ok);
    expect(failedItems).toHaveLength(1);
    expect(failedItems[0]?.index).toBe(0);
    expect(failedItems[0]?.item.failure?.code).toBe('mock_forced_failure');
  });

  it('persists a batch for a client that never opens the stream', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'no subscriber here',
      width: 128,
      height: 64,
      count: 2,
    });
    const batch = await waitForSettled(batchId);
    expect(batch.status).toBe('complete');
    expect(batch.images).toHaveLength(2);
    const listed = bodyOf(await api<BatchRecord[]>('GET', '/api/batches'));
    expect(listed.some((candidate) => candidate.id === batchId)).toBe(true);
  });

  it('replays every buffered event to a late subscriber', async () => {    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'late to the party',
      width: 96,
      height: 96,
      count: 2,
    });
    const settled = await waitForSettled(batchId);
    expect(settled.status).toBe('complete');
    const events = await readEvents(batchId);
    expect(itemEventsOf(events)).toHaveLength(2);
    expect(events.some((event) => event.type === 'progress')).toBe(true);
    expect(batchOf(events).id).toBe(batchId);
  });

  it('runs two generations at once without mixing their images', async () => {
    const firstId = await startGeneration({
      providerId: 'mock',
      prompt: 'concurrent one',
      width: 96,
      height: 96,
      count: 2,
    });
    const secondId = await startGeneration({
      providerId: 'mock',
      prompt: 'concurrent two',
      width: 96,
      height: 64,
      count: 2,
    });
    expect(firstId).not.toBe(secondId);

    const [first, second] = await Promise.all([waitForSettled(firstId), waitForSettled(secondId)]);
    expect(first.status).toBe('complete');
    expect(second.status).toBe('complete');
    expect(first.images).toHaveLength(2);
    expect(second.images).toHaveLength(2);
    for (const image of first.images) expect(image.batchId).toBe(firstId);
    for (const image of second.images) expect(image.batchId).toBe(secondId);
  });

  it('cancels a run when its only subscriber disconnects', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'cancel this run',
      width: 256,
      height: 256,
      count: 10,
    });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/generations/${batchId}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const body = response.body;
    if (body === null) throw new Error('The event stream has no body.');
    const reader = body.getReader();
    const first = await reader.read();
    const opening = new TextDecoder().decode(first.value ?? new Uint8Array());
    expect(opening.startsWith('retry: 0\n\n')).toBe(true);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    const batch = await waitForSettled(batchId);
    expect(batch.status).toBe('cancelled');
  });

  it('rejects malformed generation bodies and unknown providers', async () => {
    const bodies = [
      { providerId: 'mock', prompt: '', width: 512, height: 512, count: 1 },
      { providerId: 'mock', prompt: 'a plate', width: 0, height: 512, count: 1 },
      { providerId: 'mock', prompt: 'a plate', width: 512, height: 512, count: 99 },
      { providerId: 'mock', prompt: 'a plate', width: 512.5, height: 512, count: 1 },
      { providerId: 'mock', prompt: 'a plate', width: '512', height: 512, count: 1 },
      { providerId: 'mock', prompt: 'a plate', width: 512, height: 512, count: 1, seed: -4 },
    ];
    for (const body of bodies) {
      const result = await api('POST', '/api/generations', body);
      expect(result.status).toBe(400);
      expect(errorOf(result.body).code).toBe('invalid_body');
    }

    const unknown = await api('POST', '/api/generations', {
      providerId: 'not-a-provider',
      prompt: 'a plate',
      width: 512,
      height: 512,
      count: 1,
    });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.body).code).toBe('unknown_provider');
  });

  it('answers 404 for the events of an unknown batch', async () => {
    const result = await api('GET', '/api/generations/batch_missing/events');
    expect(result.status).toBe(404);
    expect(errorOf(result.body).code).toBe('unknown_batch');
  });

  it('replays a stored batch when this process has no job for it', async () => {
    // The shape a restart leaves behind: the batch is in the library, no job is running.
    const store = new LibraryStore({ rootDir: dataDir });
    const batch = await store.createBatch({
      id: createId('batch'),
      providerId: 'mock',
      prompt: 'from an earlier run',
      width: 64,
      height: 64,
      requested: 1,
      status: 'complete',
    });
    const events = await readEvents(batch.id);
    expect(events).toHaveLength(1);
    const replayed = batchOf(events);
    expect(replayed.id).toBe(batch.id);
    expect(replayed.status).toBe('complete');
  });
});

describe('the library surface', () => {
  it('retries selected indices as a new batch', async () => {
    const originalId = await startGeneration({
      providerId: 'mock',
      prompt: 'retry these plates',
      width: 128,
      height: 64,
      count: 3,
      seed: 21,
    });
    const original = batchOf(await readEvents(originalId));
    expect(original.status).toBe('complete');
    expect(original.images).toHaveLength(3);

    const retried = await api<{ batchId: string }>('POST', `/api/batches/${originalId}/retry`, {
      indices: [0, 2],
    });
    expect(retried.status).toBe(202);
    const retryId = bodyOf(retried).batchId;
    expect(retryId).not.toBe(originalId);

    const batch = batchOf(await readEvents(retryId));
    expect(batch.status).toBe('complete');
    expect(batch.requested).toBe(2);
    expect(batch.images).toHaveLength(2);
    expect(batch.prompt).toBe(original.prompt);
    expect(batch.width).toBe(original.width);
    expect(batch.height).toBe(original.height);
    expect(batch.providerId).toBe(original.providerId);
    expect(batch.seed).toBe(original.seed);

    const unchanged = bodyOf(await api<BatchRecord>('GET', `/api/batches/${originalId}`));
    expect(unchanged.requested).toBe(3);
    expect(unchanged.images).toHaveLength(3);
    expect(unchanged.status).toBe('complete');

    const outside = await api('POST', `/api/batches/${originalId}/retry`, { indices: [7] });
    expect(outside.status).toBe(400);
    expect(errorOf(outside.body).code).toBe('invalid_indices');

    const repeated = await api('POST', `/api/batches/${originalId}/retry`, { indices: [1, 1] });
    expect(repeated.status).toBe(400);
    expect(errorOf(repeated.body).code).toBe('invalid_indices');

    const missing = await api('POST', '/api/batches/batch_missing/retry', { indices: [0] });
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe('unknown_batch');
  });

  it('lists and deletes batches', async () => {
    const listed = await api<BatchRecord[]>('GET', '/api/batches');
    expect(listed.status).toBe(200);
    const all = bodyOf(listed);
    expect(all.length).toBeGreaterThanOrEqual(2);

    const limited = bodyOf(await api<BatchRecord[]>('GET', '/api/batches?limit=1'));
    expect(limited).toHaveLength(1);

    const badLimit = await api('GET', '/api/batches?limit=all');
    expect(badLimit.status).toBe(400);
    expect(errorOf(badLimit.body).code).toBe('invalid_query');

    const [target] = all;
    if (target === undefined) throw new Error('The library listed no batch.');
    const detail = bodyOf(await api<BatchRecord>('GET', `/api/batches/${target.id}`));
    expect(detail.id).toBe(target.id);

    const imageId = target.images[0]?.id;
    const deleted = await api<{ ok: boolean }>('DELETE', `/api/batches/${target.id}`);
    expect(deleted.status).toBe(200);
    expect(bodyOf(deleted).ok).toBe(true);

    const gone = await api('GET', `/api/batches/${target.id}`);
    expect(gone.status).toBe(404);
    expect(errorOf(gone.body).code).toBe('unknown_batch');

    if (imageId !== undefined) {
      const image = await api('GET', `/api/images/${imageId}`);
      expect(image.status).toBe(404);
    }

    const again = await api('DELETE', `/api/batches/${target.id}`);
    expect(again.status).toBe(404);
  });

  it('exports a zip of the requested images', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'export these plates',
      width: 96,
      height: 96,
      count: 3,
    });
    const batch = batchOf(await readEvents(batchId));
    expect(batch.images).toHaveLength(3);
    const imageIds = batch.images.map((image) => image.id);

    const response = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds, format: 'png' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(zipEntryCount(bytes)).toBe(3);

    const jpeg = await api('POST', '/api/export', { imageIds, format: 'jpeg' });
    expect(jpeg.status).toBe(415);
    expect(errorOf(jpeg.body).code).toBe('unsupported_format');

    const missing = await api('POST', '/api/export', { imageIds: ['img_missing'], format: 'png' });
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe('unknown_image');
  });

  it('creates and deletes presets', async () => {
    const empty = bodyOf(await api<Preset[]>('GET', '/api/presets'));
    expect(empty).toEqual([]);

    const created = await api<Preset>('POST', '/api/presets', {
      name: 'Square 512',
      prompt: 'a quiet studio',
      width: 512,
      height: 512,
      count: 1,
    });
    expect(created.status).toBe(201);
    const preset = bodyOf(created);
    expect(preset.id.startsWith('preset_')).toBe(true);
    expect(preset.name).toBe('Square 512');

    const listed = bodyOf(await api<Preset[]>('GET', '/api/presets'));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(preset.id);

    const bad = await api('POST', '/api/presets', { name: '', prompt: 'x', width: 0, height: 512, count: 1 });
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body).code).toBe('invalid_body');

    const removed = await api<{ ok: boolean }>('DELETE', `/api/presets/${preset.id}`);
    expect(removed.status).toBe(200);
    expect(bodyOf(removed).ok).toBe(true);
    expect(bodyOf(await api<Preset[]>('GET', '/api/presets'))).toEqual([]);

    const again = await api('DELETE', `/api/presets/${preset.id}`);
    expect(again.status).toBe(404);
    expect(errorOf(again.body).code).toBe('unknown_preset');
  });

  it('reports stats that match the library', async () => {
    const stats = bodyOf(await api<StudioStats>('GET', '/api/stats'));
    const batches = bodyOf(await api<BatchRecord[]>('GET', '/api/batches'));
    const providers = bodyOf(await api<ProviderConfig[]>('GET', '/api/providers'));

    const imageCount = batches.reduce((total, batch) => total + batch.images.length, 0);
    const bytes = batches.reduce(
      (total, batch) => total + batch.images.reduce((sum, image) => sum + image.bytes, 0),
      0,
    );

    expect(stats.batchCount).toBe(batches.length);
    expect(stats.imageCount).toBe(imageCount);
    expect(stats.bytes).toBe(bytes);
    expect(stats.providerCount).toBe(providers.length);
    expect(stats.imageCount).toBeGreaterThan(0);
  });
});

describe('generation hub', () => {
  it('fails the batch and closes the stream when the adapter throws', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'h3-hub-'));
    try {
      const store = new LibraryStore({ rootDir });
      await store.init();
      const broken: ProviderAdapter = {
        id: 'mock',
        label: 'Broken mock',
        kind: 'mock',
        health: async () => ({ ok: false, detail: 'broken on purpose' }),
        capabilities: async () => {
          throw new Error('broken on purpose');
        },
        generate: async () => {
          throw new Error('adapter exploded');
        },
      };
      const hub = new GenerationHub({ store, adapterFactory: () => broken });
      const config: ProviderConfig = { id: 'mock', kind: 'mock', label: 'Broken mock', baseUrl: 'mock://broken' };
      const batch = await hub.start(config, { prompt: 'will fail', width: 64, height: 64, count: 2 });

      const events: BatchStreamEvent[] = [];
      hub.subscribe(batch.id, (event) => {
        events.push(event);
      });

      const deadline = Date.now() + 5_000;
      while (!events.some((event) => event.type === 'batch') && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      const closing = events.find((event) => event.type === 'batch');
      if (closing === undefined || closing.type !== 'batch') throw new Error('No batch event was published.');
      expect(closing.batch.status).toBe('failed');
      expect(closing.batch.failures).toHaveLength(1);
      expect(closing.batch.failures[0]?.message).toContain('adapter exploded');

      const stored = await store.getBatch(batch.id);
      expect(stored?.status).toBe('failed');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
