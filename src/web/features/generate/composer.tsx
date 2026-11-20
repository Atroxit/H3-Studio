// The prompt composer: the elevated card that holds the prompt, the attachments it runs
// with, and the one bright action of the studio. References live here, beside the words
// they illustrate, instead of in the inspector: a picture and the prompt that names it are
// one decision. Files can be picked or dropped onto the card.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ReferenceImage } from '../../../core/types';
import { imageUrl, uploadReference } from '../../api';
import { Button, Spinner } from '../../components';
import { PROMPT_MAX_LENGTH, promptProblem } from './helpers';
import type { AlterationCandidate, GenerationForm } from './useGeneration';

export interface PromptComposerProps {
  form: GenerationForm;
  running: boolean;
  canGenerate: boolean;
  blockedReason: string | null;
  /** The images this provider accepts, or 0 when it takes text only. */
  maxReferenceImages: number;
  /** The image an alteration would use, or null when the composer writes a new image. */
  alterationSource: AlterationCandidate | null;
  alterationCandidates: ReadonlyArray<AlterationCandidate>;
  onSelectAlterationSource: (imageId: string) => void;
  onNewImage: () => void;
  onAddReference: (reference: ReferenceImage) => void;
  onRemoveReference: (referenceId: string) => void;
  /** Bumped by the store when the textarea should take focus. */
  focusNonce: number;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

/**
 * A reference is a file on disk, so its thumbnail is a document scoped object URL made
 * when it is uploaded. Keeping them at module scope means switching to the library and
 * back does not lose the picture the filename alone could never show.
 */
const referencePreviews = new Map<string, string>();

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`The file ${file.name} could not be read.`));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = (): void => {
      reject(new Error(`The file ${file.name} could not be read.`));
    };
    reader.readAsDataURL(file);
  });
}

function PlusIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

function CrossIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

function PaperclipIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="M4.5 17.5l5-5 4 4 2.5-2.5 3.5 3.5" />
    </svg>
  );
}

