// The right inspector. Every control here is decided by ProviderCapabilities: a control the
// provider does not support becomes one quiet line of explanation, never a disabled field with
// no reason. The layout is one compact column of horizontal segmented bars, so the whole
// inspector fits a 1080p window without scrolling.

import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { getSystemProfile } from '../../api';
import { Button, Slider, VramLedMeter } from '../../components';
import type { ProviderCapabilities, SizePreset } from '../../../core/types';
import {
  SIZE_TIER_DETAILS,
  SIZE_TIER_LABELS,
  ratioOf,
  seedProblem,
  sizeProblem,
  tieredPresetsForRatio,
} from './helpers';
import { MAX_STEPS, MIN_STEPS, type GenerationController } from './useGeneration';
import { estimateVram, formatVramGb } from './vram';

interface HardwareSummary {
  gpuVramGb: number | null;
  systemRamGb: number | null;
}

/**
 * One hardware read per session: the inspector mounts on every tab switch, but the GPU does
 * not change. A failed or missing profile stays silent so the bar falls back to its estimate.
 */
let hardwarePromise: Promise<HardwareSummary> | null = null;

function loadHardware(): Promise<HardwareSummary> {
  hardwarePromise ??= getSystemProfile()
    .then((profile) => ({ gpuVramGb: profile.gpu.vramGb, systemRamGb: profile.ramTotalGb }))
    .catch((): HardwareSummary => ({ gpuVramGb: null, systemRamGb: null }));
  return hardwarePromise;
}

export interface GenerationControlsProps {
  controller: GenerationController;
  providerLabel: string | null;
}

interface AspectGroup {
  ratio: string;
  presets: SizePreset[];
}

interface SegmentedOption {
  value: string;
  label: string;
  /** The micro line under the label: Draft, 4MP, Hero, Fast, Max. */
  detail?: string;
  /** The full explanation a hover or focus reveals. */
  title?: string;
}

/** The prompt enhancer choices, cheapest first. */
const PROMPT_ENHANCER_OPTIONS: readonly SegmentedOption[] = [
  { value: 'off', label: 'Off', title: 'Use your exact prompt as written' },
  {
    value: 'qwen3.5_9b',
    label: '9B',
    title: 'Fast (Qwen3.5 9B) — Quick art-direction expansion (+15–20s)',
  },
  {
    value: 'qwen3.8_27b',
    label: '27B',
    title: 'Best (Qwen3.8 27B H3 PE) — Dedicated 27B H3 enhancer for richest detail (+30–45s)',
  },
];

/** The two official H3 diffusion models, fast weights first. */
const MODEL_PRECISION_OPTIONS: readonly SegmentedOption[] = [
  {
    value: 'w4a8',
    label: 'W4A8',
    detail: 'Fast',
    title: 'Fast (W4A8, 11.7 GB) — Fits 100% in 24 GB VRAM with zero offloading',
  },
  {
    value: 'int8_convrot',
    label: 'INT8',
    detail: 'Max',
    title: 'Max quality (INT8 ConvRot, 19.5 GB) — 8-bit weights for maximum micro-texture and text fidelity',
  },
];

/** The two official 32B Qwen3-VL H3 text encoders, the smaller NVFP4 build first. */
const TEXT_ENCODER_OPTIONS: readonly SegmentedOption[] = [
  {
    value: 'nvfp4',
    label: 'NVFP4',
    detail: 'Fast',
    title: 'Fast (NVFP4, 14.6 GB) — Fits 100% in 24 GB VRAM with zero CPU offload',
  },
  {
    value: 'int8',
    label: 'INT8',
    detail: 'Max',
    title: 'Max quality (INT8 ConvRot, 25.3 GB) — Full 8-bit Qwen3-VL 32B text & vision encoder',
  },
];

