import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CorruptIndexError, LibraryStore, createId } from '../../src/core/store';
import type { BatchRecord } from '../../src/core/types';

type BatchInput = Omit<BatchRecord, 'images' | 'failures' | 'createdAt'> & { createdAt?: string };

let rootDir = '';

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'h3-store-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function openStore(): Promise<LibraryStore> {
  const store = new LibraryStore({ rootDir });
  await store.init();
  return store;
}

function batchInput(overrides: Partial<BatchInput> = {}): BatchInput {
  return {
    id: createId('batch'),
    providerId: 'mock',
    prompt: 'a lighthouse at dusk',
    width: 512,
    height: 512,
    requested: 1,
    status: 'running',
    ...overrides,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)) >>> 0, false);
  return chunk;
}

/** A real 8 bit RGB PNG, so the store reads its size the same way it would for provider output. */
function makePng(width: number, height: number, shade: number): Uint8Array {
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = (shade + x) % 256;
      raw[pixel + 1] = (shade + y) % 256;
      raw[pixel + 2] = shade % 256;
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, false);
  headerView.setUint32(4, height, false);
  header[8] = 8;
  header[9] = 2;
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

async function listAllFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  return names.map((name) => name.replaceAll('\\', '/'));
}

describe('LibraryStore init', () => {
  it('creates the directory layout and an empty index', async () => {
    const store = await openStore();
    const files = await listAllFiles(rootDir);
    expect(files).toContain('index.json');

    const index = JSON.parse(await readFile(path.join(rootDir, 'index.json'), 'utf8'));
    expect(index).toEqual({ version: 1, batches: [], presets: [] });
    expect(await store.listBatches()).toEqual([]);
    expect((await stat(path.join(rootDir, 'images'))).isDirectory()).toBe(true);
    expect((await stat(path.join(rootDir, 'references'))).isDirectory()).toBe(true);
  });

  it('keeps an existing index when init runs twice', async () => {
    const first = await openStore();
    const batch = await first.createBatch(batchInput());
    await first.init();
    expect((await first.listBatches()).map((entry) => entry.id)).toEqual([batch.id]);
  });
});

describe('LibraryStore batches', () => {
  it('creates a batch and lists it', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput({ prompt: 'a quiet harbour' }));

    expect(batch.images).toEqual([]);
    expect(batch.failures).toEqual([]);
    expect(typeof batch.createdAt).toBe('string');

    const listed = await store.listBatches();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(batch.id);
    expect(listed[0]?.prompt).toBe('a quiet harbour');
    expect(await store.getBatch(batch.id)).toMatchObject({ id: batch.id, status: 'running' });
    expect(await store.getBatch('missing')).toBeNull();
  });

  it('lists newest first and respects a limit', async () => {
    const store = await openStore();
    const older = await store.createBatch(
      batchInput({ createdAt: '2024-01-01T00:00:00.000Z', prompt: 'older' }),
    );
    const newer = await store.createBatch(
      batchInput({ createdAt: '2024-06-01T00:00:00.000Z', prompt: 'newer' }),
    );

    expect((await store.listBatches()).map((entry) => entry.id)).toEqual([newer.id, older.id]);
    expect((await store.listBatches(1)).map((entry) => entry.id)).toEqual([newer.id]);
  });

  it('finishes a batch with status and optional fields', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());

    await store.recordFailure(batch.id, { index: 1, message: 'provider refused', retryable: true });
    const finished = await store.finishBatch(batch.id, 'partial', {
      revisedPrompt: 'a moodier view',
      durationMs: 1200,
      seed: 42,
    });

    expect(finished.status).toBe('partial');
    expect(finished.revisedPrompt).toBe('a moodier view');
    expect(finished.durationMs).toBe(1200);
    expect(finished.seed).toBe(42);
    expect(typeof finished.finishedAt).toBe('string');

    const reloaded = await store.getBatch(batch.id);
    expect(reloaded?.status).toBe('partial');
    expect(reloaded?.failures).toEqual([
      { index: 1, message: 'provider refused', retryable: true },
    ]);
  });

  it('finishes a batch without the optional fields', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    const finished = await store.finishBatch(batch.id, 'complete');

    expect(finished.status).toBe('complete');
    expect(finished.revisedPrompt).toBeUndefined();
    expect(finished.durationMs).toBeUndefined();
    expect(finished.seed).toBeUndefined();
  });

  it('rejects writes to an unknown batch', async () => {
    const store = await openStore();
    await expect(store.finishBatch('nope', 'complete')).rejects.toThrow('Unknown batch: nope');
  });
});

