// The Performance & Defaults tab: the studio defaults the Generate composer reads, and the
// ComfyUI launch tuning that is written into providers.json.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  H3ModelVariant,
  H3PromptEnhancer,
  H3TextEncoderVariant,
  SystemProfile,
} from '../../../core/types';
import { applySystemProfile } from '../../api';
import { Button, SegmentedControl, Slider } from '../../components';
import { useStudio } from '../../studio';
import {
  applyStudioDefaults,
  readDefaultResolutionPreference,
  readModelVariantPreference,
  readPromptEnhancerPreference,
  readTextEncoderPreference,
  type StudioDefaults,
} from '../generate/useGeneration';
import { describeError, sizeLabel } from './helpers';
import { comfyProviderIdOf } from './SetupWizard';

export interface PerformancePanelProps {
  profile: SystemProfile | null;
  scanning: boolean;
  scanError: string | null;
  onRescan: () => Promise<void>;
  onProfile: (profile: SystemProfile) => void;
}

const ROCM_ENV = 'TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL';
const MIN_RESERVE_GB = 2;
const MAX_RESERVE_GB = 8;

type ResolutionChoice = '2048x2048' | '4096x4096' | '1024x1024';

const RESOLUTION_OPTIONS: readonly { value: ResolutionChoice; label: string }[] = [
  { value: '2048x2048', label: '2048×2048 · Recommended' },
  { value: '4096x4096', label: '4096×4096 · Hero' },
  { value: '1024x1024', label: '1024×1024 · Draft' },
];

function resolutionOf(value: ResolutionChoice): { width: number; height: number } {
  if (value === '4096x4096') return { width: 4096, height: 4096 };
  if (value === '1024x1024') return { width: 1024, height: 1024 };
  return { width: 2048, height: 2048 };
}

