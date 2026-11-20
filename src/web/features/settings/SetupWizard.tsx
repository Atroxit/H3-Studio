// The three step Setup Wizard: measure the machine, check the model files, then apply the
// tuned profile. Every number shown here came from the server's detection, so the wizard
// never guesses about the hardware it is running on.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ModelCatalogEntry, ProviderConfig, SystemProfile } from '../../../core/types';
import { applySystemProfile, type ApplySystemProfileResponse } from '../../api';
import { Button, Spinner, VramLedMeter } from '../../components';
import { useStudio } from '../../studio';
import { applyStudioDefaults } from '../generate/useGeneration';
import { estimateVram, formatVramGb } from '../generate/vram';
import {
  describeError,
  formatGigabytes,
  installedModelCount,
  MODEL_ROLE_LABELS,
  modelsByRole,
  modelPrecisionLabel,
  promptEnhancerLabel,
  sizeLabel,
  textEncoderLabel,
  tierHeadline,
  vendorLabel,
} from './helpers';

export interface SetupWizardProps {
  profile: SystemProfile | null;
  scanning: boolean;
  scanError: string | null;
  canClose: boolean;
  onRescan: () => Promise<void>;
  onProfile: (profile: SystemProfile) => void;
  onClose: () => void;
}

type StepId = 1 | 2 | 3;

const STEPS: readonly { id: StepId; label: string }[] = [
  { id: 1, label: 'Hardware Scan' },
  { id: 2, label: 'Model Checklist' },
  { id: 3, label: 'Auto-Tune & Apply' },
];

const MIN_RESERVE_GB = 2;
const MAX_RESERVE_GB = 8;

/** The ComfyUI provider a profile apply targets: an enabled one first, then any. */
export function comfyProviderIdOf(providers: readonly ProviderConfig[]): string | null {
  const comfy = providers.filter((provider) => provider.kind === 'comfyui');
  const chosen = comfy.find((provider) => provider.enabled !== false) ?? comfy[0];
  return chosen === undefined ? null : chosen.id;
}

function CheckIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5.5 12.5l4 4 9-9" />
    </svg>
  );
}

function CopyIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="10.5" height="10.5" rx="2" />
      <path d="M15 9V6.5a2 2 0 00-2-2H6.5a2 2 0 00-2 2V13a2 2 0 002 2H9" />
    </svg>
  );
}

function DownloadIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4.5v10M8 11l4 4 4-4M5.5 19.5h13" />
    </svg>
  );
}

