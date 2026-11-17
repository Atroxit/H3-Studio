import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryStore } from '../../src/core/store';
import { synthImage } from '../../src/core/png';

/**
 * Regression for a Windows defect: renaming a temporary over index.json fails with
 * EPERM while any handle has index.json open. The server reads the index on nearly
 * every request, so without a retry, generations silently lost images whenever the
 * UI polled the library at the same time.
 */
describe('LibraryStore index writes under a concurrent reader', () => {
  let root: string;
  let store: LibraryStore;
  let bytes: Uint8Array;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'h3-index-race-'));
    store = new LibraryStore({ rootDir: root });
    await store.init();
    bytes = synthImage({ width: 64, height: 64, seed: 7, label: 'race' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves images while another handle holds index.json open', async () => {
    const batch = await store.createBatch({
      id: 'batch-race',
      providerId: 'mock',
      prompt: 'a held open index',
      width: 64,
      height: 64,
      requested: 6,
      status: 'running',
    });

    const handle = await open(path.join(root, 'index.json'), 'r');
    try {
      for (let index = 0; index < 6; index += 1) {
        const saved = await store.saveImage(batch.id, index, bytes, { providerId: 'mock' });
        expect(saved.width).toBe(64);
      }
    } finally {
      await handle.close();
    }

    const listed = await store.listBatches();
    expect(listed[0]?.images.length).toBe(6);
  });

  it('saves images while a reader loop rereads index.json throughout', async () => {
    const batch = await store.createBatch({
      id: 'batch-loop',
      providerId: 'mock',
      prompt: 'a polling reader',
      width: 64,
      height: 64,
      requested: 12,
      status: 'running',
    });

    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(path.join(root, 'index.json'), 'utf8');
        expect(text.length).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    try {
      for (let index = 0; index < 12; index += 1) {
        await store.saveImage(batch.id, index, bytes, { providerId: 'mock' });
      }
    } finally {
      stop = true;
      await reader;
    }

    const listed = await store.listBatches();
    expect(listed[0]?.images.length).toBe(12);
    const leftovers = await readFile(path.join(root, 'index.json'), 'utf8').then((text) => text.includes('.tmp'));
    expect(leftovers).toBe(false);
  });
});
