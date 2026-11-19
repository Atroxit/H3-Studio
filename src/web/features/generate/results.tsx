// The results grid: one tile per requested index, with its own waiting, sampling,
// finished and failed state. Partial failure is a normal outcome here, not an
// error banner that hides the images that did arrive.
//
// A local run can be slow and a healthy provider may report no step progress at all,
// so elapsed time is the only liveness signal this surface can honestly show. There is
// no percentage and no ETA: the adapter knows neither.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { imageUrl } from '../../api';
import { Button, Spinner } from '../../components';
import { useStudio } from '../../studio';
import type { GenerationBatch, GenerationTile, TileSummary } from './useGeneration';

export interface ResultsGridProps {
  batch: GenerationBatch | null;
  summary: TileSummary | null;
  running: boolean;
  /** Size of the next batch, used to size the empty placeholder. */
  plannedWidth: number;
  plannedHeight: number;
  onRetry: (indices: number[]) => void;
  onRetryFailed: () => void;
  onReload: () => void;
  onClear: () => void;
  onOpenImage: (imageId: string, trigger: HTMLElement | null) => void;
  /** Adds a starter to the prompt, so a first run is one click away. */
  onUseStarter: (prompt: string) => void;
}

/** The first screen: three prompts that only fill the composer, never submit it. */
const PROMPT_STARTERS: readonly string[] = [
  'A brass diving helmet on wet sand, overcast light',
  'A stone lighthouse on a basalt cliff at blue hour',
  'Pears on a linen cloth, north window light',
];