export function PromptComposer({
  form,
  running,
  canGenerate,
  blockedReason,
  maxReferenceImages,
  alterationSource,
  alterationCandidates,
  onSelectAlterationSource,
  onNewImage,
  onAddReference,
  onRemoveReference,
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
  const [uploading, setUploading] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const altering = alterationSource !== null;
  const referenceLimit = Math.max(0, Math.trunc(maxReferenceImages));
  const referenceCount = form.references.length;
  const canAttach = referenceLimit > 0 && !running && referenceCount < referenceLimit;
  const showTray = referenceLimit > 0 || altering;
  const countLabel = altering
    ? form.count === 1
      ? '1 alteration'
      : `${form.count} alterations`
    : form.count === 1
      ? '1 image'
      : `${form.count} images`;
  const promptIssue = form.prompt.trim().length === 0 ? null : promptProblem(form.prompt);
  const describedBy = [running ? hintId : null, promptIssue === null ? null : errorId]
    .filter((id): id is string => id !== null)
    .join(' ');
  // A quiet line beside the add control: what to do with no attachments, what is left with some.
  const referenceHint =
    referenceCount === 0
      ? `0/${referenceLimit} · Drop images or click to reference as <Picture 1>`
      : `${referenceCount}/${referenceLimit}`;

  // A new image, an opened batch or an "Alter this" click all ask for the prompt box.
  useEffect(() => {
    if (focusNonce <= 0) return;
    promptRef.current?.focus();
  }, [focusNonce]);

  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || !canAttach) return;
    setUploading(true);
    setReferenceError(null);
    try {
      let added = 0;
      for (const file of files) {
        if (referenceCount + added >= referenceLimit) break;
        if (!file.type.startsWith('image/')) {
          setReferenceError('Only image files can be used as a reference.');
          continue;
        }
        const dataBase64 = await readFileAsBase64(file);
        const reference = await uploadReference({ filename: file.name, mimeType: file.type, dataBase64 });
        referencePreviews.set(reference.id, URL.createObjectURL(file));
        onAddReference(reference);
        added += 1;
      }
    } catch (error) {
      setReferenceError(describeError(error));
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void addFiles(files);
  };

  const handleRemoveReference = (reference: ReferenceImage): void => {
    const preview = referencePreviews.get(reference.id);
    if (preview !== undefined) {
      URL.revokeObjectURL(preview);
      referencePreviews.delete(reference.id);
    }
    onRemoveReference(reference.id);
  };

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

  // Dropping a picture onto the card attaches it, exactly like picking it from the file input.
  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!canAttach) return;
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    if (!canAttach) return;
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return (
    <section
      className={dragging ? 'gen-composer is-dragging' : 'gen-composer'}
      aria-label="Prompt and actions"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showTray ? (
        <div className="gen-tray" role="group" aria-label="Attachments">
          {alterationSource === null ? null : (
            <div className="gen-tray-chip is-source">
              <span className="gen-tray-thumb">
                <img src={imageUrl(alterationSource.imageId)} alt={`Source image ${alterationSource.label}`} />
                <span className="gen-tray-badge" aria-hidden="true">
                  {alterationSource.label}
                </span>
              </span>
              <span className="gen-tray-copy">
                <span className="gen-tray-name">Altering {alterationSource.label}</span>
                {alterationCandidates.length > 1 ? (
                  <span className="gen-tray-switch" role="group" aria-label="Choose which image to alter">
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
              </span>
              <button
                type="button"
                className="gen-tray-remove"
                aria-label="Clear the alteration source"
                title="Clear alteration"
                disabled={running}
                onClick={onNewImage}
              >
                <CrossIcon />
              </button>
            </div>
          )}

          {form.references.map((reference, position) => {
            const preview = referencePreviews.get(reference.id);
            return (
              <div key={reference.id} className="gen-tray-chip">
                <span className="gen-tray-thumb">
                  {preview === undefined ? (
                    <span className="gen-tray-thumb-empty" aria-hidden="true">
                      <PaperclipIcon />
                    </span>
                  ) : (
                    <img src={preview} alt="" />
                  )}
                  <span className="gen-tray-badge" aria-hidden="true">
                    {position + 1}
                  </span>
                </span>
                <span className="gen-tray-copy">
                  <span className="gen-tray-name">Pic {position + 1}</span>
                  <span className="gen-tray-file" title={reference.filename}>
                    {reference.filename}
                  </span>
                </span>
                <button
                  type="button"
                  className="gen-tray-remove"
                  disabled={running}
                  aria-label={`Remove reference ${reference.filename}`}
                  title="Remove reference"
                  onClick={() => handleRemoveReference(reference)}
                >
                  <CrossIcon />
                </button>
              </div>
            );
          })}

          {canAttach ? (
            <label className="gen-tray-add">
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={uploading}
                aria-label="Add reference images"
                onChange={handleFiles}
              />
              <span className="gen-tray-add-icon" aria-hidden="true">
                {uploading ? <Spinner size={12} label="" /> : <PlusIcon />}
              </span>
              <span className="gen-tray-add-text">{uploading ? 'Uploading' : 'Ref'}</span>
            </label>
          ) : null}

          {referenceLimit === 0 ? null : <span className="gen-tray-hint">{referenceHint}</span>}
        </div>
      ) : null}

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
        aria-describedby={describedBy.length === 0 ? undefined : describedBy}
        placeholder={
          altering
            ? 'Describe what to change in this image. Lighting, weather, objects, style.'
            : 'Describe the image. Materials, light, framing.'
        }
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      {running ? (
        <p className="gen-hint" id={hintId}>
          A batch is running. Stop it before starting another.
        </p>
      ) : null}
      {promptIssue === null ? null : (
        <p className="gen-hint is-error" id={errorId} role="alert">
          {promptIssue}
        </p>
      )}
      {referenceError === null ? null : (
        <p className="gen-hint is-error" role="alert">
          {referenceError}
        </p>
      )}

      <div className="gen-actions">
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
          {running ? null : (
            <kbd className="gen-shortcut" title="Ctrl or Cmd + Enter" aria-hidden="true">
              Ctrl↵
            </kbd>
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
