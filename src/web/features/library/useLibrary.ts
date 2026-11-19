// The library controller. Batches, paging, selection, export and deletion live in
// one module store, so the rail list and the library canvas read the same state
// instead of each keeping its own copy.
//
// The selection reducers and the formatting helpers below are pure: state in,
// state out. There is no jsdom in this project, so those functions are what
// review can reason about; the untested part is the wiring between them and the DOM.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BatchRecord, StoredImage } from '../../../core/types';
import {
  ApiError,
  deleteBatch as deleteBatchRequest,
  exportImages,
  listBatches,
  retryBatch as retryBatchRequest,
} from '../../api';
import { useStudio } from '../../App';

/** Batches fetched per page. /api/batches takes a limit, so a page is the newest N. */
export const PAGE_SIZE = 10;
/** Rows the left rail shows. */
export const RAIL_LIMIT = 6;
/** /api/export accepts at most this many image ids. Mirrors MAX_IMAGE_IDS on the server. */
export const MAX_EXPORT_IMAGES = 200;

export type LibraryPhase = 'idle' | 'loading' | 'ready' | 'error';

/** A result a surface can show as a toast or an inline status. */
export interface LibraryNotice {
  tone: 'success' | 'error';
  message: string;
}

/** Where a shift click starts counting from: one image in one batch. */
export interface SelectionAnchor {
  batchId: string;
  index: number;
}

export interface SelectedImage {
  batch: BatchRecord;
  image: StoredImage;
}

export interface LibraryController {
  batches: BatchRecord[];
  phase: LibraryPhase;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  selectedCount: number;
  activeBatchId: string | null;
  isSelected: (imageId: string) => boolean;
  toggleImage: (batch: BatchRecord, index: number, extend: boolean) => void;
  selectBatchImages: (batch: BatchRecord, selected: boolean) => void;
  clearSelection: () => void;
  selectBatch: (batchId: string | null) => void;
  firstSelected: SelectedImage | null;
  reload: () => Promise<void>;
  loadMore: () => void;
  exporting: boolean;
  exportSelection: () => Promise<LibraryNotice>;
  deletingBatchId: string | null;
  deleteBatch: (batchId: string) => Promise<LibraryNotice>;
  retryingBatchId: string | null;
  retryFailed: (batch: BatchRecord) => Promise<LibraryNotice>;
}

