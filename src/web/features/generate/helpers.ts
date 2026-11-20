// Pure helpers for the generate surface. Nothing here touches React or the DOM,
// so the unit suite can import this module directly under Node.

import type { BatchRecord, SizePreset, StoredImage } from '../../../core/types';

/** The largest prompt the server accepts, mirrored here so the UI can block it early. */
export const PROMPT_MAX_LENGTH = 4000;
/** The size range the server accepts. */
export const MIN_IMAGE_SIZE = 64;
export const MAX_IMAGE_SIZE = 8192;
/** The largest seed the server accepts. */
export const MAX_SEED = 4_294_967_295;

interface CanonicalRatio {
  label: string;
  value: number;
}

// Ordered from the most square to the widest, with vertical counterparts. The
// tolerance below is relative, so large and small presets behave the same.
const CANONICAL_RATIOS: readonly CanonicalRatio[] = [
  { label: '1:1', value: 1 },
  { label: '5:4', value: 5 / 4 },
  { label: '4:5', value: 4 / 5 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:10', value: 16 / 10 },
  { label: '10:16', value: 10 / 16 },
  { label: '21:9', value: 21 / 9 },
  { label: '9:21', value: 9 / 21 },
];

/** Two percent relative tolerance covers presets that are rounded to a multiple of 32. */
const RATIO_TOLERANCE = 0.02;

function greatestCommonDivisor(left: number, right: number): number {
  if (right === 0) return Math.max(1, Math.abs(left));
  return greatestCommonDivisor(right, left % right);
}

/**
 * A readable aspect label. Canonical ratios win over exact reduction, so 5472x3072
 * reads as 16:9 rather than 57:32. Anything unusual falls back to the reduced fraction.
 */
export function ratioOf(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '1:1';
  const actual = width / height;
  for (const candidate of CANONICAL_RATIOS) {
    if (Math.abs(actual - candidate.value) / candidate.value <= RATIO_TOLERANCE) return candidate.label;
  }
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/** The three resolution classes the inspector shows, cheapest first. */
export const SIZE_TIER_LABELS = ['1K', '2K', '4K'] as const;
export type SizeTierLabel = (typeof SIZE_TIER_LABELS)[number];

/** The micro line under each tier label. */
export const SIZE_TIER_DETAILS: Readonly<Record<SizeTierLabel, string>> = {
  '1K': 'Draft',
  '2K': '4MP',
  '4K': 'Hero',
};

interface SizeTierTarget {
  label: SizeTierLabel;
  /** The longest side a preset of this tier may have; the same cuts `presetShort` uses. */
  longest: number;
  /** The pixel count a synthesized preset aims for. */
  area: number;
}

const SIZE_TIER_TARGETS: readonly SizeTierTarget[] = [
  { label: '1K', longest: 1280, area: 1024 * 1024 },
  { label: '2K', longest: 2560, area: 2048 * 2048 },
  { label: '4K', longest: Number.POSITIVE_INFINITY, area: 4096 * 4096 },
];

/**
 * The tier a preset belongs to, by its longest side. Providers name their presets freely,
 * so this is the only shared vocabulary between a provider preset and a synthesized one.
 */
export function sizeTier(preset: SizePreset): SizeTierLabel {
  const longest = Math.max(preset.width, preset.height);
  if (!Number.isFinite(longest) || longest <= 0) return '2K';
  for (const target of SIZE_TIER_TARGETS) {
    if (longest <= target.longest) return target.label;
  }
  return '4K';
}

/** The numeric value of an "a:b" label, defaulting to square for anything unreadable. */
function ratioValue(ratio: string): number {
  const [left, right] = ratio.split(':');
  const numerator = Number(left);
  const denominator = Number(right);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return 1;
  }
  return numerator / denominator;
}

/** Whether a size reads back as the ratio label, by name or within the ratio tolerance. */
function matchesRatio(width: number, height: number, ratio: string): boolean {
  if (ratioOf(width, height) === ratio) return true;
  const value = ratioValue(ratio);
  return Math.abs(width / height - value) / value <= RATIO_TOLERANCE;
}

/**
 * One synthesized preset at a target pixel count and aspect ratio. Sizes are rounded to the
 * provider's multiple, then nudged by whole steps until the label reads back as the same
 * ratio, so the tile the user picks is the tile the ratio row shows.
 */
function synthesizedPreset(ratio: string, area: number, multiple: number): SizePreset {
  const step = Math.max(1, Math.trunc(Number.isFinite(multiple) && multiple > 0 ? multiple : 32));
  const value = ratioValue(ratio);
  const snap = (candidate: number): number =>
    Math.min(MAX_IMAGE_SIZE, Math.max(MIN_IMAGE_SIZE, Math.round(candidate / step) * step));
  const baseWidth = snap(Math.sqrt(area * value));
  const baseHeight = snap(Math.sqrt(area / value));
  let width = baseWidth;
  let height = baseHeight;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let offsetWidth = -2; offsetWidth <= 2; offsetWidth += 1) {
    for (let offsetHeight = -2; offsetHeight <= 2; offsetHeight += 1) {
      const candidateWidth = snap(baseWidth + offsetWidth * step);
      const candidateHeight = snap(baseHeight + offsetHeight * step);
      if (!matchesRatio(candidateWidth, candidateHeight, ratio)) continue;
      const delta = Math.abs(candidateWidth * candidateHeight - area);
      if (delta < bestDelta) {
        width = candidateWidth;
        height = candidateHeight;
        bestDelta = delta;
      }
    }
  }
  return { id: `${width}x${height}`, label: `${width}×${height}`, width, height };
}

