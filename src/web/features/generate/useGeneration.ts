// The generate screen controller: the form, the provider capabilities, the run and
// its event stream live in one module store, so the canvas slot and the inspector
// slot share a single batch instead of each owning half of it.
//
// The reducers and the form helpers below are pure: state in, state out. There is
// no jsdom in this project, so those functions are what review can reason about;
// the untested part is the wiring between them and the DOM.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type {
  BatchRecord,
  BatchStatus,
  GenerationEvent,
  H3ModelVariant,
  ItemFailure,
  Preset,
  ProviderCapabilities,
  ReferenceImage,
  SizePreset,
  StoredImage,
} from '../../../core/types';
import {
  getBatch,
  getProviderCapabilities,
  listBatches,
  openGenerationEvents,
  retryBatch,
  startGeneration,
  type GenerationBody,
} from '../../api';
import { useStudio, type PromptSettings } from '../../studio';
import { promptProblem, retryEventIndex, seedProblem, sizeProblem } from './helpers';

export { retryEventIndex } from './helpers';

export const MIN_STEPS = 1;
export const MAX_STEPS = 100;
export const DEFAULT_STEPS = 20;
export const DEFAULT_GUIDANCE = 7;
/** Fallback side, in size units, when a provider offers no presets at all. */
const FALLBACK_SIDE_UNITS = 128;

export type TilePhase = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface GenerationTile {
  index: number;
  phase: TilePhase;
  /** Provider stage name, when it reports one. */
  stage: string | null;
  step: number | null;
  totalSteps: number | null;
  percent: number | null;
  /** Set once the stored image is known. The grid shows the image from here. */
  imageId: string | null;
  width: number | null;
  height: number | null;
  failure: ItemFailure | null;
}

export interface GenerationBatch {
  /** The batch the grid represents. Set once the server answers. */
  batchId: string | null;
  /** The batch whose events are being consumed, which differs during a retry. */
  streamBatchId: string | null;
  providerId: string;
  prompt: string;
  width: number;
  height: number;
  requested: number;
  status: BatchStatus;
  revisedPrompt: string | null;
  tiles: GenerationTile[];
  /** A local problem, such as a lost event stream. Never the provider's failure. */
  streamError: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** The seed the batch used, when the provider reports one. */
  seed: number | null;
}

export interface GenerationForm {
  /** The provider the values below were adopted from. Null until capabilities land. */
  providerId: string | null;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  presetId: string | null;
  count: number;
  /** Kept as text so the field can be empty, which means a fresh seed. */
  seed: string;
  steps: number;
  guidance: number;
  /** Runs the provider's prompt enhancer, when its graph has one. */
  enhancePrompt: boolean;
  /** Which H3 diffusion model the graph loads. The fast weights are the default. */
  modelVariant: H3ModelVariant;
  references: ReferenceImage[];
}

export interface CapabilityState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  providerId: string | null;
  capabilities: ProviderCapabilities | null;
  error: string | null;
}

export interface AlterationCandidate {
  imageId: string;
  index: number;
  /** Two digit tile label, so the switcher reads 01, 02 and so on. */
  label: string;
}

export interface AlterationTarget extends AlterationCandidate {
  /** Every ready tile of the batch, in tile order. */
  candidates: AlterationCandidate[];
}

export interface TileSummary {
  total: number;
  waiting: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Mean completion across the batch, with failures and cancellations counted as settled. */
  percent: number;
}

export interface GenerationController {
  providerId: string | null;
  capability: CapabilityState;
  form: GenerationForm;
  batch: GenerationBatch | null;
  running: boolean;
  summary: TileSummary | null;
  failed: number[];
  canGenerate: boolean;
  /** The image an alteration would use, or null when the canvas is not altering. */
  alterationTarget: AlterationTarget | null;
  /** Every ready image of the viewed batch, for the composer switcher. */
  alterationCandidates: readonly AlterationCandidate[];
  /** Bumps whenever the composer should take focus. */
  promptFocusNonce: number;
  /** Why the generate button is off, when it is off. */
  blockedReason: string | null;
  setPrompt: (value: string) => void;
  updateForm: (patch: Partial<Omit<GenerationForm, 'references' | 'providerId'>>) => void;
  choosePreset: (preset: SizePreset) => void;
  addReference: (reference: ReferenceImage) => void;
  removeReference: (referenceId: string) => void;
  start: () => void;
  cancel: () => void;
  retry: (indices: number[]) => void;
  retryFailed: () => void;
  reloadCapabilities: () => void;
  reloadBatch: () => void;
  clearBatch: () => void;
  /** Picks which ready image of the viewed batch is the alteration source. */
  selectSourceImage: (imageId: string) => void;
  /** Returns to a blank canvas, ready for a brand new image. */
  startNewImage: () => void;
}

