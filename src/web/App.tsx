// The studio frame: top bar, left rail, centre canvas, right inspector.
// Feature screens mount into the slots below. Nothing here renders a features
// screen, and nothing styles their internal markup.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Preset, ProviderCapabilities, ProviderConfig, ProviderKind } from '../core/types';
import {
  checkProviderHealth,
  createProvider,
  getStats,
  listPresets,
  listProviders,
  updateProvider,
  type ProviderHealth,
  type StudioStats,
} from './api';
import { Button, EmptyState, Field, SegmentedControl, Select, Spinner, Toast } from './components';
import { H3_IMAGE_TEMPLATE_JSON } from './data/h3ImageTemplate';
import './styles/topbar.css';

// Checked once at startup: only the desktop shell reports Electron in its user agent.
// The class lets CSS reserve the window control strip and make the top bar a drag
// region. In the browser neither applies, so no mysterious gap appears there.
if (typeof navigator !== 'undefined' && typeof document !== 'undefined' && navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('is-desktop');
}

export type StudioView = 'generate' | 'library';

export interface StudioContextValue {
  /** Every provider config the server knows about, enabled or not. */
  providers: ProviderConfig[];
  /** The provider the generate screen should target. Null when nothing is enabled. */
  provider: ProviderConfig | null;
  selectProvider: (providerId: string) => void;
  /** Library totals from /api/stats. Null until the first load succeeds. */
  stats: StudioStats | null;
  presets: Preset[];
  /** Reloads providers, stats and presets without showing the loading screen. */
  refresh: () => Promise<void>;
}

/** Read this instead of prop drilling into feature screens. */
export const StudioProvider = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = useContext(StudioProvider);
  if (value === null) throw new Error('useStudio must be called inside the App tree.');
  return value;
}

/**
 * A config counts as enabled unless the server marks it disabled.
 */
export function isProviderEnabled(config: ProviderConfig): boolean {
  return config.enabled !== false;
}

export interface StudioSlots {
  /** Left rail, under the library summary. The library feature lists batches here. */
  rail?: ReactNode;
  /** Centre panel in the generate view. The generate feature renders results here. */
  canvas?: ReactNode;
  /** Right inspector body. The generate feature renders its controls here. */
  controls?: ReactNode;
  /** Centre panel in the library view. The library feature renders its screen here. */
  library?: ReactNode;
}

export interface AppProps {
  slots?: StudioSlots;
}

type Phase = 'loading' | 'ready' | 'error';

interface ToastState {
  id: number;
  message: string;
  tone: 'success' | 'error';
}

interface ProviderKindMeta {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  summary: string;
}

// Mirrors defaultProviderConfigs in docs/api-contract.md. The browser cannot
// import src/core/providers/registry.ts, which pulls in Node only adapter code.
const PROVIDER_KINDS: ReadonlyArray<ProviderKindMeta> = [
  {
    kind: 'mock',
    label: 'Mock (offline)',
    defaultBaseUrl: 'mock://local',
    summary: 'An offline stand-in. No model and no network, so it is the quickest way to check the studio works.',
  },
  {
    kind: 'comfyui',
    label: 'ComfyUI',
    defaultBaseUrl: 'http://127.0.0.1:8188',
    summary: 'A local ComfyUI server, addressed by its HTTP port.',
  },
  {
    kind: 'openai-images',
    label: 'SGLang or vLLM image server',
    defaultBaseUrl: 'http://127.0.0.1:30000',
    summary: 'A server that accepts the OpenAI image generation request shape.',
  },
  {
    kind: 'a1111',
    label: 'Automatic1111 or Forge',
    defaultBaseUrl: 'http://127.0.0.1:7860',
    summary: 'The Automatic1111 or Forge web UI, addressed by its HTTP port.',
  },
];

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** The names the ComfyUI adapter substitutes inside string values of a workflow graph. */
const WORKFLOW_PLACEHOLDERS = [
  'prompt',
  'negativePrompt',
  'width',
  'height',
  'seed',
  'steps',
  'cfg',
  'ckpt',
  'batch',
] as const;

/**
 * MiniMax H3 image generation is fixed: six sampling steps, guidance at 1, and a
 * negative prompt is rejected. Nothing here is guessed by the adapter, so the card
 * can state it once and save it as an override.
 */
