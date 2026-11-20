// The prompt theme picker and manager. One centered darkroom dialog: browse the tags,
// turn them on and off, and write, edit or delete a custom chunk without leaving it.
//
// It deliberately owns no prompt state. The composer's controller stores the active tag
// ids, so a tag clicked here is already on when the drawer closes.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  PROMPT_THEME_CATEGORIES,
  PROMPT_THEME_CATEGORY_LABELS,
  composePromptWithThemes,
} from '../../../core/themes';
import type { PromptTheme, PromptThemeCategory } from '../../../core/types';
import type { ThemeCreateBody, ThemeUpdateBody } from '../../api';
import { Button, Spinner } from '../../components';

export interface ThemeDrawerProps {
  open: boolean;
  themes: PromptTheme[];
  activeThemes: PromptTheme[];
  onToggle: (id: string) => void;
  onClear: () => void;
  onCreate: (input: ThemeCreateBody) => Promise<PromptTheme>;
  onUpdate: (id: string, patch: ThemeUpdateBody) => Promise<PromptTheme>;
  onDelete: (id: string) => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
}

type CategoryFilter = 'all' | PromptThemeCategory;

interface FilterOption {
  id: CategoryFilter;
  label: string;
}

const FILTERS: readonly FilterOption[] = [
  { id: 'all', label: 'All' },
  ...PROMPT_THEME_CATEGORIES.map((category) => ({
    id: category,
    label: PROMPT_THEME_CATEGORY_LABELS[category],
  })),
];

type EditorState = { mode: 'new' } | { mode: 'edit'; id: string } | null;

interface EditorDraft {
  name: string;
  category: PromptThemeCategory;
  snippet: string;
}

const EMPTY_DRAFT: EditorDraft = { name: '', category: 'custom', snippet: '' };

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The theme could not be saved.';
}

function EditIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.5 19.5h4l10-10-4-4-10 10z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function TrashIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7.5h14M9.5 7.5V5h5v2.5M7 7.5l.8 12h8.4l.8-12" />
    </svg>
  );
}

function CloseIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

