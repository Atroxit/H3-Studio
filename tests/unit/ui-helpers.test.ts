import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchRecord, ProviderCapabilities, StoredImage } from '../../src/core/types';
import {
  batchDurationMs,
  formatClock,
  formatDuration,
  formatEta,
  formatSecondsPerStep,
  imageDurationMs,
  pipelineStages,
  previewBlurPx,
  promptProblem,
  ratioOf,
  readH3ExpanderState,
  retryEventIndex,
  seedProblem,
  setH3ExpanderState,
  sizeProblem,
  stageHeadline,
  uniqueNotes,
} from '../../src/web/features/generate/helpers';
import {
  applyItemEvent,
  applyPreviewEvent,
  applyProgressEvent,
  applyStudioDefaults,
  batchFromRecord,
  clearIfShowingBatch,
  createTiles,
  mergeBatchRecord,
  openStoredBatch,
  parseResolutionPreference,
  readCurrentFormSnapshot,
  readDefaultResolutionPreference,
  readGenerationBatch,
  readModelVariantPreference,
  readPromptEnhancerPreference,
  readStudioDefaults,
  readTextEncoderPreference,
  resolveAlterationTarget,
  startNewImage,
  toGenerationBody,
  type GenerationBatch,
  type GenerationForm,
  type GenerationTile,
} from '../../src/web/features/generate/useGeneration';
import {
  formatEnvLines,
  formatLaunchArguments,
  parseEnvLines,
  parseLaunchArguments,
} from '../../src/web/features/settings/helpers';

// The stored batch fetch is the only thing openStoredBatch needs from the network.
vi.mock('../../src/web/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/api')>();
  return { ...actual, getBatch: vi.fn() };
});
import { getBatch } from '../../src/web/api';
import {
  computeZoomScroll,
  computeZoomedDimensions,
  stepZoomLevel,
  type ZoomScrollInput,
} from '../../src/web/features/library/viewer';

describe('ratioOf', () => {
  it('names the canonical ratios the presets actually mean', () => {
    expect(ratioOf(2048, 2048)).toBe('1:1');
    expect(ratioOf(5472, 3072)).toBe('16:9');
    expect(ratioOf(3072, 5472)).toBe('9:16');
    expect(ratioOf(4736, 3552)).toBe('4:3');
    expect(ratioOf(3552, 4736)).toBe('3:4');
    expect(ratioOf(5024, 3360)).toBe('3:2');
    expect(ratioOf(6272, 2688)).toBe('21:9');
  });

  it('falls back to a reduced fraction for unusual sizes', () => {
    expect(ratioOf(1000, 700)).toBe('10:7');
    expect(ratioOf(1000, 1250)).toBe('4:5');
    expect(ratioOf(0, 100)).toBe('1:1');
  });
});

describe('retryEventIndex', () => {
  it('maps a renumbered retry position back to the original index', () => {
    const first = [0, 2];
    expect(retryEventIndex(first, 0)).toBe(0);
    expect(retryEventIndex(first, 1)).toBe(2);

    const second = [1, 2];
    expect(retryEventIndex(second, 0)).toBe(1);
    expect(retryEventIndex(second, 1)).toBe(2);

    const third = [1, 3, 4];
    expect(retryEventIndex(third, 0)).toBe(1);
    expect(retryEventIndex(third, 1)).toBe(3);
    expect(retryEventIndex(third, 2)).toBe(4);
  });

  it('returns null past the end of the retried list', () => {
    expect(retryEventIndex([1, 2], 2)).toBeNull();
    expect(retryEventIndex([], 0)).toBeNull();
  });
});

function h3Template(switchValue: boolean): string {
  return JSON.stringify({
    '22': {
      class_type: 'ComfySwitchNode',
      inputs: {
        switch: switchValue,
        on_false: ['24', 0],
        on_true: ['26', 0],
      },
    },
    '24': { class_type: 'PrimitiveStringMultiline', inputs: { value: '{{prompt}}' } },
  });
}

