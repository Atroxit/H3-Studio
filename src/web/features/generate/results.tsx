// The results grid: one tile per requested index, with its own waiting, sampling,
// finished and failed state. Partial failure is a normal outcome here, not an
// error banner that hides the images that did arrive.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { imageUrl } from '../../api';
import { Button, Spinner } from '../../components';
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
  return 'Failed';
}

function stateClass(tile: GenerationTile): string {
  return tile.phase === 'running' ? 'is-running' : tile.phase === 'done' ? 'is-done' : tile.phase === 'failed' ? 'is-failed' : 'is-waiting';
}

interface ResultTileProps {
  tile: GenerationTile;
  total: number;
  width: number;
  height: number;
  settled: boolean;
  canRetry: boolean;
  onRetry: (index: number) => void;
}

function ResultTile({ tile, total, width, height, settled, canRetry, onRetry }: ResultTileProps): ReactNode {
  const label = `Image ${tile.index + 1} of ${total}`;

  return (
    <article className={`gen-tile ${stateClass(tile)}`} style={ratioStyle(width, height)} aria-label={label}>
      <span className="gen-tile-index">{String(tile.index + 1).padStart(2, '0')}</span>
      <span className={`gen-tile-state ${stateClass(tile)}`}>{stateLabel(tile)}</span>

      {tile.phase === 'done' && tile.imageId !== null ? (
        <img className="gen-tile-image" src={imageUrl(tile.imageId)} alt={`Generated result ${tile.index + 1} of ${total}`} />
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

      {tile.phase === 'running' ? (
        <div className="gen-tile-body gen-tile-progress">
          <p className="gen-tile-stage">{tile.stage ?? 'Sampling'}</p>
          <p className="gen-tile-step">
            {tile.step !== null && tile.totalSteps !== null ? `step ${tile.step} of ${tile.totalSteps}` : 'working'}
            {tile.percent === null ? '' : ` / ${tile.percent}%`}
          </p>
          <span className="gen-bar" role="presentation">
            <span className="gen-bar-fill" style={{ width: `${tile.percent ?? 0}%` }} />
          </span>
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
        <span>{tile.phase === 'done' ? 'stored' : tile.phase === 'failed' ? 'not stored' : 'pending'}</span>
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
  onUseStarter,
}: ResultsGridProps): ReactNode {
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
  const settled = summary === null ? 0 : summary.done + summary.failed;
  const showPartial = summary !== null && summary.failed > 0;
  const canRetry = !running && batch.batchId !== null;
  const statusLabel = running
    ? 'Running'
    : batch.status === 'cancelled'
      ? 'Stopped'
      : batch.status === 'failed'
        ? 'Failed'
        : 'Settled';

  return (
    <section className="gen-results" aria-label="Batch results">
      <header className="gen-results-head">
        <div className="gen-results-copy">
          <h3 className="gen-results-title">{batch.prompt}</h3>
          <p className="gen-results-detail">
            {batch.width} x {batch.height} / {batch.requested === 1 ? '1 image' : `${batch.requested} images`}
          </p>
        </div>
        <span className={running ? 'gen-status is-running' : 'gen-status'}>{statusLabel}</span>
      </header>

      {/* Progress is a live signal: once the batch settles the status pill and the
          tiles already say what happened, so the line goes away. */}
      {running ? (
        <p className="gen-progress-line">
          <span className="gen-progress-count">
            {settled} of {batch.tiles.length} settled
          </span>
          <span className="gen-progress-percent">{summary === null ? 0 : summary.percent}%</span>
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
          <Button variant="secondary" size="sm" onClick={onReload}>
            Reload batch
          </Button>
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
            settled={!running}
            canRetry={canRetry}
            onRetry={(index) => onRetry([index])}
          />
        ))}
      </div>

      {batch.revisedPrompt === null ? null : <RevisedPrompt text={batch.revisedPrompt} />}
    </section>
  );
}
