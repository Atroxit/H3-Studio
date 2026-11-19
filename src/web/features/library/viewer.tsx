// The full image viewer. One image on a dark backdrop, with its batch metadata.
// Arrow keys move through the batch, Escape closes, and focus goes back to the
// tile that opened it.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { BatchRecord } from '../../../core/types';
import { imageUrl } from '../../api';
import { Button } from '../../components';
import { useStudio } from '../../studio';
import { formatBytes, formatCount, formatTimestamp, orderedImages } from './useLibrary';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The drag distance, in pixels, that turns a click into a pan. */
const DRAG_THRESHOLD = 4;

export interface ZoomScrollInput {
  /** Normalized click point inside the fitted image, 0..1. */
  ratioX: number;
  ratioY: number;
  /** Desired anchor position inside the scroll viewport (e.g. cursor X/Y relative to viewport, or viewport/2 for centering). */
  anchorX: number;
  anchorY: number;
  /** Full rendered image width/height at 1:1 (actual) scale. */
  contentWidth: number;
  contentHeight: number;
  /** Inner offset of the image inside the scroll container (e.g. border/margin offset). */
  contentOffsetX: number;
  contentOffsetY: number;
  /** Visible viewport dimensions of the scroll container (clientWidth, clientHeight). */
  viewportWidth: number;
  viewportHeight: number;
  /** Total scrollable dimensions of the scroll container (scrollWidth, scrollHeight). */
  scrollWidth: number;
  scrollHeight: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Works out where the scroll container must sit so the clicked spot on the
 * fitted image lands under the cursor once the image is shown at 1:1.
 */
export function computeZoomScroll(input: ZoomScrollInput): { left: number; top: number } {
  const targetX = input.contentOffsetX + clampUnit(input.ratioX) * input.contentWidth;
  const targetY = input.contentOffsetY + clampUnit(input.ratioY) * input.contentHeight;
  const maxLeft = Math.max(0, input.scrollWidth - input.viewportWidth);
  const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(0, targetX - input.anchorX))),
    top: Math.round(Math.min(maxTop, Math.max(0, targetY - input.anchorY))),
  };
}

interface PendingZoom {
  ratioX: number;
  ratioY: number;
  /** Raw cursor screen coordinates, or null to centre the image in the viewport. */
  clientX: number | null;
  clientY: number | null;
}

