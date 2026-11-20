import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatEta,
  formatSecondsPerStep,
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
  applyPreviewEvent,
  applyProgressEvent,
  readCurrentFormSnapshot,
  readPromptEnhancerPreference,
  resolveAlterationTarget,
  type GenerationBatch,
  type GenerationTile,
} from '../../src/web/features/generate/useGeneration';
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
