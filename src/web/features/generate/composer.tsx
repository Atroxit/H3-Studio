// The prompt composer: the elevated card that holds the prompt, the attachments it runs
// with, and the one bright action of the studio. References live here, beside the words
// they illustrate, instead of in the inspector: a picture and the prompt that names it are
// one decision. Files can be picked or dropped onto the card.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { composePromptWithThemes, themeAppendCharDelta } from '../../../core/themes';
import type { PromptTheme, ReferenceImage } from '../../../core/types';
import {
  imageUrl,
  uploadReference,
  type ThemeCreateBody,
  type ThemeUpdateBody,
} from '../../api';
import { Button, Spinner } from '../../components';
import { PROMPT_MAX_LENGTH, promptProblem } from './helpers';
import { ThemeDrawer } from './ThemeDrawer';
import { resolveActiveThemes, type AlterationCandidate, type GenerationForm } from './useGeneration';

export interface PromptComposerProps {
  form: GenerationForm;
  /** Every theme the server knows, shipped and custom. */
  themes: PromptTheme[];
  onToggleTheme: (id: string) => void;
  onClearThemes: () => void;
  onCreateTheme: (input: ThemeCreateBody) => Promise<PromptTheme>;
  onUpdateTheme: (id: string, patch: ThemeUpdateBody) => Promise<PromptTheme>;
  onDeleteTheme: (id: string) => Promise<void>;
  onResetThemes: () => Promise<void>;
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

/**
 * The tags the strip offers when nothing is picked yet, in the order the studio wants
 * them read: the three styles a new user reaches for first, then film, mood, light, lens.
 */
const QUICK_PICK_THEME_IDS: readonly string[] = [
  'realistic',
  'cinematic',
  'cyberpunk',
  '35mm-film',
  'noir',
  'golden-hour',
  'neon-night',
  'shallow-dof',
  'editorial',
  'studio-softbox',
];

/**
 * The strip order: active tags first in selection order, then the quick picks, then any
 * custom themes, then whatever shipped themes are left. Nothing is dropped, so a user
 * theme is always one click away even before it is active.
 */
function stripThemes(themes: readonly PromptTheme[], activeIds: ReadonlySet<string>): PromptTheme[] {
  const available = themes.filter((theme) => !activeIds.has(theme.id));
  const byId = new Map(available.map((theme) => [theme.id, theme]));
  const ordered: PromptTheme[] = [];
  const placed = new Set<string>();
  for (const id of QUICK_PICK_THEME_IDS) {
    const theme = byId.get(id);
    if (theme === undefined) continue;
    ordered.push(theme);
    placed.add(id);
  }
  for (const theme of available) {
    if (theme.builtIn === true || placed.has(theme.id)) continue;
    ordered.push(theme);
    placed.add(theme.id);
  }
  for (const theme of available) {
    if (!placed.has(theme.id)) ordered.push(theme);
  }
  return ordered;
}

function SparkleIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4.5l1.6 4.4 4.4 1.6-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6z" />
      <path d="M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
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
  themes,
  onToggleTheme,
  onClearThemes,
  onCreateTheme,
  onUpdateTheme,
  onDeleteTheme,
  onResetThemes,
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
  const [themesOpen, setThemesOpen] = useState(false);
  const closeThemes = useCallback((): void => {
    setThemesOpen(false);
  }, []);
  const activeThemes = useMemo(
    () => resolveActiveThemes(form.themeIds, themes),
    [form.themeIds, themes],
  );
  const activeIds = useMemo(() => new Set(activeThemes.map((theme) => theme.id)), [activeThemes]);
  const strip = useMemo(() => stripThemes(themes, activeIds), [themes, activeIds]);
  const composedPrompt = composePromptWithThemes(form.prompt, activeThemes);
  const appendDelta = themeAppendCharDelta(form.prompt, activeThemes);
  const overLimit = composedPrompt.length > PROMPT_MAX_LENGTH;
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
  const promptIssue =
    form.prompt.trim().length === 0 ? null : (promptProblem(form.prompt) ?? promptProblem(composedPrompt));
  const describedBy = [running ? hintId : null, promptIssue === null ? null : errorId]
    .filter((id): id is string => id !== null)
    .join(' ');
  // A quiet line beside the add control: what to do with no attachments, what is left with some.
  const referenceHint = `${referenceCount}/${referenceLimit}`;

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

      {/* The theme bar: a quiet shelf of preset chunks between the attachments and the
          words. It never takes a row of its own from the prompt. */}
      <div className="gen-theme-bar">
        <button
          type="button"
          className={themesOpen ? 'gen-theme-label is-open' : 'gen-theme-label'}
          aria-expanded={themesOpen}
          aria-haspopup="dialog"
          title="Browse every prompt theme"
          onClick={() => {
            setThemesOpen((open) => !open);
          }}
        >
          <SparkleIcon />
          <span>Themes</span>
          {activeThemes.length === 0 ? null : (
            <span className="gen-theme-label-count" aria-hidden="true">
              {activeThemes.length}
            </span>
          )}
        </button>

        <div className="gen-theme-strip" role="group" aria-label="Prompt theme tags">
          {activeThemes.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="gen-theme-tag is-active"
              aria-pressed
              title={`Appends: "${theme.snippet}"`}
              onClick={() => {
                onToggleTheme(theme.id);
              }}
            >
              <span className="gen-theme-tag-dot" aria-hidden="true" />
              {theme.name}
            </button>
          ))}
          {strip.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="gen-theme-tag"
              aria-pressed={false}
              title={`Appends: "${theme.snippet}"`}
              onClick={() => {
                onToggleTheme(theme.id);
              }}
            >
              {theme.name}
            </button>
          ))}
        </div>

        <div className="gen-theme-bar-actions">
          {activeThemes.length === 0 ? null : (
            <button
              type="button"
              className="gen-theme-clear"
              title="Clear every prompt theme"
              onClick={onClearThemes}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="gen-theme-more"
            aria-expanded={themesOpen}
            aria-haspopup="dialog"
            title="Pick and manage prompt themes"
            onClick={() => {
              setThemesOpen(true);
            }}
          >
            All
          </button>
        </div>
      </div>

      <div className="gen-composer-head">
        <label className="gen-composer-label" htmlFor={promptId}>
          {altering ? 'Alteration prompt' : 'New image prompt'}
        </label>
        <span className={overLimit ? 'gen-composer-count is-error' : 'gen-composer-count'} aria-hidden="true">
          {form.prompt.length}
          {activeThemes.length === 0 ? null : (
            <span className="gen-composer-delta"> (+{appendDelta})</span>
          )}
          {' / '}
          {PROMPT_MAX_LENGTH}
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

      <ThemeDrawer
        open={themesOpen}
        themes={themes}
        activeThemes={activeThemes}
        onToggle={onToggleTheme}
        onClear={onClearThemes}
        onCreate={onCreateTheme}
        onUpdate={onUpdateTheme}
        onDelete={onDeleteTheme}
        onReset={onResetThemes}
        onClose={closeThemes}
      />
    </section>
  );
}
