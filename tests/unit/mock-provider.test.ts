import { describe, expect, it } from 'vitest';
import { readPngSize } from '../../src/core/png';
import { createAdapter } from '../../src/core/providers/registry';
import type {
  GeneratedItem,
  GenerationEvent,
  GenerationOutcome,
  GenerationRequest,
} from '../../src/core/types';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MOCK_CONFIG = { id: 'mock', kind: 'mock', label: 'Mock (offline)', baseUrl: 'mock://local' } as const;

function makeAdapter() {
  return createAdapter({ ...MOCK_CONFIG });
}

function makeRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { prompt: 'a quiet lake at dawn', width: 64, height: 40, count: 3, seed: 7, ...overrides };
}

async function runMock(request: GenerationRequest): Promise<{ outcome: GenerationOutcome; events: GenerationEvent[] }> {
  const events: GenerationEvent[] = [];
  const outcome = await makeAdapter().generate(request, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return { outcome, events };
}

function pngBytesOf(item: GeneratedItem | undefined): Uint8Array {
  if (!item) {
    throw new Error('expected an item');
  }
  if (!item.bytes) {
    throw new Error(`item ${item.index} has no bytes`);
  }
  return item.bytes;
}

describe('mock provider capabilities', () => {
  it('reports the documented identity and contract limits', async () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe('mock');
    expect(adapter.kind).toBe('mock');
    expect(adapter.label).toBe('Mock (offline)');

    const capabilities = await adapter.capabilities();
    expect(capabilities.maxBatch).toBe(10);
    expect(capabilities.sizeMultiple).toBe(8);
    expect(capabilities.arbitrarySize).toBe(true);
    expect(capabilities.seed).toBe(true);
    expect(capabilities.streamingProgress).toBe(true);
    expect(capabilities.outputFormats).toContain('png');
    expect(capabilities.presets.length).toBeGreaterThan(0);
    expect(capabilities.fixedSteps).toBeNull();

    await expect(adapter.health()).resolves.toMatchObject({ ok: true });
  });
});

describe('mock provider generate', () => {
  it('returns three ok items with real PNG bytes for a batch of three', async () => {
    const { outcome } = await runMock(makeRequest());
    expect(outcome.providerId).toBe('mock');
    expect(outcome.items).toHaveLength(3);
    expect(outcome.items.map((item) => item.index)).toEqual([0, 1, 2]);

    for (const item of outcome.items) {
      expect(item.ok).toBe(true);
      const bytes = pngBytesOf(item);
      expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
      expect(readPngSize(bytes)).toEqual({ width: 64, height: 40 });
      expect(item.width).toBe(64);
      expect(item.height).toBe(40);
    }
    expect(outcome.items.map((item) => item.seed)).toEqual([7, 8, 9]);
    expect(() => new Date(outcome.startedAt).toISOString()).not.toThrow();
  });

  it('fails item 0 with a retryable failure for a prompt containing FAIL_ONE', async () => {
    const { outcome } = await runMock(makeRequest({ prompt: 'FAIL_ONE a quiet lake at dawn' }));
    expect(outcome.items).toHaveLength(3);

    const first = outcome.items[0];
    expect(first?.ok).toBe(false);
    expect(first?.failure?.retryable).toBe(true);
    expect(first?.failure?.code).toBe('mock_forced_failure');
    expect(first?.failure?.message).toContain('FAIL_ONE');
    expect(first?.bytes).toBeUndefined();

    for (const item of outcome.items.slice(1)) {
      expect(item.ok).toBe(true);
      expect(Array.from(pngBytesOf(item).subarray(0, 8))).toEqual(PNG_SIGNATURE);
    }
  });

  it('emits progress before each item and then the item event', async () => {
    const { outcome, events } = await runMock(makeRequest({ count: 2 }));
    expect(outcome.items).toHaveLength(2);
    expect(events.filter((event) => event.type === 'item')).toHaveLength(2);

    for (const index of [0, 1]) {
      const progressAt = events.findIndex((event) => event.type === 'progress' && event.index === index);
      const itemAt = events.findIndex((event) => event.type === 'item' && event.index === index);
      expect(progressAt).toBeGreaterThanOrEqual(0);
      expect(progressAt).toBeLessThan(itemAt);
    }
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.every((event) => typeof event.stage === 'string' && event.stage.length > 0)).toBe(true);
  });

  it('stops on abort after an item without rejecting', async () => {
    const controller = new AbortController();
    const outcome = await makeAdapter().generate(makeRequest({ count: 5 }), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'item') {
          controller.abort();
        }
      },
    });

    expect(outcome.items).toHaveLength(1);
    expect(outcome.items.every((item) => item.ok)).toBe(true);
  });

  it('returns no items when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await makeAdapter().generate(makeRequest(), {
      signal: controller.signal,
      onEvent: () => undefined,
    });
    expect(outcome.items).toEqual([]);
  });
});
