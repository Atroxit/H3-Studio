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
import { formatDuration, imageDurationMs } from '../generate/helpers';
import { formatBytes, formatCount, formatTimestamp, orderedImages } from './useLibrary';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The drag distance, in pixels, that turns a click into a pan. */
const DRAG_THRESHOLD = 4;

/** Zoom levels relative to the fitted image size. */
export const ZOOM_STEPS: readonly number[] = [1, 1.5, 2, 3, 4, 6, 8];

/** The scales a plain click cycles through: Fit, 2x, 4x, back to Fit. */
export const CLICK_ZOOM_CYCLE: readonly number[] = [1, 2, 4];

/**
 * The rendered pixel size of an image at a zoom scale on top of its fitted size.
 * Both the fitted size and the zoomed size are safe against zero dimensions.
 */
export function computeZoomedDimensions(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): { width: number; height: number } {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  const fitScale = Math.min(vw / w, vh / h);
  const baseWidth = w * fitScale;
  const baseHeight = h * fitScale;
  return {
    width: Math.max(1, Math.round(baseWidth * scale)),
    height: Math.max(1, Math.round(baseHeight * scale)),
  };
}

/** The next scale in a direction, walking the exported zoom steps. */
export function stepZoomLevel(current: number, direction: 'in' | 'out' | 'cycle'): number {
  if (direction === 'cycle') {
    if (current < 2) return 2;
    if (current < 4) return 4;
    return 1;
  }
  if (direction === 'in') {
    const next = ZOOM_STEPS.find((step) => step > current + 0.01);
    return next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 8;
  }
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01);
  return lower ?? 1;
}

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
  /** Opens on the source image, for the Compare action on an alteration tile. */
  initialCompare?: boolean;
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
  initialCompare = false,
}: ImageViewerProps): ReactNode {
  const studio = useStudio();
  const images = useMemo(() => orderedImages(batch), [batch]);
  const [position, setPosition] = useState(() => {
    const found = images.findIndex((image) => image.id === imageId);
    return found === -1 ? 0 : found;
  });
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 720,
  });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** True while the source image is shown in place of the alteration. */
  const [showOriginal, setShowOriginal] = useState(
    initialCompare && (batch.sourceImageId ?? null) !== null,
  );
  /** The image the compare view was last reset for, so the first render keeps its intent. */
  const compareKeyRef = useRef<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingZoomRef = useRef<PendingZoom | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragStart | null>(null);
  const detachDragListenersRef = useRef<(() => void) | null>(null);
  const zoomScaleRef = useRef(zoomScale);
  const [isDragging, setIsDragging] = useState(false);
  const isZoomed = zoomScale > 1;

  zoomScaleRef.current = zoomScale;

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

  const safePosition = images.length === 0 ? 0 : Math.min(position, images.length - 1);
  const image = images[safePosition];
  const sourceImageId = batch.sourceImageId ?? null;
  const generationDuration =
    image === undefined ? null : formatDuration(imageDurationMs(image, batch));

  // A different image always opens showing the alteration, never the hold to compare view.
  // The first render is exempt: that is where a Compare click asked for the source image.
  useEffect(() => {
    const key = `${batch.id}:${image?.id ?? ''}`;
    const previous = compareKeyRef.current;
    compareKeyRef.current = key;
    if (previous === null || previous === key) return;
    setShowOriginal(false);
  }, [image?.id, batch.id]);

  // Anchor the next zoom step on whatever part of the image sits at the viewport
  // centre, so the header buttons and the keyboard shortcuts keep the panned spot.
  const anchorZoomAtViewportCenter = (): void => {
    const wrap = wrapRef.current;
    const img = imageRef.current;
    if (wrap === null || img === null) {
      pendingZoomRef.current = null;
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) {
      pendingZoomRef.current = null;
      return;
    }
    pendingZoomRef.current = {
      ratioX: (wrapRect.left + wrap.clientWidth / 2 - imgRect.left) / imgRect.width,
      ratioY: (wrapRect.top + wrap.clientHeight / 2 - imgRect.top) / imgRect.height,
      clientX: null,
      clientY: null,
    };
  };

  const resetZoom = (): void => {
    pendingZoomRef.current = null;
    setZoomScale(1);
  };

  const zoomIn = (): void => {
    suppressClickRef.current = false;
    const nextScale = stepZoomLevel(zoomScaleRef.current, 'in');
    if (nextScale === zoomScaleRef.current) return;
    anchorZoomAtViewportCenter();
    setZoomScale(nextScale);
  };

  const zoomOut = (): void => {
    suppressClickRef.current = false;
    const nextScale = stepZoomLevel(zoomScaleRef.current, 'out');
    if (nextScale === zoomScaleRef.current) return;
    if (nextScale <= 1) {
      resetZoom();
      return;
    }
    anchorZoomAtViewportCenter();
    setZoomScale(nextScale);
  };

  const toggleZoom = (): void => {
    suppressClickRef.current = false;
    if (zoomScaleRef.current > 1) {
      resetZoom();
      return;
    }
    anchorZoomAtViewportCenter();
    setZoomScale(2);
  };

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
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomIn();
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomOut();
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        resetZoom();
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
        return;
      }
      // Holding Space shows the alteration's source image in the same frame and zoom.
      if (event.code === 'Space' && sourceImageId !== null) {
        const target = event.target;
        const onControl =
          target instanceof HTMLElement && target.closest('button, a, input, textarea, select') !== null;
        if (onControl) return;
        event.preventDefault();
        setShowOriginal(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [images.length, onClose, resetZoom, zoomIn, zoomOut, sourceImageId]);

  // Releasing Space returns to the alteration, which is what makes it a hold, not a toggle.
  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setShowOriginal(false);
    };
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Drop any window pan listeners if the viewer unmounts mid drag.
  useEffect(
    () => () => {
      detachDragListenersRef.current?.();
      detachDragListenersRef.current = null;
    },
    [],
  );

  // The wheel listener has to be non-passive so preventDefault stops the page and the
  // container from scrolling while the image zooms under the cursor.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const handleWheel = (event: WheelEvent): void => {
      const current = zoomScaleRef.current;
      const nextScale = stepZoomLevel(current, event.deltaY < 0 ? 'in' : 'out');
      if (nextScale === current) return;
      event.preventDefault();
      const img = imageRef.current;
      if (nextScale > 1 && img !== null) {
        const imgRect = img.getBoundingClientRect();
        if (imgRect.width > 0 && imgRect.height > 0) {
          pendingZoomRef.current = {
            ratioX: (event.clientX - imgRect.left) / imgRect.width,
            ratioY: (event.clientY - imgRect.top) / imgRect.height,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        }
      } else {
        pendingZoomRef.current = null;
      }
      setZoomScale(nextScale);
    };
    wrap.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      wrap.removeEventListener('wheel', handleWheel);
    };
  }, [image?.id]);

  // Size the image and place the pending zoom scroll in the same layout pass, before
  // paint, so the cursor stays on the exact pixel it pointed at on the first frame.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const img = imageRef.current;
    if (wrap === null || img === null) return;
    const measuredWidth = wrap.clientWidth;
    const measuredHeight = wrap.clientHeight;
    if (
      measuredWidth > 0 &&
      measuredHeight > 0 &&
      (measuredWidth !== viewportSize.width || measuredHeight !== viewportSize.height)
    ) {
      setViewportSize({ width: measuredWidth, height: measuredHeight });
    }
    if (isZoomed && image !== undefined) {
      const dims = computeZoomedDimensions(
        image.width,
        image.height,
        measuredWidth || viewportSize.width,
        measuredHeight || viewportSize.height,
        zoomScale,
      );
      img.style.width = `${dims.width}px`;
      img.style.height = `${dims.height}px`;
    } else {
      img.style.width = '';
      img.style.height = '';
    }
    const pending = pendingZoomRef.current;
    pendingZoomRef.current = null;
    if (pending === null) return;
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
  }, [zoomScale, image?.id]);

  // A different image always opens fitted, so a stale zoom offset never carries over.
  // A pending drag is dropped too, and its listeners are detached, so navigating with
  // the arrow keys mid-drag cannot leave the pan state stuck.
  useLayoutEffect(() => {
    detachDragListenersRef.current?.();
    detachDragListenersRef.current = null;
    dragRef.current = null;
    setZoomScale(1);
    setIsDragging(false);
    pendingZoomRef.current = null;
    suppressClickRef.current = false;
  }, [image?.id]);

  const handleImageClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const nextScale = stepZoomLevel(zoomScaleRef.current, 'cycle');
    if (nextScale <= 1) {
      resetZoom();
      return;
    }
    const img = imageRef.current;
    if (img !== null) {
      const imgRect = img.getBoundingClientRect();
      if (imgRect.width > 0 && imgRect.height > 0) {
        pendingZoomRef.current = {
          ratioX: (event.clientX - imgRect.left) / imgRect.width,
          ratioY: (event.clientY - imgRect.top) / imgRect.height,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      }
    }
    setZoomScale(nextScale);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    suppressClickRef.current = false;
    if (!isZoomed || event.button !== 0) return;
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
      // A themed batch restores its words and tags instead of re-appending the chunks.
      basePrompt: batch.basePrompt ?? batch.prompt,
      appliedThemes: batch.appliedThemes ?? [],
      width: batch.width,
      height: batch.height,
      count: batch.requested,
      negativePrompt: batch.negativePrompt,
      providerId: batch.providerId,
      modelVariant: batch.modelVariant,
      textEncoderVariant: batch.textEncoderVariant,
      promptEnhancer: batch.promptEnhancer,
    });
  };

  return (
    <div
      className={isZoomed ? 'lb-viewer is-actual' : 'lb-viewer'}
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
            {sourceImageId === null || image === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showOriginal}
                onClick={() => {
                  setShowOriginal((value) => !value);
                }}
                title="Toggle original source image (or hold Space)"
              >
                {showOriginal ? 'Show altered' : 'Compare original'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void copyPrompt()}>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'}
            </Button>
            <Button variant="ghost" size="sm" onClick={usePrompt}>
              Use prompt
            </Button>
            {image === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                title="Open this image on the Generate canvas as an alteration"
                onClick={() => {
                  onClose();
                  studio.alterImage(batch.id, image.id);
                }}
              >
                Alter this image
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={zoomScale <= 1}
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (-)"
            >
              -
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleZoom}
              aria-pressed={isZoomed}
              title={isZoomed ? 'Reset zoom to fit (0)' : 'Zoom in to 2x'}
            >
              {isZoomed ? `${zoomScale}x` : 'Fit'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={zoomScale >= 8}
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              +
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
            {sourceImageId === null ? null : (
              <span className="lb-viewer-compare-badge" aria-hidden="true">
                {showOriginal ? 'Original' : 'Altered'}
              </span>
            )}
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
                isZoomed ? 'is-actual' : '',
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
                aria-label={isZoomed ? 'Reset the image to fit the window' : 'Zoom the image in'}
                aria-pressed={isZoomed}
              >
                <img
                  className="lb-viewer-image"
                  ref={imageRef}
                  src={showOriginal && sourceImageId !== null ? imageUrl(sourceImageId) : imageUrl(image.id)}
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
              {generationDuration === null ? null : (
                <div className="lb-viewer-row">
                  <dt>Generation time</dt>
                  <dd className="lb-viewer-mono">{generationDuration}</dd>
                </div>
              )}
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
          {sourceImageId === null
            ? 'Arrow keys move between images. Escape closes the viewer. Click or scroll to zoom up to 8x, and drag to pan.'
            : 'Arrow keys move between images. Escape closes the viewer. Click or scroll to zoom up to 8x, drag to pan, and hold Space to compare the original.'}
        </p>
      </div>
    </div>
  );
}
