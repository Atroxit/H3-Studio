// The studio frame: top bar, left rail, centre canvas, right inspector.
// Feature screens mount into the slots below. Nothing here renders a features
// screen, and nothing styles their internal markup.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
import { readH3ExpanderState, setH3ExpanderState } from './features/generate/helpers';
import {
  adoptPromptSettings,
  applyPresetToForm,
  openStoredBatch,
  startNewImage,
} from './features/generate/useGeneration';
import {
  StudioProvider,
  isProviderEnabled,
  useStudio,
  type PromptSettings,
  type StudioContextValue,
  type StudioView,
} from './studio';
import './styles/topbar.css';

export { StudioProvider, useStudio, isProviderEnabled };
export type { StudioContextValue, StudioView };

// Checked once at startup: only the desktop shell reports Electron in its user agent.
// The class lets CSS reserve the window control strip and make the top bar a drag
// region. In the browser neither applies, so no mysterious gap appears there.
if (typeof navigator !== 'undefined' && typeof document !== 'undefined' && navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('is-desktop');
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
  maxReferenceImages: 4,
  maxBatch: 4,
  arbitrarySize: true,
  sizeMultiple: 32,
  presets: [
    { id: '1024x1024', label: '1024x1024 (1 MP Fast)', width: 1024, height: 1024 },
    { id: '2048x2048', label: '2048x2048 (4 MP)', width: 2048, height: 2048 },
    { id: '4096x4096', label: '4096x4096', width: 4096, height: 4096 },
    { id: '4736x3552', label: '4736x3552', width: 4736, height: 3552 },
    { id: '3552x4736', label: '3552x4736', width: 3552, height: 4736 },
    { id: '5472x3072', label: '5472x3072', width: 5472, height: 3072 },
    { id: '3072x5472', label: '3072x5472', width: 3072, height: 5472 },
  ],
  outputFormats: ['png'],
  streamingProgress: true,
  notes: [
    'H3 fixes 6 steps and guidance 1, and it rejects a negative prompt.',
    'H3 alters an existing image from up to 4 reference images, named in the prompt as <Picture 1> and so on.',
    'Batches above one run as sequential single image prompts.',
  ],
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

/** The saved ComfyUI timeout in seconds, with the adapter default of 900 s. */
function savedTimeoutSeconds(existing: ProviderConfig | null): string {
  const raw = existing?.options?.['timeoutMs'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? String(raw / 1000) : '900';
}

function sameJson(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Arguments are edited as text: space separated, one per line, or a JSON array. */
function savedLaunchArguments(existing: ProviderConfig | null): string {
  const args = existing?.launch?.args ?? [];
  if (args.length === 0) return '';
  return args.some((arg) => /\s/.test(arg)) ? JSON.stringify(args) : args.join(' ');
}

/** Null when a JSON array is malformed, so the field can say so instead of guessing. */
function parseLaunchArguments(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const args: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') return null;
      args.push(entry);
    }
    return args;
  }
  if (trimmed.includes('\n')) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return trimmed.split(/\s+/);
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

const SELECTED_PROVIDER_KEY = 'h3-studio:selected-provider';

const RAIL_WIDTH_DEFAULT = 260;
const RAIL_WIDTH_MIN = 200;
const RAIL_WIDTH_MAX = 520;
const RAIL_WIDTH_STORAGE_KEY = 'h3-studio.railWidth';

const INSPECTOR_WIDTH_DEFAULT = 300;
const INSPECTOR_WIDTH_MIN = 240;
const INSPECTOR_WIDTH_MAX = 560;
const INSPECTOR_WIDTH_STORAGE_KEY = 'h3-studio.inspectorWidth';

const RESIZE_STEP = 16;

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return fallback;
    return clampWidth(parsed, min, max);
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Private mode or a blocked storage area leaves the width in memory only.
  }
}

function readSelectedProvider(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SELECTED_PROVIDER_KEY);
  } catch {
    return null;
  }
}

function persistSelectedProvider(providerId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (providerId === null) window.localStorage.removeItem(SELECTED_PROVIDER_KEY);
    else window.localStorage.setItem(SELECTED_PROVIDER_KEY, providerId);
  } catch {
    // Private mode or a blocked storage area leaves the choice in memory only.
  }
}