export function columnsForCount(count: number): 1 | 2 | 3 | 4 {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function ratioStyle(width: number, height: number): CSSProperties {
  const safeWidth = width > 0 ? width : 1;
  const safeHeight = height > 0 ? height : 1;
  return { aspectRatio: `${safeWidth} / ${safeHeight}` };
}

/**
 * Keeps the empty placeholder inside a sane box whatever the aspect is. The frame
 * is deliberately small: it is a size hint above the prompt, not the subject.
 */
function ghostStyle(width: number, height: number): CSSProperties {
  const safeWidth = width > 0 ? width : 1;
  const safeHeight = height > 0 ? height : 1;
  const longest = 224;
  const ghostWidth = safeHeight > safeWidth ? Math.max(104, Math.round((longest * safeWidth) / safeHeight)) : longest;
  return { ...ratioStyle(safeWidth, safeHeight), width: ghostWidth, maxWidth: '100%' };
}

function stateLabel(tile: GenerationTile): string {
  if (tile.phase === 'waiting') return 'Waiting';
  if (tile.phase === 'running') return 'Sampling';
  if (tile.phase === 'done') return 'Ready';
  if (tile.phase === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function stateClass(tile: GenerationTile): string {
  return tile.phase === 'running' ? 'is-running' : tile.phase === 'done' ? 'is-done' : tile.phase === 'failed' ? 'is-failed' : tile.phase === 'cancelled' ? 'is-cancelled' : 'is-waiting';
}

function batchStatusLabel(batch: GenerationBatch, running: boolean): string {
  if (running) return 'Running';
  if (batch.status === 'queued') return 'Queued';
  if (batch.status === 'running') return 'Running';
  if (batch.status === 'complete') return 'Complete';
  if (batch.status === 'partial') return 'Partial';
  if (batch.status === 'failed') return 'Failed';
  return 'Stopped';
}

function isGoing(tile: GenerationTile): boolean {
  return tile.phase === 'waiting' || tile.phase === 'running';
}

/** The elapsed clock of one tile's current attempt. */
interface TileClock {
  /** When the attempt started, in epoch milliseconds. */
  startedAt: number;
  /** When it settled, in epoch milliseconds. Null while it is still going. */
  settledAt: number | null;
}

// Module scope, so a settled duration outlives this surface unmounting, which switching
// to the library does. Only one batch is on screen, so this holds one run: a new run
// replaces the map instead of adding to it.
let clockRun = 0;
let clocks = new Map<number, TileClock>();
let clockRunning = false;

/**
 * Keeps the clocks in step with the tiles: one starts when a tile begins waiting, gets
 * stamped when the tile settles, and restarts for a retry. It only writes the clock it
 * has just read, so running twice, as StrictMode does, changes nothing.
 */
function reconcileClocks(batch: GenerationBatch | null, running: boolean): Map<number, TileClock> {
  if (batch === null) {
    clockRunning = running;
    return clocks;
  }
  const now = Date.now();
  if (clockRun !== batch.startedAt) {
    clockRun = batch.startedAt;
    clocks = new Map();
  } else if (running && !clockRunning) {
    // A retry begins a fresh attempt for every tile that has not settled yet, including
    // the ones an earlier cancel put back to waiting.
    for (const tile of batch.tiles) {
      if (isGoing(tile)) clocks.set(tile.index, { startedAt: now, settledAt: null });
    }
  }
  clockRunning = running;

  const present = new Set<number>();
  for (const tile of batch.tiles) {
    present.add(tile.index);
    const clock = clocks.get(tile.index);
    if (isGoing(tile)) {
      if (clock === undefined) {
        clocks.set(tile.index, { startedAt: batch.startedAt, settledAt: null });
      } else if (clock.settledAt !== null) {
        clocks.set(tile.index, { startedAt: now, settledAt: null });
      }
      continue;
    }
    if (clock !== undefined && clock.settledAt === null) {
      clocks.set(tile.index, { startedAt: clock.startedAt, settledAt: now });
    }
  }
  // A tile that was already settled when it first appeared, such as one folded in from a
  // stored record, has no honest start, so it gets no clock and shows no duration.
  for (const index of clocks.keys()) {
    if (!present.has(index)) clocks.delete(index);
  }
  return clocks;
}

/** Seconds under a minute, then m:ss. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function elapsedLabel(clock: TileClock | undefined, now: number): string | null {
  if (clock === undefined) return null;
  return formatElapsed((clock.settledAt ?? now) - clock.startedAt);
}

interface ResultTileProps {
  tile: GenerationTile;
  total: number;
  width: number;
  height: number;
  /** Elapsed time in a display form, or null when there is no honest start to count from. */
  elapsed: string | null;
  settled: boolean;
  canRetry: boolean;
  onRetry: (index: number) => void;
  onOpen: (imageId: string, trigger: HTMLElement | null) => void;
}

function ResultTile({ tile, total, width, height, elapsed, settled, canRetry, onRetry, onOpen }: ResultTileProps): ReactNode {
  const label = `Image ${tile.index + 1} of ${total}`;

  return (
    <article className={`gen-tile ${stateClass(tile)}`} style={ratioStyle(width, height)} aria-label={label}>
      <span className="gen-tile-index">{String(tile.index + 1).padStart(2, '0')}</span>
      <span className="gen-tile-tags">
        {elapsed === null ? null : (
          // role=timer keeps the once a second change out of live announcements.
          <span className={tile.phase === 'running' ? 'gen-tile-elapsed is-live' : 'gen-tile-elapsed'} role="timer">
            {elapsed}
          </span>
        )}
        <span className={`gen-tile-state ${stateClass(tile)}`}>{stateLabel(tile)}</span>
      </span>

      {tile.phase === 'done' && tile.imageId !== null ? (
        <button
          type="button"
          className="gen-tile-open"
          aria-label={`Open generated result ${tile.index + 1} of ${total}`}
          onClick={(event) => onOpen(tile.imageId ?? '', event.currentTarget)}
        >
          <img className="gen-tile-image" src={imageUrl(tile.imageId)} alt={`Generated result ${tile.index + 1} of ${total}`} />
        </button>
      ) : null}

      {tile.phase === 'done' && tile.imageId === null ? (
        <div className="gen-tile-body">
          {settled ? <p className="gen-tile-note">Not stored</p> : <Spinner size={16} label="Saving the image" />}
          <p className="gen-tile-note">{settled ? 'The image was not saved to the library' : 'Saving to the library'}</p>
        </div>
      ) : null}

      {tile.phase === 'waiting' ? (
        <div className="gen-tile-body">
          <p className="gen-tile-note">Queued</p>
        </div>
      ) : null}

      {tile.phase === 'cancelled' ? (
        <div className="gen-tile-body">
          <p className="gen-tile-note">Cancelled</p>
        </div>
      ) : null}

      {tile.phase === 'running' ? (
        <div className="gen-tile-body gen-tile-progress">
          <p className="gen-tile-stage">{tile.stage ?? 'Sampling'}</p>
          {/* A provider that reports no step progress sends no percent, so there is no
              bar to fill and no number to show. The elapsed clock is the whole signal. */}
          {tile.percent === null ? null : (
            <>
              <p className="gen-tile-step">
                {tile.step !== null && tile.totalSteps !== null ? `step ${tile.step} of ${tile.totalSteps}` : 'working'}
                {` / ${tile.percent}%`}
              </p>
              <span className="gen-bar" role="presentation">
                <span className="gen-bar-fill" style={{ width: `${tile.percent}%` }} />
              </span>
            </>
          )}
        </div>
      ) : null}

      {tile.phase === 'failed' ? (
        <div className="gen-tile-body gen-tile-failure">
          <p className="gen-tile-failure-title">No image</p>
          <p className="gen-tile-failure-message">{tile.failure === null ? 'The provider gave no reason.' : tile.failure.message}</p>
          <Button variant="secondary" size="sm" disabled={!canRetry} onClick={() => onRetry(tile.index)}>
            Retry this image
          </Button>
        </div>
      ) : null}

      <span className="gen-tile-meta">
        <span>{tile.width === null || tile.height === null ? `${width} x ${height}` : `${tile.width} x ${tile.height}`}</span>
        <span>
          {tile.phase === 'done'
            ? tile.imageId === null
              ? 'not stored'
              : 'stored'
            : tile.phase === 'failed' || tile.phase === 'cancelled'
              ? 'not stored'
              : 'pending'}
        </span>
      </span>
    </article>
  );
}

function RevisedPrompt({ text }: { text: string }): ReactNode {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), 2400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copyState]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <section className="gen-revised" aria-label="Prompt as rewritten by the provider">
      <div className="gen-revised-head">
        <h3 className="gen-revised-title">Provider rewrite</h3>
        <span className="gen-badge">Rewritten</span>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </Button>
      </div>
      <p className="gen-revised-text">{text}</p>
      <p className="gen-hint">The provider rewrote the prompt for this batch. Your prompt is unchanged.</p>
    </section>
  );
}