interface DragStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
}

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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingZoomRef = useRef<PendingZoom | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragStart | null>(null);
  const detachDragListenersRef = useRef<(() => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);

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

  // Drop any window pan listeners if the viewer unmounts mid drag.
  useEffect(
    () => () => {
      detachDragListenersRef.current?.();
      detachDragListenersRef.current = null;
    },
    [],
  );

  // Apply the pending zoom target once the 1:1 layout exists and before paint.
  useLayoutEffect(() => {
    if (zoom !== 'actual') return;
    const wrap = wrapRef.current;
    const img = imageRef.current;
    const pending = pendingZoomRef.current;
    pendingZoomRef.current = null;
    if (wrap === null || img === null || pending === null) return;
    const wrapRect = wrap.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return;
    // The wrap may have grown since the click, so the anchor is recomputed against
    // the post-zoom viewport rect.
    const anchorX = pending.clientX === null ? wrap.clientWidth / 2 : pending.clientX - wrapRect.left;
    const anchorY = pending.clientY === null ? wrap.clientHeight / 2 : pending.clientY - wrapRect.top;
    const next = computeZoomScroll({
      ratioX: pending.ratioX,
      ratioY: pending.ratioY,
      anchorX,
      anchorY,
      contentWidth: imgRect.width,
      contentHeight: imgRect.height,
      contentOffsetX: imgRect.left - wrapRect.left + wrap.scrollLeft,
      contentOffsetY: imgRect.top - wrapRect.top + wrap.scrollTop,
      viewportWidth: wrap.clientWidth,
      viewportHeight: wrap.clientHeight,
      scrollWidth: wrap.scrollWidth,
      scrollHeight: wrap.scrollHeight,
    });
    wrap.scrollLeft = next.left;
    wrap.scrollTop = next.top;
  }, [zoom]);

  const safePosition = images.length === 0 ? 0 : Math.min(position, images.length - 1);
  const image = images[safePosition];

  // A different image always opens fitted, so a stale 1:1 offset never carries over.
  // A pending drag is dropped too, and its listeners are detached, so navigating with
  // the arrow keys mid-drag cannot leave the pan state stuck.
  useEffect(() => {
    detachDragListenersRef.current?.();
    detachDragListenersRef.current = null;
    dragRef.current = null;
    setZoom('fit');
    setIsDragging(false);
    pendingZoomRef.current = null;
    suppressClickRef.current = false;
  }, [image?.id]);

  const toggleZoom = (): void => {
    suppressClickRef.current = false;
    if (zoom === 'actual') {
      pendingZoomRef.current = null;
      setZoom('fit');
      return;
    }
    pendingZoomRef.current = { ratioX: 0.5, ratioY: 0.5, clientX: null, clientY: null };
    setZoom('actual');
  };

  const handleImageClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (zoom === 'actual') {
      setZoom('fit');
      return;
    }
    const wrap = wrapRef.current;
    const img = imageRef.current;
    if (event.detail > 0 && wrap !== null && img !== null) {
      const imgRect = img.getBoundingClientRect();
      if (imgRect.width > 0 && imgRect.height > 0) {
        pendingZoomRef.current = {
          ratioX: (event.clientX - imgRect.left) / imgRect.width,
          ratioY: (event.clientY - imgRect.top) / imgRect.height,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        setZoom('actual');
        return;
      }
    }
    toggleZoom();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    suppressClickRef.current = false;
    if (zoom !== 'actual' || event.button !== 0) return;
    const wrap = wrapRef.current;
    if (wrap === null) return;
    detachDragListenersRef.current?.();

    const drag: DragStart = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
      moved: false,
    };
    dragRef.current = drag;

    const handleMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const dx = moveEvent.clientX - drag.clientX;
      const dy = moveEvent.clientY - drag.clientY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        drag.moved = true;
        setIsDragging(true);
      }
      moveEvent.preventDefault();
      wrap.scrollLeft = drag.scrollLeft - dx;
      wrap.scrollTop = drag.scrollTop - dy;
    };

    const finish = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== drag.pointerId) return;
      detach();
      if (dragRef.current === drag) dragRef.current = null;
      if (!drag.moved) return;
      // The click that follows this release belongs to the pan, not to a zoom toggle.
      suppressClickRef.current = true;
      setIsDragging(false);
    };

    const detach = (): void => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (detachDragListenersRef.current === detach) detachDragListenersRef.current = null;
    };
    detachDragListenersRef.current = detach;

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

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
            <div
              className={[
                'lb-viewer-image-wrap',
                zoom === 'actual' ? 'is-actual' : '',
                isDragging ? 'is-dragging' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              ref={wrapRef}
            >
              <button
                type="button"
                className="lb-viewer-image-button"
                onClick={handleImageClick}
                onPointerDown={handlePointerDown}
                aria-label={zoom === 'actual' ? 'Fit the image to the window' : 'Show the image at actual pixels'}
                aria-pressed={zoom === 'actual'}
              >
                <img
                  className="lb-viewer-image"
                  ref={imageRef}
                  src={imageUrl(image.id)}
                  alt={`Image ${safePosition + 1} of ${images.length} in the batch for ${batch.prompt}`}
                  width={image.width}
                  height={image.height}
                  draggable={false}
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
          Arrow keys move between images. Escape closes the viewer. Click any spot to zoom to 1:1, drag to pan, and
          click again to fit.
        </p>
      </div>
    </div>
  );
}