/** A preset as a scannable tile: the H3 class on top, the character of it underneath. */
function presetShort(preset: SizePreset): { label: string; detail?: string } {
  const longest = Math.max(preset.width, preset.height);
  if (!Number.isFinite(longest) || longest <= 0) return { label: preset.label };
  if (longest <= 1280) return { label: '1K', detail: 'Draft' };
  if (longest <= 2560) return { label: '2K', detail: '4MP' };
  return { label: '4K', detail: 'Hero' };
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

function QuietLine({ text }: { text: string }): ReactNode {
  return <p className="gen-quiet">{text}</p>;
}

/** Section heading with an instant darkroom hover/focus tooltip explaining what the control does. */
function SectionTitle({
  label,
  tip,
  above = false,
}: {
  label: string;
  tip: string;
  above?: boolean;
}): ReactNode {
  const tipId = useId();
  return (
    <div className="gen-section-head">
      <h3 className="gen-section-title" tabIndex={0} aria-describedby={tipId}>
        <span className="gen-section-title-text">{label}</span>
        <span id={tipId} role="tooltip" className={above ? 'gen-tip is-above' : 'gen-tip'}>
          {tip}
        </span>
      </h3>
    </div>
  );
}

/** One horizontal segmented track: native radios, so arrow keys work as they always did. */
function SegmentedField({
  legend,
  name,
  value,
  options,
  onChange,
  onOptionActivate,
  disabled = false,
  fixedColumns = false,
}: {
  legend: string;
  name: string;
  value: string | null;
  options: readonly SegmentedOption[];
  onChange: (value: string) => void;
  /** Runs on any option click, including the one already checked. */
  onOptionActivate?: () => void;
  disabled?: boolean;
  /** Five equal columns for the aspect row, instead of the wrapping flex fallback. */
  fixedColumns?: boolean;
}): ReactNode {
  return (
    // The section title is already on screen, so the fieldset carries its name for
    // assistive tech instead of printing the same word twice.
    <fieldset className="gen-field" aria-label={legend}>
      <div className={fixedColumns ? 'gen-seg is-fixed' : 'gen-seg'}>
        {options.map((option) => (
          <label
            key={option.value}
            className="gen-seg-option"
            title={option.title}
            onClick={onOptionActivate}
          >
            <input
              className="gen-seg-input"
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              disabled={disabled}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span className="gen-seg-body">
              <span className="gen-seg-label">{option.label}</span>
              {option.detail === undefined ? null : (
                <span className="gen-seg-detail">{option.detail}</span>
              )}
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
  const widthId = useId();
  const heightId = useId();
  const enhancerName = useId();
  const precisionName = useId();
  const encoderName = useId();
  const [hardware, setHardware] = useState<HardwareSummary | null>(null);
  // The width and height fields are an explicit choice: a matching preset closes them again.
  const [customSizeOpen, setCustomSizeOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void loadHardware().then((summary) => {
      if (active) setHardware(summary);
    });
    return () => {
      active = false;
    };
  }, []);

  if (providerLabel === null) {
    return <QuietLine text="No provider is enabled yet. Connect one to see its controls." />;
  }

  if (capability.phase === 'error') {
    return (
      <div className="gen-section">
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
  // A ratio with a single 16 MP provider preset still offers the cheaper tiers, so the
  // inspector never shrinks to one hero size plus Custom.
  const presetsForRatio = (group: AspectGroup): SizePreset[] =>
    tieredPresetsForRatio(group.presets, group.ratio, multiple, capabilities.arbitrarySize);
  const visiblePresets = activeGroup === null ? capabilities.presets : presetsForRatio(activeGroup);
  // Synthesized tiers keep the 1K/2K/4K names they were built for, whatever their longest side.
  const tieredActive = capabilities.arbitrarySize && activeGroup !== null;
  const activePreset = visiblePresets.find((preset) => preset.id === form.presetId) ?? null;
  const sizeIssue = sizeProblem(form.width, form.height);
  const sizeInvalid = sizeIssue !== null;
  const seedIssue = seedProblem(form.seed);
  // A canvas that names no preset is a custom one, so the fields open without a click.
  const showCustomSize = capabilities.arbitrarySize && (customSizeOpen || activePreset === null);

  const vram = estimateVram({
    width: form.width,
    height: form.height,
    modelVariant: form.modelVariant,
    textEncoderVariant: form.textEncoderVariant,
    promptEnhancer: form.promptEnhancer,
    referenceCount: form.references.length,
    gpuVramGb: hardware === null ? null : hardware.gpuVramGb,
    systemRamGb: hardware === null ? null : hardware.systemRamGb,
  });

  const aspectOptions: SegmentedOption[] = groups.map((group) => ({ value: group.ratio, label: group.ratio }));
  const sizeOptions: SegmentedOption[] = visiblePresets.map((preset, index) => {
    const tier = tieredActive ? SIZE_TIER_LABELS[index] : undefined;
    return {
      value: preset.id,
      ...(tier === undefined ? presetShort(preset) : { label: tier, detail: SIZE_TIER_DETAILS[tier] }),
      title: `${preset.width} × ${preset.height} — ${preset.label}`,
    };
  });
  // Four counts at most, plus whatever larger count the form already holds, so nothing hides.
  const countLimit = Math.min(4, Math.max(1, Math.trunc(capabilities.maxBatch)));
  const countValues = Array.from({ length: countLimit }, (_unused, index) => index + 1);
  if (!countValues.includes(form.count)) countValues.push(form.count);
  countValues.sort((left, right) => left - right);

  // Unsupported sampling options compress into one muted line under the enhancer.
  const fixedSummary = [
    ...(capabilities.adjustableSteps
      ? []
      : [capabilities.fixedSteps !== null ? `${capabilities.fixedSteps} steps fixed` : 'Auto steps']),
    ...(capabilities.guidance ? [] : ['No guidance']),
    ...(capabilities.negativePrompt ? [] : ['No negative prompt']),
  ].join(' · ');

  const sizeEmptyNote =
    capabilities.presets.length === 0
      ? noteFor(capabilities, ['size', 'resolution', 'dimension'])
      : null;
  const sizeFixedNote =
    capabilities.presets.length > 0 && !capabilities.arbitrarySize
      ? noteFor(capabilities, ['size', 'resolution', 'dimension'])
      : null;
  const seedNote = capabilities.seed ? null : noteFor(capabilities, ['seed']);

  const handleAspect = (ratio: string): void => {
    const group = groups.find((candidate) => candidate.ratio === ratio);
    if (group === undefined) return;
    const presets = presetsForRatio(group);
    // Keep the tier the user is already on, so switching ratio changes shape and not cost.
    const activeTier = tieredActive ? visiblePresets.findIndex((preset) => preset.id === form.presetId) : -1;
    const wantedTier = activeTier >= 0 ? activeTier : Math.min(1, presets.length - 1);
    const preset = presets[wantedTier] ?? presets[0];
    if (preset !== undefined) controller.choosePreset(preset);
  };

  const handleSize = (presetId: string): void => {
    // A synthesized tier is not in capabilities.presets, so the visible list comes first.
    const preset = visiblePresets.find((candidate) => candidate.id === presetId);
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

  return (
    <div className="gen-controls">
      {capabilities.presets.length === 0 ? (
        <section className="gen-section">
          <SectionTitle
            label="Resolution"
            tip="Output pixel size. Higher resolutions add fine detail but use more VRAM and take longer."
          />
          <QuietLine text={sizeEmptyNote ?? 'This provider lists no size presets.'} />
        </section>
      ) : (
        <>
          <section className="gen-section">
            <SectionTitle
              label="Aspect ratio"
              tip="Frame shape (width vs. height). Switching keeps your current resolution tier."
            />
            <SegmentedField
              legend="Aspect ratio"
              name={aspectName}
              value={activeRatio}
              options={aspectOptions}
              onChange={handleAspect}
              onOptionActivate={() => setCustomSizeOpen(false)}
              disabled={controller.running}
              fixedColumns={aspectOptions.length === 5}
            />
          </section>

          <section className="gen-section">
            <SectionTitle
              label="Resolution"
              tip="Output pixel size. 2K (4 MP) is H3's sweet spot; 4K (16 MP) adds micro-detail at higher VRAM and time cost."
            />
            <fieldset className="gen-field" aria-label="Resolution">
              <div className="gen-seg">
                {sizeOptions.map((option) => (
                  <label
                    key={option.value}
                    className="gen-seg-option"
                    title={option.title}
                    onClick={() => setCustomSizeOpen(false)}
                  >
                    <input
                      className="gen-seg-input"
                      type="radio"
                      name={sizeName}
                      value={option.value}
                      checked={option.value === (activePreset === null ? '' : activePreset.id)}
                      disabled={controller.running}
                      onChange={() => handleSize(option.value)}
                    />
                    <span className="gen-seg-body">
                      <span className="gen-seg-label">{option.label}</span>
                      {option.detail === undefined ? null : (
                        <span className="gen-seg-detail">{option.detail}</span>
                      )}
                    </span>
                  </label>
                ))}
                {capabilities.arbitrarySize ? (
                  <button
                    type="button"
                    className={showCustomSize ? 'gen-seg-btn is-active' : 'gen-seg-btn'}
                    aria-pressed={showCustomSize}
                    title="Set an exact width and height"
                    disabled={controller.running}
                    onClick={() => {
                      setCustomSizeOpen(true);
                      // Custom is a mode, so no preset stays marked as the chosen one.
                      if (form.presetId !== null) controller.updateForm({ presetId: null });
                    }}
                  >
                    <span className="gen-seg-label">Custom</span>
                  </button>
                ) : null}
              </div>
            </fieldset>

            {showCustomSize ? (
              <div className="gen-size-custom">
                <div className="gen-pair">
                  <label className="gen-num-field" htmlFor={widthId}>
                    <span className="gen-label">Width</span>
                    <input
                      id={widthId}
                      className="field-input gen-num"
                      type="number"
                      inputMode="numeric"
                      min={64}
                      max={8192}
                      step={multiple}
                      value={String(form.width)}
                      disabled={controller.running}
                      aria-invalid={sizeInvalid ? true : undefined}
                      onChange={handleWidth}
                    />
                  </label>
                  <label className="gen-num-field" htmlFor={heightId}>
                    <span className="gen-label">Height</span>
                    <input
                      id={heightId}
                      className="field-input gen-num"
                      type="number"
                      inputMode="numeric"
                      min={64}
                      max={8192}
                      step={multiple}
                      value={String(form.height)}
                      disabled={controller.running}
                      aria-invalid={sizeInvalid ? true : undefined}
                      onChange={handleHeight}
                    />
                  </label>
                </div>
                <p className="gen-hint">Multiples of {multiple} px (64–8192)</p>
                {sizeIssue === null ? null : <p className="gen-hint is-error">{sizeIssue}</p>}
              </div>
            ) : null}

            {capabilities.arbitrarySize ? null : (
              <QuietLine text={sizeFixedNote ?? 'This provider takes sizes from its presets only.'} />
            )}
          </section>
        </>
      )}

      <section className="gen-section">
        <SectionTitle
          label="Batch & seed"
          tip="How many images to generate per click, plus an optional seed number to reproduce the exact same result."
        />
        <div className="gen-field">
          <p className="gen-legend" aria-hidden="true">
            Images
          </p>
          <fieldset className="gen-field gen-batch-count" aria-label="Images">
            <div className="gen-seg is-fixed">
              {countValues.map((value) => (
                <label key={value} className="gen-seg-option" title={`${value} ${value === 1 ? 'image' : 'images'}`}>
                  <input
                    className="gen-seg-input"
                    type="radio"
                    name={countName}
                    value={String(value)}
                    checked={form.count === value}
                    disabled={controller.running}
                    onChange={() => controller.updateForm({ count: value })}
                  />
                  <span className="gen-seg-body is-single">
                    <span className="gen-seg-label">{value}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {capabilities.seed ? (
          <div className="gen-field">
            <label className="gen-label" htmlFor={`${countName}-seed`}>
              Seed
            </label>
            <input
              id={`${countName}-seed`}
              className="field-input gen-num"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              placeholder="Random"
              aria-label="Seed"
              title="Leave empty for a fresh seed per image"
              value={form.seed}
              disabled={controller.running}
              aria-invalid={seedIssue === null ? undefined : true}
              onChange={(event) => controller.updateForm({ seed: event.target.value })}
            />
            <p className="gen-hint">Empty means a fresh random seed per image.</p>
          </div>
        ) : (
          <QuietLine text={seedNote ?? 'This provider chooses the seed itself.'} />
        )}
        {seedIssue === null ? null : <p className="gen-hint is-error">{seedIssue}</p>}
      </section>

      <section className="gen-section">
        <SectionTitle
          label="Model"
          tip="The diffusion model that draws the image. W4A8 is faster and lighter; INT8 keeps finer texture and text."
        />
        <SegmentedField
          legend="Model precision"
          name={precisionName}
          value={form.modelVariant}
          options={MODEL_PRECISION_OPTIONS}
          disabled={controller.running}
          onChange={(value) =>
            controller.updateForm({ modelVariant: value === 'int8_convrot' ? 'int8_convrot' : 'w4a8' })
          }
        />
      </section>

      <section className="gen-section">
        <SectionTitle
          label="Encoder"
          tip="Reads your prompt and reference images and translates them into guidance for the model. NVFP4 fits in 24 GB VRAM; INT8 is larger and offloads to RAM."
          above
        />
        <SegmentedField
          legend="Text encoder"
          name={encoderName}
          value={form.textEncoderVariant}
          options={TEXT_ENCODER_OPTIONS}
          disabled={controller.running}
          onChange={(value) =>
            controller.updateForm({ textEncoderVariant: value === 'nvfp4' ? 'nvfp4' : 'int8' })
          }
        />
      </section>

      <section className="gen-section">
        <SectionTitle
          label="Enhancer"
          tip="Optional language model that rewrites and expands your prompt before generation. Turn Off to send your exact wording."
          above
        />
        <SegmentedField
          legend="Prompt enhancer"
          name={enhancerName}
          value={form.promptEnhancer}
          options={PROMPT_ENHANCER_OPTIONS}
          disabled={controller.running}
          onChange={(value) =>
            controller.updateForm({
              promptEnhancer: value === 'qwen3.5_9b' || value === 'qwen3.8_27b' ? value : 'off',
            })
          }
        />

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
        ) : null}
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
        ) : null}
        {capabilities.negativePrompt ? (
          <div className="field">
            <label className="gen-label" htmlFor={negativeId}>
              Negative prompt
            </label>
            <textarea
              id={negativeId}
              className="field-textarea gen-textarea"
              rows={2}
              value={form.negativePrompt}
              disabled={controller.running}
              placeholder="What to leave out."
              onChange={(event) => controller.updateForm({ negativePrompt: event.target.value })}
            />
          </div>
        ) : null}
        {fixedSummary.length === 0 ? null : <p className="gen-fixed-meta">{fixedSummary}</p>}
      </section>

      <div className="gen-vram">
        <div className="gen-vram-head">
          <span className="gen-vram-label" tabIndex={0}>
            <span className="gen-section-title-text">Est. VRAM</span>
            <span role="tooltip" className="gen-tip is-above">
              Estimated peak GPU memory across H3&apos;s sequential stages (enhancer, encoder, then diffusion — never all at once). {vram.breakdownTitle}
            </span>
          </span>
          <span className="gen-vram-value">
            {vram.gpuVramGb === null
              ? `~${vram.peakGb.toFixed(1)} GB`
              : `~${vram.peakGb.toFixed(1)} / ${formatVramGb(vram.gpuVramGb)} GB`}
          </span>
        </div>
        <VramLedMeter
          fillPercent={vram.fillPercent}
          status={vram.status}
          value={vram.peakGb}
          max={vram.gpuVramGb ?? 24}
          label="Estimated peak VRAM"
          size="sm"
        />
        <div className="gen-vram-foot">
          <span className="gen-vram-peak">Peak: {vram.peakStage.label}</span>
          <span className={`gen-vram-status is-${vram.status}`}>{vram.statusLabel}</span>
        </div>
      </div>
    </div>
  );
}