const H3_IMAGE_CAPABILITIES: ProviderCapabilities = {
  seed: true,
  negativePrompt: false,
  adjustableSteps: false,
  fixedSteps: 6,
  guidance: false,
  maxReferenceImages: 0,
  maxBatch: 1,
  arbitrarySize: true,
  sizeMultiple: 32,
  presets: [
    { id: '4096x4096', label: '4096x4096', width: 4096, height: 4096 },
    { id: '4736x3552', label: '4736x3552', width: 4736, height: 3552 },
    { id: '3552x4736', label: '3552x4736', width: 3552, height: 4736 },
    { id: '5472x3072', label: '5472x3072', width: 5472, height: 3072 },
    { id: '3072x5472', label: '3072x5472', width: 3072, height: 5472 },
  ],
  outputFormats: ['png'],
  streamingProgress: true,
  notes: ['H3 fixes 6 steps and guidance 1, and it rejects a negative prompt.'],
};

function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'B';
  return unitIndex === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

function describeError(error: unknown): string {
  if (error instanceof TypeError) return 'The studio server did not answer.';
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

function findProvider(providers: ProviderConfig[], kind: ProviderKind): ProviderConfig | null {
  return providers.find((candidate) => candidate.kind === kind) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The saved graph, or an empty string: the adapter falls back to its own graph. */
function savedWorkflowTemplate(existing: ProviderConfig | null): string {
  const raw = existing?.options?.['workflowTemplate'];
  return typeof raw === 'string' ? raw : '';
}

function savedCapabilityOverride(existing: ProviderConfig | null): Record<string, unknown> | null {
  const raw = existing?.options?.['capabilities'];
  return isRecord(raw) ? raw : null;
}

/**
 * Checks the text against the ComfyUI API format the adapter reads: an object of
 * node id to node, and every node carries a string class_type and an object inputs.
 * Empty is allowed, and nothing here ever throws: the first problem is returned.
 */
function workflowTemplateProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the text does not parse';
    return `This is not valid JSON yet. ${detail}`;
  }
  if (!isRecord(parsed)) {
    return 'The graph must be a JSON object of node id to node, not a list or a single value.';
  }
  for (const [nodeId, node] of Object.entries(parsed)) {
    if (!isRecord(node)) return `Node ${nodeId} must be an object with class_type and inputs.`;
    const classType = node['class_type'];
    if (typeof classType !== 'string' || classType.length === 0) {
      return `Node ${nodeId} needs a class_type string, like "KSampler".`;
    }
    if (!isRecord(node['inputs'])) return `Node ${nodeId} needs an inputs object.`;
  }
  return null;
}

/** A short description of a saved override, read from the fields the studio can name. */
function describeCapabilityOverride(override: Record<string, unknown>): string {
  const parts: string[] = [];
  const fixedSteps = override['fixedSteps'];
  if (typeof fixedSteps === 'number') parts.push(`${fixedSteps} fixed steps`);
  if (override['negativePrompt'] === false) parts.push('negative prompt off');
  if (override['guidance'] === false) parts.push('guidance off');
  const presets = override['presets'];
  if (Array.isArray(presets)) {
    parts.push(presets.length === 1 ? '1 size preset' : `${presets.length} size presets`);
  }
  if (parts.length === 0) {
    const count = Object.keys(override).length;
    return `Capability override active: ${count === 1 ? '1 field' : `${count} fields`} set.`;
  }
  return `Capability override active: ${parts.join(', ')}.`;
}

/** ?view=library or ?view=generate, so a screenshot or a bookmark opens where it points. */
function readViewFromLocation(): StudioView {
  if (typeof window === 'undefined') return 'generate';
  return new URLSearchParams(window.location.search).get('view') === 'library' ? 'library' : 'generate';
}

function ApertureIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5l4.4 7.6M20.5 12h-8.8M16.4 20.5l-4.4-7.6M7.6 20.5l4.4-7.6M3.5 12h8.8M7.6 3.5l4.4 7.6" />
    </svg>
  );
}

function ImageIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="M4.5 17.5l5-5 4 4 2.5-2.5 3.5 3.5" />
    </svg>
  );
}

function DiskIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="5" width="16" height="6" rx="2" />
      <rect x="4" y="13" width="16" height="6" rx="2" />
      <path d="M7.5 8h0.01M7.5 16h0.01" />
    </svg>
  );
}