/** One tag card: the whole face toggles it, the two icons beside it manage it. */
function ThemeCard({
  theme,
  active,
  onToggle,
  onEdit,
  onDelete,
}: {
  theme: PromptTheme;
  active: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): ReactNode {
  return (
    <li className={active ? 'gen-theme-card is-active' : 'gen-theme-card'}>
      <button
        type="button"
        className="gen-theme-card-toggle"
        aria-pressed={active}
        title={`Appends: "${theme.snippet}"`}
        onClick={onToggle}
      >
        <span className="gen-theme-card-mark" aria-hidden="true">
          {active ? '\u2713' : ''}
        </span>
        <span className="gen-theme-card-copy">
          <span className="gen-theme-card-name">{theme.name}</span>
          <span className="gen-theme-card-cat">{PROMPT_THEME_CATEGORY_LABELS[theme.category]}</span>
        </span>
      </button>
      <span className="gen-theme-card-actions">
        <button
          type="button"
          className="gen-theme-icon"
          aria-label={`Edit ${theme.name}`}
          title={`Edit ${theme.name}`}
          onClick={onEdit}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="gen-theme-icon is-danger"
          aria-label={`Delete ${theme.name}`}
          title={`Delete ${theme.name}`}
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      </span>
    </li>
  );
}

export function ThemeDrawer({
  open,
  themes,
  activeThemes,
  onToggle,
  onClear,
  onCreate,
  onUpdate,
  onDelete,
  onReset,
  onClose,
}: ThemeDrawerProps): ReactNode {
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Escape closes the dialog, and the panel takes focus so a keyboard user is inside it.
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose]);

  // A fresh editor form asks for the name, which is the first thing to type.
  useEffect(() => {
    if (editor === null) return;
    nameRef.current?.focus();
  }, [editor]);

  const activeIds = useMemo(() => new Set(activeThemes.map((theme) => theme.id)), [activeThemes]);
  const visible = filter === 'all' ? themes : themes.filter((theme) => theme.category === filter);
  const appended = composePromptWithThemes('', activeThemes);
  const draftName = draft.name.trim();
  const draftSnippet = draft.snippet.trim();
  const canSave = !busy && draftName.length > 0 && draftSnippet.length > 0;

  const openNew = (): void => {
    setError(null);
    setDraft(EMPTY_DRAFT);
    setEditor({ mode: 'new' });
  };

  const openEdit = (theme: PromptTheme): void => {
    setError(null);
    setDraft({ name: theme.name, category: theme.category, snippet: theme.snippet });
    setEditor({ mode: 'edit', id: theme.id });
  };

  const closeEditor = (): void => {
    setEditor(null);
    setError(null);
  };

  const handleDelete = async (theme: PromptTheme): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(theme.id);
      if (editor !== null && editor.mode === 'edit' && editor.id === theme.id) setEditor(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReset();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave || editor === null) return;
    setBusy(true);
    setError(null);
    try {
      if (editor.mode === 'new') {
        await onCreate({ name: draftName, category: draft.category, snippet: draftSnippet });
      } else {
        await onUpdate(editor.id, {
          name: draftName,
          category: draft.category,
          snippet: draftSnippet,
        });
      }
      setEditor(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="gen-theme-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="gen-theme-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt themes"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="gen-theme-head">
          <div className="gen-theme-heading">
            <h2 className="gen-theme-title">Prompt themes</h2>
            <p className="gen-theme-subtitle">Select tags to append preset prompt chunks on generate.</p>
          </div>
          <div className="gen-theme-head-actions">
            <Button variant="secondary" size="sm" onClick={openNew} disabled={busy}>
              + New theme
            </Button>
            <button
              type="button"
              className="gen-theme-close"
              aria-label="Close prompt themes"
              title="Close"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="gen-theme-filters" role="group" aria-label="Filter themes by category">
          {FILTERS.map((option) => {
            const active = option.id === filter;
            return (
              <button
                key={option.id}
                type="button"
                className={active ? 'gen-theme-filter is-active' : 'gen-theme-filter'}
                aria-pressed={active}
                onClick={() => {
                  setFilter(option.id);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="gen-theme-body">
          {visible.length === 0 ? (
            <p className="gen-theme-empty">No themes in this category yet. Create one to fill it.</p>
          ) : (
            <ul className="gen-theme-grid" aria-label="Prompt themes">
              {visible.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  active={activeIds.has(theme.id)}
                  onToggle={() => {
                    onToggle(theme.id);
                  }}
                  onEdit={() => {
                    openEdit(theme);
                  }}
                  onDelete={() => {
                    void handleDelete(theme);
                  }}
                />
              ))}
            </ul>
          )}

          {activeThemes.length === 0 ? null : (
            <section className="gen-theme-preview" aria-label="Appended prompt preview">
              <div className="gen-theme-preview-head">
                <span className="label">Appended to your prompt</span>
                <button type="button" className="gen-theme-link" onClick={onClear}>
                  Clear all
                </button>
              </div>
              <div className="gen-theme-preview-chips">
                {activeThemes.map((theme, position) => (
                  <button
                    key={theme.id}
                    type="button"
                    className="gen-theme-chip"
                    title={`Remove ${theme.name}`}
                    onClick={() => {
                      onToggle(theme.id);
                    }}
                  >
                    <span className="gen-theme-chip-order" aria-hidden="true">
                      {position + 1}
                    </span>
                    {theme.name}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
              <p className="gen-theme-preview-text">{appended}</p>
            </section>
          )}

          {editor === null ? null : (
            <form className="gen-theme-form" onSubmit={(event) => void handleSubmit(event)}>
              <div className="gen-theme-form-head">
                <span className="label">{editor.mode === 'new' ? 'New theme' : 'Edit theme'}</span>
              </div>
              <label className="gen-theme-field">
                <span className="field-label">Name</span>
                <input
                  className="field-input"
                  ref={nameRef}
                  value={draft.name}
                  maxLength={40}
                  autoComplete="off"
                  placeholder="Retro VHS"
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, name: event.target.value }));
                  }}
                />
              </label>
              <div className="gen-theme-field">
                <span className="field-label">Category</span>
                <div className="gen-theme-cats" role="group" aria-label="Theme category">
                  {PROMPT_THEME_CATEGORIES.map((category) => {
                    const active = category === draft.category;
                    return (
                      <button
                        key={category}
                        type="button"
                        className={active ? 'gen-theme-filter is-active' : 'gen-theme-filter'}
                        aria-pressed={active}
                        onClick={() => {
                          setDraft((current) => ({ ...current, category }));
                        }}
                      >
                        {PROMPT_THEME_CATEGORY_LABELS[category]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="gen-theme-field">
                <span className="field-label">Prompt chunk</span>
                <textarea
                  className="field-textarea gen-theme-textarea"
                  rows={3}
                  maxLength={600}
                  value={draft.snippet}
                  placeholder="shot on 1990s VHS camcorder, subtle chromatic aberration, scanline softness, nostalgic flash lighting"
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, snippet: event.target.value }));
                  }}
                />
                <span className="gen-theme-count" aria-hidden="true">
                  {draft.snippet.trim().length} / 600
                </span>
              </label>
              {error === null ? null : (
                <p className="gen-hint is-error" role="alert">
                  {error}
                </p>
              )}
              <div className="gen-theme-form-actions">
                <Button variant="ghost" size="sm" onClick={closeEditor} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" variant="secondary" size="sm" busy={busy} disabled={!canSave}>
                  {editor.mode === 'new' ? 'Create theme' : 'Save theme'}
                </Button>
              </div>
            </form>
          )}

          {error === null || editor !== null ? null : (
            <p className="gen-hint is-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="gen-theme-foot">
          <Button variant="ghost" size="sm" onClick={() => void handleReset()} disabled={busy}>
            Restore defaults
          </Button>
          <div className="gen-theme-foot-right">
            {busy && editor === null ? <Spinner size={12} label="Saving themes" /> : null}
            <Button variant="secondary" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