type ProgressEvent = Extract<GenerationEvent, { type: 'progress' }>;
type ItemEvent = Extract<GenerationEvent, { type: 'item' }>;

function createTile(index: number): GenerationTile {
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

export function createTiles(count: number): GenerationTile[] {
  const total = Math.max(1, Math.trunc(Number.isFinite(count) ? count : 1));
  return Array.from({ length: total }, (_unused, index) => createTile(index));
}

function percentFrom(step: number | undefined, totalSteps: number | undefined): number | null {
  if (step === undefined || totalSteps === undefined || totalSteps <= 0) return null;
  const ratio = Math.min(1, Math.max(0, step / totalSteps));
  return Math.round(ratio * 100);
}

export function applyProgressEvent(tiles: readonly GenerationTile[], event: ProgressEvent): GenerationTile[] {
  return tiles.map((tile) => {
    if (tile.index !== event.index) return tile;
    if (tile.phase === 'done' || tile.phase === 'failed' || tile.phase === 'cancelled') return tile;
    return {
      ...tile,
      phase: 'running',
      stage: event.stage,
      step: event.step ?? tile.step,
      totalSteps: event.totalSteps ?? tile.totalSteps,
      percent: event.percent ?? percentFrom(event.step, event.totalSteps) ?? tile.percent,
    };
  });
}

export function applyItemEvent(tiles: readonly GenerationTile[], event: ItemEvent): GenerationTile[] {
  return tiles.map((tile) => {
    if (tile.index !== event.index) return tile;
    if (tile.phase === 'cancelled') return tile;
    const { item } = event;
    if (item.ok) {
      return {
        ...tile,
        phase: 'done',
        stage: 'Ready',
        percent: 100,
        failure: null,
        width: item.width ?? tile.width,
        height: item.height ?? tile.height,
      };
    }
    return {
      ...tile,
      phase: 'failed',
      stage: null,
      percent: null,
      failure: item.failure ?? { message: 'The provider returned no image for this item.', retryable: true },
    };
  });
}

/**
 * Folds a stored batch record into the tiles. The record is the only source of
 * stored image ids, so a finished item shows its image as soon as this runs.
 */
export function mergeBatchRecord(
  tiles: readonly GenerationTile[],
  record: BatchRecord,
  mapIndex?: (index: number) => number | null,
): GenerationTile[] {
  const images = new Map<number, StoredImage>();
  for (const image of record.images) {
    const index = mapIndex === undefined ? image.index : mapIndex(image.index);
    if (index !== null) images.set(index, image);
  }
  const failures = new Map<number, ItemFailure>();
  for (const failure of record.failures) {
    const index = mapIndex === undefined ? failure.index : mapIndex(failure.index);
    if (index !== null) {
      failures.set(index, { message: failure.message, code: failure.code, retryable: failure.retryable });
    }
  }

  const previousByIndex = new Map(tiles.map((tile) => [tile.index, tile]));
  const next = createTiles(Math.max(tiles.length, record.requested));
  return next.map((tile) => {
    const base = previousByIndex.get(tile.index) ?? tile;
    const image = images.get(base.index);
    if (image !== undefined) {
      return {
        ...base,
        phase: 'done',
        stage: 'Ready',
        percent: 100,
        failure: null,
        imageId: image.id,
        width: image.width,
        height: image.height,
      };
    }
    const failure = failures.get(base.index);
    if (failure !== undefined) {
      return { ...base, phase: 'failed', stage: null, percent: null, failure };
    }
    return base;
  });
}

export function summarizeTiles(tiles: readonly GenerationTile[]): TileSummary {
  let waiting = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let settledPercent = 0;
  for (const tile of tiles) {
    if (tile.phase === 'done') {
      done += 1;
      settledPercent += 100;
    } else if (tile.phase === 'failed') {
      failed += 1;
      settledPercent += 100;
    } else if (tile.phase === 'cancelled') {
      cancelled += 1;
      settledPercent += 100;
    } else if (tile.phase === 'running') {
      running += 1;
      settledPercent += tile.percent ?? 0;
    } else {
      waiting += 1;
    }
  }
  const total = tiles.length;
  return {
    total,
    waiting,
    running,
    done,
    failed,
    cancelled,
    percent: total === 0 ? 0 : Math.round(settledPercent / total),
  };
}

export function failedIndices(tiles: readonly GenerationTile[]): number[] {
  return tiles.filter((tile) => tile.phase === 'failed').map((tile) => tile.index);
}

export function isPreservedRetry(record: BatchRecord, retried: readonly number[]): boolean {
  const incoming = [...record.images.map((image) => image.index), ...record.failures.map((failure) => failure.index)];
  return incoming.every((index) => retried.includes(index));
}

/**
 * The image an alteration run would start from. The batch on the canvas is the subject:
 * its first ready tile by default, or the tile the user picked. A provider that accepts
 * no reference images, or a batch with nothing ready yet, has no target at all.
 */
export function resolveAlterationTarget(
  batch: GenerationBatch | null,
  selectedSourceImageId: string | null,
  maxReferenceImages: number,
): AlterationTarget | null {
  if (batch === null || maxReferenceImages <= 0) return null;
  const candidates: AlterationCandidate[] = [];
  for (const tile of batch.tiles) {
    if (tile.phase !== 'done' || tile.imageId === null) continue;
    candidates.push({
      imageId: tile.imageId,
      index: tile.index,
      label: String(tile.index + 1).padStart(2, '0'),
    });
  }
  const first = candidates[0];
  if (first === undefined) return null;
  const selected = candidates.find((candidate) => candidate.imageId === selectedSourceImageId) ?? first;
  return { ...selected, candidates };
}

export function clampCount(count: number, maxBatch: number): number {
  const limit = Math.max(1, Math.trunc(Number.isFinite(maxBatch) ? maxBatch : 1));
  const value = Math.trunc(Number.isFinite(count) ? count : 1);
  return Math.min(Math.max(1, value), limit);
}

export function clampSteps(steps: number): number {
  const value = Math.round(Number.isFinite(steps) ? steps : DEFAULT_STEPS);
  return Math.min(Math.max(MIN_STEPS, value), MAX_STEPS);
}

export function snapToMultiple(value: number, multiple: number): number {
  const unit = Math.max(1, Math.trunc(Number.isFinite(multiple) ? multiple : 1));
  const rounded = Math.round((Number.isFinite(value) ? value : unit) / unit) * unit;
  return Math.max(unit, rounded);
}

export function parseSeed(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * Reconciles the form with the capabilities that just arrived, so the screen can
 * never hold a value the provider cannot honour.
 */
export function adoptCapabilities(
  form: GenerationForm,
  capabilities: ProviderCapabilities,
  providerId: string,
): GenerationForm {
  const multiple = Math.max(1, Math.trunc(Number.isFinite(capabilities.sizeMultiple) ? capabilities.sizeMultiple : 1));
  const firstPreset = capabilities.presets[0];
  const isNewProvider = form.providerId !== providerId;

  let width = form.width;
  let height = form.height;
  let presetId = form.presetId;

  if (isNewProvider) {
    presetId = firstPreset === undefined ? null : firstPreset.id;
    width = firstPreset === undefined ? multiple * FALLBACK_SIDE_UNITS : firstPreset.width;
    height = firstPreset === undefined ? multiple * FALLBACK_SIDE_UNITS : firstPreset.height;
  } else if (presetId !== null) {
    const match = capabilities.presets.find((preset) => preset.id === presetId);
    if (match === undefined) {
      presetId = null;
      width = snapToMultiple(width, multiple);
      height = snapToMultiple(height, multiple);
    } else {
      width = match.width;
      height = match.height;
    }
  } else {
    width = snapToMultiple(width, multiple);
    height = snapToMultiple(height, multiple);
  }

  const referenceLimit = Math.max(0, Math.trunc(capabilities.maxReferenceImages));

  return {
    ...form,
    providerId,
    width,
    height,
    presetId,
    count: clampCount(isNewProvider ? 1 : form.count, capabilities.maxBatch),
    steps: capabilities.adjustableSteps ? clampSteps(isNewProvider ? DEFAULT_STEPS : form.steps) : form.steps,
    guidance: Number.isFinite(form.guidance) && !isNewProvider ? form.guidance : DEFAULT_GUIDANCE,
    references: referenceLimit > 0 ? form.references.slice(0, referenceLimit) : [],
  };
}

export interface PreparedBody {
  body: GenerationBody | null;
  problem: string | null;
}

/** Builds the request from the form, sending only what the provider supports. */
export function toGenerationBody(
  form: GenerationForm,
  capabilities: ProviderCapabilities,
  providerId: string,
  alterationSourceId: string | null = null,
): PreparedBody {
  const prompt = form.prompt.trim();
  const promptIssue = promptProblem(prompt);
  if (promptIssue !== null) return { body: null, problem: promptIssue };
  const sizeIssue = sizeProblem(form.width, form.height);
  if (sizeIssue !== null) return { body: null, problem: sizeIssue };
  const seedIssue = seedProblem(form.seed);
  if (seedIssue !== null) return { body: null, problem: seedIssue };

  const multiple = Math.max(1, Math.trunc(Number.isFinite(capabilities.sizeMultiple) ? capabilities.sizeMultiple : 1));
  const width = snapToMultiple(form.width, multiple);
  const height = snapToMultiple(form.height, multiple);

  const body: GenerationBody = {
    providerId,
    prompt,
    width,
    height,
    count: clampCount(form.count, capabilities.maxBatch),
    enhancePrompt: form.enhancePrompt,
    modelVariant: form.modelVariant,
  };

  if (capabilities.negativePrompt && form.negativePrompt.trim().length > 0) {
    body.negativePrompt = form.negativePrompt.trim();
  }
  const seed = parseSeed(form.seed);
  if (capabilities.seed && seed !== null) body.seed = seed;
  if (capabilities.adjustableSteps) body.steps = clampSteps(form.steps);
  if (capabilities.guidance) body.guidance = form.guidance;
  if (capabilities.maxReferenceImages > 0) {
    const limit = Math.max(0, Math.trunc(capabilities.maxReferenceImages));
    const manual = form.references.map((reference) => reference.id);
    // The alteration source goes first, so it always survives the reference limit, and a
    // duplicate manual argument for the same image is dropped rather than sent twice.
    const combined = alterationSourceId === null ? manual : [alterationSourceId, ...manual];
    const referenceIds = combined.filter((id, position) => combined.indexOf(id) === position).slice(0, limit);
    if (referenceIds.length > 0) body.referenceIds = referenceIds;
  }

  return { body, problem: null };
}

function isFinalStatus(status: BatchStatus): boolean {
  return status === 'complete' || status === 'partial' || status === 'failed' || status === 'cancelled';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

const EMPTY_FORM: GenerationForm = {
  providerId: null,
  prompt: '',
  negativePrompt: '',
  width: 1024,
  height: 1024,
  presetId: null,
  count: 1,
  seed: '',
  steps: DEFAULT_STEPS,
  guidance: DEFAULT_GUIDANCE,
  enhancePrompt: false,
  modelVariant: 'w4a8',
  references: [],
};

const EMPTY_CAPABILITY: CapabilityState = {
  phase: 'idle',
  providerId: null,
  capabilities: null,
  error: null,
};

interface GenerationState {
  form: GenerationForm;
  capability: CapabilityState;
  batch: GenerationBatch | null;
  running: boolean;
  /** The tile the user picked as the alteration source, or null to default to the first. */
  selectedSourceImageId: string | null;
  /** A counter, so focusing the composer is an explicit event, not a render side effect. */
  promptFocusNonce: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: GenerationState = {
  form: EMPTY_FORM,
  capability: EMPTY_CAPABILITY,
  batch: null,
  running: false,
  selectedSourceImageId: null,
  promptFocusNonce: 0,
};
let activeRun: (() => void) | null = null;
/** Incremented whenever a new run starts or an existing one is cancelled. */
let runToken = 0;
/** Ordinal for batch selection, so a slower fetch cannot replace a newer choice. */
let selectionToken = 0;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): GenerationState {
  return state;
}

function setState(next: GenerationState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function update(updater: (current: GenerationState) => GenerationState): void {
  setState(updater(state));
}

function closeRun(): void {
  if (activeRun === null) return;
  const close = activeRun;
  activeRun = null;
  close();
}

function cancelledTile(index: number): GenerationTile {
  return { ...createTile(index), phase: 'cancelled' };
}

/** Builds the display batch for a stored record, including cancelled slots. */
function batchFromRecord(record: BatchRecord): GenerationBatch {
  const merged = mergeBatchRecord(createTiles(record.requested), record);
  const tiles: GenerationTile[] =
    record.status === 'cancelled'
      ? merged.map((tile) =>
          tile.phase === 'waiting' || tile.phase === 'running' ? cancelledTile(tile.index) : tile,
        )
      : merged;
  const createdAt = Date.parse(record.createdAt);
  const finishedAt = record.finishedAt === undefined ? null : Date.parse(record.finishedAt);
  return {
    batchId: record.id,
    streamBatchId: null,
    providerId: record.providerId,
    prompt: record.prompt,
    width: record.width,
    height: record.height,
    requested: record.requested,
    status: record.status,
    revisedPrompt: record.revisedPrompt ?? null,
    tiles,
    streamError: null,
    startedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    finishedAt: finishedAt !== null && Number.isFinite(finishedAt) ? finishedAt : null,
    seed: record.seed ?? null,
  };
}

function isRecent(iso: string): boolean {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time < 24 * 60 * 60 * 1000;
}

let hydrationAttempted = false;

/** The first load shows the newest stored batch instead of an empty canvas. */
async function hydrateLatestBatch(): Promise<void> {
  if (hydrationAttempted || state.batch !== null || state.running) return;
  hydrationAttempted = true;
  try {
    const records = await listBatches(1);
    const record = records[0];
    if (record === undefined || state.batch !== null || state.running) return;
    if (record.images.length === 0 && !isRecent(record.createdAt)) return;
    update((current) =>
      current.batch !== null || current.running ? current : { ...current, batch: batchFromRecord(record), running: false },
    );
  } catch {
    // The canvas stays empty when the library cannot be read. The library screen reports it.
  }
}

/**
 * Loads one stored batch for inspection, retry or reuse. A live run is never replaced.
 * A source image id selects the tile an alteration starts from; null means the first
 * ready tile. The composer takes focus, because this is a deliberate jump to the canvas.
 */
export async function loadBatchById(batchId: string, sourceImageId: string | null = null): Promise<void> {
  if (state.running) return;
  hydrationAttempted = true;
  const token = ++selectionToken;
  const runId = runToken;
  try {
    const record = await getBatch(batchId);
    if (token !== selectionToken || runId !== runToken) return;
    update((current) =>
      current.running
        ? current
        : {
            ...current,
            batch: batchFromRecord(record),
            running: false,
            selectedSourceImageId: sourceImageId,
            promptFocusNonce: current.promptFocusNonce + 1,
          },
    );
  } catch {
    // A missing batch leaves the current canvas alone.
  }
}

/** Opens a stored batch on the canvas, optionally on one exact image as the alter source. */
export function openStoredBatch(batchId: string, sourceImageId: string | null = null): Promise<void> {
  return loadBatchById(batchId, sourceImageId);
}

/** Opens a stored batch on the canvas with this image selected for alteration. */
export function alterImage(batchId: string, imageId: string): void {
  void loadBatchById(batchId, imageId);
}

/** Clears the canvas back to a blank composer, ready for a brand new image. */
export function startNewImage(): void {
  if (state.running) return;
  hydrationAttempted = true;
  selectionToken += 1;
  closeRun();
  update((current) => ({
    ...current,
    batch: null,
    running: false,
    selectedSourceImageId: null,
    promptFocusNonce: current.promptFocusNonce + 1,
    form: { ...current.form, references: [] },
  }));
}

function selectSourceImageState(imageId: string): void {
  update((current) =>
    current.selectedSourceImageId === imageId
      ? current
      : { ...current, selectedSourceImageId: imageId, promptFocusNonce: current.promptFocusNonce + 1 },
  );
}

/** Fills the composer from a preset or batch, clamped to the active provider. */
export function adoptPromptSettings(settings: PromptSettings, providerId: string | null): void {
  update((current) => {
    const activeCapabilities =
      providerId !== null && current.capability.providerId === providerId ? current.capability.capabilities : null;
    const multiple = activeCapabilities === null ? 1 : Math.max(1, Math.trunc(activeCapabilities.sizeMultiple));
    const maxBatch = activeCapabilities === null ? 10 : Math.max(1, Math.trunc(activeCapabilities.maxBatch));
    const width = settings.width === undefined ? current.form.width : snapToMultiple(settings.width, multiple);
    const height = settings.height === undefined ? current.form.height : snapToMultiple(settings.height, multiple);
    const count = settings.count === undefined ? current.form.count : clampCount(settings.count, maxBatch);
    // Reusing a prompt means a new image from that prompt, not an alteration of whatever
    // batch happened to be on the canvas. A live run keeps its own batch on screen.
    return {
      ...current,
      batch: current.running ? current.batch : null,
      selectedSourceImageId: current.running ? current.selectedSourceImageId : null,
      form: {
        ...current.form,
        providerId: providerId ?? current.form.providerId,
        prompt: settings.prompt,
        negativePrompt:
          settings.negativePrompt === undefined ? current.form.negativePrompt : settings.negativePrompt,
        width,
        height,
        count,
        presetId: null,
      },
    };
  });
}

export function applyPresetToForm(preset: Preset, providerId: string | null): void {
  adoptPromptSettings(
    { prompt: preset.prompt, width: preset.width, height: preset.height, count: preset.count },
    providerId,
  );
}

function updateFormState(patch: Partial<Omit<GenerationForm, 'references' | 'providerId'>>): void {
  update((current) => ({ ...current, form: { ...current.form, ...patch } }));
}

function addReferenceState(reference: ReferenceImage): void {
  update((current) => {
    const capabilities = current.capability.capabilities;
    const limit = capabilities === null ? Number.POSITIVE_INFINITY : Math.max(0, capabilities.maxReferenceImages);
    if (current.form.references.length >= limit) return current;
    if (current.form.references.some((existing) => existing.id === reference.id)) return current;
    return { ...current, form: { ...current.form, references: [...current.form.references, reference] } };
  });
}

function removeReferenceState(referenceId: string): void {
  update((current) => ({
    ...current,
    form: {
      ...current.form,
      references: current.form.references.filter((reference) => reference.id !== referenceId),
    },
  }));
}

function ensureCapabilities(providerId: string): void {
  const current = state.capability;
  if (current.providerId === providerId && (current.phase === 'loading' || current.phase === 'ready')) return;

  update((snapshot) => ({
    ...snapshot,
    capability: { phase: 'loading', providerId, capabilities: null, error: null },
  }));

  getProviderCapabilities(providerId)
    .then((capabilities) => {
      if (state.capability.providerId !== providerId) return;
      update((snapshot) => ({
        ...snapshot,
        capability: { phase: 'ready', providerId, capabilities, error: null },
        form: adoptCapabilities(snapshot.form, capabilities, providerId),
      }));
    })
    .catch((error: unknown) => {
      if (state.capability.providerId !== providerId) return;
      update((snapshot) => ({
        ...snapshot,
        capability: { phase: 'error', providerId, capabilities: null, error: describeError(error) },
      }));
    });
}

function reloadCapabilitiesState(): void {
  const providerId = state.capability.providerId;
  if (providerId === null) return;
  update((snapshot) => ({ ...snapshot, capability: { ...snapshot.capability, phase: 'idle' } }));
  ensureCapabilities(providerId);
}

/** Folds a record into the batch, but only when it belongs to the running stream. */
function applyRecord(record: BatchRecord, retried: readonly number[] | null): void {
  const mapper =
    retried === null || isPreservedRetry(record, retried) ? undefined : (index: number) => retried[index] ?? null;
  update((current) => {
    if (current.batch === null) return current;
    return {
      ...current,
      batch: {
        ...current.batch,
        batchId: current.batch.batchId ?? record.id,
        status: record.status,
        revisedPrompt: record.revisedPrompt ?? current.batch.revisedPrompt,
        seed: record.seed ?? current.batch.seed,
        tiles: mergeBatchRecord(current.batch.tiles, record, mapper),
      },
    };
  });
}

async function syncBatch(batchId: string, retried: readonly number[] | null, onSettled: () => void): Promise<void> {
  try {
    const record = await getBatch(batchId);
    if (state.batch === null || state.batch.streamBatchId !== batchId) return;
    applyRecord(record, retried);
    if (isFinalStatus(record.status)) {
      closeRun();
      update((current) => (current.batch === null ? { ...current, running: false } : { ...current, running: false, batch: { ...current.batch, streamBatchId: null, finishedAt: Date.now() } }));
      onSettled();
    }
  } catch {
    // The final batch event carries the same record, so a failed sync is not surfaced.
  }
}

function openRun(batchId: string, retried: readonly number[] | null, onSettled: () => void): void {
  closeRun();
  const runId = runToken;
  const map = (incoming: number): number | null => (retried === null ? incoming : retryEventIndex(retried, incoming));

  const close = openGenerationEvents(batchId, {
    onProgress: (event) => {
      if (runId !== runToken) return;
      const index = map(event.index);
      if (index === null) return;
      update((current) =>
        current.batch === null
          ? current
          : { ...current, batch: { ...current.batch, tiles: applyProgressEvent(current.batch.tiles, { ...event, index }) } },
      );
    },
    onItem: (event) => {
      if (runId !== runToken) return;
      const index = map(event.index);
      if (index === null) return;
      update((current) =>
        current.batch === null
          ? current
          : { ...current, batch: { ...current.batch, tiles: applyItemEvent(current.batch.tiles, { ...event, index }) } },
      );
      void syncBatch(batchId, retried, onSettled);
    },
    onBatch: (record) => {
      if (runId !== runToken) return;
      // A sync may have settled the stream first, in which case this event is stale.
      if (state.batch !== null && state.batch.streamBatchId !== batchId) return;
      applyRecord(record, retried);
      update((current) =>
        current.batch === null
          ? { ...current, running: false }
          : {
              ...current,
              running: false,
              batch: { ...current.batch, status: record.status, streamError: null, streamBatchId: null, finishedAt: Date.now() },
            },
      );
      activeRun = null;
      onSettled();
    },
    onError: (error) => {
      if (activeRun !== close) return;
      activeRun = null;
      update((current) =>
        current.batch === null
          ? { ...current, running: false }
          : { ...current, running: false, batch: { ...current.batch, streamError: error.message } },
      );
      onSettled();
    },
  });

  activeRun = close;
}

async function beginGeneration(onSettled: () => void): Promise<void> {
  if (state.running) return;
  hydrationAttempted = true;
  const capabilities = state.capability.capabilities;
  const providerId = state.capability.providerId;
  if (capabilities === null || providerId === null) return;

  const alterationTarget = resolveAlterationTarget(
    state.batch,
    state.selectedSourceImageId,
    capabilities.maxReferenceImages,
  );
  const prepared = toGenerationBody(
    state.form,
    capabilities,
    providerId,
    alterationTarget === null ? null : alterationTarget.imageId,
  );
  if (prepared.body === null) return;
  const body = prepared.body;

  const token = ++runToken;
  closeRun();
  const batch: GenerationBatch = {
    batchId: null,
    streamBatchId: null,
    providerId,
    prompt: body.prompt,
    width: body.width,
    height: body.height,
    requested: body.count,
    status: 'queued',
    revisedPrompt: null,
    tiles: createTiles(body.count),
    streamError: null,
    startedAt: Date.now(),
    finishedAt: null,
    seed: body.seed ?? null,
  };
  // The selection belongs to the batch just left behind. Clearing it makes the finished
  // alteration batch target its own first ready image, so editing can continue in place.
  update((current) => ({ ...current, running: true, batch, selectedSourceImageId: null }));

  let created: { batchId: string };
  try {
    created = await startGeneration(body);
  } catch (error) {
    if (token !== runToken) {
      onSettled();
      return;
    }
    update((current) =>
      current.batch === null
        ? { ...current, running: false }
        : {
            ...current,
            running: false,
            batch: { ...current.batch, status: 'failed', streamError: describeError(error), finishedAt: Date.now() },
          },
    );
    onSettled();
    return;
  }

  // Cancelled or replaced while the request was in flight: the stream is never attached.
  if (token !== runToken || !state.running) {
    onSettled();
    return;
  }

  update((current) =>
    current.batch === null
      ? current
      : {
          ...current,
          batch: { ...current.batch, batchId: created.batchId, streamBatchId: created.batchId, status: 'running' },
        },
  );
  // The batch exists now, so the library should list it before it settles.
  onSettled();
  openRun(created.batchId, null, onSettled);
}

async function retryRun(indices: readonly number[], onSettled: () => void): Promise<void> {
  const batch = state.batch;
  if (batch === null || batch.batchId === null || state.running) return;

  const retried = [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < batch.tiles.length)
    .sort((left, right) => left - right);
  if (retried.length === 0) return;

  const previousTiles = batch.tiles;
  const fallbackStatus: BatchStatus = batch.status === 'partial' ? 'partial' : 'failed';
  const token = ++runToken;
  closeRun();
  update((current) => {
    if (current.batch === null) return current;
    const tiles = current.batch.tiles.map((tile) => (retried.includes(tile.index) ? createTile(tile.index) : tile));
    return {
      ...current,
      running: true,
      batch: {
        ...current.batch,
        tiles,
        status: 'running',
        streamError: null,
        streamBatchId: null,
        startedAt: Date.now(),
        finishedAt: null,
      },
    };
  });

  const batchId = batch.batchId;
  try {
    const created = await retryBatch(batchId, retried);
    if (token !== runToken || !state.running) {
      onSettled();
      return;
    }
    update((current) => (current.batch === null ? current : { ...current, batch: { ...current.batch, streamBatchId: created.batchId } }));
    // The retry batch exists now, so refresh the library totals immediately.
    onSettled();
    openRun(created.batchId, retried, onSettled);
  } catch (error) {
    if (token !== runToken) {
      onSettled();
      return;
    }
    update((current) =>
      current.batch === null || !current.running
        ? current
        : {
            ...current,
            running: false,
            batch: {
              ...current.batch,
              status: fallbackStatus,
              tiles: previousTiles,
              streamError: describeError(error),
              finishedAt: Date.now(),
            },
          },
    );
    onSettled();
  }
}

function retryFailedRun(onSettled: () => void): void {
  const batch = state.batch;
  if (batch === null) return;
  void retryRun(failedIndices(batch.tiles), onSettled);
}

function cancelRun(onSettled: () => void): void {
  if (!state.running) return;
  // There is no cancel endpoint in the contract: dropping the event stream is the
  // signal the server gets, and the local status says what the screen is showing.
  runToken += 1;
  closeRun();
  update((current) => {
    if (current.batch === null) return { ...current, running: false };
    const tiles = current.batch.tiles.map((tile) =>
      tile.phase === 'running' || tile.phase === 'waiting' ? cancelledTile(tile.index) : tile,
    );
    return {
      ...current,
      running: false,
      batch: { ...current.batch, status: 'cancelled', tiles, streamBatchId: null, finishedAt: Date.now() },
    };
  });
  onSettled();
}

async function reloadBatchRun(onSettled: () => void): Promise<void> {
  const batchId = state.batch === null ? null : state.batch.batchId;
  if (batchId === null) return;
  const token = runToken;
  try {
    const record = await getBatch(batchId);
    if (token !== runToken || state.batch === null || state.batch.batchId !== batchId) return;
    applyRecord(record, null);
    update((current) =>
      current.batch === null
        ? current
        : {
            ...current,
            running: false,
            batch: { ...current.batch, streamError: null, finishedAt: Date.now() },
          },
    );
    onSettled();
  } catch (error) {
    if (token !== runToken || state.batch === null || state.batch.batchId !== batchId) return;
    update((current) =>
      current.batch === null ? current : { ...current, batch: { ...current.batch, streamError: describeError(error) } },
    );
  }
}

/** Returns the canvas to the empty prompt-starter screen. A live run is never cleared. */
function clearBatchState(): void {
  startNewImage();
}

/**
 * The controller the canvas and the inspector both read. One module store means a
 * run started in the composer is visible in the results grid immediately.
 */
export function useGeneration(): GenerationController {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const studio = useStudio();
  const provider = studio.provider;
  const providerId = provider === null ? null : provider.id;
  const refresh = studio.refresh;

  useEffect(() => {
    if (providerId !== null) ensureCapabilities(providerId);
  }, [providerId]);

  // Show the newest stored batch on a cold start. This runs once per page load.
  useEffect(() => {
    if (state.batch === null) void hydrateLatestBatch();
  }, []);

  const settle = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const setPrompt = useCallback((value: string): void => {
    updateFormState({ prompt: value });
  }, []);

  const updateForm = useCallback((patch: Partial<Omit<GenerationForm, 'references' | 'providerId'>>): void => {
    updateFormState(patch);
  }, []);

  const choosePreset = useCallback((preset: SizePreset): void => {
    updateFormState({ width: preset.width, height: preset.height, presetId: preset.id });
  }, []);

  const addReference = useCallback((reference: ReferenceImage): void => {
    addReferenceState(reference);
  }, []);

  const removeReference = useCallback((referenceId: string): void => {
    removeReferenceState(referenceId);
  }, []);

  const start = useCallback((): void => {
    void beginGeneration(settle);
  }, [settle]);

  const cancel = useCallback((): void => {
    cancelRun(settle);
  }, [settle]);

  const retry = useCallback(
    (indices: number[]): void => {
      void retryRun(indices, settle);
    },
    [settle],
  );

  const retryFailed = useCallback((): void => {
    retryFailedRun(settle);
  }, [settle]);

  const reloadCapabilities = useCallback((): void => {
    reloadCapabilitiesState();
  }, []);

  const reloadBatch = useCallback((): void => {
    void reloadBatchRun(settle);
  }, [settle]);

  const clearBatch = useCallback((): void => {
    clearBatchState();
  }, []);

  const selectSourceImage = useCallback((imageId: string): void => {
    selectSourceImageState(imageId);
  }, []);

  const startNewImageAction = useCallback((): void => {
    startNewImage();
  }, []);

  const maxReferenceImages =
    snapshot.capability.capabilities === null
      ? 0
      : Math.max(0, Math.trunc(snapshot.capability.capabilities.maxReferenceImages));
  const alterationTarget = resolveAlterationTarget(
    snapshot.batch,
    snapshot.selectedSourceImageId,
    maxReferenceImages,
  );

  const promptIssue = promptProblem(snapshot.form.prompt);
  const sizeIssue = sizeProblem(snapshot.form.width, snapshot.form.height);
  const seedIssue = seedProblem(snapshot.form.seed);
  let blockedReason: string | null = null;
  if (provider === null) blockedReason = 'No provider is enabled yet.';
  else if (snapshot.capability.providerId !== providerId) blockedReason = 'Loading provider capabilities.';
  else if (snapshot.capability.phase === 'idle' || snapshot.capability.phase === 'loading') {
    blockedReason = 'Loading provider capabilities.';
  } else if (snapshot.capability.phase === 'error') blockedReason = 'Provider capabilities could not be loaded.';
  else if (snapshot.running) blockedReason = 'A batch is already running.';
  else if (promptIssue !== null) blockedReason = promptIssue;
  else if (sizeIssue !== null) blockedReason = sizeIssue;
  else if (seedIssue !== null) blockedReason = seedIssue;

  return {
    providerId,
    capability: snapshot.capability,
    form: snapshot.form,
    batch: snapshot.batch,
    running: snapshot.running,
    summary: snapshot.batch === null ? null : summarizeTiles(snapshot.batch.tiles),
    failed: snapshot.batch === null ? [] : failedIndices(snapshot.batch.tiles),
    canGenerate: blockedReason === null,
    blockedReason,
    alterationTarget,
    alterationCandidates: alterationTarget === null ? [] : alterationTarget.candidates,
    promptFocusNonce: snapshot.promptFocusNonce,
    setPrompt,
    updateForm,
    choosePreset,
    addReference,
    removeReference,
    start,
    cancel,
    retry,
    retryFailed,
    reloadCapabilities,
    reloadBatch,
    clearBatch,
    selectSourceImage,
    startNewImage: startNewImageAction,
  };
}