export function App({ slots = {} }: AppProps): ReactNode {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [stats, setStats] = useState<StudioStats | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(readSelectedProvider);
  const [view, setView] = useState<StudioView>(readViewFromLocation);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [railWidth, setRailWidth] = useState<number>(() =>
    readStoredWidth(RAIL_WIDTH_STORAGE_KEY, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX),
  );
  const [inspectorWidth, setInspectorWidth] = useState<number>(() =>
    readStoredWidth(INSPECTOR_WIDTH_STORAGE_KEY, INSPECTOR_WIDTH_DEFAULT, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX),
  );

  const detachResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    writeStoredWidth(RAIL_WIDTH_STORAGE_KEY, railWidth);
  }, [railWidth]);

  useEffect(() => {
    writeStoredWidth(INSPECTOR_WIDTH_STORAGE_KEY, inspectorWidth);
  }, [inspectorWidth]);

  // A drag that is still running when the frame unmounts must not keep its window listeners.
  useEffect(
    () => () => {
      detachResizeRef.current?.();
    },
    [],
  );

  const startResize = useCallback(
    (side: 'rail' | 'inspector', event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = side === 'rail' ? railWidth : inspectorWidth;
      const min = side === 'rail' ? RAIL_WIDTH_MIN : INSPECTOR_WIDTH_MIN;
      const max = side === 'rail' ? RAIL_WIDTH_MAX : INSPECTOR_WIDTH_MAX;
      const apply = side === 'rail' ? setRailWidth : setInspectorWidth;

      function handleMove(moveEvent: PointerEvent): void {
        const delta = side === 'rail' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        apply(clampWidth(startWidth + delta, min, max));
      }

      function detach(): void {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (detachResizeRef.current === detach) detachResizeRef.current = null;
      }

      function finish(): void {
        detach();
      }

      detachResizeRef.current?.();
      detachResizeRef.current = detach;
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [railWidth, inspectorWidth],
  );

  const handleResizeKey = useCallback(
    (side: 'rail' | 'inspector', event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const isRail = side === 'rail';
      const current = isRail ? railWidth : inspectorWidth;
      const min = isRail ? RAIL_WIDTH_MIN : INSPECTOR_WIDTH_MIN;
      const max = isRail ? RAIL_WIDTH_MAX : INSPECTOR_WIDTH_MAX;
      let next: number | null = null;
      if (event.key === 'Home') next = isRail ? RAIL_WIDTH_DEFAULT : INSPECTOR_WIDTH_DEFAULT;
      else if (event.key === 'ArrowLeft') next = current + (isRail ? -RESIZE_STEP : RESIZE_STEP);
      else if (event.key === 'ArrowRight') next = current + (isRail ? RESIZE_STEP : -RESIZE_STEP);
      if (next === null) return;
      event.preventDefault();
      if (isRail) setRailWidth(clampWidth(next, min, max));
      else setInspectorWidth(clampWidth(next, min, max));
    },
    [railWidth, inspectorWidth],
  );

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

  // The browser chrome colour comes from the same token as the canvas, so the HTML
  // stays free of literal colours and the two can never drift apart.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const canvasTop = getComputedStyle(document.documentElement).getPropertyValue('--canvas-top').trim();
    if (meta !== null && canvasTop.length > 0) meta.setAttribute('content', canvasTop);
  }, []);

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
    if (selected !== undefined) return selected;
    const nonMock = enabledProviders.find((candidate) => candidate.kind !== 'mock');
    if (nonMock !== undefined) return nonMock;
    const mock = enabledProviders.find((candidate) => candidate.kind === 'mock');
    return mock ?? enabledProviders[0] ?? null;
  }, [enabledProviders, selectedId]);

  useEffect(() => {
    persistSelectedProvider(provider === null ? null : provider.id);
  }, [provider]);

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success'): void => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  const openBatch = useCallback((batchId: string): void => {
    void openStoredBatch(batchId);
  }, []);

  const newImage = useCallback((): void => {
    selectView('generate');
    startNewImage();
  }, [selectView]);

  const alterImage = useCallback(
    (batchId: string, imageId: string): void => {
      selectView('generate');
      void openStoredBatch(batchId, imageId);
    },
    [selectView],
  );

  const applyPreset = useCallback(
    (preset: Preset): void => {
      applyPresetToForm(preset, provider === null ? null : provider.id);
      selectView('generate');
    },
    [provider, selectView],
  );

  const useSettings = useCallback(
    (settings: PromptSettings): void => {
      const requested = settings.providerId;
      const target =
        requested !== undefined && enabledProviders.some((candidate) => candidate.id === requested)
          ? requested
          : provider === null
            ? null
            : provider.id;
      if (target !== null && target !== (provider === null ? null : provider.id)) setSelectedId(target);
      adoptPromptSettings(settings, target);
      selectView('generate');
    },
    [enabledProviders, provider, selectView],
  );

  const contextValue = useMemo<StudioContextValue>(
    () => ({
      providers,
      provider,
      selectProvider: setSelectedId,
      stats,
      presets,
      view,
      selectView,
      openBatch,
      newImage,
      alterImage,
      applyPreset,
      useSettings,
      notify,
      refresh,
    }),
    [
      providers,
      provider,
      stats,
      presets,
      view,
      selectView,
      openBatch,
      newImage,
      alterImage,
      applyPreset,
      useSettings,
      notify,
      refresh,
    ],
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

          <div
            className={
              view === 'library' ? 'studio-body is-library' : inspectorOpen ? 'studio-body' : 'studio-body is-collapsed'
            }
            style={{ '--rail-width': `${railWidth}px`, '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
          >
            <aside className="rail" aria-label="Library summary and presets">
              <Button variant="primary" className="rail-new-btn" onClick={newImage}>
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5.5v13M5.5 12h13" />
                </svg>
                New image
              </Button>

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
                      <li key={preset.id}>
                        <button
                          type="button"
                          className="preset-chip"
                          title={`Apply ${preset.name}`}
                          onClick={() => {
                            applyPreset(preset);
                          }}
                        >
                          <span className="preset-chip-name">{preset.name}</span>
                          <span className="preset-chip-meta">
                            {preset.width} x {preset.height} / {preset.count}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize left sidebar"
              aria-valuemin={RAIL_WIDTH_MIN}
              aria-valuemax={RAIL_WIDTH_MAX}
              aria-valuenow={railWidth}
              tabIndex={0}
              className="pane-resizer is-rail"
              title="Drag to resize, double click to reset"
              onPointerDown={(event) => {
                startResize('rail', event);
              }}
              onDoubleClick={() => {
                setRailWidth(RAIL_WIDTH_DEFAULT);
              }}
              onKeyDown={(event) => {
                handleResizeKey('rail', event);
              }}
            />

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

            {view === 'generate' && inspectorOpen ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize right sidebar"
                aria-valuemin={INSPECTOR_WIDTH_MIN}
                aria-valuemax={INSPECTOR_WIDTH_MAX}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                className="pane-resizer is-inspector"
                title="Drag to resize, double click to reset"
                onPointerDown={(event) => {
                  startResize('inspector', event);
                }}
                onDoubleClick={() => {
                  setInspectorWidth(INSPECTOR_WIDTH_DEFAULT);
                }}
                onKeyDown={(event) => {
                  handleResizeKey('inspector', event);
                }}
              />
            ) : null}

            {view === 'generate' ? (
              <aside
                className={inspectorOpen ? 'inspector' : 'inspector is-collapsed'}
                aria-label="Generation controls"
              >
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
            ) : null}
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
  const { refresh } = useStudio();
  const graphId = useId();
  const workflowId = `${graphId}-workflow`;
  const workflowHintId = `${graphId}-workflow-hint`;
  const expanderId = `${graphId}-expander`;
  // Only ComfyUI reads a graph, so only its card grows the advanced section.
  const isComfy = meta.kind === 'comfyui';
  // The mock runs inside the server, so there is nothing for the studio to start.
  const supportsLaunch = meta.kind !== 'mock';
  const displayLabel = existing === null ? meta.label : existing.label;
  const enabled = existing !== null && existing.enabled !== false;

  const [baseUrl, setBaseUrl] = useState(existing === null ? meta.defaultBaseUrl : existing.baseUrl);
  const [configId, setConfigId] = useState<string | null>(existing === null ? null : existing.id);
  const [busy, setBusy] = useState<'none' | 'testing' | 'enabling' | 'saving' | 'disabling'>('none');
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [workflow, setWorkflow] = useState<string>(() => savedWorkflowTemplate(existing));
  const [capabilities, setCapabilities] = useState<Record<string, unknown> | null>(() =>
    savedCapabilityOverride(existing),
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>(() => savedTimeoutSeconds(existing));
  const [launchEnabled, setLaunchEnabled] = useState<boolean>(() => existing?.launch?.enabled === true);
  const [launchCommand, setLaunchCommand] = useState<string>(() => existing?.launch?.command ?? '');
  const [launchArgs, setLaunchArgs] = useState<string>(() => savedLaunchArguments(existing));
  const [launchCwd, setLaunchCwd] = useState<string>(() => existing?.launch?.cwd ?? '');

  const workflowProblem = workflowTemplateProblem(workflow);
  const trimmedUrl = baseUrl.trim();
  const idle = busy === 'none';
  const timeoutValue = Number(timeoutSeconds);
  const timeoutValid =
    isComfy && timeoutSeconds.trim().length > 0 && Number.isInteger(timeoutValue) && timeoutValue > 0;
  const timeoutProblem = isComfy && !timeoutValid ? 'Timeout must be a whole number of seconds above zero.' : null;
  const parsedLaunchArgs = parseLaunchArguments(launchArgs);
  const launchProblem =
    supportsLaunch && launchEnabled && launchCommand.trim().length === 0
      ? 'A command is needed before the studio can start this provider.'
      : supportsLaunch && parsedLaunchArgs === null
        ? 'Arguments must be space separated, one per line, or a JSON array of strings.'
        : null;
  const canSave =
    idle &&
    trimmedUrl.length > 0 &&
    workflowProblem === null &&
    launchProblem === null &&
    (!isComfy || timeoutValid);
  const expanderState = isComfy ? readH3ExpanderState(workflow) : null;
  const launchDirty =
    supportsLaunch &&
    (launchEnabled !== (existing?.launch?.enabled === true) ||
      launchCommand.trim() !== (existing?.launch?.command ?? '').trim() ||
      JSON.stringify(parsedLaunchArgs) !== JSON.stringify(existing?.launch?.args ?? []) ||
      launchCwd.trim() !== (existing?.launch?.cwd ?? '').trim());
  const dirty =
    existing === null ||
    trimmedUrl !== existing.baseUrl ||
    workflow !== savedWorkflowTemplate(existing) ||
    !sameJson(capabilities, savedCapabilityOverride(existing)) ||
    launchDirty ||
    (isComfy && timeoutSeconds !== savedTimeoutSeconds(existing));

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
    if (timeoutValid) next['timeoutMs'] = Math.round(timeoutValue * 1000);
    return next;
  }, [capabilities, existing, isComfy, timeoutValid, timeoutValue, workflow]);

  const draft = useCallback((): Omit<ProviderConfig, 'id'> => {
    const base: Omit<ProviderConfig, 'id'> = {
      kind: meta.kind,
      label: existing === null ? meta.label : existing.label,
      baseUrl: trimmedUrl,
    };
    // Autostart is saved even when it is off, so turning it off is a real edit rather
    // than a field that silently keeps the old command.
    if (supportsLaunch && parsedLaunchArgs !== null) {
      base.launch = {
        enabled: launchEnabled,
        command: launchCommand.trim(),
        args: parsedLaunchArgs,
        cwd: launchCwd.trim().length > 0 ? launchCwd.trim() : undefined,
      };
    }
    const options = optionsDraft();
    return options === undefined ? base : { ...base, options };
  }, [
    existing,
    launchArgs,
    launchCommand,
    launchCwd,
    launchEnabled,
    meta.kind,
    meta.label,
    optionsDraft,
    parsedLaunchArgs,
    supportsLaunch,
    trimmedUrl,
  ]);

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
      // A clean saved config is tested in place. Unsaved edits are written first, and the
      // message says so, because testing must use the values in the fields.
      const saved =
        existing !== null && !dirty && configId !== null ? existing : await persist();
      const health: ProviderHealth = await checkProviderHealth(saved.id);
      const prefix = saved === existing ? '' : 'Saved the changes, then tested. ';
      setStatus(
        health.ok
          ? { tone: 'ok', message: `${prefix}${health.detail ?? 'The provider answered.'}` }
          : { tone: 'error', message: `${prefix}${health.detail ?? 'The provider did not answer.'}` },
      );
      if (saved !== existing) void refresh();
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [configId, dirty, existing, persist, refresh]);

  const saveGraph = useCallback(async (): Promise<void> => {
    setBusy('saving');
    setStatus(null);
    try {
      await persist();
      setStatus({ tone: 'ok', message: 'The settings are saved. This provider uses them on the next run.' });
      void refresh();
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [persist, refresh]);

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

  const disable = useCallback(async (): Promise<void> => {
    if (existing === null) return;
    setBusy('disabling');
    setStatus(null);
    try {
      await updateProvider(existing.id, { enabled: false });
      await refresh();
      setStatus({ tone: 'ok', message: `${existing.label} is disabled.` });
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [existing, refresh]);

  return (
    <section className="setup-card" aria-labelledby={`setup-${meta.kind}`}>
      <div className="setup-card-head">
        <h3 className="setup-card-title" id={`setup-${meta.kind}`}>
          {displayLabel}
        </h3>
        <span className="setup-card-meta">
          <span className={enabled ? 'setup-state is-enabled' : 'setup-state'}>{enabled ? 'Enabled' : 'Disabled'}</span>
          <span className="data">{meta.kind}</span>
        </span>
      </div>
      <p className="setup-card-summary">{meta.summary}</p>
      <Field
        label={`${displayLabel} base URL`}
        value={baseUrl}
        spellCheck={false}
        autoComplete="off"
        disabled={!idle}
        hint={`Default: ${meta.defaultBaseUrl}`}
        onChange={(event) => {
          setBaseUrl(event.target.value);
        }}
      />
      {isComfy ? (
        <Field
          label="Timeout (s)"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={timeoutSeconds}
          disabled={!idle}
          invalid={!timeoutValid}
          hint={timeoutProblem ?? 'The H3 default is 900 s (15 minutes).'}
          onChange={(event) => {
            setTimeoutSeconds(event.target.value);
          }}
        />
      ) : null}
      {supportsLaunch ? (
        <section className="setup-launch" aria-labelledby={`${graphId}-launch`}>
          <label className="setup-check" htmlFor={`${graphId}-launch-enabled`}>
            <input
              id={`${graphId}-launch-enabled`}
              type="checkbox"
              checked={launchEnabled}
              disabled={!idle}
              onChange={(event) => {
                setLaunchEnabled(event.target.checked);
              }}
            />
            <span className="setup-check-copy">
              <span className="setup-check-title" id={`${graphId}-launch`}>
                Auto-start with H3 Studio
              </span>
              <span className="field-hint">
                Runs this command when the studio starts, and stops it again when the studio quits.
              </span>
            </span>
          </label>
          {launchEnabled ? (
            <div className="setup-launch-fields">
              <Field
                label="Command"
                value={launchCommand}
                spellCheck={false}
                autoComplete="off"
                disabled={!idle}
                placeholder="python"
                hint="The program to run. A bare name is looked up on PATH."
                onChange={(event) => {
                  setLaunchCommand(event.target.value);
                }}
              />
              <Field
                label="Arguments"
                value={launchArgs}
                spellCheck={false}
                autoComplete="off"
                disabled={!idle}
                invalid={parsedLaunchArgs === null}
                placeholder="main.py --listen 127.0.0.1"
                hint={launchProblem ?? 'Space separated, one per line, or a JSON array of strings.'}
                onChange={(event) => {
                  setLaunchArgs(event.target.value);
                }}
              />
              <Field
                label="Working folder"
                value={launchCwd}
                spellCheck={false}
                autoComplete="off"
                disabled={!idle}
                placeholder="Optional, for example the ComfyUI folder"
                hint="Optional. The command runs from here."
                onChange={(event) => {
                  setLaunchCwd(event.target.value);
                }}
              />
            </div>
          ) : null}
          {launchProblem === null ? null : (
            <p className="field-error" role="alert">
              {launchProblem}
            </p>
          )}
        </section>
      ) : null}
      <div className="setup-card-actions">
        <Button variant="secondary" busy={busy === 'testing'} disabled={!canSave} onClick={() => void testConnection()}>
          {dirty ? 'Save and test' : 'Test connection'}
        </Button>
        <Button variant="primary" busy={busy === 'enabling'} disabled={!canSave} onClick={() => void enable()}>
          Enable
        </Button>
        {enabled ? (
          <Button variant="ghost" busy={busy === 'disabling'} disabled={!idle} onClick={() => void disable()}>
            Disable
          </Button>
        ) : null}
        {dirty ? <span className="setup-dirty">Unsaved changes</span> : null}
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
          {expanderState === null ? null : (
            <label className="setup-check" htmlFor={expanderId}>
              <input
                id={expanderId}
                type="checkbox"
                checked={expanderState}
                disabled={!idle}
                onChange={(event) => {
                  const next = setH3ExpanderState(workflow, event.target.checked);
                  if (next !== null) setWorkflow(next);
                }}
              />
              <span className="setup-check-copy">
                <span className="setup-check-title">H3 Prompt Expander (Qwen3.5 9B)</span>
                <span className="field-hint">Enabling runs the 9B caption expander before the image model.</span>
              </span>
            </label>
          )}
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
                Save settings
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
                  if (!timeoutValid) setTimeoutSeconds('900');
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
