// The prompt composer and the action row: a real textarea, a character count,
// Cmd or Ctrl Enter to generate, and a visible Stop while a batch runs.
// Size and count each appear once: the size beside the button, the count in it.

import { useEffect, useId, useRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { imageUrl } from '../../api';
import { Button } from '../../components';
import { PROMPT_MAX_LENGTH, promptProblem, sizeProblem } from './helpers';
import type { AlterationCandidate, GenerationForm } from './useGeneration';

export interface PromptComposerProps {
  form: GenerationForm;
  running: boolean;
  canGenerate: boolean;
  blockedReason: string | null;
  snappedWidth: number;
  snappedHeight: number;
  /** The image an alteration would use, or null when the composer writes a new image. */
  alterationSource: AlterationCandidate | null;
  alterationCandidates: ReadonlyArray<AlterationCandidate>;
  onSelectAlterationSource: (imageId: string) => void;
  onNewImage: () => void;
  /** Bumped by the store when the textarea should take focus. */
  focusNonce: number;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

export function PromptComposer({
  form,
  running,
  canGenerate,
  blockedReason,
  snappedWidth,
  snappedHeight,
  alterationSource,
  alterationCandidates,
  onSelectAlterationSource,
  onNewImage,
  focusNonce,
  onChange,
  onGenerate,
  onCancel,
}: PromptComposerProps): ReactNode {
  const promptId = useId();
  const hintId = `${promptId}-hint`;
  const errorId = `${promptId}-prompt-error`;
  const blockedId = `${promptId}-blocked`;
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const altering = alterationSource !== null;
  const countLabel = altering
    ? form.count === 1
      ? '1 alteration'
      : `${form.count} alterations`
    : form.count === 1
      ? '1 image'
      : `${form.count} images`;
  const promptIssue = form.prompt.trim().length === 0 ? null : promptProblem(form.prompt);
  const snapped =
    sizeProblem(form.width, form.height) === null &&
    (snappedWidth !== form.width || snappedHeight !== form.height);

  // A new image, an opened batch or an "Alter this" click all ask for the prompt box.
  useEffect(() => {
    if (focusNonce <= 0) return;
    promptRef.current?.focus();
  }, [focusNonce]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value);
  };

  // Enter alone keeps its native newline. Only the modifier chord submits.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    if (canGenerate) onGenerate();
  };

  return (
    <section className="gen-composer" aria-label="Prompt and actions">
      {alterationSource === null ? null : (
        <div className="gen-alter-bar">
          <img
            className="gen-alter-thumb"
            src={imageUrl(alterationSource.imageId)}
            alt={`Source image ${alterationSource.label}`}
          />
          <div className="gen-alter-copy">
            <span className="gen-alter-title">Altering image {alterationSource.label}</span>
            {alterationCandidates.length > 1 ? (
              <span className="gen-alter-switch" role="group" aria-label="Choose which image to alter">
                {alterationCandidates.map((candidate) => {
                  const active = candidate.imageId === alterationSource.imageId;
                  return (
                    <button
                      key={candidate.imageId}
                      type="button"
                      className={active ? 'gen-alter-pill is-active' : 'gen-alter-pill'}
                      aria-pressed={active}
                      title={`Alter image ${candidate.label}`}
                      disabled={running}
                      onClick={() => {
                        onSelectAlterationSource(candidate.imageId);
                      }}
                    >
                      {candidate.label}
                    </button>
                  );
                })}
              </span>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" disabled={running} onClick={onNewImage}>
            New image
          </Button>
        </div>
      )}

      <div className="gen-composer-head">
        <label className="gen-composer-label" htmlFor={promptId}>
          {altering ? 'Alteration prompt' : 'New image prompt'}
        </label>
        <span className={promptIssue === null ? 'gen-composer-count' : 'gen-composer-count is-error'} aria-hidden="true">
          {form.prompt.length} / {PROMPT_MAX_LENGTH}
        </span>
      </div>

      <textarea
        id={promptId}
        className="field-textarea gen-prompt"
        ref={promptRef}
        value={form.prompt}
        rows={3}
        spellCheck
        autoComplete="off"
        aria-invalid={promptIssue === null ? undefined : true}
        aria-describedby={promptIssue === null ? hintId : `${hintId} ${errorId}`}
        placeholder={
          altering
            ? 'Describe what to change in this image. Lighting, weather, objects, style.'
            : 'Describe the image. Materials, light, framing.'
        }
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      <p className="gen-hint" id={hintId}>
        {running
          ? 'A batch is running. Stop it before starting another.'
          : altering
            ? 'Cmd or Ctrl + Enter to create an alteration. Enter adds a new line.'
            : 'Cmd or Ctrl + Enter to generate. Enter adds a new line.'}
      </p>
      {promptIssue === null ? null : (
        <p className="gen-hint is-error" id={errorId} role="alert">
          {promptIssue}
        </p>
      )}

      <div className="gen-actions">
        <p className="gen-actions-meta">
          <span className="gen-mono">
            {form.width} x {form.height}
          </span>
          {snapped ? (
            <span className="gen-mono gen-snapped" title="The size sent to the provider">
              Snapped to {snappedWidth} x {snappedHeight}
            </span>
          ) : null}
        </p>
        <div className="gen-actions-buttons">
          {running ? (
            <Button variant="secondary" onClick={onCancel}>
              Stop
            </Button>
          ) : null}
          {blockedReason === null ? null : (
            <span className="sr-only" id={blockedId}>
              {blockedReason}
            </span>
          )}
          <Button
            variant="primary"
            disabled={!canGenerate}
            title={blockedReason ?? undefined}
            aria-describedby={blockedReason === null ? undefined : blockedId}
            onClick={onGenerate}
          >
            Generate {countLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
