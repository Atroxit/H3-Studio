// The prompt composer and the action row: a real textarea, a character count,
// Cmd or Ctrl Enter to generate, and a visible Stop while a batch runs.

import { useId, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../../components';
import type { GenerationForm } from './useGeneration';

export interface PromptComposerProps {
  form: GenerationForm;
  providerLabel: string | null;
  running: boolean;
  canGenerate: boolean;
  blockedReason: string | null;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

export function PromptComposer({
  form,
  providerLabel,
  running,
  canGenerate,
  blockedReason,
  onChange,
  onGenerate,
  onCancel,
}: PromptComposerProps): ReactNode {
  const promptId = useId();
  const hintId = `${promptId}-hint`;
  const blockedId = `${promptId}-blocked`;
  const countLabel = form.count === 1 ? '1 image' : `${form.count} images`;

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
      <div className="gen-composer-head">
        <label className="gen-composer-label" htmlFor={promptId}>
          Prompt
        </label>
        <span className="gen-composer-count" aria-hidden="true">
          {form.prompt.length} characters
        </span>
      </div>

      <textarea
        id={promptId}
        className="gen-prompt"
        value={form.prompt}
        rows={3}
        spellCheck
        autoComplete="off"
        aria-describedby={hintId}
        placeholder="Describe the image. Materials, light, framing."
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      <p className="gen-hint" id={hintId}>
        {running
          ? 'A batch is running. Stop it before starting another.'
          : `Cmd or Ctrl + Enter to generate. Enter adds a new line. ${form.prompt.length} characters, ${countLabel}.`}
      </p>

      <div className="gen-actions">
        <div className="gen-actions-meta">
          <span className="gen-mono">
            {form.width} x {form.height}
          </span>
          <span className="gen-mono">{countLabel}</span>
          <span className="gen-mono">{providerLabel ?? 'No provider'}</span>
        </div>
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
            className="gen-generate"
            disabled={!canGenerate}
            title={blockedReason ?? undefined}
            aria-describedby={blockedReason === null ? undefined : blockedId}
            onClick={onGenerate}
          >
            <span className="gen-generate-title">Generate {countLabel}</span>
            <span className="gen-generate-sub">{providerLabel ?? 'No provider'}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
