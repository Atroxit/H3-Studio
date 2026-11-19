// The full image viewer. One image on a dark backdrop, with its batch metadata.
// Arrow keys move through the batch, Escape closes, and focus goes back to the
// tile that opened it.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BatchRecord } from '../../../core/types';
import { imageUrl } from '../../api';
import { Button } from '../../components';
import { useStudio } from '../../studio';
import { formatBytes, formatCount, formatTimestamp, orderedImages } from './useLibrary';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ImageViewerProps {
  batch: BatchRecord;
  /** The image the tile opened. */
  imageId: string;
  providerLabel: string;
  onClose: () => void;
  /** The tile button, so focus can go back to it when the viewer closes. */
  returnFocusTo: HTMLElement | null;
}

function ChevronIcon({ pointsLeft }: { pointsLeft: boolean }): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={pointsLeft ? 'M14.5 6.5L9 12l5.5 5.5' : 'M9.5 6.5L15 12l-5.5 5.5'} />
    </svg>
  );
}

export function ImageViewer({
  batch,
  imageId,
  providerLabel,
  onClose,
  returnFocusTo,
}: ImageViewerProps): ReactNode {
  const studio = useStudio();
  const images = useMemo(() => orderedImages(batch), [batch]);
  const [position, setPosition] = useState(() => {
    const found = images.findIndex((image) => image.id === imageId);
    return found === -1 ? 0 : found;
  });
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // The overlay takes focus, and hands it back to the opener when it closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const target = returnFocusTo ?? previouslyFocused;
      if (target !== null && target.isConnected) target.focus();
    };
  }, [returnFocusTo]);

  // The page behind the overlay must not scroll while the viewer is open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        const root = overlayRef.current;
        if (root === null) return;
        const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (element) => element.offsetParent !== null,
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first === undefined || last === undefined) return;
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPosition((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        setPosition((current) => Math.min(images.length - 1, current + 1));
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [images.length, onClose]);

  const safePosition = images.length === 0 ? 0 : Math.min(position, images.length - 1);
  const image = images[safePosition];
  const toggleZoom = (): void => setZoom((current) => (current === 'fit' ? 'actual' : 'fit'));

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(batch.prompt);
      setCopyState('copied');
      studio.notify('Prompt copied.');
    } catch {
      setCopyState('failed');
      studio.notify('The prompt could not be copied.', 'error');
    }
    window.setTimeout(() => setCopyState('idle'), 2400);
  };

  const usePrompt = (): void => {
    studio.useSettings({
      prompt: batch.prompt,
      width: batch.width,
      height: batch.height,
      count: batch.requested,
      negativePrompt: batch.negativePrompt,
      providerId: batch.providerId,
    });
  };

  return (
    <div
      className={zoom === 'actual' ? 'lb-viewer is-actual' : 'lb-viewer'}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lb-viewer-inner">
        <header className="lb-viewer-head">
          <span className="lb-viewer-count">
            {images.length === 0 ? 'No images' : `${safePosition + 1} / ${images.length}`}
          </span>
          <div className="lb-viewer-head-actions">
            <Button variant="ghost" size="sm" onClick={() => void copyPrompt()}>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'}
            </Button>
            <Button variant="ghost" size="sm" onClick={usePrompt}>
              Use prompt
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleZoom} aria-pressed={zoom === 'actual'}>
              {zoom === 'actual' ? 'Fit' : '1:1'}
            </Button>
            {image === undefined ? null : (
              <a
                className="lb-viewer-download"
                href={imageUrl(image.id, { download: true })}
                download
                title={`Download image ${safePosition + 1}`}
              >
                Download PNG
              </a>
            )}
            <button
              type="button"
              className="lb-viewer-close"
              ref={closeRef}
              onClick={onClose}
              aria-label="Close the viewer"
              title="Close the viewer"
            >
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            </button>
          </div>
        </header>

        {image === undefined ? (
          <p className="lb-viewer-note">This batch has no stored images to show.</p>
        ) : (
          <div className="lb-viewer-stage">
            <button
              type="button"
              className="lb-viewer-nav is-previous"
              aria-label="Previous image"
              title="Previous image"
              disabled={safePosition === 0}
              onClick={() => {
                setPosition((current) => Math.max(0, current - 1));
              }}
            >
              <ChevronIcon pointsLeft />
            </button>
            <div className={zoom === 'actual' ? 'lb-viewer-image-wrap is-actual' : 'lb-viewer-image-wrap'}>
              <button
                type="button"
                className="lb-viewer-image-button"
                onClick={toggleZoom}
                aria-label={zoom === 'actual' ? 'Fit the image to the window' : 'Show the image at actual pixels'}
                aria-pressed={zoom === 'actual'}
              >
                <img
                  className="lb-viewer-image"
                  src={imageUrl(image.id)}
                  alt={`Image ${safePosition + 1} of ${images.length} in the batch for ${batch.prompt}`}
                  width={image.width}
                  height={image.height}
                />
              </button>
            </div>
            <button
              type="button"
              className="lb-viewer-nav is-next"
              aria-label="Next image"
              title="Next image"
              disabled={safePosition === images.length - 1}
              onClick={() => {
                setPosition((current) => Math.min(images.length - 1, current + 1));
              }}
            >
              <ChevronIcon pointsLeft={false} />
            </button>
          </div>
        )}

        <dl className="lb-viewer-meta">
          <div className="lb-viewer-row">
            <dt>Provider</dt>
            <dd>{providerLabel}</dd>
          </div>
          <div className="lb-viewer-row">
            <dt>Prompt</dt>
            <dd className="lb-viewer-prompt">{batch.prompt}</dd>
          </div>
          {batch.seed === undefined ? null : (
            <div className="lb-viewer-row">
              <dt>Seed</dt>
              <dd className="lb-viewer-mono">{batch.seed}</dd>
            </div>
          )}
          {image === undefined ? null : (
            <>
              <div className="lb-viewer-row">
                <dt>Dimensions</dt>
                <dd className="lb-viewer-mono">
                  {image.width} x {image.height}
                </dd>
              </div>
              <div className="lb-viewer-row">
                <dt>Created</dt>
                <dd>{formatTimestamp(image.createdAt)}</dd>
              </div>
              <div className="lb-viewer-row">
                <dt>File</dt>
                <dd className="lb-viewer-mono">
                  {image.filename} / {formatBytes(image.bytes)}
                </dd>
              </div>
            </>
          )}
          <div className="lb-viewer-row">
            <dt>Batch</dt>
            <dd>
              {formatCount(batch.images.length, 'image', 'images')} of {batch.requested} requested
            </dd>
          </div>
        </dl>

        <p className="lb-viewer-hint">
          Arrow keys move between images. Escape closes the viewer. Click the image or 1:1 to switch between fit and
          actual pixels.
        </p>
      </div>
    </div>
  );
}
