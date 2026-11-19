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
import {
  formatClock,
  formatEta,
  formatSecondsPerStep,
  pipelineStages,
  previewBlurPx,
  stageHeadline,
} from './helpers';
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
  /** The tile an alteration would start from, or null when alterations are unavailable. */
  alterationSourceId: string | null;
  /** Picks another ready tile as the alteration source, without opening the viewer. */
  onSelectSource: (imageId: string) => void;
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
 * Feeds the grid container query the tile aspect ratio and row/column counts so tiles
 * scale with the window in both directions without overflowing the stage.
 */
function gridScaleStyle(width: number, height: number, count: number, columns: 1 | 2 | 3 | 4): CSSProperties {
  const safeWidth = width > 0 ? width : 1;
  const safeHeight = height > 0 ? height : 1;
  const rows = Math.max(1, Math.ceil(Math.max(1, count) / columns));
  const vars: Record<string, string> = {
    '--tile-ratio': String(safeWidth / safeHeight),
    '--grid-cols': String(columns),
    '--grid-rows': String(rows),
  };
  return vars as CSSProperties;
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

function fallbackDetail(stage: string | null): string {
  switch (stage) {
    case null:
    case 'waiting':
      return 'Waiting for a GPU slot';
    case 'preparing':
      return 'Warming the graph';
    case 'loading':
      return 'Loading model weights';
    case 'enhancing':
      return 'Expanding your prompt';
    case 'encoding':
      return 'Building conditioning tensors';
    case 'sampling':
      return 'Denoising latent image';
    case 'decoding':
      return 'Decoding latent to pixels';
    case 'saving':
      return 'Writing the PNG';
    default:
      return 'Working';
  }
}

interface TileLoadingProps {
  tile: GenerationTile;
  total: number;
  width: number;
  height: number;
  /** Milliseconds since this tile's attempt started, or null when there is no clock. */
  elapsedMs: number | null;
}

/**
 * Everything a tile shows while it is still waiting or denoising. With a preview frame it
 * becomes a live image with a glass HUD; without one it is an animated status panel. Both
 * read the same stage, detail, step and clock state, so the switch is only a visual one.
 */
function TileLoading({ tile, total, width, height, elapsedMs }: TileLoadingProps): ReactNode {
  const live = tile.phase === 'running' && tile.previewUrl !== undefined && tile.previewUrl.length > 0;
  const headline = stageHeadline(tile.stage);
  // A step message replaces the node detail, so keep the node line as the title and the
  // step line as the measurement instead of showing "Step 4 of 6" twice.
  const detail = tile.detail ?? null;
  const stepDetail = detail !== null && /^Step \d+ of \d+$/.test(detail) ? null : detail;
  const nodeDetail = stepDetail ?? fallbackDetail(tile.stage);
  const percent = tile.percent === null ? null : Math.min(100, Math.max(0, Math.round(tile.percent)));
  const stepText =
    tile.step === null || tile.totalSteps === null ? null : `Step ${tile.step} / ${tile.totalSteps}`;
  const speed = formatSecondsPerStep(tile.stage === 'sampling' ? tile.avgStepMs : null);
  const remainingSteps =
    tile.step === null || tile.totalSteps === null ? null : Math.max(0, tile.totalSteps - tile.step);
  const eta = formatEta(
    tile.avgStepMs === undefined || remainingSteps === null ? null : tile.avgStepMs * remainingSteps,
  );
  const clock = elapsedMs === null ? null : formatClock(elapsedMs);
  const steps = pipelineStages(tile.stage, tile.completedStages ?? []);
  const blur = previewBlurPx(tile.step, tile.totalSteps);
  const slotLabel = total > 1 ? `Image ${tile.index + 1} of ${total}` : `${width} × ${height}`;
  const topLabel = tile.stage === 'decoding' || tile.stage === 'saving' ? 'Decoding final...' : 'Live preview';
  const hudLine = [stepText, percent === null ? null : `${percent}%`, speed].filter(Boolean).join(' · ');
  const richDetail = [nodeDetail, speed, eta].filter(Boolean).join(' · ');
  const barClass = percent === null ? 'gen-progress is-indeterminate' : 'gen-progress';
  const barFill = <span className="gen-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />;
  const pipeline = (
    <ul className="gen-pipeline" aria-label="Pipeline progress">
      {steps.map((step) => (
        <li key={step.id} className={`is-${step.state}`}>
          <span className="gen-pipeline-mark" aria-hidden="true">
            {step.state === 'done' ? '✓' : ''}
          </span>
          {step.label}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={`gen-loading${live ? ' is-live' : ''}`}>
      {live ? (
        <img
          className="tile-live-preview"
          src={tile.previewUrl}
          alt=""
          draggable={false}
          style={{ filter: `blur(${blur}px)` }}
        />
      ) : (
        <div className="gen-ambient" aria-hidden="true">
          <span className="gen-ambient-mesh" />
          <span className="gen-ambient-scan" />
          <span className="gen-ambient-grid" />
        </div>
      )}

      {live ? (
        <>
          <div className="gen-hud-top">
            <span className="gen-live-dot" aria-hidden="true" />
            <span className="gen-live-label">{topLabel}</span>
            <span className="gen-hud-clock">
              {clock === null ? null : (
                <span className="gen-clock" role="timer">
                  {clock}
                </span>
              )}
              {eta === null ? null : <span className="gen-eta">{eta}</span>}
            </span>
          </div>
          <div className="gen-live-hud">
            <p className="gen-hud-title">{nodeDetail}</p>
            <p className="gen-hud-detail">{hudLine.length === 0 ? headline : hudLine}</p>
            <span
              className={barClass}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              {barFill}
            </span>
            {pipeline}
          </div>
        </>
      ) : (
        <div className="gen-panel">
          <div className="gen-panel-inner">
            <div className="gen-panel-eyebrow">
              <span className="gen-ring" aria-hidden="true" />
              <span className="gen-panel-slot">{slotLabel}</span>
              {clock === null ? null : (
                <span className="gen-panel-clock" role="timer">
                  {clock}
                </span>
              )}
            </div>
            <p className="gen-panel-title">{headline}</p>
            <p className="gen-panel-detail">{richDetail}</p>
            {pipeline}
            <span
              className={barClass}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              {barFill}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

interface ResultTileProps {
  tile: GenerationTile;
  total: number;
  width: number;
  height: number;
  /** Elapsed time in a display form, or null when there is no honest start to count from. */
  elapsed: string | null;
  /** The same duration as a number, for the loading clock. */
  elapsedMs: number | null;
  settled: boolean;
  canRetry: boolean;
  alterationSourceId: string | null;
  onRetry: (index: number) => void;
  onOpen: (imageId: string, trigger: HTMLElement | null) => void;
  onSelectSource: (imageId: string) => void;
}

function ResultTile({
  tile,
  total,
  width,
  height,
  elapsed,
  elapsedMs,
  settled,
  canRetry,
  alterationSourceId,
  onRetry,
  onOpen,
  onSelectSource,
}: ResultTileProps): ReactNode {
  const label = `Image ${tile.index + 1} of ${total}`;
  const ready = tile.phase === 'done' && tile.imageId !== null;
  const isAlterSource = ready && alterationSourceId !== null && tile.imageId === alterationSourceId;
  const canAlter = ready && alterationSourceId !== null;
  const going = isGoing(tile);

  return (
    <article
      className={`gen-tile ${stateClass(tile)}${isAlterSource ? ' is-alter-source' : ''}`}
      style={ratioStyle(width, height)}
      aria-label={label}
    >
      <span className="gen-tile-index">{String(tile.index + 1).padStart(2, '0')}</span>
      {going ? null : (
        <span className="gen-tile-tags">
          {elapsed === null ? null : (
            // role=timer keeps the once a second change out of live announcements.
            <span className={tile.phase === 'running' ? 'gen-tile-elapsed is-live' : 'gen-tile-elapsed'} role="timer">
              {elapsed}
            </span>
          )}
          <span className={`gen-tile-state ${stateClass(tile)}`}>{stateLabel(tile)}</span>
        </span>
      )}

      {going ? <TileLoading tile={tile} total={total} width={width} height={height} elapsedMs={elapsedMs} /> : null}

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

      {tile.phase === 'cancelled' ? (
        <div className="gen-tile-body">
          <p className="gen-tile-note">Cancelled</p>
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

      {going ? null : (
        <span className="gen-tile-meta">
          <span>{tile.width === null || tile.height === null ? `${width} x ${height}` : `${tile.width} x ${tile.height}`}</span>
          {canAlter && tile.imageId !== null ? (
            isAlterSource ? (
              <span className="gen-alter-badge">Altering</span>
            ) : (
              <button
                type="button"
                className="gen-alter-action"
                title={`Alter image ${tile.index + 1} instead`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectSource(tile.imageId ?? '');
                }}
              >
                Alter this
              </button>
            )
          ) : null}
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
      )}
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
  alterationSourceId,
  onSelectSource,
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
            <h3 className="gen-empty-title">Create a new image</h3>
            <p className="gen-empty-lead">Write a prompt below, or start with one of these.</p>
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
          <Button variant="secondary" size="sm" disabled={running} onClick={onClear}>
            New image
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

      <div
        className={`gen-grid is-cols-${columns}`}
        style={gridScaleStyle(batch.width, batch.height, batch.tiles.length, columns)}
      >
        {batch.tiles.map((tile) => {
          const clock = tickClocks.get(tile.index);
          return (
          <ResultTile
            key={tile.index}
            tile={tile}
            total={batch.tiles.length}
            width={batch.width}
            height={batch.height}
            elapsed={elapsedLabel(clock, now)}
            elapsedMs={clock === undefined ? null : (clock.settledAt ?? now) - clock.startedAt}
            settled={!running}
            canRetry={canRetry}
            alterationSourceId={alterationSourceId}
            onRetry={(index) => onRetry([index])}
            onOpen={onOpenImage}
            onSelectSource={onSelectSource}
          />
          );
        })}
      </div>

      {batch.revisedPrompt === null ? null : <RevisedPrompt text={batch.revisedPrompt} />}
    </section>
  );
}
