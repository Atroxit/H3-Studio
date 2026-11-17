// End to end coverage of the studio over a real loopback socket.
// createApp is the real server; only the data directory is temporary. The provider is the
// deterministic mock, so nothing here opens a network connection or needs a GPU.
//
// Every test creates its own batch, so a single test can be run alone with -t. The shared
// data directory only affects aggregate numbers, and every aggregate assertion is checked
// against the batch list fetched in the same test.

import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatchRecord, ProviderCapabilities, ProviderConfig } from '../../src/core/types';
import { createApp } from '../../src/server/app';
import type { BatchStreamEvent } from '../../src/server/jobs';
import type { GenerationBody, StudioStats } from '../../src/web/api';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Generous: the mock needs a few hundred milliseconds, a hung server must fail the wait. */
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 25;
const ZIP_END_RECORD_BYTES = 22;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;

type ItemStreamEvent = Extract<BatchStreamEvent, { type: 'item' }>;

let server: Server | null = null;
let dataDir: string | null = null;
let baseUrl = '';

beforeAll(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'h3-e2e-'));
  dataDir = directory;
  const app = createApp({ dataDir: directory });
  const listening = app.listen(0, '127.0.0.1');
  server = listening;
  try {
    await new Promise<void>((resolve, reject) => {
      listening.once('listening', () => {
        listening.off('error', reject);
        resolve();
      });
      listening.once('error', reject);
    });
    const address = listening.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The test server did not report a loopback port.');
    }
    // Port 0 is chosen by the kernel. The URL is read from the socket, never assumed.
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    // A server that failed half way to listening must not leave a socket or directory behind.
    await teardown();
    throw error;
  }
});

afterAll(async () => {
  await teardown();
});

/** Closes the socket first, then removes the temporary data directory. Safe to call twice. */
async function teardown(): Promise<void> {
  const running = server;
  server = null;
  if (running !== null && running.listening) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
      // An open event stream never goes idle, so close alone would wait for it forever.
      running.closeAllConnections();
    });
  }
  const directory = dataDir;
  dataDir = null;
  if (directory !== null) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}...` : oneLine;
}

interface ApiResponse<T> {
  status: number;
  text: string;
  headers: Headers;
  body: T | null;
}

async function api<T>(method: string, requestPath: string, body?: unknown): Promise<ApiResponse<T>> {
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
  return { status: response.status, text, headers: response.headers, body: parsed };
}

function bodyOf<T>(response: ApiResponse<T>, request: string): T {
  if (response.body === null) {
    throw new Error(
      `${request} did not answer with JSON. Status ${response.status}. Body: ${shorten(response.text)}`,
    );
  }
  return response.body;
}

async function startGeneration(body: GenerationBody): Promise<string> {
  const request = 'POST /api/generations';
  const response = await api<{ batchId: string }>('POST', '/api/generations', body);
  expect(
    response.status,
    `${request} answered ${response.status}. Body: ${shorten(response.text)}`,
  ).toBe(202);
  const payload = bodyOf(response, request);
  expect(
    typeof payload.batchId,
    `${request} returned no batchId. Body: ${shorten(response.text)}`,
  ).toBe('string');
  return payload.batchId;
}

/** Reads the event stream until the closing batch event, then hangs up. */
async function readEvents(batchId: string): Promise<BatchStreamEvent[]> {
  const controller = new AbortController();
  const url = `${baseUrl}/api/generations/${encodeURIComponent(batchId)}/events`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.status, `GET ${url} answered ${response.status}.`).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
    const body = response.body;
    if (body === null) throw new Error(`GET ${url} returned no event stream body.`);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const events: BatchStreamEvent[] = [];
    let buffer = '';
    try {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('');
          if (data.length > 0) events.push(JSON.parse(data) as BatchStreamEvent);
          boundary = buffer.indexOf('\n\n');
        }
        if (events.some((event) => event.type === 'batch')) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!events.some((event) => event.type === 'batch')) {
      throw new Error(`The stream for batch ${batchId} ended without a batch event.`);
    }
    return events;
  } finally {
    // A failed assertion earlier in the test must not leave this socket open.
    controller.abort();
  }
}

function batchOf(events: BatchStreamEvent[]): BatchRecord {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === 'batch') return event.batch;
  }
  throw new Error('The stream carried no batch event.');
}

function startsWithPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

async function fetchImageBytes(imageId: string): Promise<Uint8Array> {
  const url = `${baseUrl}/api/images/${encodeURIComponent(imageId)}`;
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 200) {
    throw new Error(
      `GET ${url} answered ${response.status}: ${shorten(new TextDecoder().decode(bytes))}`,
    );
  }
  expect(response.headers.get('content-type') ?? '', `GET ${url} sent the wrong content type.`).toContain(
    'image/png',
  );
  expect(
    startsWithPngSignature(bytes),
    `GET ${url} did not start with the PNG signature. First bytes: ${Array.from(bytes.subarray(0, 8)).join(',')}`,
  ).toBe(true);
  return bytes;
}

async function waitForSettled(batchId: string): Promise<BatchRecord> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    const request = `GET /api/batches/${batchId}`;
    const response = await api<BatchRecord>('GET', `/api/batches/${encodeURIComponent(batchId)}`);
    if (response.status === 200 && response.body !== null) {
      const batch = response.body;
      if (batch.status !== 'queued' && batch.status !== 'running') return batch;
      last = `status ${batch.status}`;
    } else {
      last = `status ${response.status}, body ${shorten(response.text)}`;
    }
    expect(response.status, `${request} answered ${response.status}: ${shorten(response.text)}`).toBe(200);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Batch ${batchId} did not settle within ${SETTLE_TIMEOUT_MS} ms (${last}).`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Returns a description of what is wrong with a /api/batches body, or null when it is sound. */
function describeBatchListProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'a body that is not an array';
  for (const entry of value) {
    if (!isRecord(entry)) return 'an array entry that is not an object';
    if (typeof entry.id !== 'string') return 'an array entry with no id';
    if (typeof entry.status !== 'string') return `batch ${entry.id} with no status`;
    if (!Array.isArray(entry.images)) return `batch ${entry.id} with no images array`;
    if (entry.images.some((image) => !isRecord(image))) {
      return `batch ${entry.id} with a malformed image`;
    }
  }
  return null;
}

/** Returns a description of what is wrong with a /api/stats body, or null when it is sound. */
function describeStatsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'a body that is not an object';
  for (const key of ['batchCount', 'imageCount', 'bytes', 'providerCount']) {
    if (typeof value[key] !== 'number') return `a body whose ${key} is not a number`;
  }
  return null;
}

interface PollLog {
  endpoint: string;
  requests: number;
  problems: string[];
}

/**
 * Polls one endpoint every POLL_INTERVAL_MS until stop() returns true, recording rather than
 * throwing so a probe failure is reported next to the batch it was probing. A broken response
 * stops the probe instead of being silently skipped.
 */
async function pollEndpoint(
  endpoint: string,
  stop: () => boolean,
  describeProblem: (value: unknown) => string | null,
): Promise<PollLog> {
  const log: PollLog = { endpoint, requests: 0, problems: [] };
  while (!stop()) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      log.requests += 1;
      if (response.status !== 200) {
        log.problems.push(`GET ${endpoint} answered ${response.status}: ${shorten(text)}`);
        return log;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      const problem = describeProblem(parsed);
      if (problem !== null) {
        log.problems.push(`GET ${endpoint} returned ${problem}: ${shorten(text)}`);
        return log;
      }
    } catch (error) {
      log.problems.push(
        `GET ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return log;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return log;
}

interface ZipEntryRecord {
  name: string;
  storedBytes: number;
}

interface ZipCentralDirectory {
  declaredCount: number;
  declaredSize: number;
  walkedSize: number;
  entries: ZipEntryRecord[];
}

/** Walks the central directory of a store-method zip, from its end of central directory record. */
function readCentralDirectory(archive: Uint8Array): ZipCentralDirectory {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let endOffset = -1;
  for (let offset = archive.byteLength - ZIP_END_RECORD_BYTES; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) {
    throw new Error(`The export (${archive.byteLength} bytes) has no end of central directory record.`);
  }
  const declaredCount = view.getUint16(endOffset + 10, true);
  const declaredSize = view.getUint32(endOffset + 12, true);
  const firstEntry = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntryRecord[] = [];
  let cursor = firstEntry;
  while (entries.length < declaredCount) {
    if (cursor + ZIP_CENTRAL_HEADER_BYTES > archive.byteLength) {
      throw new Error(`Central directory entry ${entries.length} runs past the archive.`);
    }
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Central directory entry ${entries.length} is not a central directory header.`);
    }
    const storedBytes = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + ZIP_CENTRAL_HEADER_BYTES;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.byteLength) {
      throw new Error(`Central directory entry ${entries.length} has a name past the archive.`);
    }
    entries.push({
      name: decoder.decode(archive.subarray(nameStart, nameEnd)),
      storedBytes,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return { declaredCount, declaredSize, walkedSize: cursor - firstEntry, entries };
}

describe('the studio, end to end over a real socket', () => {
  it('serves the mock provider and its capabilities', async () => {
    const providersRequest = 'GET /api/providers';
    const providersResponse = await api<ProviderConfig[]>('GET', '/api/providers');
    expect(providersResponse.status).toBe(200);
    const providers = bodyOf(providersResponse, providersRequest);
    const mock = providers.find((config) => config.id === 'mock');
    if (mock === undefined) {
      throw new Error(`${providersRequest} did not list the mock provider: ${shorten(providersResponse.text)}`);
    }
    expect(mock.kind).toBe('mock');
    expect(mock.baseUrl).toBe('mock://local');
    expect(mock.enabled).not.toBe(false);

    const capabilitiesRequest = 'GET /api/providers/mock/capabilities';
    const capabilitiesResponse = await api<ProviderCapabilities>(
      'GET',
      '/api/providers/mock/capabilities',
    );
    expect(capabilitiesResponse.status).toBe(200);
    const capabilities = bodyOf(capabilitiesResponse, capabilitiesRequest);
    expect(capabilities.seed).toBe(true);
    expect(capabilities.streamingProgress).toBe(true);
    expect(capabilities.maxBatch).toBeGreaterThanOrEqual(4);
    expect(capabilities.outputFormats).toContain('png');
  });

  it('streams a four image generation and serves every image as a PNG', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'end to end studio plates',
      width: 128,
      height: 96,
      count: 4,
      seed: 7,
    });

    const events = await readEvents(batchId);
    const items = events.filter((event): event is ItemStreamEvent => event.type === 'item');
    expect(items.map((event) => event.index).sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    expect(items.every((event) => event.item.ok)).toBe(true);
    expect(events.some((event) => event.type === 'progress')).toBe(true);

    const batch = batchOf(events);
    expect(batch.id).toBe(batchId);
    expect(batch.status).toBe('complete');
    expect(batch.requested).toBe(4);
    expect(batch.images.map((image) => image.index).sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3,
    ]);

    const seen = new Set<string>();
    for (const image of batch.images) {
      expect(seen.has(image.id), `Image ${image.id} appeared twice in batch ${batchId}.`).toBe(false);
      seen.add(image.id);
      const bytes = await fetchImageBytes(image.id);
      expect(bytes.byteLength).toBe(image.bytes);
      expect(image.width).toBe(128);
      expect(image.height).toBe(96);
    }
  });

  it('agrees between the batch list, stats and an export zip', async () => {
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'library plates for export',
      width: 96,
      height: 96,
      count: 4,
      seed: 13,
    });
    const settled = await waitForSettled(batchId);
    expect(settled.status).toBe('complete');
    expect(settled.images).toHaveLength(4);

    const listRequest = 'GET /api/batches';
    const listResponse = await api<BatchRecord[]>('GET', '/api/batches');
    expect(listResponse.status).toBe(200);
    const listed = bodyOf(listResponse, listRequest);
    const stored = listed.find((batch) => batch.id === batchId);
    if (stored === undefined) {
      throw new Error(`${listRequest} did not include batch ${batchId}: ${shorten(listResponse.text)}`);
    }
    expect(stored.status).toBe('complete');
    expect(stored.images).toHaveLength(4);

    const statsRequest = 'GET /api/stats';
    const statsResponse = await api<StudioStats>('GET', '/api/stats');
    expect(statsResponse.status).toBe(200);
    const stats = bodyOf(statsResponse, statsRequest);
    const imageCount = listed.reduce((total, batch) => total + batch.images.length, 0);
    const storedBytes = listed.reduce(
      (total, batch) => total + batch.images.reduce((sum, image) => sum + image.bytes, 0),
      0,
    );
    expect(stats.batchCount).toBe(listed.length);
    expect(stats.imageCount).toBe(imageCount);
    expect(stats.bytes).toBe(storedBytes);
    expect(stats.imageCount).toBeGreaterThanOrEqual(4);

    const imageIds = stored.images.map((image) => image.id);
    const exportResponse = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { Accept: 'application/zip', 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds, format: 'png' }),
    });
    const archive = new Uint8Array(await exportResponse.arrayBuffer());
    expect(
      exportResponse.status,
      `POST /api/export answered ${exportResponse.status}: ${shorten(new TextDecoder().decode(archive))}`,
    ).toBe(200);
    expect(exportResponse.headers.get('content-type') ?? '').toContain('application/zip');

    const directory = readCentralDirectory(archive);
    expect(directory.declaredCount).toBe(4);
    expect(directory.entries).toHaveLength(4);
    expect(directory.walkedSize).toBe(directory.declaredSize);
    const names = directory.entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => name.endsWith('.png'))).toBe(true);
    expect(directory.entries.every((entry) => entry.storedBytes > 0)).toBe(true);
  });

  it('reports a partial batch and retries the failed index', async () => {
    const prompt = 'FAIL_ONE a lighthouse at dusk';
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt,
      width: 128,
      height: 128,
      count: 4,
    });

    const batch = batchOf(await readEvents(batchId));
    expect(batch.status).toBe('partial');
    expect(batch.images).toHaveLength(3);
    expect(batch.images.map((image) => image.index).sort((left, right) => left - right)).toEqual([
      1, 2, 3,
    ]);
    expect(batch.failures).toHaveLength(1);
    const failure = batch.failures[0];
    if (failure === undefined) {
      throw new Error(`Batch ${batchId} reported no failure: ${JSON.stringify(batch)}`);
    }
    expect(failure.index).toBe(0);
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe('mock_forced_failure');

    const retryBody = { indices: [failure.index] };
    const retryRequest = `POST /api/batches/${batchId}/retry with ${JSON.stringify(retryBody)}`;
    const retryResponse = await api<{ batchId: string }>(
      'POST',
      `/api/batches/${encodeURIComponent(batchId)}/retry`,
      retryBody,
    );
    expect(
      retryResponse.status,
      `${retryRequest} answered ${retryResponse.status}: ${shorten(retryResponse.text)}`,
    ).toBe(202);
    const retryId = bodyOf(retryResponse, retryRequest).batchId;
    expect(retryId).not.toBe(batchId);

    const retried = await waitForSettled(retryId);
    expect(
      retried.status,
      `${retryRequest} created batch ${retryId}; GET /api/batches/${retryId} answered ${JSON.stringify(retried)}`,
    ).toBe('complete');
    expect(retried.requested).toBe(1);
    expect(retried.images).toHaveLength(1);
  });

  it('keeps all four images when two clients poll during the write', async () => {
    // The mock spends at least 30 ms on each of four items, so the run cannot finish inside the
    // 25 ms gap between polls: both readers are reading while items are being written.
    const batchId = await startGeneration({
      providerId: 'mock',
      prompt: 'plates polled during the write',
      width: 512,
      height: 512,
      count: 4,
      seed: 41,
    });

    const stop = { value: false };
    const batchPolls = pollEndpoint('/api/batches', () => stop.value, describeBatchListProblem);
    const statsPolls = pollEndpoint('/api/stats', () => stop.value, describeStatsProblem);
    let settled: BatchRecord | null = null;
    let batchLog: PollLog | null = null;
    let statsLog: PollLog | null = null;
    try {
      settled = batchOf(await readEvents(batchId));
    } finally {
      stop.value = true;
      [batchLog, statsLog] = await Promise.all([batchPolls, statsPolls]);
    }
    if (settled === null || batchLog === null || statsLog === null) {
      throw new Error(`The readers for batch ${batchId} did not finish.`);
    }

    expect(batchLog.problems).toEqual([]);
    expect(statsLog.problems).toEqual([]);
    expect(batchLog.requests).toBeGreaterThanOrEqual(2);
    expect(statsLog.requests).toBeGreaterThanOrEqual(2);
    expect(settled.status).toBe('complete');
    expect(settled.images).toHaveLength(4);

    const detailRequest = `GET /api/batches/${batchId}`;
    const detailResponse = await api<BatchRecord>(
      'GET',
      `/api/batches/${encodeURIComponent(batchId)}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = bodyOf(detailResponse, detailRequest);
    expect(detail.status).toBe('complete');
    expect(detail.images).toHaveLength(4);
    expect(detail.images.map((image) => image.index).sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(new Set(detail.images.map((image) => image.id)).size).toBe(4);

    const listRequest = 'GET /api/batches';
    const listResponse = await api<BatchRecord[]>('GET', '/api/batches');
    expect(listResponse.status).toBe(200);
    const listed = bodyOf(listResponse, listRequest).find((candidate) => candidate.id === batchId);
    if (listed === undefined) {
      throw new Error(`${listRequest} lost batch ${batchId} after polling: ${shorten(listResponse.text)}`);
    }
    expect(listed.images).toHaveLength(4);
  });
});
