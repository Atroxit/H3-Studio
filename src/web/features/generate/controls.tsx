// The right inspector. Every control here is decided by ProviderCapabilities:
// a control the provider does not support becomes one quiet line of explanation,
// never a disabled field with no reason.

import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { uploadReference } from '../../api';
import { Button, Field, Slider, Spinner } from '../../components';
import type { ProviderCapabilities, SizePreset } from '../../../core/types';
import { MAX_STEPS, MIN_STEPS, type GenerationController } from './useGeneration';

export interface GenerationControlsProps {
  controller: GenerationController;
  providerLabel: string | null;
}

interface AspectGroup {
  ratio: string;
  presets: SizePreset[];
}

interface ChipOption {
  value: string;
  label: string;
  detail?: string;
}

function greatestCommonDivisor(left: number, right: number): number {
  if (right === 0) return Math.max(1, Math.abs(left));
  return greatestCommonDivisor(right, left % right);
}

function ratioOf(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '1:1';
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function groupPresetsByRatio(presets: readonly SizePreset[]): AspectGroup[] {
  const groups: AspectGroup[] = [];
  for (const preset of presets) {
    const ratio = ratioOf(preset.width, preset.height);
    const existing = groups.find((group) => group.ratio === ratio);
    if (existing === undefined) groups.push({ ratio, presets: [preset] });
    else existing.presets.push(preset);
  }
  return groups;
}

/** The first provider note that mentions one of the keywords, if any. */
function noteFor(capabilities: ProviderCapabilities, keywords: readonly string[]): string | null {
  for (const keyword of keywords) {
    const match = capabilities.notes.find((note) => note.toLowerCase().includes(keyword));
    if (match !== undefined) return match;
  }
  return null;
}

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

function QuietLine({ text }: { text: string }): ReactNode {
  return <p className="gen-quiet">{text}</p>;
}

function ChipGroup({
  legend,
  name,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
}: {
  legend: string;
  name: string;
  value: string | null;
  options: readonly ChipOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Short numeric options share one row, so they read as a scale rather than a block grid. */
  compact?: boolean;
}): ReactNode {
  return (
    <fieldset className="gen-group">
      <legend className="gen-legend">{legend}</legend>
      <div className={compact ? 'gen-chips is-compact' : 'gen-chips'}>
        {options.map((option) => (
          <label key={option.value} className="gen-chip">
            <input
              className="gen-chip-input"
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              disabled={disabled}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span className="gen-chip-body">
              <span className="gen-chip-label">{option.label}</span>
              {option.detail === undefined ? null : <span className="gen-chip-detail">{option.detail}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ControlsSkeleton(): ReactNode {
  return (
    <div className="gen-skeleton-stack">
      <p className="gen-quiet" role="status">
        Loading provider controls.
      </p>
      <span className="gen-skeleton" aria-hidden="true" />
      <span className="gen-skeleton is-tall" aria-hidden="true" />
      <span className="gen-skeleton" aria-hidden="true" />
    </div>
  );
}

export function GenerationControls({ controller, providerLabel }: GenerationControlsProps): ReactNode {
  const { capability, form } = controller;
  const aspectName = useId();
  const sizeName = useId();
  const countName = useId();
  const negativeId = useId();
  const [uploading, setUploading] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  if (providerLabel === null) {
    return <QuietLine text="No provider is enabled yet. Connect one to see its controls." />;
  }

  if (capability.phase === 'error') {
    return (
      <div className="gen-group">
        <p className="gen-quiet">{capability.error ?? 'The provider capabilities could not be loaded.'}</p>
        <Button variant="secondary" size="sm" onClick={controller.reloadCapabilities}>
          Try again
        </Button>
      </div>
    );
  }

  const capabilities = capability.capabilities;
  if (capabilities === null || capability.phase !== 'ready') return <ControlsSkeleton />;

  const multiple = Math.max(1, Math.trunc(capabilities.sizeMultiple));
  const groups = groupPresetsByRatio(capabilities.presets);
  const activeRatio = ratioOf(form.width, form.height);
  const activeGroup = groups.find((group) => group.ratio === activeRatio) ?? null;
  const visiblePresets = activeGroup === null ? capabilities.presets : activeGroup.presets;
  const activePreset = visiblePresets.find((preset) => preset.id === form.presetId) ?? null;
  const sizeInvalid = form.width < 1 || form.height < 1;

  const aspectOptions: ChipOption[] = groups.map((group) => ({ value: group.ratio, label: group.ratio }));
  const sizeOptions: ChipOption[] = visiblePresets.map((preset) => ({
    value: preset.id,
    label: preset.label,
    detail: `${preset.width} x ${preset.height}`,
  }));
  const countOptions: ChipOption[] = Array.from(
    { length: Math.max(1, Math.trunc(capabilities.maxBatch)) },
    (_unused, index) => ({ value: String(index + 1), label: String(index + 1) }),
  );

  const handleAspect = (ratio: string): void => {
    const group = groups.find((candidate) => candidate.ratio === ratio);
    const preset = group === undefined ? undefined : group.presets[0];
    if (preset !== undefined) controller.choosePreset(preset);
  };

  const handleSize = (presetId: string): void => {
    const preset = capabilities.presets.find((candidate) => candidate.id === presetId);
    if (preset !== undefined) controller.choosePreset(preset);
  };

  const handleWidth = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.valueAsNumber;
    controller.updateForm({ width: Number.isFinite(value) ? value : 0, presetId: null });
  };

  const handleHeight = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.valueAsNumber;
    controller.updateForm({ height: Number.isFinite(value) ? value : 0, presetId: null });
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setUploading(true);
    setReferenceError(null);
    try {
      let added = 0;
      for (const file of files) {
        if (form.references.length + added >= capabilities.maxReferenceImages) break;
        if (!file.type.startsWith('image/')) {
          setReferenceError('Only image files can be used as a reference.');
          continue;
        }
        const dataBase64 = await readFileAsBase64(file);
        const reference = await uploadReference({ filename: file.name, mimeType: file.type, dataBase64 });
        controller.addReference(reference);
        added += 1;
      }
    } catch (error) {
      setReferenceError(describeError(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="gen-controls">
      {capabilities.presets.length === 0 ? (
        <div className="gen-group">
          <p className="gen-legend-static">Size</p>
          <QuietLine text={noteFor(capabilities, ['size', 'resolution', 'dimension']) ?? 'This provider lists no size presets.'} />
        </div>
      ) : (
        <>
          <ChipGroup
            legend="Aspect ratio"
            name={aspectName}
            value={activeRatio}
            options={aspectOptions}
            onChange={handleAspect}
            disabled={controller.running}
          />
          <ChipGroup
            legend="Resolution"
            name={sizeName}
            value={activePreset === null ? null : activePreset.id}
            options={sizeOptions}
            onChange={handleSize}
            disabled={controller.running}
          />
        </>
      )}

      {capabilities.arbitrarySize ? (
        <div className="gen-group">
          <div className="gen-pair">
            <Field
              label="Width"
              type="number"
              inputMode="numeric"
              min={multiple}
              step={multiple}
              value={String(form.width)}
              disabled={controller.running}
              hint={`Multiples of ${multiple} px`}
              onChange={handleWidth}
            />
            <Field
              label="Height"
              type="number"
              inputMode="numeric"
              min={multiple}
              step={multiple}
              value={String(form.height)}
              disabled={controller.running}
              onChange={handleHeight}
            />
          </div>
          {sizeInvalid ? <p className="gen-quiet is-error">Width and height must be at least 1 px.</p> : null}
        </div>
      ) : (
        <div className="gen-group">
          <QuietLine
            text={noteFor(capabilities, ['size', 'resolution', 'dimension']) ?? 'This provider takes sizes from its presets only.'}
          />
        </div>
      )}

      <ChipGroup
        legend="Batch count"
        name={countName}
        value={String(form.count)}
        options={countOptions}
        onChange={(value) => controller.updateForm({ count: Number(value) })}
        disabled={controller.running}
        compact
      />

      {capabilities.seed ? (
        <div className="gen-group">
          <Field
            label="Seed"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={form.seed}
            disabled={controller.running}
            hint="Leave empty for a fresh seed per image."
            onChange={(event) => controller.updateForm({ seed: event.target.value })}
          />
        </div>
      ) : (
        <div className="gen-group">
          <QuietLine text={noteFor(capabilities, ['seed']) ?? 'This provider chooses the seed itself.'} />
        </div>
      )}

      <div className="gen-group">
        {capabilities.adjustableSteps ? (
          <Slider
            label="Steps"
            min={MIN_STEPS}
            max={MAX_STEPS}
            step={1}
            value={form.steps}
            disabled={controller.running}
            hint={`${MIN_STEPS} to ${MAX_STEPS} sampling steps.`}
            onChange={(value) => controller.updateForm({ steps: value })}
          />
        ) : (
          <QuietLine
            text={
              capabilities.fixedSteps !== null
                ? `Steps are fixed at ${capabilities.fixedSteps} by this provider.`
                : noteFor(capabilities, ['step']) ?? 'Steps are chosen by this provider.'
            }
          />
        )}
      </div>

      <div className="gen-group">
        {capabilities.guidance ? (
          <Slider
            label="Guidance"
            min={0}
            max={20}
            step={0.5}
            value={form.guidance}
            disabled={controller.running}
            hint="How closely the provider follows the prompt."
            format={(value) => value.toFixed(1)}
            onChange={(value) => controller.updateForm({ guidance: value })}
          />
        ) : (
          <QuietLine text={noteFor(capabilities, ['guidance', 'cfg']) ?? 'This provider has no guidance scale.'} />
        )}
      </div>

      <div className="gen-group">
        {capabilities.negativePrompt ? (
          <>
            <label className="gen-label" htmlFor={negativeId}>
              Negative prompt
            </label>
            <textarea
              id={negativeId}
              className="gen-textarea"
              rows={2}
              value={form.negativePrompt}
              disabled={controller.running}
              placeholder="What to leave out."
              onChange={(event) => controller.updateForm({ negativePrompt: event.target.value })}
            />
          </>
        ) : (
          <QuietLine text={noteFor(capabilities, ['negative']) ?? 'This provider has no negative prompt.'} />
        )}
      </div>

      <div className="gen-group">
        {capabilities.maxReferenceImages > 0 ? (
          <>
            <div className="gen-group-head">
              <span className="gen-legend-static">References</span>
              <span className="gen-group-count">
                {form.references.length} of {capabilities.maxReferenceImages}
              </span>
            </div>
            <ul className="gen-ref-list">
              {form.references.map((reference) => (
                <li key={reference.id} className="gen-ref">
                  <span className="gen-ref-name" title={reference.filename}>
                    {reference.filename}
                  </span>
                  <button
                    type="button"
                    className="gen-ref-remove"
                    disabled={controller.running}
                    aria-label={`Remove reference ${reference.filename}`}
                    onClick={() => controller.removeReference(reference.id)}
                  >
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M7 7l10 10M17 7L7 17" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            {form.references.length >= capabilities.maxReferenceImages ? null : (
              <label className="gen-ref-add">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  disabled={uploading || controller.running}
                  aria-label="Add reference images"
                  onChange={(event) => {
                    void handleFiles(event);
                  }}
                />
                <span className="gen-ref-add-icon" aria-hidden="true">
                  {uploading ? <Spinner size={12} label="" /> : (
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M12 5.5v13M5.5 12h13" />
                    </svg>
                  )}
                </span>
                <span className="gen-ref-add-text">{uploading ? 'Uploading' : 'Add image'}</span>
              </label>
            )}
            {referenceError === null ? null : <p className="gen-quiet is-error">{referenceError}</p>}
          </>
        ) : (
          <QuietLine
            text={noteFor(capabilities, ['reference', 'image input', 'edit']) ?? 'This provider does not accept reference images.'}
          />
        )}
      </div>

      {capabilities.streamingProgress ? null : (
        <div className="gen-group">
          <QuietLine text="This provider reports progress only when each image finishes." />
        </div>
      )}

      {capabilities.notes.length === 0 ? null : (
        <section className="gen-group" aria-label="Provider notes">
          <span className="gen-legend-static">Provider notes</span>
          <ul className="gen-notes">
            {capabilities.notes.map((note, index) => (
              <li key={`${index}-${note}`} className="gen-quiet">
                {note}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