describe('the H3 prompt expander helper', () => {
  it('reads a false switch and toggles it both ways', () => {
    const template = h3Template(false);
    expect(readH3ExpanderState(template)).toBe(false);

    const enabled = setH3ExpanderState(template, true);
    expect(enabled).not.toBeNull();
    expect(readH3ExpanderState(enabled ?? '')).toBe(true);

    const disabled = setH3ExpanderState(enabled ?? '', false);
    expect(disabled).not.toBeNull();
    expect(readH3ExpanderState(disabled ?? '')).toBe(false);
  });

  it('returns null for invalid JSON, a missing node, or a different switch class', () => {
    expect(readH3ExpanderState('not json')).toBeNull();
    expect(readH3ExpanderState('')).toBeNull();
    expect(readH3ExpanderState(JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }))).toBeNull();
    expect(
      readH3ExpanderState(JSON.stringify({ '22': { class_type: 'OtherSwitch', inputs: { switch: false } } })),
    ).toBeNull();
    expect(setH3ExpanderState('{}', true)).toBeNull();
    expect(setH3ExpanderState('not json', true)).toBeNull();
  });
});

describe('computeZoomScroll', () => {
  const base: ZoomScrollInput = {
    ratioX: 0.5,
    ratioY: 0.5,
    anchorX: 400,
    anchorY: 300,
    contentWidth: 2000,
    contentHeight: 1000,
    contentOffsetX: 0,
    contentOffsetY: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    scrollWidth: 2000,
    scrollHeight: 1000,
  };

  it('zooms toward the bottom-right spot that was clicked', () => {
    expect(computeZoomScroll({ ...base, ratioX: 0.9, ratioY: 0.9, anchorX: 760, anchorY: 560 })).toEqual({
      left: 1040,
      top: 340,
    });
  });

  it('centres the scroll offset for a centre click', () => {
    expect(computeZoomScroll(base)).toEqual({ left: 600, top: 200 });
  });

  it('clamps a top-left click to the scroll origin', () => {
    expect(computeZoomScroll({ ...base, ratioX: 0.02, ratioY: 0.02, anchorX: 100, anchorY: 100 })).toEqual({
      left: 0,
      top: 0,
    });
  });

  it('clamps a bottom-right click to the maximum scroll offset', () => {
    expect(computeZoomScroll({ ...base, ratioX: 1, ratioY: 1, anchorX: 10, anchorY: 10 })).toEqual({
      left: 1200,
      top: 400,
    });
  });

  it('returns the origin when the content fits inside the viewport', () => {
    expect(
      computeZoomScroll({
        ...base,
        ratioX: 1,
        ratioY: 1,
        contentWidth: 400,
        contentHeight: 300,
        scrollWidth: 500,
        scrollHeight: 300,
      }),
    ).toEqual({ left: 0, top: 0 });
  });
});