describe('LibraryStore images', () => {
  it('saves an image and reads it back byte for byte', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    const bytes = makePng(4, 3, 40);

    const image = await store.saveImage(batch.id, 0, bytes, { providerId: 'mock' });

    expect(image.width).toBe(4);
    expect(image.height).toBe(3);
    expect(image.bytes).toBe(bytes.byteLength);
    expect(image.batchId).toBe(batch.id);
    expect(image.index).toBe(0);
    expect(image.filename).toBe(`${image.id}.png`);
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);

    const stored = await store.readImage(image.id);
    expect(stored?.meta).toEqual(image);
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(await store.readImage('missing-image')).toBeNull();
  });

  it('writes the image file at imagePath', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    const bytes = makePng(2, 2, 7);
    const image = await store.saveImage(batch.id, 0, bytes, { providerId: 'mock' });

    const onDisk = await readFile(store.imagePath(image));
    expect(Array.from(onDisk)).toEqual(Array.from(bytes));
    expect(store.imagePath(image)).toContain(path.join('images', `${image.id}.png`));
  });

  it('records a stable sha256 across saves and reloads', async () => {
    const store = await openStore();
    const bytes = makePng(3, 3, 11);
    const firstBatch = await store.createBatch(batchInput());
    const secondBatch = await store.createBatch(batchInput());
    const first = await store.saveImage(firstBatch.id, 0, bytes, { providerId: 'mock' });
    const second = await store.saveImage(secondBatch.id, 0, bytes, { providerId: 'mock' });
    const different = await store.saveImage(
      secondBatch.id,
      1,
      makePng(3, 3, 12),
      { providerId: 'mock' },
    );

    expect(second.sha256).toBe(first.sha256);
    expect(different.sha256).not.toBe(first.sha256);

    const reloaded = await new LibraryStore({ rootDir }).getBatch(firstBatch.id);
    expect(reloaded?.images[0]?.sha256).toBe(first.sha256);
  });

  it('persists both of two concurrent saves', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());

    const [first, second] = await Promise.all([
      store.saveImage(batch.id, 0, makePng(2, 2, 1), { providerId: 'mock' }),
      store.saveImage(batch.id, 1, makePng(3, 2, 2), { providerId: 'mock' }),
    ]);

    const reloaded = await new LibraryStore({ rootDir }).getBatch(batch.id);
    expect(reloaded?.images.map((image) => image.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await store.stats()).toMatchObject({ imageCount: 2 });
  });

  it('keeps every concurrent create and preset write', async () => {
    const store = await openStore();

    const batches = await Promise.all([
      store.createBatch(batchInput({ prompt: 'one' })),
      store.createBatch(batchInput({ prompt: 'two' })),
      store.createBatch(batchInput({ prompt: 'three' })),
    ]);
    const preset = await store.createPreset({
      name: 'Wide',
      prompt: 'a wide panorama',
      width: 1024,
      height: 512,
      count: 2,
    });

    expect((await store.listBatches()).map((entry) => entry.id).sort()).toEqual(
      batches.map((entry) => entry.id).sort(),
    );
    expect((await store.listPresets()).map((entry) => entry.id)).toEqual([preset.id]);
  });
});

describe('LibraryStore deletion', () => {
  it('deletes a batch and its image files', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    const image = await store.saveImage(batch.id, 0, makePng(2, 2, 3), { providerId: 'mock' });
    const imageFile = store.imagePath(image);

    await expect(stat(imageFile)).resolves.toBeTruthy();
    expect(await store.deleteBatch(batch.id)).toBe(true);
    expect(await stat(imageFile).catch(() => null)).toBeNull();
    expect(await store.getBatch(batch.id)).toBeNull();
    expect(await store.listBatches()).toEqual([]);
  });

  it('returns false for an unknown batch and keeps the others', async () => {
    const store = await openStore();
    const keep = await store.createBatch(batchInput());

    expect(await store.deleteBatch('nope')).toBe(false);
    expect((await store.listBatches()).map((entry) => entry.id)).toEqual([keep.id]);
  });
});

