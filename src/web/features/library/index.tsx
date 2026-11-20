// The library screen. LibraryCanvas is the full view for the centre panel;
// LibraryRail is the compact recent list for the left rail. Both read the same
// controller, so a batch selected in the rail is highlighted in the canvas.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BatchRecord, BatchStatus } from '../../../core/types';
import { imageUrl } from '../../api';
import { useStudio } from '../../App';
import { Button, Dialog, EmptyState, SegmentedControl, Spinner } from '../../components';
import { batchDurationMs, formatDuration } from '../generate/helpers';
import { clearIfShowingBatch } from '../generate/useGeneration';
import {
  formatCount,
  formatTimestamp,
  orderedImages,
  promptExcerpt,
  RAIL_LIMIT,
  useLibrary,
  type LibraryNotice,
} from './useLibrary';
import { ImageViewer } from './viewer';
import './library.css';

interface ViewerState {
  batch: BatchRecord;
  imageId: string;
}

function ImageIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="M4.5 17.5l5-5 4 4 2.5-2.5 3.5 3.5" />
    </svg>
  );
}

function TrashIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7.5h14M9.5 7.5V5.5h5v2M7 7.5l.8 11h8.4l.8-11M10.5 10.5v5M13.5 10.5v5" />
    </svg>
  );
}

function DownloadIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4.5v10M8 11l4 4 4-4M5 19.5h14" />
    </svg>
  );
}

function statusLabel(status: BatchStatus): string {
  if (status === 'complete') return 'Complete';
  if (status === 'partial') return 'Partial';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Stopped';
  if (status === 'running') return 'Running';
  return 'Queued';
}

interface BatchSectionProps {
  batch: BatchRecord;
  providerLabel: string;
  active: boolean;
  deleting: boolean;
  retrying: boolean;
  isSelected: (imageId: string) => boolean;
  onToggleImage: (batch: BatchRecord, index: number, extend: boolean) => void;
  onSelectBatch: (batch: BatchRecord, selected: boolean) => void;
  onOpen: (batch: BatchRecord, imageId: string, trigger: HTMLElement | null) => void;
  onRequestDelete: (batch: BatchRecord) => void;
  onRetryFailed: (batch: BatchRecord) => void;
  onUsePrompt: (batch: BatchRecord) => void;
  onCopyPrompt: (batch: BatchRecord) => void;
}