describe('computeZoomedDimensions', () => {
  it('scales the fitted square image up by the requested amount', () => {
    expect(computeZoomedDimensions(1024, 1024, 800, 600, 2)).toEqual({ width: 1200, height: 1200 });
  });

  it('keeps the fitted aspect ratio for a wide image', () => {
    expect(computeZoomedDimensions(2000, 1000, 800, 600, 1.5)).toEqual({ width: 1200, height: 600 });
  });

  it('returns the fitted size at a scale of one', () => {
    expect(computeZoomedDimensions(2000, 1000, 800, 600, 1)).toEqual({ width: 800, height: 400 });
  });

  it('never returns a zero dimension', () => {
    expect(computeZoomedDimensions(0, 0, 0, 0, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('stepZoomLevel', () => {
  it('walks the zoom steps in and stops at eight', () => {
    expect(stepZoomLevel(1, 'in')).toBe(1.5);
    expect(stepZoomLevel(1.5, 'in')).toBe(2);
    expect(stepZoomLevel(4, 'in')).toBe(6);
    expect(stepZoomLevel(8, 'in')).toBe(8);
  });

  it('walks the zoom steps out and stops at one', () => {
    expect(stepZoomLevel(8, 'out')).toBe(6);
    expect(stepZoomLevel(2, 'out')).toBe(1.5);
    expect(stepZoomLevel(1.5, 'out')).toBe(1);
    expect(stepZoomLevel(1, 'out')).toBe(1);
  });

  it('cycles a click through one, two, four, and back to one', () => {
    const first = stepZoomLevel(1, 'cycle');
    const second = stepZoomLevel(first, 'cycle');
    const third = stepZoomLevel(second, 'cycle');
    expect([first, second, third]).toEqual([2, 4, 1]);
    expect(stepZoomLevel(4, 'cycle')).toBe(1);
  });
});

function readyTile(index: number, imageId: string): GenerationTile {
  return {
    index,
    phase: 'done',
    stage: 'Ready',
    step: null,
    totalSteps: null,
    percent: 100,
    imageId,
    width: 512,
    height: 512,
    failure: null,
  };
}

function waitingTile(index: number): GenerationTile {
  return {
    index,
    phase: 'waiting',
    stage: null,
    step: null,
    totalSteps: null,
    percent: null,
    imageId: null,
    width: null,
    height: null,
    failure: null,
  };
}

function batchOf(tiles: GenerationTile[]): GenerationBatch {
  return {
    batchId: 'batch_test',
    streamBatchId: null,
    providerId: 'comfy-h3',
    prompt: 'a brass lighthouse',
    width: 512,
    height: 512,
    requested: tiles.length,
    status: 'complete',
    revisedPrompt: null,
    tiles,
    streamError: null,
    startedAt: 0,
    finishedAt: 1,
    durationMs: null,
    seed: 7,
  };
}

describe('progress folding', () => {
  it('tracks stages, details, step speed and completed phases', () => {
    let tiles = [waitingTile(0)];
    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'loading', detail: 'Loading VAE decoder' },
      1_000,
    );
    expect(tiles[0]).toMatchObject({ phase: 'running', stage: 'loading', detail: 'Loading VAE decoder' });

    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'encoding', detail: 'Encoding prompt & canvas conditioning' },
      1_500,
    );
    expect(tiles[0]?.completedStages).toEqual(['loading']);

    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'sampling', step: 1, totalSteps: 4, percent: 25 },
      2_000,
    );
    expect(tiles[0]?.completedStages).toEqual(['loading', 'encoding']);
    expect(tiles[0]?.stepStartedAt).toBe(2_000);
    expect(tiles[0]?.avgStepMs).toBeUndefined();

    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'sampling', step: 2, totalSteps: 4, percent: 50 },
      2_200,
    );
    expect(tiles[0]?.avgStepMs).toBe(200);

    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'sampling', step: 3, totalSteps: 4, percent: 75 },
      2_500,
    );
    expect(tiles[0]?.avgStepMs).toBe(230);

    tiles = applyProgressEvent(
      tiles,
      { type: 'progress', index: 0, stage: 'decoding', detail: 'Decoding latent to full-resolution pixels' },
      2_800,
    );
    expect(tiles[0]?.completedStages).toEqual(['loading', 'encoding', 'sampling']);
  });

  it('does not let a poll guess mark sampling complete', () => {
    // A polling percent arrives before the socket reports anything, so the stage starts at
    // sampling; a loader event after it must not record sampling as a finished phase.
    let tiles = [waitingTile(0)];
    tiles = applyProgressEvent(tiles, { type: 'progress', index: 0, stage: 'sampling', percent: 10 }, 1_000);
    tiles = applyProgressEvent(tiles, { type: 'progress', index: 0, stage: 'loading' }, 1_100);
    expect(tiles[0]?.completedStages).toBeUndefined();
  });

  it('moves a waiting tile to running on the first preview frame', () => {
    const tiles = applyPreviewEvent([waitingTile(0), waitingTile(1)], {
      type: 'preview',
      index: 1,
      dataUrl: 'data:image/jpeg;base64,AA==',
    });
    expect(tiles[0]?.phase).toBe('waiting');
    expect(tiles[1]).toMatchObject({ phase: 'running', previewUrl: 'data:image/jpeg;base64,AA==' });
  });

  it('ignores preview frames once a tile is settled', () => {
    const settled = readyTile(0, 'img_one');
    const tiles = applyPreviewEvent([settled], { type: 'preview', index: 0, dataUrl: 'data:image/jpeg;base64,AA==' });
    expect(tiles[0]).toBe(settled);
  });
});