export function PerformancePanel({
  profile,
  scanning,
  scanError,
  onRescan,
  onProfile,
}: PerformancePanelProps): ReactNode {
  const studio = useStudio();

  const [resolution, setResolution] = useState<ResolutionChoice>(() => {
    const stored = readDefaultResolutionPreference();
    const match = RESOLUTION_OPTIONS.find((option) => {
      const size = resolutionOf(option.value);
      return size.width === stored.width && size.height === stored.height;
    });
    return match === undefined ? '2048x2048' : match.value;
  });
  const [precision, setPrecision] = useState<H3ModelVariant>(() => readModelVariantPreference());
  const [encoder, setEncoder] = useState<H3TextEncoderVariant>(() => readTextEncoderPreference());
  const [enhancer, setEnhancer] = useState<H3PromptEnhancer>(() => readPromptEnhancerPreference());

  const [reserveVramGb, setReserveVramGb] = useState(MIN_RESERVE_GB);
  const [previewMethod, setPreviewMethod] = useState<'latent2rgb' | 'none'>('latent2rgb');
  const [disablePinnedMemory, setDisablePinnedMemory] = useState(true);
  const [rocmFlashAttention, setRocmFlashAttention] = useState(false);
  const [applying, setApplying] = useState<'save' | 'reset' | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (profile === null) return;
    setReserveVramGb(profile.recommended.reserveVramGb);
    setPreviewMethod(profile.recommended.previewMethod);
    setDisablePinnedMemory(profile.recommended.disablePinnedMemory);
    setRocmFlashAttention(profile.recommended.launchEnv[ROCM_ENV] === '1');
  }, [profile]);

  // One place that applies a default, so every control also updates the live composer.
  const applyDefaults = useCallback((defaults: StudioDefaults): void => {
    applyStudioDefaults(defaults);
  }, []);

  const runApply = useCallback(
    async (mode: 'save' | 'reset'): Promise<void> => {
      const providerId = comfyProviderIdOf(studio.providers);
      setApplying(mode);
      setApplyError(null);
      try {
        const response = await applySystemProfile(
          mode === 'reset'
            ? providerId === null
              ? {}
              : { providerId }
            : {
                ...(providerId === null ? {} : { providerId }),
                reserveVramGb,
                previewMethod,
                disablePinnedMemory,
                rocmFlashAttention,
              },
        );
        onProfile(response.profile);
        await studio.refresh();
        studio.notify(
          mode === 'reset'
            ? 'Launch tuning reset to the hardware defaults.'
            : 'Launch tuning applied. Restart ComfyUI for it to take effect.',
        );
      } catch (error) {
        setApplyError(describeError(error));
      } finally {
        setApplying(null);
      }
    },
    [disablePinnedMemory, onProfile, previewMethod, reserveVramGb, rocmFlashAttention, studio],
  );

  const currentArgs = profile === null ? null : profile.currentLaunch?.args ?? null;
  const currentEnv = profile === null ? null : profile.currentLaunch?.env ?? null;

  return (
    <div className="pf">
      <section className="pf-card" aria-labelledby="pf-defaults-title">
        <header className="pf-head">
          <div>
            <h2 className="pf-title" id="pf-defaults-title">
              Default generation settings
            </h2>
            <p className="pf-lead">
              What a fresh Generate screen starts on. Every change applies to the composer immediately and is
              remembered across restarts.
            </p>
          </div>
        </header>

        <div className="pf-rows">
          <div className="pf-row">
            <div className="pf-row-copy">
              <span className="pf-row-label">Default resolution</span>
              <span className="pf-row-hint">
                1024×1024 is a draft canvas: good for exploring, weak on anatomy. 4096×4096 needs a 30 GB card.
              </span>
            </div>
            <SegmentedControl<ResolutionChoice>
              label="Default resolution"
              value={resolution}
              options={RESOLUTION_OPTIONS}
              onChange={(value) => {
                setResolution(value);
                const size = resolutionOf(value);
                applyDefaults({ width: size.width, height: size.height });
              }}
            />
          </div>

          <div className="pf-row">
            <div className="pf-row-copy">
              <span className="pf-row-label">Default model precision</span>
              <span className="pf-row-hint">
                W4A8 is the 11.7 GB driver that fills a 24 GB card. INT8 ConvRot is the 19.5 GB maximum quality build.
              </span>
            </div>
            <SegmentedControl<H3ModelVariant>
              label="Default model precision"
              value={precision}
              options={[
                { value: 'w4a8', label: 'Fast W4A8' },
                { value: 'int8_convrot', label: 'Max INT8' },
              ]}
              onChange={(value) => {
                setPrecision(value);
                applyDefaults({ modelVariant: value });
              }}
            />
          </div>

          <div className="pf-row">
            <div className="pf-row-copy">
              <span className="pf-row-label">Default text encoder</span>
              <span className="pf-row-hint">
                NVFP4 AWQ is the 14.6 GB encoder that runs fully on the card. INT8 ConvRot is the 25.3 GB full 8-bit
                build.
              </span>
            </div>
            <SegmentedControl<H3TextEncoderVariant>
              label="Default text encoder"
              value={encoder}
              options={[
                { value: 'nvfp4', label: 'Fast NVFP4' },
                { value: 'int8', label: 'Max INT8' },
              ]}
              onChange={(value) => {
                setEncoder(value);
                applyDefaults({ textEncoderVariant: value });
              }}
            />
          </div>

          <div className="pf-row">
            <div className="pf-row-copy">
              <span className="pf-row-label">Default prompt enhancer</span>
              <span className="pf-row-hint">
                Expands short prompts into full scene and lighting detail. The 27B build is the richest, the 9B build
                the fastest.
              </span>
            </div>
            <SegmentedControl<H3PromptEnhancer>
              label="Default prompt enhancer"
              value={enhancer}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'qwen3.5_9b', label: 'Fast 9B' },
                { value: 'qwen3.8_27b', label: 'Best 27B' },
              ]}
              onChange={(value) => {
                setEnhancer(value);
                applyDefaults({ promptEnhancer: value });
              }}
            />
          </div>
        </div>
      </section>

      <section className="pf-card" aria-labelledby="pf-tuning-title">
        <header className="pf-head">
          <div>
            <h2 className="pf-title" id="pf-tuning-title">
              ComfyUI runtime tuning
            </h2>
            <p className="pf-lead">
              Written into the ComfyUI provider's launch flags and environment. ComfyUI picks them up the next time it
              starts.
            </p>
          </div>
          <Button variant="ghost" size="sm" busy={scanning} onClick={() => void onRescan()}>
            Re-scan hardware
          </Button>
        </header>

        {profile === null ? (
          <p className="pf-quiet" role="status">
            {scanError === null ? 'Reading the hardware profile...' : `The hardware scan failed: ${scanError}`}
          </p>
        ) : (
          <>
            <div className="pf-tuning">
              <Slider
                label="Reserved VRAM"
                min={MIN_RESERVE_GB}
                max={MAX_RESERVE_GB}
                step={1}
                value={reserveVramGb}
                disabled={applying !== null}
                hint={`Keeps ${reserveVramGb} GB free for the desktop, the browser and the compositor.`}
                format={(value) => `${value} GB`}
                onChange={(value) => setReserveVramGb(value)}
              />

              <label className="sw-switch pf-switch">
                <input
                  type="checkbox"
                  checked={previewMethod === 'latent2rgb'}
                  disabled={applying !== null}
                  onChange={(event) => setPreviewMethod(event.target.checked ? 'latent2rgb' : 'none')}
                />
                <span className="sw-switch-track" aria-hidden="true" />
                <span className="sw-switch-copy">
                  <span className="sw-switch-label">Live diffusion previews</span>
                  <span className="sw-switch-hint">
                    --preview-method latent2rgb sends a denoise frame per step, at a small cost per step.
                  </span>
                </span>
              </label>

              <label className="sw-switch pf-switch">
                <input
                  type="checkbox"
                  checked={!disablePinnedMemory}
                  disabled={applying !== null}
                  onChange={(event) => setDisablePinnedMemory(!event.target.checked)}
                />
                <span className="sw-switch-track" aria-hidden="true" />
                <span className="sw-switch-copy">
                  <span className="sw-switch-label">Pinned host memory</span>
                  <span className="sw-switch-hint">
                    Faster CPU to GPU loads. Only safe with 28 GB of RAM or more.
                  </span>
                </span>
              </label>

              <label className="sw-switch pf-switch">
                <input
                  type="checkbox"
                  checked={rocmFlashAttention}
                  disabled={applying !== null}
                  onChange={(event) => setRocmFlashAttention(event.target.checked)}
                />
                <span className="sw-switch-track" aria-hidden="true" />
                <span className="sw-switch-copy">
                  <span className="sw-switch-label">AMD ROCm AOTriton flash attention</span>
                  <span className="sw-switch-hint">{ROCM_ENV}=1 for the fast attention kernels on ROCm.</span>
                </span>
              </label>
            </div>

            <div className="pf-preview">
              <h3 className="section-label">Current launch</h3>
              {currentArgs === null ? (
                <p className="pf-quiet">This ComfyUI provider has no managed launch config yet.</p>
              ) : (
                <ul className="sw-args">
                  {currentArgs.map((arg, index) => (
                    <li key={`${arg}-${index}`} className={arg.startsWith('--') ? 'sw-arg is-flag' : 'sw-arg'}>
                      {arg}
                    </li>
                  ))}
                </ul>
              )}
              {currentEnv === null || Object.keys(currentEnv).length === 0 ? (
                <p className="pf-quiet">No extra environment variables.</p>
              ) : (
                <ul className="sw-env">
                  {Object.entries(currentEnv).map(([key, value]) => (
                    <li key={key} className="sw-env-row">
                      {key}={value}
                    </li>
                  ))}
                </ul>
              )}
              <p className="pf-quiet">
                Recommended for this machine: {sizeLabel(profile.recommended.width, profile.recommended.height)} canvas,
                reserve {profile.recommended.reserveVramGb} GB, previews{' '}
                {profile.recommended.previewMethod === 'none' ? 'off' : profile.recommended.previewMethod}, pinned memory{' '}
                {profile.recommended.disablePinnedMemory ? 'off' : 'on'}.
              </p>
            </div>

            {applyError === null ? null : (
              <p className="pr-status is-error" role="alert">
                {applyError}
              </p>
            )}

            <div className="pf-actions">
              <Button variant="ghost" busy={applying === 'reset'} disabled={applying !== null} onClick={() => void runApply('reset')}>
                Reset to hardware defaults
              </Button>
              <Button variant="primary" busy={applying === 'save'} disabled={applying !== null} onClick={() => void runApply('save')}>
                Save &amp; apply tuning
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
