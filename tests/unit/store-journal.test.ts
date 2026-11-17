import { appendFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { synthImage } from '../../src/core/png';
import { LibraryStore, createId } from '../../src/core/store';
import type { BatchRecord } from '../../src/core/types';

type BatchInput = Omit<BatchRecord, 'images' | 'failures' | 'createdAt'> & { createdAt?: string };

let rootDir = '';

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'h3-store-journal-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function indexPath(): string {
  return path.join(rootDir, 'index.json');
}

function journalPath(): string {
  return path.join(rootDir, 'journal.ndjson');
}

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

async function journalTypes(): Promise<string[]> {
  const raw = await readFile(journalPath(), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => String((JSON.parse(line) as { t: unknown }).t));
}

describe('LibraryStore journal under a concurrent reader', () => {
  it('keeps 50 saves while a readFile loop rereads index.json continuously', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput({ requested: 50 }));
    const bytes = synthImage({ width: 32, height: 32, seed: 3, label: 'journal-50' });

    let stop = false;
    let reads = 0;
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(indexPath(), 'utf8');
        expect(text.length).toBeGreaterThan(0);
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    try {
      for (let index = 0; index < 50; index += 1) {
        const saved = await store.saveImage(batch.id, index, bytes, { providerId: 'mock' });
        expect(saved.width).toBe(32);
      }
    } finally {
      stop = true;
      await reader;
    }

    expect(reads).toBeGreaterThan(0);
    expect((await store.getBatch(batch.id))?.images).toHaveLength(50);
    expect(await journalTypes()).toHaveLength(51);
    expect((await readdir(rootDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Memory and disk agree: a fresh instance replays the same 50 saves.
    const reopened = await openStore();
    expect((await reopened.getBatch(batch.id))?.images).toHaveLength(50);
    expect(await reopened.stats()).toEqual({
      batchCount: 1,
      imageCount: 50,
      bytes: 50 * bytes.byteLength,
    });
  });

  it('keeps appending while a reader loop rereads the journal continuously', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput({ requested: 20 }));
    const bytes = synthImage({ width: 16, height: 16, seed: 8, label: 'journal-reader' });

    let stop = false;
    let reads = 0;
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(journalPath(), 'utf8');
        // Every newline-terminated line must be a whole record, even mid-append.
        const lines = text.split('\n');
        lines.pop();
        for (const line of lines) {
          if (line.length > 0) expect(() => JSON.parse(line)).not.toThrow();
        }
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    try {
      for (let index = 0; index < 20; index += 1) {
        await store.saveImage(batch.id, index, bytes, { providerId: 'mock' });
      }
    } finally {
      stop = true;
      await reader;
    }

    expect(reads).toBeGreaterThan(0);
    expect(await journalTypes()).toHaveLength(21);
    expect((await store.getBatch(batch.id))?.images).toHaveLength(20);
  });
});

