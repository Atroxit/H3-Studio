// Presets: a small form that saves the values a composer would send, a list of
// saved presets, and an apply and delete per row. Applying a preset fills the
// Generate composer and switches to that view.

import { useCallback, useId, useState, type ReactNode } from 'react';
import type { Preset } from '../../../core/types';
import { createPreset, deletePreset, ApiError } from '../../api';
import { useStudio } from '../../App';
import { Button, Field } from '../../components';
import { formatCount, promptExcerpt } from './useLibrary';

/** Matches the server schema in src/server/app.ts. */
const MIN_SIZE = 64;
const MAX_SIZE = 8192;
const MAX_COUNT = 10;
const MAX_NAME = 120;
const MAX_PROMPT = 4000;

export interface PresetForm {
  name: string;
  prompt: string;
  width: string;
  height: string;
  count: string;
}

export interface PresetFormErrors {
  name?: string;
  prompt?: string;
  width?: string;
  height?: string;
  count?: string;
}

const EMPTY_FORM: PresetForm = { name: '', prompt: '', width: '1024', height: '1024', count: '1' };

function parseWhole(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** Checks the form against the same limits the server enforces, before sending it. */
export function validatePresetForm(form: PresetForm): {
  input: Omit<Preset, 'id' | 'createdAt'> | null;
  errors: PresetFormErrors;
} {
  const errors: PresetFormErrors = {};
  const name = form.name.trim();
  const prompt = form.prompt.trim();

  if (name.length === 0) errors.name = 'Give the preset a name.';
  else if (name.length > MAX_NAME) errors.name = `Keep the name under ${MAX_NAME} characters.`;

  if (prompt.length > MAX_PROMPT) errors.prompt = `Keep the prompt under ${MAX_PROMPT} characters.`;

  const width = parseWhole(form.width);
  if (width === null || width < MIN_SIZE || width > MAX_SIZE) {
    errors.width = `Width must be ${MIN_SIZE} to ${MAX_SIZE}.`;
  }
  const height = parseWhole(form.height);
  if (height === null || height < MIN_SIZE || height > MAX_SIZE) {
    errors.height = `Height must be ${MIN_SIZE} to ${MAX_SIZE}.`;
  }
  const count = parseWhole(form.count);
  if (count === null || count < 1 || count > MAX_COUNT) {
    errors.count = `Count must be 1 to ${MAX_COUNT}.`;
  }

  if (width === null || height === null || count === null) return { input: null, errors };
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return { input: { name, prompt, width, height, count }, errors };
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The studio server did not answer.';
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

interface PresetStatus {
  tone: 'ok' | 'error';
  message: string;
}

export function PresetsPanel(): ReactNode {
  const { presets, refresh, applyPreset } = useStudio();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PresetForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<PresetFormErrors>({});
  const [status, setStatus] = useState<PresetStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const headingId = useId();
  const promptId = useId();
  const promptErrorId = `${promptId}-error`;

  const setField = useCallback((key: keyof PresetForm, value: string): void => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (saving) return;
    const result = validatePresetForm(form);
    setErrors(result.errors);
    if (result.input === null) return;

    setSaving(true);
    setStatus(null);
    try {
      const saved = await createPreset(result.input);
      await refresh();
      setForm((current) => ({ ...current, name: '', prompt: '' }));
      setFormOpen(false);
      setStatus({ tone: 'ok', message: `Saved the preset "${saved.name}".` });
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setSaving(false);
    }
  }, [form, refresh, saving]);

  const remove = useCallback(
    async (preset: Preset): Promise<void> => {
      if (deletingId !== null) return;
      setDeletingId(preset.id);
      setStatus(null);
      try {
        await deletePreset(preset.id);
        await refresh();
        setStatus({ tone: 'ok', message: `Deleted the preset "${preset.name}".` });
      } catch (error) {
        setStatus({ tone: 'error', message: describeError(error) });
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, refresh],
  );

  return (
    <section className="lb-presets" aria-labelledby={headingId}>
      <header className="lb-presets-head">
        <h3 className="lb-presets-title" id={headingId}>
          Presets
        </h3>
        <span className="lb-presets-count">{presets.length}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={formOpen}
          onClick={() => {
            setFormOpen(!formOpen);
            setErrors({});
          }}
        >
          {formOpen ? 'Close form' : 'New preset'}
        </Button>
      </header>

      {formOpen ? (
        <form
          className="lb-preset-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label="Preset name"
            value={form.name}
            placeholder="Blue hour, four wide"
            autoComplete="off"
            error={errors.name}
            onChange={(event) => {
              setField('name', event.target.value);
            }}
          />
          <div className="field">
            <label className="field-label" htmlFor={promptId}>
              Prompt
            </label>
            <textarea
              id={promptId}
              className="field-textarea lb-preset-prompt-input"
              rows={3}
              value={form.prompt}
              placeholder="The prompt to save with this preset"
              autoComplete="off"
              aria-invalid={errors.prompt === undefined ? undefined : true}
              aria-describedby={errors.prompt === undefined ? undefined : promptErrorId}
              onChange={(event) => {
                setField('prompt', event.target.value);
              }}
            />
            <span className="field-hint">Optional. Applying the preset fills this prompt into the composer.</span>
            {errors.prompt === undefined ? null : (
              <span className="field-error" id={promptErrorId}>
                {errors.prompt}
              </span>
            )}
          </div>
          <div className="lb-preset-grid">
            <Field
              label="Width"
              type="number"
              inputMode="numeric"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={1}
              value={form.width}
              error={errors.width}
              onChange={(event) => {
                setField('width', event.target.value);
              }}
            />
            <Field
              label="Height"
              type="number"
              inputMode="numeric"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={1}
              value={form.height}
              error={errors.height}
              onChange={(event) => {
                setField('height', event.target.value);
              }}
            />
            <Field
              label="Count"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_COUNT}
              step={1}
              value={form.count}
              error={errors.count}
              hint={`Up to ${MAX_COUNT}`}
              onChange={(event) => {
                setField('count', event.target.value);
              }}
            />
          </div>
          <div className="lb-preset-actions">
            <Button type="submit" variant="primary" size="sm" busy={saving}>
              Save preset
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setFormOpen(false);
                setErrors({});
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {presets.length === 0 ? (
        <p className="lb-presets-empty">No presets yet. Save a size and prompt you reuse.</p>
      ) : (
        <ul className="lb-presets-list">
          {presets.map((preset) => (
            <li key={preset.id} className="lb-preset">
              <div className="lb-preset-copy">
                <span className="lb-preset-name">{preset.name}</span>
                <span className="lb-preset-meta">
                  {preset.width} x {preset.height} / {formatCount(preset.count, 'image', 'images')}
                </span>
                <span className="lb-preset-prompt">
                  {preset.prompt.trim().length === 0 ? 'No prompt saved' : promptExcerpt(preset.prompt, 12)}
                </span>
              </div>
              <div className="lb-preset-row-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    applyPreset(preset);
                  }}
                >
                  Apply
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  busy={deletingId === preset.id}
                  disabled={deletingId !== null && deletingId !== preset.id}
                  onClick={() => {
                    void remove(preset);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === null ? null : (
        <p className={status.tone === 'ok' ? 'lb-presets-status is-ok' : 'lb-presets-status is-error'} role="status">
          {status.message}
        </p>
      )}
    </section>
  );
}
