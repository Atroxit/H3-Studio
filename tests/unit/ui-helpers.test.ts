import { describe, expect, it } from 'vitest';
import {
  promptProblem,
  ratioOf,
  readH3ExpanderState,
  retryEventIndex,
  seedProblem,
  setH3ExpanderState,
  sizeProblem,
  uniqueNotes,
} from '../../src/web/features/generate/helpers';
import { computeZoomScroll, type ZoomScrollInput } from '../../src/web/features/library/viewer';

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

describe('uniqueNotes', () => {
  it('removes duplicate and blank notes without changing the order', () => {
    expect(uniqueNotes(['a', 'a', 'b', ' b ', '', 'c'])).toEqual(['a', 'b', 'c']);
    expect(uniqueNotes([])).toEqual([]);
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