describe('LibraryStore journal replay', () => {
  it('rebuilds identical state in a fresh instance', async () => {
    const store = await openStore();
    const kept = await store.createBatch(batchInput({ prompt: 'kept' }));
    const finished = await store.createBatch(
      batchInput({ prompt: 'finished', negativePrompt: 'blur, text' }),
    );
    const first = await store.saveImage(
      kept.id,
      0,
      synthImage({ width: 16, height: 16, seed: 1, label: 'a' }),
      { providerId: 'mock' },
    );
    const second = await store.saveImage(
      kept.id,
      1,
      synthImage({ width: 24, height: 12, seed: 2, label: 'b' }),
      { providerId: 'mock' },
    );
    await store.recordFailure(finished.id, {
      index: 0,
      message: 'provider refused',
      code: 'provider_http',
      retryable: true,
    });
    await store.finishBatch(finished.id, 'partial', {
      revisedPrompt: 'a moodier view',
      durationMs: 42,
      seed: 7,
    });
    const preset = await store.createPreset({
      name: 'Wide',
      prompt: 'a wide panorama',
      width: 1024,
      height: 512,
      count: 2,
    });
    const dropped = await store.createPreset({
      name: 'Tall',
      prompt: 'a tall portrait',
      width: 512,
      height: 1024,
      count: 1,
    });
    expect(await store.deletePreset(dropped.id)).toBe(true);

    const reopened = await openStore();
    expect(await reopened.listBatches()).toEqual(await store.listBatches());
    expect(await reopened.listPresets()).toEqual([preset]);
    expect(await reopened.stats()).toEqual(await store.stats());

    const replayedFirst = await reopened.readImage(first.id);
    const replayedSecond = await reopened.readImage(second.id);
    expect(replayedFirst?.meta).toEqual(first);
    expect(replayedSecond?.meta).toEqual(second);
    expect(Array.from(replayedSecond?.bytes ?? [])).toEqual(
      Array.from((await store.readImage(second.id))?.bytes ?? []),
    );
  });

  it('ignores a truncated final journal line', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    await store.saveImage(batch.id, 0, synthImage({ width: 8, height: 8, seed: 4, label: 'torn' }), {
      providerId: 'mock',
    });

    const before = await readFile(journalPath(), 'utf8');
    expect(before.endsWith('\n')).toBe(true);

    // A crash mid-append leaves a fragment with no terminator. The batch it describes was
    // never created, so replay must drop the fragment instead of throwing.
    await appendFile(journalPath(), '{"t":"batch.create","batch":{"id":"batch_torn","providerId":"mock"');

    const reopened = new LibraryStore({ rootDir });
    await expect(reopened.init()).resolves.toBeUndefined();
    expect(await reopened.listBatches()).toEqual(await store.listBatches());
    expect(await reopened.getBatch('batch_torn')).toBeNull();
    expect(await readFile(journalPath(), 'utf8')).toBe('');
  });

  it('compacts the journal to empty during init', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    const preset = await store.createPreset({
      name: 'Square',
      prompt: 'a square crop',
      width: 512,
      height: 512,
      count: 1,
    });
    expect((await stat(journalPath())).size).toBeGreaterThan(0);

    const reopened = await openStore();
    expect((await stat(journalPath())).size).toBe(0);
    expect(await readFile(journalPath(), 'utf8')).toBe('');

    const snapshot = JSON.parse(await readFile(indexPath(), 'utf8')) as {
      version: number;
      batches: BatchRecord[];
      presets: { id: string }[];
    };
    expect(snapshot.version).toBe(1);
    expect(snapshot.batches.map((entry) => entry.id)).toEqual([batch.id]);
    expect(snapshot.presets.map((entry) => entry.id)).toEqual([preset.id]);
    expect((await readdir(rootDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('appends exactly one journal line per mutation', async () => {
    const store = await openStore();
    const batch = await store.createBatch(batchInput());
    await store.saveImage(batch.id, 0, synthImage({ width: 8, height: 8, seed: 5, label: 'count' }), {
      providerId: 'mock',
    });
    await store.recordFailure(batch.id, { index: 0, message: 'no image', retryable: false });
    await store.finishBatch(batch.id, 'partial');
    const preset = await store.createPreset({
      name: 'Wide',
      prompt: 'a wide panorama',
      width: 1024,
      height: 512,
      count: 2,
    });
    expect(await store.deletePreset(preset.id)).toBe(true);
    expect(await store.deleteBatch('missing-batch')).toBe(false);

    expect(await journalTypes()).toEqual([
      'batch.create',
      'batch.image',
      'batch.failure',
      'batch.finish',
      'preset.create',
      'preset.delete',
    ]);
  });
});

describe('LibraryStore journal across instances', () => {
  it('sees records another instance appended to the same directory', async () => {
    const live = await openStore();
    const writer = new LibraryStore({ rootDir });
    const batch = await writer.createBatch(batchInput({ prompt: 'from another instance' }));

    expect(await live.getBatch(batch.id)).toMatchObject({
      id: batch.id,
      prompt: 'from another instance',
    });
    expect((await live.listBatches()).map((entry) => entry.id)).toEqual([batch.id]);
    expect(await live.stats()).toMatchObject({ batchCount: 1 });
  });

  it('two stores opened in sequence on the same directory agree', async () => {
    const first = await openStore();
    const batch = await first.createBatch(batchInput());
    await first.saveImage(batch.id, 0, synthImage({ width: 8, height: 8, seed: 6, label: 'seq' }), {
      providerId: 'mock',
    });

    const second = await openStore();
    expect(await second.listBatches()).toEqual(await first.listBatches());
    expect(await second.stats()).toEqual(await first.stats());

    const preset = await second.createPreset({
      name: 'Wide',
      prompt: 'a wide panorama',
      width: 1024,
      height: 512,
      count: 2,
    });
    await second.finishBatch(batch.id, 'complete', { durationMs: 11 });

    const third = await openStore();
    expect(await third.listBatches()).toEqual(await second.listBatches());
    expect(await third.listPresets()).toEqual([preset]);
    expect(await third.stats()).toEqual(await second.stats());
  });
});