describe('resolveAlterationTarget', () => {
  it('has no target without a batch or without reference support', () => {
    const batch = batchOf([readyTile(0, 'img_one')]);
    expect(resolveAlterationTarget(null, null, 4)).toBeNull();
    expect(resolveAlterationTarget(batch, null, 0)).toBeNull();
    expect(resolveAlterationTarget(batch, 'img_one', 0)).toBeNull();
  });

  it('has no target while nothing in the batch is ready', () => {
    expect(resolveAlterationTarget(batchOf([waitingTile(0), waitingTile(1)]), null, 4)).toBeNull();
  });

  it('defaults to the first ready image and lists every candidate', () => {
    const target = resolveAlterationTarget(
      batchOf([waitingTile(0), readyTile(1, 'img_one'), readyTile(2, 'img_two')]),
      null,
      4,
    );
    expect(target).not.toBeNull();
    expect(target?.imageId).toBe('img_one');
    expect(target?.index).toBe(1);
    expect(target?.label).toBe('02');
    expect(target?.candidates.map((candidate) => candidate.imageId)).toEqual(['img_one', 'img_two']);
  });

  it('picks the explicitly selected ready image', () => {
    const batch = batchOf([readyTile(0, 'img_one'), readyTile(1, 'img_two')]);
    const target = resolveAlterationTarget(batch, 'img_two', 4);
    expect(target?.imageId).toBe('img_two');
    expect(target?.index).toBe(1);
    expect(target?.label).toBe('02');
    expect(target?.candidates.map((candidate) => candidate.label)).toEqual(['01', '02']);
  });

  it('falls back to the first ready image when the selection is stale', () => {
    const target = resolveAlterationTarget(batchOf([readyTile(0, 'img_one')]), 'img_gone', 4);
    expect(target?.imageId).toBe('img_one');
  });
});

describe('composer snapshot and enhancer preference', () => {
  it('reads the active composer with safe defaults', () => {
    const snapshot = readCurrentFormSnapshot();
    expect(typeof snapshot.prompt).toBe('string');
    expect(Number.isInteger(snapshot.width)).toBe(true);
    expect(snapshot.width).toBeGreaterThan(0);
    expect(Number.isInteger(snapshot.height)).toBe(true);
    expect(snapshot.height).toBeGreaterThan(0);
    expect(Number.isInteger(snapshot.count)).toBe(true);
    expect(snapshot.count).toBeGreaterThan(0);
  });

  it('starts on the fast 9B enhancer without a stored preference', () => {
    expect(readPromptEnhancerPreference()).toBe('qwen3.5_9b');
  });
});

function storedImage(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 'img_one',
    batchId: 'batch_old',
    index: 0,
    filename: 'img_one.png',
    bytes: 1_234,
    sha256: 'a'.repeat(64),
    width: 512,
    height: 512,
    providerId: 'comfy-h3',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function storedBatch(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'batch_old',
    providerId: 'comfy-h3',
    prompt: 'a brass lighthouse',
    width: 512,
    height: 512,
    requested: 1,
    status: 'complete',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:14.000Z',
    seed: 7,
    images: [storedImage()],
    failures: [],
    ...overrides,
  };
}