function StepIndicator({
  step,
  locked,
  onSelect,
}: {
  step: StepId;
  /** True while there is no measurement: only step one can be entered. */
  locked: boolean;
  onSelect: (step: StepId) => void;
}): ReactNode {
  return (
    <ol className="sw-steps">
      {STEPS.map((entry, index) => {
        const active = entry.id === step;
        const done = entry.id < step;
        const disabled = locked && entry.id !== 1;
        const className = [
          'sw-step',
          active ? 'is-active' : '',
          done ? 'is-done' : '',
        ]
          .filter((part) => part.length > 0)
          .join(' ');
        return (
          <li key={entry.id} className="sw-step-item">
            <button
              type="button"
              className={className}
              aria-current={active ? 'step' : undefined}
              disabled={disabled}
              onClick={() => {
                onSelect(entry.id);
              }}
            >
              <span className="sw-step-number" aria-hidden="true">
                {done ? <CheckIcon /> : entry.id}
              </span>
              <span className="sw-step-label">
                {entry.id}. {entry.label}
              </span>
            </button>
            {index === STEPS.length - 1 ? null : <span className="sw-step-line" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function SpecCard({
  label,
  value,
  meta,
  badge,
  badgeTone = 'muted',
}: {
  label: string;
  value: string;
  meta: string;
  badge: string;
  badgeTone?: 'muted' | 'ok' | 'warn' | 'accent';
}): ReactNode {
  return (
    <div className="sw-spec">
      <span className="sw-spec-label">{label}</span>
      <span className="sw-spec-value" title={value}>
        {value}
      </span>
      <span className="sw-spec-meta">{meta}</span>
      <span className={`sw-badge is-${badgeTone}`}>{badge}</span>
    </div>
  );
}

function ModelRow({
  entry,
  onCopy,
  copied,
}: {
  entry: ModelCatalogEntry;
  onCopy: (entry: ModelCatalogEntry) => void;
  copied: boolean;
}): ReactNode {
  const stateClass = entry.installed ? 'is-installed' : entry.recommended ? 'is-recommended' : 'is-missing';
  return (
    <li className="sw-model">
      <div className="sw-model-main">
        <span className="sw-model-label">
          {entry.label}
          {entry.recommended ? <span className="sw-model-pick">Recommended</span> : null}
        </span>
        <span className="sw-model-file">{entry.filename}</span>
        <span className="sw-model-note">{entry.note}</span>
      </div>
      <div className="sw-model-figures">
        <span className="sw-model-size">{entry.sizeGb.toFixed(entry.sizeGb < 10 ? 2 : 1)} GB</span>
        <span className={entry.fitsVram ? 'sw-badge is-ok' : 'sw-badge is-warn'}>
          {entry.fitsVram ? 'Fits in VRAM' : 'Offloads to RAM'}
        </span>
      </div>
      <div className="sw-model-state">
        <span className={`sw-badge ${stateClass}`}>
          {entry.installed ? 'Installed' : entry.tier === 'required' ? 'Required' : 'Not installed'}
        </span>
        {entry.installed ? null : (
          <span className="sw-model-target">{entry.targetSubdir}/</span>
        )}
      </div>
      {entry.installed ? null : (
        <div className="sw-model-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onCopy(entry);
            }}
          >
            <CopyIcon />
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
          <a className="sw-download" href={entry.downloadUrl} target="_blank" rel="noreferrer">
            <DownloadIcon />
            Download
          </a>
        </div>
      )}
    </li>
  );
}

export function SetupWizard({
  profile,
  scanning,
  scanError,
  canClose,
  onRescan,
  onProfile,
  onClose,
}: SetupWizardProps): ReactNode {
  const studio = useStudio();
  const [step, setStep] = useState<StepId>(1);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [reserveVramGb, setReserveVramGb] = useState<number | null>(null);
  const [disablePinnedMemory, setDisablePinnedMemory] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplySystemProfileResponse | null>(null);
  // A fresh scan replaces the overrides with what the new measurement recommends. A profile
  // that comes back from an apply keeps its timestamp, so the success banner survives it.
  const syncedStamp = useRef<string | null>(null);

  useEffect(() => {
    if (profile === null) return;
    if (syncedStamp.current === profile.detectedAt) return;
    syncedStamp.current = profile.detectedAt;
    setReserveVramGb(profile.recommended.reserveVramGb);
    setDisablePinnedMemory(profile.recommended.disablePinnedMemory);
    setApplied(null);
    setApplyError(null);
  }, [profile]);

  const reserve = reserveVramGb ?? (profile === null ? MIN_RESERVE_GB : profile.recommended.reserveVramGb);

  const copyUrl = useCallback(
    async (entry: ModelCatalogEntry): Promise<void> => {
      try {
        await navigator.clipboard.writeText(entry.downloadUrl);
        setCopiedUrl(entry.downloadUrl);
        studio.notify(`${entry.label} URL copied.`);
      } catch {
        studio.notify('The URL could not be copied.', 'error');
      }
    },
    [studio],
  );

  const apply = useCallback(async (): Promise<void> => {
    const targetProviderId = comfyProviderIdOf(studio.providers);
    setApplying(true);
    setApplyError(null);
    try {
      const response = await applySystemProfile({
        ...(targetProviderId === null ? {} : { providerId: targetProviderId }),
        reserveVramGb: reserve,
        disablePinnedMemory,
      });
      // The tuned defaults reach the live composer before the banner appears, so the
      // Generate screen already shows what this machine was set up for.
      applyStudioDefaults(response.applied);
      onProfile(response.profile);
      setApplied(response);
      await studio.refresh();
      studio.notify('Optimal settings applied.');
    } catch (error) {
      setApplyError(describeError(error));
    } finally {
      setApplying(false);
    }
  }, [disablePinnedMemory, onProfile, reserve, studio]);

  const totalModels = profile === null ? 0 : profile.models.length;
  const installedModels = profile === null ? 0 : installedModelCount(profile.models);
  const locked = profile === null;
  const targetProviderId = comfyProviderIdOf(studio.providers);
  // Step three's budget preview: the same pure estimator the Generate rail uses, pinned to the
  // profile the wizard is about to write, so the user sees the fit before applying it.
  const vram =
    step === 3 && profile !== null
      ? estimateVram({
          width: profile.recommended.width,
          height: profile.recommended.height,
          modelVariant: profile.recommended.modelVariant,
          textEncoderVariant: profile.recommended.textEncoderVariant,
          promptEnhancer: profile.recommended.promptEnhancer,
          referenceCount: 0,
          gpuVramGb: profile.gpu.vramGb,
          systemRamGb: profile.ramTotalGb,
        })
      : null;

  return (
    <div className="sw">
      <StepIndicator step={step} locked={locked} onSelect={setStep} />

      {step === 1 ? (
        <section className="sw-panel" aria-labelledby="sw-step-1">
          <header className="sw-panel-head">
            <div>
              <h2 className="sw-panel-title" id="sw-step-1">
                Hardware scan
              </h2>
              <p className="sw-panel-lead">
                Read from this machine: the GPU driver, the system memory and the local ComfyUI server. Nothing is
                uploaded anywhere.
              </p>
            </div>
            <Button variant="ghost" size="sm" busy={scanning} onClick={() => void onRescan()}>
              Re-scan hardware
            </Button>
          </header>

          {profile === null ? (
            <div className="sw-scan-state" role="status">
              {scanning ? <Spinner size={18} label="Scanning hardware" /> : null}
              <p className="sw-quiet">
                {scanError === null
                  ? 'Scanning the GPU, memory and local backend...'
                  : `The hardware scan failed: ${scanError}`}
              </p>
              {scanning ? null : (
                <Button variant="secondary" size="sm" onClick={() => void onRescan()}>
                  Try the scan again
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="sw-specs">
                <SpecCard
                  label="GPU"
                  value={profile.gpu.name}
                  meta={profile.gpu.vramGb === null ? 'VRAM not reported' : `${formatGigabytes(profile.gpu.vramGb)} VRAM`}
                  badge={vendorLabel(profile.gpu)}
                  badgeTone="accent"
                />
                <SpecCard
                  label="System RAM"
                  value={`${formatGigabytes(profile.ramTotalGb)} total`}
                  meta={`${formatGigabytes(profile.ramFreeGb)} free right now`}
                  badge={profile.ramTotalGb >= 28 ? 'Enough for pinned memory' : 'Pinned memory off'}
                  badgeTone={profile.ramTotalGb >= 28 ? 'ok' : 'warn'}
                />
                <SpecCard
                  label="Processor & OS"
                  value={profile.cpuModel}
                  meta={`${profile.cpuCores} cores · ${profile.os} · ${profile.arch}`}
                  badge={`${profile.cpuCores} threads`}
                />
                <SpecCard
                  label="Local backend"
                  value={profile.comfyui.reachable ? 'ComfyUI is live' : 'ComfyUI is offline'}
                  meta={
                    profile.comfyui.reachable
                      ? [profile.comfyui.version === null ? null : `ComfyUI ${profile.comfyui.version}`, profile.comfyui.pytorchVersion]
                          .filter((part): part is string => part !== null)
                          .join(' · ') || 'Version not reported'
                      : profile.comfyui.baseUrl === null
                        ? 'No ComfyUI provider is configured'
                        : `Nothing answers at ${profile.comfyui.baseUrl}`
                  }
                  badge={profile.comfyui.reachable ? 'Live' : 'Offline'}
                  badgeTone={profile.comfyui.reachable ? 'ok' : 'warn'}
                />
              </div>

              <div className="sw-tier">
                <div className="sw-tier-main">
                  <span className="sw-tier-kicker">Detected tier</span>
                  <h3 className="sw-tier-title">{tierHeadline(profile.recommended.tier, profile.gpu.vramGb)}</h3>
                  <p className="sw-tier-summary">{profile.recommended.summary}</p>
                </div>
                <span className={`sw-tier-badge is-${profile.recommended.tier}`}>{profile.recommended.tierLabel}</span>
              </div>

              <div className="sw-panel-actions">
                <span className="sw-quiet">
                  {installedModels} of {totalModels} H3 model files are already on disk.
                </span>
                <Button variant="primary" onClick={() => setStep(2)}>
                  Continue to models
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M9.5 6.5L15 12l-5.5 5.5" />
                  </svg>
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {step === 2 && profile !== null ? (
        <section className="sw-panel" aria-labelledby="sw-step-2">
          <header className="sw-panel-head">
            <div>
              <h2 className="sw-panel-title" id="sw-step-2">
                Model checklist
              </h2>
              <p className="sw-panel-lead">
                The official MiniMax H3 Image files, grouped by what they do. Anything marked Not installed can be
                downloaded straight into the folder ComfyUI reads.
              </p>
            </div>
            <span className="sw-count">
              {installedModels}/{totalModels} installed
            </span>
          </header>

          <div className="sw-model-groups">
            {modelsByRole(profile.models).map((group) => (
              <section key={group.role} className="sw-model-group" aria-labelledby={`sw-role-${group.role}`}>
                <h3 className="sw-group-title" id={`sw-role-${group.role}`}>
                  {MODEL_ROLE_LABELS[group.role]}
                </h3>
                <ul className="sw-model-list">
                  {group.entries.map((entry) => (
                    <ModelRow
                      key={entry.id}
                      entry={entry}
                      copied={copiedUrl === entry.downloadUrl}
                      onCopy={(target) => {
                        void copyUrl(target);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="sw-summary">
            <span className="sw-quiet">
              {installedModels} of {totalModels} H3 models installed. Missing files never block a run, but the graph
              that loads them will fail until they are there.
            </span>
            <div className="sw-panel-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(3)}>
                Continue to auto-tune
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9.5 6.5L15 12l-5.5 5.5" />
                </svg>
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {step === 3 && profile !== null ? (
        <section className="sw-panel" aria-labelledby="sw-step-3">
          <header className="sw-panel-head">
            <div>
              <h2 className="sw-panel-title" id="sw-step-3">
                Auto-tune &amp; apply
              </h2>
              <p className="sw-panel-lead">
                Exactly what will be written: the studio default canvas and models, plus the ComfyUI launch flags and
                environment for this card.
              </p>
            </div>
          </header>

          <div className="sw-preview">
            <div className="sw-preview-column">
              <h3 className="sw-group-title">Studio defaults</h3>
              <dl className="sw-kv">
                <div className="sw-kv-row">
                  <dt>Default canvas</dt>
                  <dd>{sizeLabel(profile.recommended.width, profile.recommended.height)}</dd>
                </div>
                <div className="sw-kv-row">
                  <dt>Model precision</dt>
                  <dd>{modelPrecisionLabel(profile.recommended.modelVariant)}</dd>
                </div>
                <div className="sw-kv-row">
                  <dt>Text encoder</dt>
                  <dd>{textEncoderLabel(profile.recommended.textEncoderVariant)}</dd>
                </div>
                <div className="sw-kv-row">
                  <dt>Prompt enhancer</dt>
                  <dd>{promptEnhancerLabel(profile.recommended.promptEnhancer)}</dd>
                </div>
                <div className="sw-kv-row">
                  <dt>Hardware tier</dt>
                  <dd>{profile.recommended.tierLabel}</dd>
                </div>
              </dl>
            </div>

            <div className="sw-preview-column">
              <h3 className="sw-group-title">ComfyUI launch</h3>
              <ul className="sw-args">
                {previewArgs(profile.recommended.launchArgs, reserve, disablePinnedMemory).map((arg, index) => (
                  <li key={`${arg}-${index}`} className={arg.startsWith('--') ? 'sw-arg is-flag' : 'sw-arg'}>
                    {arg}
                  </li>
                ))}
              </ul>
              {Object.keys(profile.recommended.launchEnv).length === 0 ? (
                <p className="sw-quiet">No extra environment variables.</p>
              ) : (
                <ul className="sw-env">
                  {Object.entries(profile.recommended.launchEnv).map(([key, value]) => (
                    <li key={key} className="sw-env-row">
                      {key}={value}
                    </li>
                  ))}
                </ul>
              )}

              <div className="sw-toggles">
                <div className="sw-toggle">
                  <span className="sw-toggle-label" id="sw-reserve-label">
                    Reserved VRAM
                  </span>
                  <div className="sw-stepper" role="group" aria-labelledby="sw-reserve-label">
                    <button
                      type="button"
                      className="sw-stepper-btn"
                      aria-label="Reserve less VRAM"
                      disabled={reserve <= MIN_RESERVE_GB}
                      onClick={() => setReserveVramGb(Math.max(MIN_RESERVE_GB, reserve - 1))}
                    >
                      −
                    </button>
                    <span className="sw-stepper-value">{reserve} GB</span>
                    <button
                      type="button"
                      className="sw-stepper-btn"
                      aria-label="Reserve more VRAM"
                      disabled={reserve >= MAX_RESERVE_GB}
                      onClick={() => setReserveVramGb(Math.min(MAX_RESERVE_GB, reserve + 1))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <label className="sw-switch">
                  <input
                    type="checkbox"
                    checked={!disablePinnedMemory}
                    onChange={(event) => {
                      setDisablePinnedMemory(!event.target.checked);
                    }}
                  />
                  <span className="sw-switch-track" aria-hidden="true" />
                  <span className="sw-switch-copy">
                    <span className="sw-switch-label">Pinned host memory</span>
                    <span className="sw-switch-hint">Faster CPU to GPU loads on machines with 28 GB or more RAM.</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          {vram === null ? null : (
            <div className="sw-vram">
              <div className="sw-vram-head">
                <h3 className="sw-group-title">Estimated peak VRAM</h3>
                <span className="sw-vram-figures">
                  <span className="sw-vram-value">
                    {vram.gpuVramGb === null
                      ? `~${vram.peakGb.toFixed(1)} GB`
                      : `~${vram.peakGb.toFixed(1)} / ${formatVramGb(vram.gpuVramGb)} GB`}
                  </span>
                  <span className={`sw-vram-status is-${vram.status}`}>{vram.statusLabel}</span>
                </span>
              </div>
              <VramLedMeter
                fillPercent={vram.fillPercent}
                status={vram.status}
                value={vram.peakGb}
                max={vram.gpuVramGb ?? 24}
                label="Estimated peak VRAM"
                size="md"
              />
              <div className="sw-vram-stages">
                <ul className="sw-vram-stage-list">
                  {vram.stages.map((stage) => (
                    <li
                      key={stage.id}
                      className={
                        stage.id === vram.peakStage.id ? 'sw-vram-stage is-peak' : 'sw-vram-stage'
                      }
                    >
                      <span className="sw-vram-stage-label">{stage.label}</span>
                      <span className="sw-vram-stage-gb">{stage.gb.toFixed(1)} GB</span>
                    </li>
                  ))}
                </ul>
                <span className="sw-vram-hint">Sequential peak · models hand off between stages</span>
              </div>
            </div>
          )}

          <div className="sw-why">
            <h3 className="sw-group-title">Why these settings?</h3>
            <ul className="sw-notes">
              {profile.recommended.notes.map((note) => (
                <li key={note} className="sw-note">
                  {note}
                </li>
              ))}
            </ul>
          </div>

          {applyError === null ? null : (
            <p className="sw-status is-error" role="alert">
              {applyError}
            </p>
          )}

          {targetProviderId === null ? (
            <p className="sw-status" role="status">
              There is no ComfyUI provider to tune yet. Add one on the Providers tab, then apply this profile.
            </p>
          ) : null}

          {applied === null ? (
            <div className="sw-apply">
              <Button variant="ghost" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                variant="primary"
                busy={applying}
                disabled={targetProviderId === null}
                onClick={() => void apply()}
              >
                Apply optimal settings
              </Button>
            </div>
          ) : (
            <div className="sw-success" role="status">
              <div className="sw-success-main">
                <h3 className="sw-success-title">Optimal settings applied</h3>
                <p className="sw-success-copy">
                  The studio defaults and the {applied.provider.label} launch flags are saved. Restart ComfyUI (and H3
                  Studio) for the new launch flags to take effect.
                </p>
              </div>
              <div className="sw-apply">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void onRescan();
                  }}
                >
                  Rescan
                </Button>
                {canClose ? (
                  <Button variant="primary" onClick={onClose}>
                    Return to studio
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The launch flags as they will be written, with the two overrides this step exposes
 * applied to the recommendation the server sent.
 */
export function previewArgs(
  baseArgs: readonly string[],
  reserveVramGb: number,
  disablePinnedMemory: boolean,
): string[] {
  const args: string[] = [];
  for (let index = 0; index < baseArgs.length; index += 1) {
    const arg = baseArgs[index];
    if (arg === undefined) continue;
    if (arg === '--reserve-vram') {
      args.push(arg, String(reserveVramGb));
      if (baseArgs[index + 1] !== undefined && !baseArgs[index + 1]?.startsWith('-')) index += 1;
      continue;
    }
    if (arg === '--disable-pinned-memory') continue;
    args.push(arg);
  }
  if (disablePinnedMemory) args.push('--disable-pinned-memory');
  return args;
}