/**
 * Exactly three resolution tiers for one aspect ratio, in 1K, 2K, 4K order. A provider
 * preset that already sits in a tier is reused (the one closest to the tier's pixel count
 * when there are several); the rest are synthesized, because a provider that lists one
 * 16 MP preset per ratio would otherwise hide the cheaper, faster sizes entirely.
 *
 * A provider that only takes its own presets gets its list back untouched.
 */
export function tieredPresetsForRatio(
  ratioPresets: readonly SizePreset[],
  ratio: string,
  multiple: number,
  arbitrarySize: boolean,
): SizePreset[] {
  if (!arbitrarySize) return [...ratioPresets];
  return SIZE_TIER_TARGETS.map((target) => {
    let best: SizePreset | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const preset of ratioPresets) {
      if (sizeTier(preset) !== target.label) continue;
      const delta = Math.abs(preset.width * preset.height - target.area);
      if (delta < bestDelta) {
        best = preset;
        bestDelta = delta;
      }
    }
    return best ?? synthesizedPreset(ratio, target.area, multiple);
  });
}

/**
 * Retry batches are renumbered from zero by every adapter, so the incoming index is a
 * position in the retried list. The final stored record confirms the mapping.
 */
export function retryEventIndex(retried: readonly number[], incoming: number): number | null {
  return retried[incoming] ?? null;
}

/** Removes duplicate strings while preserving the first occurrence. */
export function uniqueNotes(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const note of notes) {
    const trimmed = note.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

/** A problem the user can fix before a request is sent, or null when the text is fine. */
export function promptProblem(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return 'Write a prompt first.';
  if (trimmed.length > PROMPT_MAX_LENGTH) return `Keep the prompt under ${PROMPT_MAX_LENGTH} characters.`;
  return null;
}

/** Checks the size the user typed, not the snapped size that will be sent. */
export function sizeProblem(width: number, height: number): string | null {
  for (const value of [width, height]) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return 'Width and height must be whole numbers.';
    }
    if (value < MIN_IMAGE_SIZE || value > MAX_IMAGE_SIZE) {
      return `Width and height must be ${MIN_IMAGE_SIZE} to ${MAX_IMAGE_SIZE} px.`;
    }
  }
  return null;
}

/** An empty seed is allowed and means a fresh seed per image. */
export function seedProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return 'Seed must be a whole number from 0 to 4294967295.';
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SEED) return 'Seed must be a whole number from 0 to 4294967295.';
  return null;
}

/**
 * Reads the H3 prompt expander switch from a ComfyUI API graph. Returns null when the
 * text is not JSON, or when the graph has no node 22 ComfySwitchNode switch.
 */
export function readH3ExpanderState(templateJson: string): boolean | null {
  const graph = parseGraph(templateJson);
  if (graph === null) return null;
  const node = graph['22'];
  if (!isRecord(node) || node['class_type'] !== 'ComfySwitchNode') return null;
  const inputs = node['inputs'];
  if (!isRecord(inputs) || typeof inputs['switch'] !== 'boolean') return null;
  return inputs['switch'];
}

/**
 * Flips node 22's switch and returns the rewritten graph, or null when the text is not
 * a graph with an H3 prompt expander. Formatting is normalised to two-space JSON.
 */