describe('duration formatting and fallbacks', () => {
  it('formats finished durations for a person', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(750)).toBe('<1s');
    expect(formatDuration(-500)).toBe('<1s');
    expect(formatDuration(2_300)).toBe('2.3s');
    expect(formatDuration(14_000)).toBe('14s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(750_000)).toBe('12m 30s');
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });

  it('uses a stored batch duration and falls back to its timestamps', () => {
    expect(batchDurationMs(storedBatch({ durationMs: 4_200 }))).toBe(4_200);
    expect(batchDurationMs(storedBatch())).toBe(74_000);
    expect(batchDurationMs(storedBatch({ finishedAt: undefined }))).toBeNull();
    expect(batchDurationMs(storedBatch({ durationMs: Number.NaN }))).toBe(74_000);
  });

  it('counts the whole wall clock for a single image batch', () => {
    expect(imageDurationMs(storedImage({ durationMs: 30_000 }), storedBatch())).toBe(74_000);
    expect(imageDurationMs(storedImage({ durationMs: 90_000 }), storedBatch())).toBe(90_000);
    expect(imageDurationMs(storedImage(), storedBatch())).toBe(74_000);
  });

  it('keeps a per image duration in a multi image batch', () => {
    const batch = storedBatch({
      requested: 2,
      images: [storedImage({ durationMs: 30_000 }), storedImage({ id: 'img_two', index: 1, durationMs: 40_000 })],
    });
    expect(imageDurationMs(storedImage({ durationMs: 30_000 }), batch)).toBe(30_000);
    expect(imageDurationMs(storedImage({ id: 'img_three', index: 2 }), batch)).toBeNull();
  });

  it('carries the duration into tiles from an item event and a stored record', () => {
    const live = applyItemEvent([waitingTile(0)], {
      type: 'item',
      index: 0,
      item: { index: 0, ok: true, width: 512, height: 512, durationMs: 4_200 },
    });
    expect(live[0]?.durationMs).toBe(4_200);

    const merged = mergeBatchRecord(createTiles(1), storedBatch({ durationMs: 74_000, images: [storedImage({ durationMs: 30_000 })] }));
    expect(merged[0]?.durationMs).toBe(74_000);

    const oldRecord = storedBatch({ images: [storedImage()] });
    expect(oldRecord.durationMs).toBeUndefined();
    expect(mergeBatchRecord(createTiles(1), oldRecord)[0]?.durationMs).toBe(74_000);
  });

  it('fills the batch and tile durations when a stored batch is opened', async () => {
    const record = storedBatch({ images: [storedImage({ durationMs: 30_000 })] });
    expect(batchFromRecord(record).durationMs).toBe(74_000);

    vi.mocked(getBatch).mockResolvedValueOnce(record);
    await openStoredBatch(record.id);
    const opened = readGenerationBatch();
    expect(opened?.batchId).toBe(record.id);
    expect(opened?.durationMs).toBe(74_000);
    expect(opened?.tiles[0]?.durationMs).toBe(74_000);

    clearIfShowingBatch(record.id);
    expect(readGenerationBatch()).toBeNull();
    startNewImage();
  });
});

describe('uniqueNotes', () => {
  it('removes duplicate and blank notes without changing the order', () => {
    expect(uniqueNotes(['a', 'a', 'b', ' b ', '', 'c'])).toEqual(['a', 'b', 'c']);
    expect(uniqueNotes([])).toEqual([]);
  });
});