function BatchSection({
  batch,
  providerLabel,
  active,
  deleting,
  retrying,
  isSelected,
  onToggleImage,
  onSelectBatch,
  onOpen,
  onRequestDelete,
  onRetryFailed,
  onUsePrompt,
  onCopyPrompt,
}: BatchSectionProps): ReactNode {
  const images = orderedImages(batch);
  const selectedCount = images.filter((image) => isSelected(image.id)).length;
  const allSelected = images.length > 0 && selectedCount === images.length;
  const ratio = batch.width > 0 && batch.height > 0 ? `${batch.width} / ${batch.height}` : '1 / 1';
  const headingId = `lb-batch-${batch.id}`;
  const firstFailure = batch.failures[0];

  return (
    <article className={active ? 'lb-batch is-active' : 'lb-batch'} aria-labelledby={headingId} data-batch-id={batch.id}>
      <header className="lb-batch-head">
        <div className="lb-batch-copy">
          <h3 className="lb-batch-prompt" id={headingId}>
            {batch.prompt}
          </h3>
          <p className="lb-batch-meta">
            <span className="lb-batch-provider">{providerLabel}</span>
            <span>
              {batch.width} x {batch.height}
            </span>
            <span>
              {formatCount(batch.images.length, 'image', 'images')} of {batch.requested}
            </span>
            <span>{formatTimestamp(batch.createdAt)}</span>
          </p>
        </div>
        <div className="lb-batch-actions">
          <span className={`lb-status is-${batch.status}`}>{statusLabel(batch.status)}</span>
          <Button variant="ghost" size="sm" onClick={() => onUsePrompt(batch)}>
            Use prompt
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onCopyPrompt(batch)}>
            Copy prompt
          </Button>
          {batch.failures.length === 0 ? null : (
            <Button
              variant="secondary"
              size="sm"
              busy={retrying}
              disabled={retrying}
              onClick={() => onRetryFailed(batch)}
            >
              Retry failed
            </Button>
          )}
          {images.length === 0 ? null : (
            <Button variant="ghost" size="sm" onClick={() => onSelectBatch(batch, !allSelected)}>
              {allSelected ? 'Unselect all' : 'Select all'}
            </Button>
          )}
          <Button variant="ghost" size="sm" busy={deleting} onClick={() => onRequestDelete(batch)}>
            Delete batch
          </Button>
        </div>
      </header>

      {images.length === 0 ? (
        <p className="lb-batch-empty">No images were stored for this batch.</p>
      ) : (
        <ul className="lb-grid">
          {images.map((image, position) => {
            const selected = isSelected(image.id);
            return (
              <li key={image.id} className={selected ? 'lb-tile is-selected' : 'lb-tile'} style={{ aspectRatio: ratio }}>
                <button
                  type="button"
                  className="lb-tile-open"
                  aria-label={`Open image ${position + 1} of ${images.length}`}
                  onClick={(event) => onOpen(batch, image.id, event.currentTarget)}
                >
                  <img
                    className="lb-tile-image"
                    src={imageUrl(image.id)}
                    alt={`Image ${position + 1} of ${images.length}: ${promptExcerpt(batch.prompt, 12)}`}
                    loading="lazy"
                    width={image.width}
                    height={image.height}
                  />
                </button>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  className={selected ? 'lb-tile-select is-checked' : 'lb-tile-select'}
                  aria-label={`Select image ${position + 1} of ${images.length}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleImage(batch, image.index, event.shiftKey);
                  }}
                />
                <a
                  className="lb-tile-download"
                  href={imageUrl(image.id, { download: true })}
                  download
                  title={`Download image ${position + 1}`}
                  aria-label={`Download image ${position + 1}`}
                >
                  <DownloadIcon />
                </a>
                <span className="lb-tile-index" aria-hidden="true">
                  {String(position + 1).padStart(2, '0')}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {firstFailure === undefined ? null : (
        <p className="lb-batch-failure">
          {formatCount(batch.failures.length, 'image', 'images')} failed. {firstFailure.message}
        </p>
      )}
    </article>
  );
}

export function LibraryCanvas(): ReactNode {
  const studio = useStudio();
  const library = useLibrary();
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BatchRecord | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'complete' | 'failed'>('all');
  const searchId = useId();
  const viewerTrigger = useRef<HTMLElement | null>(null);
  const lastScrolledId = useRef<string | null>(null);

  const providerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const provider of studio.providers) labels.set(provider.id, provider.label);
    return labels;
  }, [studio.providers]);

  const visibleBatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return library.batches.filter((batch) => {
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'complete'
          ? batch.status === 'complete'
          : batch.status === 'failed' || batch.status === 'partial');
      if (!matchesStatus) return false;
      if (needle.length === 0) return true;
      const providerLabel = providerLabels.get(batch.providerId) ?? batch.providerId;
      return (
        batch.prompt.toLowerCase().includes(needle) || providerLabel.toLowerCase().includes(needle)
      );
    });
  }, [library.batches, providerLabels, query, statusFilter]);

  const notify = useCallback(
    (notice: LibraryNotice): void => {
      studio.notify(notice.message, notice.tone);
    },
    [studio],
  );

  // A rail click selects a batch. If the current filters hide it, clear them first, then
  // scroll once the card exists. The saved id stops later renders from re-scrolling.
  useEffect(() => {
    const activeId = library.activeBatchId;
    if (activeId === null) {
      lastScrolledId.current = null;
      return;
    }
    if (!visibleBatches.some((batch) => batch.id === activeId)) {
      setQuery('');
      setStatusFilter('all');
      return;
    }
    if (lastScrolledId.current === activeId) return;
    lastScrolledId.current = activeId;
    document
      .querySelector<HTMLElement>(`[data-batch-id="${activeId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [library.activeBatchId, visibleBatches]);

  // Stable closers keep the Dialog and viewer focus effects from re-running on
  // every render of this screen.
  const closeViewer = useCallback((): void => {
    setViewer(null);
  }, []);

  const closeDeleteDialog = useCallback((): void => {
    setPendingDelete(null);
  }, []);

  const openViewer = useCallback((batch: BatchRecord, imageId: string, trigger: HTMLElement | null): void => {
    viewerTrigger.current = trigger;
    setViewer({ batch, imageId });
  }, []);

  const openFirstSelected = useCallback(
    (trigger: HTMLElement | null): void => {
      const selected = library.firstSelected;
      if (selected === null) {
        notify({ tone: 'error', message: 'Select an image first.' });
        return;
      }
      openViewer(selected.batch, selected.image.id, trigger);
    },
    [library.firstSelected, notify, openViewer],
  );

  const exportSelection = useCallback(async (): Promise<void> => {
    notify(await library.exportSelection());
  }, [library.exportSelection, notify]);

  const retryFailed = useCallback(
    async (batch: BatchRecord): Promise<void> => {
      notify(await library.retryFailed(batch));
    },
    [library.retryFailed, notify],
  );

  const usePrompt = useCallback(
    (batch: BatchRecord): void => {
      studio.useSettings({
        prompt: batch.prompt,
        width: batch.width,
        height: batch.height,
        count: batch.requested,
        negativePrompt: batch.negativePrompt,
        providerId: batch.providerId,
        modelVariant: batch.modelVariant,
        textEncoderVariant: batch.textEncoderVariant,
        promptEnhancer: batch.promptEnhancer,
      });
    },
    [studio],
  );

  const copyPrompt = useCallback(
    async (batch: BatchRecord): Promise<void> => {
      try {
        await navigator.clipboard.writeText(batch.prompt);
        notify({ tone: 'success', message: 'Prompt copied.' });
      } catch {
        notify({ tone: 'error', message: 'The prompt could not be copied.' });
      }
    },
    [notify],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    const target = pendingDelete;
    if (target === null) return;
    const notice = await library.deleteBatch(target.id);
    setPendingDelete(null);
    notify(notice);
  }, [library.deleteBatch, notify, pendingDelete]);

  const selectionCopy =
    library.selectedCount === 0
      ? 'Select images to view or export.'
      : formatCount(library.selectedCount, 'image selected', 'images selected');

  return (
    <section className="lb-canvas" aria-label="Library">
      <header className="lb-toolbar">
        <p className="lb-toolbar-count" role="status">
          {selectionCopy}
        </p>
        <div className="lb-toolbar-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={library.selectedCount === 0}
            onClick={(event) => openFirstSelected(event.currentTarget)}
          >
            Open viewer
          </Button>
          <Button
            variant="primary"
            size="sm"
            busy={library.exporting}
            disabled={library.selectedCount === 0}
            onClick={() => {
              void exportSelection();
            }}
          >
            Export selection
          </Button>
          <Button variant="ghost" size="sm" disabled={library.selectedCount === 0} onClick={library.clearSelection}>
            Clear
          </Button>
        </div>
      </header>

      <div className="lb-filters">
        <div className="field lb-search-field">
          <label className="field-label" htmlFor={searchId}>
            Search
          </label>
          <input
            id={searchId}
            className="field-input"
            type="search"
            value={query}
            placeholder="Prompt or provider"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <SegmentedControl<'all' | 'complete' | 'failed'>
          label="Batch status filter"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'complete', label: 'Complete' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      <div className="lb-scroll">
        {library.phase === 'loading' && library.batches.length === 0 ? (
          <div className="lb-loading">
            <Spinner size={18} label="Reading the library" />
            <span>Reading the library</span>
          </div>
        ) : null}

        {library.phase === 'error' && library.batches.length === 0 ? (
          <EmptyState
            title="The library could not be read"
            description={library.error ?? 'The studio server did not answer.'}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void library.reload();
                }}
              >
                Try again
              </Button>
            }
          />
        ) : null}

        {library.phase === 'ready' && library.batches.length === 0 ? (
          <div className="lb-empty">
            <EmptyState
              icon={<ImageIcon />}
              title="Nothing saved yet"
              description="Every batch you generate is kept here. Switch to Generate in the top bar, run a batch, and it will appear in this list."
            />
          </div>
        ) : null}

        {library.batches.length > 0 && visibleBatches.length === 0 ? (
          <div className="lb-empty">
            <EmptyState title="No batches match" description="Clear the search or set the status filter back to All." />
          </div>
        ) : null}

        {visibleBatches.map((batch) => (
          <BatchSection
            key={batch.id}
            batch={batch}
            providerLabel={providerLabels.get(batch.providerId) ?? batch.providerId}
            active={library.activeBatchId === batch.id}
            deleting={library.deletingBatchId === batch.id}
            retrying={library.retryingBatchId === batch.id}
            isSelected={library.isSelected}
            onToggleImage={library.toggleImage}
            onSelectBatch={library.selectBatchImages}
            onOpen={openViewer}
            onRequestDelete={setPendingDelete}
            onRetryFailed={(target) => {
              void retryFailed(target);
            }}
            onUsePrompt={usePrompt}
            onCopyPrompt={(target) => {
              void copyPrompt(target);
            }}
          />
        ))}

        {library.phase === 'ready' && library.error !== null ? (
          <div className="lb-alert" role="alert">
            <span>{library.error}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void library.reload();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {library.hasMore ? (
          <div className="lb-more">
            <Button variant="ghost" busy={library.loadingMore} onClick={library.loadMore}>
              Load older batches
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={pendingDelete !== null}
        title="Delete this batch?"
        onClose={closeDeleteDialog}
        actions={
          <>
            <Button variant="ghost" onClick={closeDeleteDialog}>
              Keep it
            </Button>
            <Button
              variant="primary"
              className="lb-danger"
              busy={library.deletingBatchId !== null}
              onClick={() => void confirmDelete()}
            >
              Delete batch
            </Button>
          </>
        }
      >
        {pendingDelete === null ? null : (
          <p>
            {formatCount(pendingDelete.images.length, 'image', 'images')} from "{promptExcerpt(pendingDelete.prompt, 10)}"
            will be removed from disk. This cannot be undone.
          </p>
        )}
      </Dialog>

      {viewer === null ? null : (
        <ImageViewer
          batch={viewer.batch}
          imageId={viewer.imageId}
          providerLabel={providerLabels.get(viewer.batch.providerId) ?? viewer.batch.providerId}
          onClose={closeViewer}
          returnFocusTo={viewerTrigger.current}
        />
      )}

    </section>
  );
}

export function LibraryRail(): ReactNode {
  const studio = useStudio();
  const library = useLibrary();
  const recent = library.batches.slice(0, RAIL_LIMIT);

  const handleDelete = async (batch: BatchRecord): Promise<void> => {
    const notice = await library.deleteBatch(batch.id);
    if (notice.tone === 'success') {
      // A deleted batch must not stay on the Generate canvas, and the totals refresh
      // inside the library controller so the rail updates at the same time.
      clearIfShowingBatch(batch.id);
      studio.notify('Deleted batch');
    } else {
      studio.notify(notice.message, 'error');
    }
  };

  if (recent.length === 0) {
    if (library.phase === 'idle' || library.phase === 'loading') {
      return <p className="lb-rail-note">Reading the library.</p>;
    }
    if (library.phase === 'error') {
      return <p className="lb-rail-note">{library.error ?? 'The library could not be read.'}</p>;
    }
    return <p className="rail-empty">Batches appear here once you generate.</p>;
  }

  return (
    <ul className="lb-rail">
      {recent.map((batch) => {
        const images = orderedImages(batch);
        const cover = images[0];
        const active = library.activeBatchId === batch.id;
        const deleting = library.deletingBatchId === batch.id;
        const duration = formatDuration(batchDurationMs(batch));
        // One quiet line of data on the artwork: the width plus how long it took, or the
        // canvas when the batch has no duration to report yet.
        const meta = duration === null ? `${batch.width} × ${batch.height}` : `${batch.width}px · ${duration}`;
        return (
          <li key={batch.id} className={active ? 'lb-rail-item is-active' : 'lb-rail-item'}>
            <button
              type="button"
              className="lb-rail-card"
              title={batch.prompt}
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                library.selectBatch(active ? null : batch.id);
                if (studio.view === 'generate') studio.openBatch(batch.id);
              }}
            >
              <span className="sr-only">{batch.prompt}</span>
              {cover === undefined ? (
                <span className="lb-rail-blank">
                  <span className={`lb-rail-status is-${batch.status}`}>{statusLabel(batch.status)}</span>
                  <span className="lb-rail-blank-prompt">{promptExcerpt(batch.prompt, 9)}</span>
                </span>
              ) : (
                <span className="lb-rail-frame">
                  <img
                    className="lb-rail-cover"
                    src={imageUrl(cover.id)}
                    alt=""
                    loading="lazy"
                    width={cover.width}
                    height={cover.height}
                  />
                  <span className="lb-rail-scrim">
                    <span className="lb-rail-meta">{meta}</span>
                    {images.length > 1 ? (
                      <span className="lb-rail-multi">{images.length}×</span>
                    ) : null}
                  </span>
                </span>
              )}
            </button>
            <button
              type="button"
              className="lb-rail-delete"
              aria-label={`Delete batch ${promptExcerpt(batch.prompt, 6)}`}
              title="Delete batch"
              disabled={library.deletingBatchId !== null}
              aria-busy={deleting}
              onClick={(event) => {
                // The card behind this icon opens the batch, so never let the click through.
                event.stopPropagation();
                void handleDelete(batch);
              }}
            >
              <TrashIcon />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