describe('LibraryStore presets', () => {
  it('round trips a preset through the index', async () => {
    const store = await openStore();
    const preset = await store.createPreset({
      name: 'Wide',
      prompt: 'a wide panorama',
      width: 1024,
      height: 512,
      count: 2,
    });

    expect(preset.id).toMatch(/^preset_/);
    expect(typeof preset.createdAt).toBe('string');
    expect(await new LibraryStore({ rootDir }).listPresets()).toEqual([preset]);

    expect(await store.deletePreset(preset.id)).toBe(true);
    expect(await store.listPresets()).toEqual([]);
    expect(await store.deletePreset(preset.id)).toBe(false);
  });
});

describe('LibraryStore stats', () => {
  it('totals batches, images and bytes', async () => {
    const store = await openStore();
    expect(await store.stats()).toEqual({ batchCount: 0, imageCount: 0, bytes: 0 });

    const first = await store.createBatch(batchInput());
    const second = await store.createBatch(batchInput());
    const a = await store.saveImage(first.id, 0, makePng(2, 2, 4), { providerId: 'mock' });
    const b = await store.saveImage(first.id, 1, makePng(2, 2, 5), { providerId: 'mock' });
    const c = await store.saveImage(second.id, 0, makePng(3, 1, 6), { providerId: 'mock' });

    expect(await store.stats()).toEqual({
      batchCount: 2,
      imageCount: 3,
      bytes: a.bytes + b.bytes + c.bytes,
    });
  });
});

describe('LibraryStore durability', () => {
  it('leaves no temporary files behind after writes', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    await store.saveImage(batch.id, 0, makePng(2, 2, 9), { providerId: 'mock' });
    await store.finishBatch(batch.id, 'complete', { durationMs: 5 });
    await store.createPreset({
      name: 'Square',
      prompt: 'a square crop',
      width: 512,
      height: 512,
      count: 1,
    });

    const files = await listAllFiles(rootDir);
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves the index intact when an image write fails', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    await rm(path.join(rootDir, 'images'), { recursive: true, force: true });

    await expect(
      store.saveImage(batch.id, 0, makePng(2, 2, 13), { providerId: 'mock' }),
    ).rejects.toThrow();

    expect((await store.getBatch(batch.id))?.images).toEqual([]);
    const preset = await store.createPreset({
      name: 'After failure',
      prompt: 'the queue still works',
      width: 512,
      height: 512,
      count: 1,
    });
    expect((await store.listPresets()).map((entry) => entry.id)).toEqual([preset.id]);
  });

  it('reports a corrupt index instead of replacing it', async () => {
    const store = await openStore();
    const indexPath = path.join(rootDir, 'index.json');
    const broken = '{ "version": 1, "batches": [';
    await writeFile(indexPath, broken, 'utf8');

    await expect(store.listBatches()).rejects.toBeInstanceOf(CorruptIndexError);
    await expect(store.listBatches()).rejects.toThrow(indexPath);
    await expect(new LibraryStore({ rootDir }).init()).rejects.toBeInstanceOf(CorruptIndexError);
    expect(await readFile(indexPath, 'utf8')).toBe(broken);
  });

  it('reports an index with the wrong shape as corrupt', async () => {
    const store = await openStore();
    const indexPath = path.join(rootDir, 'index.json');
    await writeFile(indexPath, JSON.stringify({ version: 1, batches: 'nope', presets: [] }), 'utf8');

    await expect(store.stats()).rejects.toBeInstanceOf(CorruptIndexError);
  });

  it('reports a missing index as a typed error rather than recreating it', async () => {
    const store = await openStore();
    await rm(path.join(rootDir, 'index.json'));

    await expect(store.listBatches()).rejects.toBeInstanceOf(CorruptIndexError);
  });
});