describe('loading view formatting', () => {
  it('formats the elapsed clock as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(8_400)).toBe('0:08');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(-500)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('formats per step speed with one decimal below ten seconds', () => {
    expect(formatSecondsPerStep(2_300)).toBe('2.3s/step');
    expect(formatSecondsPerStep(12_400)).toBe('12s/step');
    expect(formatSecondsPerStep(0)).toBeNull();
    expect(formatSecondsPerStep(undefined)).toBeNull();
  });

  it('formats the remaining sampling time as an estimate', () => {
    expect(formatEta(6_000)).toBe('~6s left');
    expect(formatEta(80_000)).toBe('~1m 20s left');
    expect(formatEta(120_000)).toBe('~2m left');
    expect(formatEta(0)).toBeNull();
    expect(formatEta(null)).toBeNull();
  });

  it('turns provider stages into human headlines', () => {
    expect(stageHeadline(null)).toBe('Queued');
    expect(stageHeadline('waiting')).toBe('Queued');
    expect(stageHeadline('preparing')).toBe('Preparing pipeline');
    expect(stageHeadline('loading')).toBe('Loading models');
    expect(stageHeadline('enhancing')).toBe('Enhancing prompt');
    expect(stageHeadline('encoding')).toBe('Encoding prompt');
    expect(stageHeadline('sampling')).toBe('Generating image');
    expect(stageHeadline('decoding')).toBe('Decoding pixels');
    expect(stageHeadline('saving')).toBe('Finalizing PNG');
  });

  it('marks the real pipeline phases done, active and pending', () => {
    expect(pipelineStages('sampling', ['loading', 'enhancing', 'encoding'])).toEqual([
      { id: 'prepare', label: 'Prepare', state: 'done' },
      { id: 'enhance', label: 'Enhance', state: 'done' },
      { id: 'encode', label: 'Encode', state: 'done' },
      { id: 'diffuse', label: 'Diffuse', state: 'active' },
      { id: 'decode', label: 'Decode', state: 'pending' },
    ]);
    expect(pipelineStages('decoding', ['loading', 'encoding'])).toEqual([
      { id: 'prepare', label: 'Prepare', state: 'done' },
      { id: 'encode', label: 'Encode', state: 'done' },
      { id: 'diffuse', label: 'Diffuse', state: 'done' },
      { id: 'decode', label: 'Decode', state: 'active' },
    ]);
  });

  it('shows Enhance only when the graph actually ran it', () => {
    expect(pipelineStages('enhancing', [])[1]).toEqual({ id: 'enhance', label: 'Enhance', state: 'active' });
    expect(pipelineStages('loading', []).map((step) => step.id)).toEqual([
      'prepare',
      'encode',
      'diffuse',
      'decode',
    ]);
  });

  it('deblurs the preview as the step count approaches the total', () => {
    expect(previewBlurPx(1, 6)).toBe(3.3);
    expect(previewBlurPx(3, 6)).toBe(2);
    expect(previewBlurPx(6, 6)).toBe(0);
    expect(previewBlurPx(null, 6)).toBe(4);
    expect(previewBlurPx(2, null)).toBe(4);
    expect(previewBlurPx(0, 0)).toBe(4);
  });
});

describe('client validation helpers', () => {
  it('reports prompt length and emptiness', () => {
    expect(promptProblem('')).toBe('Write a prompt first.');
    expect(promptProblem('   ')).toBe('Write a prompt first.');
    expect(promptProblem('a lighthouse')).toBeNull();
    expect(promptProblem('x'.repeat(4001))).toBe('Keep the prompt under 4000 characters.');
  });

  it('checks the size range and integer requirement', () => {
    expect(sizeProblem(2048, 2048)).toBeNull();
    expect(sizeProblem(64, 8192)).toBeNull();
    expect(sizeProblem(63, 512)).not.toBeNull();
    expect(sizeProblem(512, 8193)).not.toBeNull();
    expect(sizeProblem(512.5, 512)).not.toBeNull();
  });

  it('allows an empty seed and rejects out of range or non-numeric text', () => {
    expect(seedProblem('')).toBeNull();
    expect(seedProblem('0')).toBeNull();
    expect(seedProblem('4294967295')).toBeNull();
    expect(seedProblem('4294967296')).not.toBeNull();
    expect(seedProblem('abc')).not.toBeNull();
    expect(seedProblem('-1')).not.toBeNull();
  });
});

/** A localStorage stand in, so the preference helpers can be exercised in Node. */
function installFakeStorage(store: Map<string, string>): void {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  };
}

function uninstallFakeStorage(): void {
  delete (globalThis as { window?: unknown }).window;
}