export function ResultsGrid({
  batch,
  summary,
  running,
  plannedWidth,
  plannedHeight,
  onRetry,
  onRetryFailed,
  onReload,
  onClear,
  onOpenImage,
  onUseStarter,
}: ResultsGridProps): ReactNode {
  const studio = useStudio();
  const tickClocks = reconcileClocks(batch, running);
  const going = batch !== null && batch.tiles.some(isGoing);
  const [now, setNow] = useState(() => Date.now());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // One interval for the whole surface, and only while a tile is still going: a timer per
  // tile would fire for the same second and update state per tile. Nothing outside this
  // subtree re-renders, because the tick lives here.
  useEffect(() => {
    if (!running || !going) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [running, going]);

  if (batch === null) {
    return (
      <section className="gen-results" aria-label="Batch results">
        <div className="gen-empty">
          <div className="gen-ghost" style={ghostStyle(plannedWidth, plannedHeight)} aria-hidden="true">
            <span className="gen-ghost-tag">
              {plannedWidth} x {plannedHeight}
            </span>
          </div>
          <div className="gen-empty-copy">
            <h3 className="gen-empty-title">Nothing generated yet</h3>
            <p className="gen-empty-lead">Write a prompt, or start with one of these.</p>
          </div>
          <ul className="gen-starters" aria-label="Prompt starters">
            {PROMPT_STARTERS.map((starter) => (
              <li key={starter}>
                <button
                  type="button"
                  className="gen-starter"
                  title="Use this prompt"
                  onClick={() => onUseStarter(starter)}
                >
                  <svg className="icon gen-starter-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 5.5v13M5.5 12h13" />
                  </svg>
                  {starter}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  const columns = columnsForCount(batch.tiles.length);
  const settled = summary === null ? 0 : summary.done + summary.failed + summary.cancelled;
  const showPartial = summary !== null && summary.failed > 0;
  const canRetry = !running && batch.batchId !== null;
  const statusLabel = batchStatusLabel(batch, running);
  const providerLabel =
    studio.providers.find((provider) => provider.id === batch.providerId)?.label ?? batch.providerId;

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

  return (
    <section className="gen-results" aria-label="Batch results">
      <header className="gen-results-head">
        <div className="gen-results-copy">
          <h3 className="gen-results-title">{batch.prompt}</h3>
          <p className="gen-results-detail">
            {providerLabel} / {batch.width} x {batch.height} /{' '}
            {batch.requested === 1 ? '1 image' : `${batch.requested} images`}
            {batch.seed === null ? null : ` / seed ${batch.seed}`}
          </p>
        </div>
        <div className="gen-results-actions">
          <span className={running ? 'gen-status is-running' : 'gen-status'}>{statusLabel}</span>
          <Button variant="ghost" size="sm" onClick={() => void copyPrompt()}>
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              studio.useSettings({
                prompt: batch.prompt,
                width: batch.width,
                height: batch.height,
                count: batch.requested,
                providerId: batch.providerId,
              });
            }}
          >
            Use prompt
          </Button>
          <Button variant="ghost" size="sm" disabled={running} onClick={onClear}>
            Clear canvas
          </Button>
        </div>
      </header>

      {/* Progress is a live signal: once the batch settles the status pill and the
          tiles already say what happened, so the line goes away. */}
      {running ? (
        <p className="gen-progress-line">
          <span className="gen-progress-count">
            {settled} of {batch.tiles.length} settled
          </span>
          <span className="gen-progress-meta">
            <span className="gen-progress-elapsed" role="timer">
              {formatElapsed(now - batch.startedAt)}
            </span>
            <span className="gen-progress-percent">{summary === null ? 0 : summary.percent}%</span>
          </span>
        </p>
      ) : null}

      {showPartial && summary !== null ? (
        <div className="gen-partial" role="status">
          <span className="gen-partial-text">
            {summary.done} of {summary.total} succeeded, {summary.failed} failed
          </span>
          <Button variant="secondary" size="sm" disabled={!canRetry} onClick={onRetryFailed}>
            Retry failed
          </Button>
        </div>
      ) : null}

      {batch.streamError === null ? null : (
        <div className="gen-stream-error" role="alert">
          <span className="gen-partial-text">{batch.streamError}</span>
          {batch.batchId === null ? null : (
            <Button variant="secondary" size="sm" onClick={onReload}>
              Reload batch
            </Button>
          )}
        </div>
      )}

      <div className={`gen-grid is-cols-${columns}`}>
        {batch.tiles.map((tile) => (
          <ResultTile
            key={tile.index}
            tile={tile}
            total={batch.tiles.length}
            width={batch.width}
            height={batch.height}
            elapsed={elapsedLabel(tickClocks.get(tile.index), now)}
            settled={!running}
            canRetry={canRetry}
            onRetry={(index) => onRetry([index])}
            onOpen={onOpenImage}
          />
        ))}
      </div>

      {batch.revisedPrompt === null ? null : <RevisedPrompt text={batch.revisedPrompt} />}
    </section>
  );
}