function ChevronIcon({ pointsLeft }: { pointsLeft: boolean }): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={pointsLeft ? 'M14.5 6.5L9 12l5.5 5.5' : 'M9.5 6.5L15 12l-5.5 5.5'} />
    </svg>
  );
}

/**
 * Switching tabs is not a navigation the user wants to undo, so the URL is
 * rewritten in place: a refresh keeps the view and the back button stays clean.
 */
function writeViewToLocation(next: StudioView): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('view', next);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function App({ slots = {} }: AppProps): ReactNode {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [stats, setStats] = useState<StudioStats | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<StudioView>(readViewFromLocation);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh'): Promise<void> => {
    if (mode === 'initial') setPhase('loading');
    try {
      const [nextProviders, nextStats] = await Promise.all([listProviders(), getStats()]);
      // The presets strip is secondary: a failure there must not blank the studio.
      const nextPresets = await listPresets().catch((): Preset[] => []);
      setProviders(nextProviders);
      setStats(nextStats);
      setPresets(nextPresets);
      setLoadError('');
      setPhase('ready');
    } catch (error) {
      const message = describeError(error);
      if (mode === 'initial') {
        setLoadError(message);
        setPhase('error');
      } else {
        setToast({ id: Date.now(), message, tone: 'error' });
      }
    }
  }, []);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const refresh = useCallback((): Promise<void> => load('refresh'), [load]);

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  const selectView = useCallback((next: StudioView): void => {
    setView(next);
    writeViewToLocation(next);
  }, []);

  const handleProviderEnabled = useCallback(
    (saved: ProviderConfig) => {
      setSelectedId(saved.id);
      setSetupOpen(false);
      setToast({ id: Date.now(), message: `${saved.label} is enabled.`, tone: 'success' });
      void refresh();
    },
    [refresh],
  );

  const enabledProviders = useMemo(() => providers.filter(isProviderEnabled), [providers]);

  const provider = useMemo<ProviderConfig | null>(() => {
    const selected = enabledProviders.find((candidate) => candidate.id === selectedId);
    return selected ?? enabledProviders[0] ?? null;
  }, [enabledProviders, selectedId]);

  const contextValue = useMemo<StudioContextValue>(
    () => ({ providers, provider, selectProvider: setSelectedId, stats, presets, refresh }),
    [providers, provider, stats, presets, refresh],
  );

  const imageCount = stats === null ? 0 : stats.imageCount;
  const batchCount = stats === null ? 0 : stats.batchCount;
  const totalBytes = stats === null ? 0 : stats.bytes;

  const centreSlot = view === 'generate' ? slots.canvas : slots.library;
  const centreTitle = view === 'generate' ? 'Generate' : 'Library';

  if (phase === 'loading') {
    return (
      <div className="loading-screen">
        <Spinner size={28} label="Loading the studio" />
        <p className="loading-screen-copy" aria-hidden="true">
          Loading the studio
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="loading-screen">
        <EmptyState
          title="The studio cannot reach its server"
          description={loadError}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void load('initial');
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <StudioProvider.Provider value={contextValue}>
      {enabledProviders.length === 0 || setupOpen ? (
        <SetupScreen
          providers={providers}
          onEnabled={handleProviderEnabled}
          onDismiss={
            enabledProviders.length === 0
              ? undefined
              : () => {
                  setSetupOpen(false);
                }
          }
        />
      ) : (
        <div className="studio">
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                <ApertureIcon />
              </span>
              <h1 className="brand-name">H3 Studio</h1>
            </div>
            <SegmentedControl<StudioView>
              label="View"
              value={view}
              onChange={selectView}
              options={[
                { value: 'generate', label: 'Generate' },
                { value: 'library', label: 'Library' },
              ]}
            />
            <div className="topbar-meta">
              {provider === null ? null : (
                <div className="topbar-provider">
                  <span className="label">Provider</span>
                  {/* Same choice as before: only an enabled provider is selectable, and
                      the label carries the state the provider reports, like Mock (offline). */}
                  <Select<string>
                    ariaLabel="Provider"
                    value={provider.id}
                    options={enabledProviders.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
                    onChange={setSelectedId}
                  />
                </div>
              )}
              <span className="stat">
                <ImageIcon />
                <strong>{imageCount.toLocaleString('en-GB')}</strong> images
              </span>
              <span className="stat">
                <DiskIcon />
                <strong>{formatBytes(totalBytes)}</strong> on disk
              </span>
              <Button
                variant="ghost"
                size="sm"
                title="Provider setup"
                onClick={() => {
                  setSetupOpen(true);
                }}
              >
                Providers
              </Button>
            </div>
          </header>

          <div className={inspectorOpen ? 'studio-body' : 'studio-body is-collapsed'}>
            <aside className="rail" aria-label="Library summary and presets">
              <section className="rail-section">
                <div className="rail-head">
                  <h2 className="section-label">Library</h2>
                </div>
                <dl className="summary">
                  <div className="summary-row">
                    <dt>Images</dt>
                    <dd>{imageCount.toLocaleString('en-GB')}</dd>
                  </div>
                  <div className="summary-row">
                    <dt>Batches</dt>
                    <dd>{batchCount.toLocaleString('en-GB')}</dd>
                  </div>
                  <div className="summary-row">
                    <dt>On disk</dt>
                    <dd>{formatBytes(totalBytes)}</dd>
                  </div>
                </dl>
                {slots.rail === undefined ? null : <div className="rail-slot">{slots.rail}</div>}
              </section>

              {/* Display only: the library feature owns applying and editing presets. */}
              <section className="rail-section">
                <div className="rail-head">
                  <h2 className="section-label">Presets</h2>
                  <span className="rail-count">{presets.length}</span>
                </div>
                {presets.length === 0 ? (
                  <p className="rail-empty">No presets saved yet.</p>
                ) : (
                  <ul className="preset-strip">
                    {presets.map((preset) => (
                      <li key={preset.id} className="preset-chip">
                        <span className="preset-chip-name">{preset.name}</span>
                        <span className="preset-chip-meta">
                          {preset.width} x {preset.height} / {preset.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>

            <main className="centre">
              <h2 className="sr-only">{centreTitle}</h2>
              {centreSlot === undefined ? (
                <div className="centre-panel is-empty">
                  <EmptyState
                    title={view === 'generate' ? 'The canvas is ready' : 'No batch selected'}
                    description={
                      view === 'generate'
                        ? 'Generated images appear here once a batch runs.'
                        : 'Saved batches, selections and exports appear here.'
                    }
                    icon={view === 'generate' ? <ImageIcon /> : undefined}
                  />
                </div>
              ) : (
                <div className="centre-panel">{centreSlot}</div>
              )}
            </main>

            <aside className={inspectorOpen ? 'inspector' : 'inspector is-collapsed'} aria-label="Generation controls">
              <div className="inspector-head">
                {inspectorOpen ? <h2 className="section-label">Controls</h2> : null}
                <button
                  type="button"
                  className="icon-button"
                  aria-expanded={inspectorOpen}
                  aria-label={inspectorOpen ? 'Collapse generation controls' : 'Expand generation controls'}
                  title={inspectorOpen ? 'Collapse controls' : 'Expand controls'}
                  onClick={() => {
                    setInspectorOpen(!inspectorOpen);
                  }}
                >
                  <ChevronIcon pointsLeft={!inspectorOpen} />
                </button>
              </div>
              {inspectorOpen ? (
                <div className="inspector-body">
                  {slots.controls === undefined ? (
                    <EmptyState title="Controls" description="Prompt, size and sampling controls appear here." />
                  ) : (
                    slots.controls
                  )}
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      )}

      {toast === null ? null : <Toast key={toast.id} message={toast.message} tone={toast.tone} onClose={dismissToast} />}
    </StudioProvider.Provider>
  );
}

interface SetupScreenProps {
  providers: ProviderConfig[];
  onEnabled: (saved: ProviderConfig) => void;
  /** Absent when no provider is enabled: there is no studio to go back to. */
  onDismiss?: () => void;
}

function SetupScreen({ providers, onEnabled, onDismiss }: SetupScreenProps): ReactNode {
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // The setup screen replaces the studio, so the button that opened it is gone:
  // move focus to the heading instead of dropping the user back to the document.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div className="setup">
      {/* The setup screen replaces the studio, and with it the top bar. In the desktop
          shell the window still needs somewhere to be grabbed, so this keeps a strip
          the height of the bar as the drag surface. The browser renders nothing here. */}
      <div className="setup-drag" aria-hidden="true" />
      <div className="setup-inner">
        <header className="setup-head">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <ApertureIcon />
            </span>
            <h1 className="brand-name">H3 Studio</h1>
          </div>
          <h2 className="setup-title" ref={titleRef} tabIndex={-1}>
            Connect a provider
          </h2>
          <p className="setup-lead">
            H3 Studio renders through a provider that runs on this machine. Everything stays local unless you point a
            provider at a remote address. Check the address, test the connection, then enable one.
          </p>
          {onDismiss === undefined ? null : (
            <div className="setup-card-actions">
              <Button variant="ghost" onClick={onDismiss}>
                Back to studio
              </Button>
            </div>
          )}
        </header>
        <div className="setup-grid">
          {PROVIDER_KINDS.map((meta) => (
            <SetupCard key={meta.kind} meta={meta} existing={findProvider(providers, meta.kind)} onEnabled={onEnabled} />
          ))}
        </div>
        <p className="setup-foot">
          The mock provider needs no model and no network. Switch providers from the top bar at any time.
        </p>
      </div>
    </div>
  );
}

interface SetupCardProps {
  meta: ProviderKindMeta;
  existing: ProviderConfig | null;
  onEnabled: (saved: ProviderConfig) => void;
}

function SetupCard({ meta, existing, onEnabled }: SetupCardProps): ReactNode {
  const graphId = useId();
  const workflowId = `${graphId}-workflow`;
  const workflowHintId = `${graphId}-workflow-hint`;
  // Only ComfyUI reads a graph, so only its card grows the advanced section.
  const isComfy = meta.kind === 'comfyui';

  const [baseUrl, setBaseUrl] = useState(existing === null ? meta.defaultBaseUrl : existing.baseUrl);
  const [configId, setConfigId] = useState<string | null>(existing === null ? null : existing.id);
  const [busy, setBusy] = useState<'none' | 'testing' | 'enabling' | 'saving'>('none');
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [workflow, setWorkflow] = useState<string>(() => savedWorkflowTemplate(existing));
  const [capabilities, setCapabilities] = useState<Record<string, unknown> | null>(() =>
    savedCapabilityOverride(existing),
  );

  const workflowProblem = workflowTemplateProblem(workflow);
  const trimmedUrl = baseUrl.trim();
  const idle = busy === 'none';
  const canSave = idle && trimmedUrl.length > 0 && workflowProblem === null;

  /**
   * The options the server stores. Other keys a saved config carries are kept, and
   * the graph keys are always present, so clearing the last one clears it on disk.
   */
  const optionsDraft = useCallback((): Record<string, unknown> | undefined => {
    if (!isComfy) return undefined;
    const next: Record<string, unknown> = { ...(existing?.options ?? {}) };
    delete next['workflowTemplate'];
    delete next['capabilities'];
    const template = workflow.trim();
    if (template.length > 0) next['workflowTemplate'] = template;
    if (capabilities !== null) next['capabilities'] = capabilities;
    return next;
  }, [capabilities, existing, isComfy, workflow]);

  const draft = useCallback((): Omit<ProviderConfig, 'id'> => {
    const base: Omit<ProviderConfig, 'id'> = { kind: meta.kind, label: meta.label, baseUrl: trimmedUrl };
    const options = optionsDraft();
    return options === undefined ? base : { ...base, options };
  }, [meta.kind, meta.label, optionsDraft, trimmedUrl]);

  const persist = useCallback(async (): Promise<ProviderConfig> => {
    if (configId === null) {
      const created = await createProvider({ ...draft(), enabled: false });
      setConfigId(created.id);
      return created;
    }
    return updateProvider(configId, draft());
  }, [configId, draft]);

  const testConnection = useCallback(async (): Promise<void> => {
    setBusy('testing');
    setStatus(null);
    try {
      const saved = await persist();
      const health: ProviderHealth = await checkProviderHealth(saved.id);
      setStatus(
        health.ok
          ? { tone: 'ok', message: health.detail ?? 'The provider answered.' }
          : { tone: 'error', message: health.detail ?? 'The provider did not answer.' },
      );
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [persist]);

  const saveGraph = useCallback(async (): Promise<void> => {
    setBusy('saving');
    setStatus(null);
    try {
      await persist();
      setStatus({ tone: 'ok', message: 'The graph is saved. This provider uses it on the next run.' });
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [persist]);

  const enable = useCallback(async (): Promise<void> => {
    setBusy('enabling');
    setStatus(null);
    try {
      const saved =
        configId === null
          ? await createProvider({ ...draft(), enabled: true })
          : await updateProvider(configId, { ...draft(), enabled: true });
      setConfigId(saved.id);
      setBusy('none');
      onEnabled(saved);
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
      setBusy('none');
    }
  }, [configId, draft, onEnabled]);

  return (
    <section className="setup-card" aria-labelledby={`setup-${meta.kind}`}>
      <div className="setup-card-head">
        <h3 className="setup-card-title" id={`setup-${meta.kind}`}>
          {meta.label}
        </h3>
        <span className="data">{meta.kind}</span>
      </div>
      <p className="setup-card-summary">{meta.summary}</p>
      <Field
        label={`${meta.label} base URL`}
        value={baseUrl}
        spellCheck={false}
        autoComplete="off"
        disabled={!idle}
        hint={`Default: ${meta.defaultBaseUrl}`}
        onChange={(event) => {
          setBaseUrl(event.target.value);
        }}
      />
      <div className="setup-card-actions">
        <Button variant="secondary" busy={busy === 'testing'} disabled={!canSave} onClick={() => void testConnection()}>
          Test connection
        </Button>
        <Button variant="primary" busy={busy === 'enabling'} disabled={!canSave} onClick={() => void enable()}>
          Enable
        </Button>
      </div>
      {status === null ? null : (
        <p className={status.tone === 'ok' ? 'setup-status is-ok' : 'setup-status is-error'} role="status">
          {status.message}
        </p>
      )}
      {isComfy ? (
        <section className="setup-advanced" aria-labelledby={`${graphId}-title`}>
          <button
            type="button"
            className="setup-advanced-toggle"
            aria-expanded={graphOpen}
            aria-controls={`${graphId}-panel`}
            onClick={() => {
              setGraphOpen(!graphOpen);
            }}
          >
            <svg className="icon setup-disclosure-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9.5 6.5L15 12l-5.5 5.5" />
            </svg>
            <span className="setup-advanced-title" id={`${graphId}-title`}>
              Advanced graph
            </span>
            <span className="setup-advanced-count">
              {workflow.trim().length === 0 ? 'Default graph' : 'Custom graph'}
            </span>
          </button>
          <div className="setup-advanced-panel" id={`${graphId}-panel`} hidden={!graphOpen}>
            <div className="field">
              <label className="field-label" htmlFor={workflowId}>
                Workflow template
              </label>
              <textarea
                id={workflowId}
                className="field-textarea setup-code"
                rows={10}
                spellCheck={false}
                autoComplete="off"
                value={workflow}
                disabled={!idle}
                aria-invalid={workflowProblem === null ? undefined : true}
                aria-describedby={workflowProblem === null ? workflowHintId : `${workflowHintId} ${workflowId}-error`}
                placeholder={`{\n  "3": {\n    "class_type": "KSampler",\n    "inputs": { "seed": "{{seed}}", "steps": "{{steps}}" }\n  }\n}`}
                onChange={(event) => {
                  setWorkflow(event.target.value);
                }}
              />
              <p className="field-hint" id={workflowHintId}>
                Available placeholders:{' '}
                {WORKFLOW_PLACEHOLDERS.map((name, index) => (
                  <span key={name}>
                    {index === 0 ? null : ', '}
                    <code className="setup-token">{`{{${name}}}`}</code>
                  </span>
                ))}
                . The value must be in ComfyUI API format (Workflow menu, Export (API)), not the normal saved
                workflow. An empty value keeps the adapter's built in graph.
              </p>
              {workflowProblem === null ? null : (
                <p className="field-error" id={`${workflowId}-error`} role="alert">
                  {workflowProblem}
                </p>
              )}
            </div>
            <div className="setup-advanced-actions">
              <Button
                variant="secondary"
                size="sm"
                busy={busy === 'saving'}
                disabled={!canSave}
                onClick={() => void saveGraph()}
              >
                Save graph
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!idle}
                onClick={() => {
                  setWorkflow(H3_IMAGE_TEMPLATE_JSON);
                }}
              >
                Load H3 Image graph
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!idle}
                onClick={() => {
                  setCapabilities({ ...H3_IMAGE_CAPABILITIES });
                }}
              >
                H3 Image capabilities
              </Button>
            </div>
            {capabilities === null ? null : (
              <div className="setup-override">
                <p className="setup-override-summary">{describeCapabilityOverride(capabilities)}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!idle}
                  onClick={() => {
                    setCapabilities(null);
                  }}
                >
                  Clear override
                </Button>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </section>
  );
}