const H3_CAPS: ProviderCapabilities = {
  seed: true,
  negativePrompt: false,
  adjustableSteps: false,
  fixedSteps: 6,
  guidance: false,
  maxReferenceImages: 4,
  maxBatch: 4,
  arbitrarySize: true,
  sizeMultiple: 32,
  presets: [{ id: '2048x2048', label: '2048×2048 (4 MP · Recommended)', width: 2048, height: 2048 }],
  outputFormats: ['png'],
  streamingProgress: true,
  notes: [],
};

function generationForm(overrides: Partial<GenerationForm> = {}): GenerationForm {
  return {
    providerId: 'comfyui',
    prompt: 'a brass lighthouse at dusk',
    negativePrompt: '',
    width: 2048,
    height: 2048,
    presetId: '2048x2048',
    count: 1,
    seed: '',
    steps: 20,
    guidance: 7,
    promptEnhancer: 'qwen3.5_9b',
    modelVariant: 'w4a8',
    textEncoderVariant: 'int8',
    themeIds: [],
    references: [],
    ...overrides,
  };
}

describe('studio defaults and the text encoder preference', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    installFakeStorage(store);
  });

  afterEach(() => {
    uninstallFakeStorage();
  });

  it('applies tuned defaults to the live composer and persists every one of them', () => {
    applyStudioDefaults({
      width: 4096,
      height: 4096,
      modelVariant: 'int8_convrot',
      textEncoderVariant: 'nvfp4',
      promptEnhancer: 'qwen3.8_27b',
    });

    expect(readStudioDefaults()).toEqual({
      width: 4096,
      height: 4096,
      modelVariant: 'int8_convrot',
      textEncoderVariant: 'nvfp4',
      promptEnhancer: 'qwen3.8_27b',
    });
    expect(readDefaultResolutionPreference()).toEqual({ width: 4096, height: 4096 });
    expect(readModelVariantPreference()).toBe('int8_convrot');
    expect(readTextEncoderPreference()).toBe('nvfp4');
    expect(readPromptEnhancerPreference()).toBe('qwen3.8_27b');

    expect(store.get('h3-studio:text-encoder-variant')).toBe('nvfp4');
    expect(store.get('h3-studio:model-variant')).toBe('int8_convrot');
    expect(store.get('h3-studio:default-resolution')).toBe('4096x4096');
    expect(store.get('h3-studio:prompt-enhancer')).toBe('qwen3.8_27b');
  });

  it('keeps the parts of the composer the defaults do not name', () => {
    applyStudioDefaults({ width: 1024, height: 1024 });
    const after = readStudioDefaults();
    expect(after.width).toBe(1024);
    expect(after.height).toBe(1024);
    // The model choices were not named, so whatever the composer had stays.
    expect(after.textEncoderVariant).toBe(readTextEncoderPreference());
  });

  it('defaults the encoder to INT8 and the canvas to 2048 when nothing is stored', () => {
    store.clear();
    expect(readTextEncoderPreference()).toBe('int8');
    expect(readModelVariantPreference()).toBe('w4a8');
    expect(readDefaultResolutionPreference()).toEqual({ width: 2048, height: 2048 });
  });

  it('ignores an unknown stored preference instead of trusting it', () => {
    store.set('h3-studio:text-encoder-variant', 'fp8');
    store.set('h3-studio:model-variant', 'nonsense');
    store.set('h3-studio:default-resolution', 'huge');
    expect(readTextEncoderPreference()).toBe('int8');
    expect(readModelVariantPreference()).toBe('w4a8');
    expect(readDefaultResolutionPreference()).toEqual({ width: 2048, height: 2048 });
  });

  it('reads a stored resolution written with either x', () => {
    expect(parseResolutionPreference('2048x2048')).toEqual({ width: 2048, height: 2048 });
    expect(parseResolutionPreference('4096×4096')).toEqual({ width: 4096, height: 4096 });
    expect(parseResolutionPreference(' 1024 X 768 ')).toEqual({ width: 1024, height: 768 });
    expect(parseResolutionPreference('huge')).toBeNull();
    expect(parseResolutionPreference('10x10')).toBeNull();
    expect(parseResolutionPreference(null)).toBeNull();
  });

  it('sends the chosen text encoder with the generation request', () => {
    const prepared = toGenerationBody(
      generationForm({ textEncoderVariant: 'nvfp4', modelVariant: 'int8_convrot', promptEnhancer: 'qwen3.8_27b' }),
      H3_CAPS,
      'comfyui',
    );
    expect(prepared.problem).toBeNull();
    expect(prepared.body?.textEncoderVariant).toBe('nvfp4');
    expect(prepared.body?.modelVariant).toBe('int8_convrot');
    expect(prepared.body?.promptEnhancer).toBe('qwen3.8_27b');
    expect(prepared.body?.enhancePrompt).toBe(true);

    const draft = toGenerationBody(generationForm({ textEncoderVariant: 'int8' }), H3_CAPS, 'comfyui');
    expect(draft.body?.textEncoderVariant).toBe('int8');
  });
});