export function setH3ExpanderState(templateJson: string, enabled: boolean): string | null {
  const graph = parseGraph(templateJson);
  if (graph === null) return null;
  const node = graph['22'];
  if (!isRecord(node) || node['class_type'] !== 'ComfySwitchNode') return null;
  const inputs = node['inputs'];
  if (!isRecord(inputs) || typeof inputs['switch'] !== 'boolean') return null;
  const next = { ...graph, '22': { ...node, inputs: { ...inputs, switch: enabled } } };
  return JSON.stringify(next, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGraph(templateJson: string): Record<string, unknown> | null {
  const trimmed = templateJson.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A finished duration, worded the way a person reads a stopwatch: under a second is
 * "<1s", under ten seconds keeps one decimal, under a minute is whole seconds, and
 * anything longer is minutes and zero padded seconds. Null means there is nothing honest
 * to show.
 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return '<1s';
  const seconds = clamped / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/**
 * A stored batch's wall clock duration. New records carry it outright; an older record
 * is measured from its timestamps, so history saved before this field existed still
 * shows a real number instead of nothing.
 */
export function batchDurationMs(batch: BatchRecord): number | null {
  if (typeof batch.durationMs === 'number' && Number.isFinite(batch.durationMs) && batch.durationMs >= 0) {
    return batch.durationMs;
  }
  if (batch.finishedAt === undefined) return null;
  const created = Date.parse(batch.createdAt);
  const finished = Date.parse(batch.finishedAt);
  if (!Number.isFinite(created) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - created);
}

/**
 * One image's generation time. A single image run took the whole batch's wall clock, so
 * the larger of the two is the honest number: prompt enhancement and fetch time happen
 * before the provider reports the item, and the tile should still count them.
 */
export function imageDurationMs(image: StoredImage, batch: BatchRecord): number | null {
  const own =
    typeof image.durationMs === 'number' && Number.isFinite(image.durationMs) && image.durationMs >= 0
      ? image.durationMs
      : null;
  const batchMs = batchDurationMs(batch);
  if (batch.requested === 1 || batch.images.length === 1) {
    if (own === null) return batchMs;
    if (batchMs === null) return own;
    return Math.max(own, batchMs);
  }
  return own;
}

/** The loading view clock: always m:ss, so the width never changes as it counts. */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Real time per denoise step, from the rolling average the controller keeps. */
export function formatSecondsPerStep(ms: number | null | undefined): string | null {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s/step` : `${Math.round(seconds)}s/step`;
}

/** The remaining sampling time, worded so it never reads as a promise. */
export function formatEta(ms: number | null | undefined): string | null {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `~${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `~${minutes}m left` : `~${minutes}m ${rest}s left`;
}

/** The human title for a provider stage. Unknown stages still read as work in progress. */
export function stageHeadline(stage: string | null): string {
  switch (stage) {
    case null:
    case 'waiting':
      return 'Queued';
    case 'preparing':
      return 'Preparing pipeline';
    case 'loading':
      return 'Loading models';
    case 'enhancing':
      return 'Enhancing prompt';
    case 'encoding':
      return 'Encoding prompt';
    case 'sampling':
      return 'Generating image';
    case 'decoding':
      return 'Decoding pixels';
    case 'saving':
      return 'Finalizing PNG';
    default:
      return 'Working';
  }
}

export type PipelinePhase = 'prepare' | 'enhance' | 'encode' | 'diffuse' | 'decode';
export type PipelineState = 'done' | 'active' | 'pending';

export interface PipelineStep {
  id: PipelinePhase;
  label: string;
  state: PipelineState;
}

const PIPELINE_LABELS: Readonly<Record<PipelinePhase, string>> = {
  prepare: 'Prepare',
  enhance: 'Enhance',
  encode: 'Encode',
  diffuse: 'Diffuse',
  decode: 'Decode',
};

const PIPELINE_ORDER: readonly PipelinePhase[] = ['prepare', 'enhance', 'encode', 'diffuse', 'decode'];

function phaseForStage(stage: string | null): PipelinePhase {
  if (stage === 'enhancing') return 'enhance';
  if (stage === 'encoding') return 'encode';
  if (stage === 'sampling') return 'diffuse';
  if (stage === 'decoding' || stage === 'saving') return 'decode';
  return 'prepare';
}

/**
 * The compact stepper the loading tile shows. Enhance only appears when the graph actually
 * ran it, because a run with the enhancer off has no such phase to report. Completed phases
 * come from the controller, so the pills agree with the headline above them.
 */
export function pipelineStages(
  stage: string | null,
  completedStages: readonly string[] = [],
): PipelineStep[] {
  const active = phaseForStage(stage);
  const showEnhance = stage === 'enhancing' || completedStages.includes('enhancing');
  const ids = PIPELINE_ORDER.filter((id) => id !== 'enhance' || showEnhance);
  const done = new Set<PipelinePhase>();
  for (const completed of completedStages) done.add(phaseForStage(completed));
  const activePosition = ids.indexOf(active);
  return ids.map((id, position) => {
    const isDone = done.has(id) || (activePosition >= 0 && position < activePosition);
    const state: PipelineState = isDone ? 'done' : id === active ? 'active' : 'pending';
    return { id, label: PIPELINE_LABELS[id], state };
  });
}

/**
 * Early latent2rgb frames are soft and low resolution, so a step proportional blur makes
 * them read as atmosphere that resolves into focus, instead of a broken image.
 */
export function previewBlurPx(step: number | null, totalSteps: number | null): number {
  if (step === null || totalSteps === null || !Number.isFinite(step) || !Number.isFinite(totalSteps) || totalSteps <= 0) {
    return 4;
  }
  const progress = Math.min(1, Math.max(0, step / totalSteps));
  return Math.round(4 * (1 - progress) * 10) / 10;
}
