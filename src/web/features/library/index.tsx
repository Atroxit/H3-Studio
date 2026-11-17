// The library screen. LibraryCanvas is the full view for the centre panel;
// LibraryRail is the compact recent list for the left rail. Both read the same
// controller, so a batch selected in the rail is highlighted in the canvas.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BatchRecord, BatchStatus } from '../../../core/types';
import { imageUrl } from '../../api';
import { useStudio } from '../../App';
import { Button, Dialog, EmptyState, Spinner, Toast } from '../../components';
import { PresetsPanel } from './presets';
import {
  formatCount,
  formatShortTimestamp,
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

interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
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
  isSelected: (imageId: string) => boolean;
  onToggleImage: (batch: BatchRecord, index: number, extend: boolean) => void;
  onSelectBatch: (batch: BatchRecord, selected: boolean) => void;
  onOpen: (batch: BatchRecord, imageId: string, trigger: HTMLElement | null) => void;
  onRequestDelete: (batch: BatchRecord) => void;
}

function BatchSection({
  batch,
  providerLabel,
  active,
  deleting,
  isSelected,
  onToggleImage,
  onSelectBatch,
  onOpen,
  onRequestDelete,
}: BatchSectionProps): ReactNode {
  const images = orderedImages(batch);
  const selectedCount = images.filter((image) => isSelected(image.id)).length;
  const allSelected = images.length > 0 && selectedCount === images.length;
  const ratio = batch.width > 0 && batch.height > 0 ? `${batch.width} / ${batch.height}` : '1 / 1';
  const headingId = `lb-batch-${batch.id}`;
  const firstFailure = batch.failures[0];

  return (
    <article className={active ? 'lb-batch is-active' : 'lb-batch'} aria-labelledby={headingId}>
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
                <input
                  type="checkbox"
                  className="lb-tile-select"
                  checked={selected}
                  aria-label={`Select image ${position + 1} of ${images.length}`}
                  onChange={() => undefined}
                  onClick={(event) => {
                    // Shift click extends the selection, so the handler owns the toggle.
                    event.preventDefault();
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
  const [toast, setToast] = useState<ToastState | null>(null);
  const viewerTrigger = useRef<HTMLElement | null>(null);

  const providerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const provider of studio.providers) labels.set(provider.id, provider.label);
    return labels;
  }, [studio.providers]);

  const notify = useCallback((notice: LibraryNotice): void => {
    setToast({ id: Date.now(), message: notice.message, tone: notice.tone });
  }, []);

  // Stable closers keep the Dialog and viewer focus effects from re-running on
  // every render of this screen.
  const closeViewer = useCallback((): void => {
    setViewer(null);
  }, []);

  const closeDeleteDialog = useCallback((): void => {
    setPendingDelete(null);
  }, []);

  const dismissToast = useCallback((): void => {
    setToast(null);
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

        {library.batches.map((batch) => (
          <BatchSection
            key={batch.id}
            batch={batch}
            providerLabel={providerLabels.get(batch.providerId) ?? batch.providerId}
            active={library.activeBatchId === batch.id}
            deleting={library.deletingBatchId === batch.id}
            isSelected={library.isSelected}
            onToggleImage={library.toggleImage}
            onSelectBatch={library.selectBatchImages}
            onOpen={openViewer}
            onRequestDelete={setPendingDelete}
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

        <PresetsPanel />
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

      {toast === null ? null : (
        <Toast key={toast.id} message={toast.message} tone={toast.tone} onClose={dismissToast} />
      )}
    </section>
  );
}

export function LibraryRail(): ReactNode {
  const library = useLibrary();
  const recent = library.batches.slice(0, RAIL_LIMIT);

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
        const cover = orderedImages(batch)[0];
        const active = library.activeBatchId === batch.id;
        return (
          <li key={batch.id}>
            <button
              type="button"
              className={active ? 'lb-rail-row is-active' : 'lb-rail-row'}
              title={batch.prompt}
              aria-current={active ? 'true' : undefined}
              onClick={() => library.selectBatch(active ? null : batch.id)}
            >
              <span className="lb-rail-thumb">
                {cover === undefined ? (
                  <span className="lb-rail-thumb-empty" aria-hidden="true" />
                ) : (
                  <img src={imageUrl(cover.id)} alt="" loading="lazy" width={cover.width} height={cover.height} />
                )}
              </span>
              <span className="lb-rail-copy">
                <span className="lb-rail-name">{promptExcerpt(batch.prompt, 5)}</span>
                <span className="lb-rail-meta">
                  {formatCount(batch.images.length, 'image', 'images')} / {batch.width} x {batch.height}
                </span>
                <span className="lb-rail-time">{formatShortTimestamp(batch.createdAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