describe('launch env and argument helpers', () => {
  it('reads KEY=VALUE lines and skips blank lines and comments', () => {
    const parsed = parseEnvLines(
      ['TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1', '', '   # a note', 'HSA_OVERRIDE_GFX_VERSION=11.0.0'].join('\n'),
    );
    expect(parsed.problem).toBeNull();
    expect(parsed.env).toEqual({
      TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL: '1',
      HSA_OVERRIDE_GFX_VERSION: '11.0.0',
    });
  });

  it('keeps an equals sign inside a value and strips surrounding quotes', () => {
    expect(parseEnvLines('EQUATION=a=b=c').env).toEqual({ EQUATION: 'a=b=c' });
    expect(parseEnvLines('QUOTED="two words"').env).toEqual({ QUOTED: 'two words' });
    expect(parseEnvLines("SINGLE='x'").env).toEqual({ SINGLE: 'x' });
    expect(parseEnvLines('EMPTY=').env).toEqual({ EMPTY: '' });
    expect(parseEnvLines('').env).toEqual({});
  });

  it('reports a line that is not a usable assignment', () => {
    expect(parseEnvLines('NOT_AN_ASSIGNMENT').problem).toContain('KEY=VALUE');
    expect(parseEnvLines('=value').problem).toContain('KEY=VALUE');
    expect(parseEnvLines('2FAST=1').problem).toContain('valid environment variable name');
    expect(parseEnvLines('GOOD=1\nbad line').problem).not.toBeNull();
  });

  it('round trips an env map through the textarea form, sorted by key', () => {
    const env = { B_SECOND: '2', A_FIRST: '1' };
    const text = formatEnvLines(env);
    expect(text).toBe('A_FIRST=1\nB_SECOND=2');
    expect(parseEnvLines(text).env).toEqual(env);
    expect(formatEnvLines(undefined)).toBe('');
    expect(formatEnvLines({})).toBe('');
  });

  it('round trips launch arguments, quoting an argument that contains a space', () => {
    expect(formatLaunchArguments(['-u', 'main.py'])).toBe('-u main.py');
    expect(parseLaunchArguments('-u main.py')).toEqual(['-u', 'main.py']);
    expect(formatLaunchArguments(undefined)).toBe('');

    const spaced = ['--extra-model-paths-config', 'C:/My Models/paths.yaml'];
    const text = formatLaunchArguments(spaced);
    expect(text).toBe(JSON.stringify(spaced));
    expect(parseLaunchArguments(text)).toEqual(spaced);

    expect(parseLaunchArguments('--listen\n--port\n8188')).toEqual(['--listen', '--port', '8188']);
    expect(parseLaunchArguments('')).toEqual([]);
    expect(parseLaunchArguments('[1, 2]')).toBeNull();
    expect(parseLaunchArguments('["-u", 5]')).toBeNull();
    expect(parseLaunchArguments('[not json')).toBeNull();
  });
});