interface LibraryState {
  batches: BatchRecord[];
  phase: LibraryPhase;
  error: string | null;
  limit: number;
  hasMore: boolean;
  loadingMore: boolean;
  selectedImageIds: string[];
  anchor: SelectionAnchor | null;
  activeBatchId: string | null;
  exporting: boolean;
  deletingBatchId: string | null;
  retryingBatchId: string | null;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const timestampFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const shortTimestampFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Images in the order the batch requested them, whatever order the store listed them in. */
export function orderedImages(batch: BatchRecord): StoredImage[] {
  return [...batch.images].sort((left, right) => left.index - right.index);
}

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'B';
  return unitIndex === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

export function formatCount(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString('en-GB')} ${value === 1 ? singular : plural}`;
}

export function formatTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Unknown time';
  return timestampFormat.format(new Date(time));
}

export function formatShortTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Unknown time';
  return shortTimestampFormat.format(new Date(time));
}

/** The first words of a prompt, for a row that has one line for it. */
export function promptExcerpt(prompt: string, wordLimit = 6): string {
  const words = prompt.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return 'Untitled batch';
  const head = words.slice(0, wordLimit).join(' ');
  return words.length > wordLimit ? `${head}...` : head;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A download name that sorts by when it was made and never collides within a second. */
export function exportFilename(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `h3-studio-${day}-${clock}.zip`;
}

/**
 * Adds or removes one image. A shift click with an anchor in the same batch
 * replaces the selection with the range between the anchor and the click, which
 * is what a file list does.
 */
export function toggleSelection(
  selectedImageIds: readonly string[],
  batch: BatchRecord,
  index: number,
  extend: boolean,
  anchor: SelectionAnchor | null,
): { selectedImageIds: string[]; anchor: SelectionAnchor | null } {
  const images = orderedImages(batch);
  const position = images.findIndex((image) => image.index === index);
  const image = position === -1 ? undefined : images[position];
  if (image === undefined) return { selectedImageIds: [...selectedImageIds], anchor };

  if (extend && anchor !== null && anchor.batchId === batch.id) {
    const anchorPosition = images.findIndex((candidate) => candidate.index === anchor.index);
    if (anchorPosition !== -1) {
      const from = Math.min(anchorPosition, position);
      const to = Math.max(anchorPosition, position);
      return {
        selectedImageIds: images.slice(from, to + 1).map((candidate) => candidate.id),
        anchor: { batchId: batch.id, index },
      };
    }
  }

  const selected = new Set(selectedImageIds);
  const next = selected.has(image.id)
    ? selectedImageIds.filter((id) => id !== image.id)
    : [...selectedImageIds, image.id];
  return { selectedImageIds: next, anchor: { batchId: batch.id, index } };
}

/** Adds or removes every image of one batch, leaving other batches alone. */
export function selectBatchImages(
  selectedImageIds: readonly string[],
  batch: BatchRecord,
  selected: boolean,
): string[] {
  const batchIds = orderedImages(batch).map((image) => image.id);
  if (!selected) {
    const removed = new Set(batchIds);
    return selectedImageIds.filter((id) => !removed.has(id));
  }
  const known = new Set(selectedImageIds);
  const next = [...selectedImageIds];
  for (const id of batchIds) {
    if (known.has(id)) continue;
    known.add(id);
    next.push(id);
  }
  return next;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The studio server did not answer.';
  if (error instanceof Error) return error.message;
  return 'The library request failed.';
}

function describeExportError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 415) {
      return 'The server refused the export format. The studio writes PNG archives, so reload the page and try again.';
    }
    if (error.status === 404) {
      return 'One of the selected images is no longer in the library. Reload the library and try again.';
    }
    return error.message;
  }
  if (error instanceof TypeError) return 'The studio server did not answer, so nothing was exported.';
  if (error instanceof Error) return error.message;
  return 'The export failed.';
}

function describeDeleteError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'That batch is already gone. The library refreshes itself.';
  }
  return describeError(error);
}

/** Hands a blob to the browser as a download. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // The browser reads the blob URL after the click returns, so revoking later is safe.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

type Listener = () => void;

const listeners = new Set<Listener>();

let state: LibraryState = {
  batches: [],
  phase: 'idle',
  error: null,
  limit: 0,
  hasMore: false,
  loadingMore: false,
  selectedImageIds: [],
  anchor: null,
  activeBatchId: null,
  exporting: false,
  deletingBatchId: null,
  retryingBatchId: null,
};

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LibraryState {
  return state;
}

function update(updater: (current: LibraryState) => LibraryState): void {
  const next = updater(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

async function loadPage(nextLimit: number, mode: 'initial' | 'more' | 'reload'): Promise<void> {
  if (mode === 'more') update((current) => ({ ...current, loadingMore: true, error: null }));
  else if (mode === 'initial') update((current) => ({ ...current, phase: 'loading', error: null }));

  try {
    const records = await listBatches(nextLimit);
    // Newest first, whatever order the store answered in.
    const batches = [...records].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

    update((current) => {
      const knownImages = new Set<string>();
      for (const batch of batches) {
        for (const image of batch.images) knownImages.add(image.id);
      }
      const previousAnchor: SelectionAnchor | null = current.anchor;
      const keepAnchor =
        previousAnchor !== null && batches.some((batch) => batch.id === previousAnchor.batchId);
      return {
        ...current,
        batches,
        phase: 'ready',
        error: null,
        limit: nextLimit,
        hasMore: records.length >= nextLimit,
        loadingMore: false,
        selectedImageIds: current.selectedImageIds.filter((id) => knownImages.has(id)),
        anchor: keepAnchor ? previousAnchor : null,
        activeBatchId:
          current.activeBatchId !== null && batches.some((batch) => batch.id === current.activeBatchId)
            ? current.activeBatchId
            : null,
      };
    });
  } catch (error) {
    update((current) => ({
      ...current,
      phase: current.phase === 'ready' ? 'ready' : 'error',
      error: describeError(error),
      loadingMore: false,
    }));
  }
}

function ensureLoaded(): void {
  if (state.phase !== 'idle') return;
  void loadPage(PAGE_SIZE, 'initial');
}

async function reloadState(): Promise<void> {
  const nextLimit = state.limit > 0 ? state.limit : PAGE_SIZE;
  await loadPage(nextLimit, state.phase === 'ready' ? 'reload' : 'initial');
}

function loadMoreState(): void {
  if (state.phase !== 'ready' || state.loadingMore || !state.hasMore) return;
  void loadPage(state.limit + PAGE_SIZE, 'more');
}

function toggleImageState(batch: BatchRecord, index: number, extend: boolean): void {
  update((current) => {
    const result = toggleSelection(current.selectedImageIds, batch, index, extend, current.anchor);
    return { ...current, selectedImageIds: result.selectedImageIds, anchor: result.anchor };
  });
}

function selectBatchImagesState(batch: BatchRecord, selected: boolean): void {
  update((current) => ({
    ...current,
    selectedImageIds: selectBatchImages(current.selectedImageIds, batch, selected),
  }));
}

function clearSelectionState(): void {
  update((current) =>
    current.selectedImageIds.length === 0 && current.anchor === null
      ? current
      : { ...current, selectedImageIds: [], anchor: null },
  );
}

function selectBatchState(batchId: string | null): void {
  update((current) => (current.activeBatchId === batchId ? current : { ...current, activeBatchId: batchId }));
}

async function exportSelectionState(): Promise<LibraryNotice> {
  if (state.exporting) return { tone: 'error', message: 'An export is already running.' };
  const imageIds = [...state.selectedImageIds];
  if (imageIds.length === 0) return { tone: 'error', message: 'Select at least one image to export.' };
  if (imageIds.length > MAX_EXPORT_IMAGES) {
    return {
      tone: 'error',
      message: `The server exports at most ${MAX_EXPORT_IMAGES} images at a time. Select ${MAX_EXPORT_IMAGES} or fewer.`,
    };
  }

  update((current) => ({ ...current, exporting: true }));
  try {
    const blob = await exportImages({ imageIds, format: 'png' });
    const filename = exportFilename(new Date());
    saveBlob(blob, filename);
    update((current) => ({ ...current, exporting: false }));
    return {
      tone: 'success',
      message: `Exported ${formatCount(imageIds.length, 'image', 'images')} to ${filename} (${formatBytes(blob.size)}).`,
    };
  } catch (error) {
    update((current) => ({ ...current, exporting: false }));
    return { tone: 'error', message: describeExportError(error) };
  }
}

async function deleteBatchState(batchId: string): Promise<LibraryNotice> {
  if (state.deletingBatchId !== null) return { tone: 'error', message: 'A batch is already being deleted.' };
  update((current) => ({ ...current, deletingBatchId: batchId }));

  try {
    await deleteBatchRequest(batchId);
  } catch (error) {
    update((current) => ({ ...current, deletingBatchId: null }));
    return { tone: 'error', message: describeDeleteError(error) };
  }

  const removed = state.batches.find((batch) => batch.id === batchId);
  const removedImageIds = new Set(removed === undefined ? [] : removed.images.map((image) => image.id));
  update((current) => {
    const anchor: SelectionAnchor | null =
      current.anchor !== null && current.anchor.batchId === batchId ? null : current.anchor;
    return {
      ...current,
      deletingBatchId: null,
      selectedImageIds: current.selectedImageIds.filter((id) => !removedImageIds.has(id)),
      activeBatchId: current.activeBatchId === batchId ? null : current.activeBatchId,
      anchor,
    };
  });

  await reloadState();
  return { tone: 'success', message: 'The batch and its images were deleted.' };
}

async function retryFailedState(batch: BatchRecord): Promise<LibraryNotice> {
  if (state.retryingBatchId !== null) return { tone: 'error', message: 'A retry is already running.' };
  const indices = [...new Set(batch.failures.map((failure) => failure.index))].sort((left, right) => left - right);
  if (indices.length === 0) return { tone: 'error', message: 'This batch has no failed images to retry.' };

  update((current) => ({ ...current, retryingBatchId: batch.id }));
  try {
    await retryBatchRequest(batch.id, indices);
    update((current) => ({ ...current, retryingBatchId: null }));
    await reloadState();
    return {
      tone: 'success',
      message: `Retrying ${formatCount(indices.length, 'image', 'images')} from this batch.`,
    };
  } catch (error) {
    update((current) => ({ ...current, retryingBatchId: null }));
    return { tone: 'error', message: describeError(error) };
  }
}

/**
 * The controller the rail and the library canvas both read.
 */
export function useLibrary(): LibraryController {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { refresh, stats } = useStudio();

  useEffect(() => {
    ensureLoaded();
  }, []);

  // A finished generation bumps the studio totals, which is the cue that the
  // library has a new batch. Only a change of totals refetches, not every refresh.
  const totalsKey = stats === null ? '' : `${stats.batchCount}:${stats.imageCount}`;
  useEffect(() => {
    if (totalsKey.length === 0 || state.phase !== 'ready') return;
    void reloadState();
  }, [totalsKey]);

  const selectedSet = useMemo(() => new Set(snapshot.selectedImageIds), [snapshot.selectedImageIds]);

  const isSelected = useCallback((imageId: string): boolean => selectedSet.has(imageId), [selectedSet]);

  const toggleImage = useCallback((batch: BatchRecord, index: number, extend: boolean): void => {
    toggleImageState(batch, index, extend);
  }, []);

  const selectBatchImagesCallback = useCallback((batch: BatchRecord, selected: boolean): void => {
    selectBatchImagesState(batch, selected);
  }, []);

  const clearSelection = useCallback((): void => {
    clearSelectionState();
  }, []);

  const selectBatch = useCallback((batchId: string | null): void => {
    selectBatchState(batchId);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    await reloadState();
  }, []);

  const loadMore = useCallback((): void => {
    loadMoreState();
  }, []);

  const exportSelection = useCallback(async (): Promise<LibraryNotice> => exportSelectionState(), []);

  const deleteBatch = useCallback(
    async (batchId: string): Promise<LibraryNotice> => {
      const notice = await deleteBatchState(batchId);
      if (notice.tone === 'success') void refresh();
      return notice;
    },
    [refresh],
  );

  const retryFailed = useCallback(async (batch: BatchRecord): Promise<LibraryNotice> => {
    const notice = await retryFailedState(batch);
    if (notice.tone === 'success') void refresh();
    return notice;
  }, [refresh]);

  const firstSelected = useMemo<SelectedImage | null>(() => {
    const firstId = snapshot.selectedImageIds[0];
    if (firstId === undefined) return null;
    for (const batch of snapshot.batches) {
      const image = orderedImages(batch).find((candidate) => candidate.id === firstId);
      if (image !== undefined) return { batch, image };
    }
    return null;
  }, [snapshot.batches, snapshot.selectedImageIds]);

  return {
    batches: snapshot.batches,
    phase: snapshot.phase,
    error: snapshot.error,
    hasMore: snapshot.hasMore,
    loadingMore: snapshot.loadingMore,
    selectedCount: snapshot.selectedImageIds.length,
    activeBatchId: snapshot.activeBatchId,
    isSelected,
    toggleImage,
    selectBatchImages: selectBatchImagesCallback,
    clearSelection,
    selectBatch,
    firstSelected,
    reload,
    loadMore,
    exporting: snapshot.exporting,
    exportSelection,
    deletingBatchId: snapshot.deletingBatchId,
    deleteBatch,
    retryingBatchId: snapshot.retryingBatchId,
    retryFailed,
  };
}
