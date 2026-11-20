// The studio frame: top bar, left rail, centre canvas, right inspector.
// Feature screens mount into the slots below. Nothing here renders a features
// screen, and nothing styles their internal markup.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { Preset, ProviderConfig } from '../core/types';
import {
  getProviderStatus,
  getStats,
  listPresets,
  listProviders,
  type ProviderStatus,
  type ProviderStatusState,
  type StudioStats,
} from './api';
import { Button, EmptyState, SegmentedControl, Select, Spinner, Toast } from './components';
import {
  adoptPromptSettings,
  applyPresetToForm,
  openStoredBatch,
  startNewImage,
} from './features/generate/useGeneration';
import { SettingsView, type SettingsTab } from './features/settings/SettingsView';
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

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

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

/** How often the top bar asks about the backend: fast while it settles, slow once ready. */
const STATUS_POLL_ACTIVE_MS = 2500;
const STATUS_POLL_READY_MS = 15_000;

const BACKEND_STATUS_LABELS: Readonly<Record<ProviderStatusState, string>> = {
  ready: 'Ready',
  starting: 'Starting...',
  offline: 'Offline',
  error: 'Error',
};

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
  /** The Settings tab to open, or null while the studio is on screen. */
  const [settingsRequest, setSettingsRequest] = useState<SettingsTab | null>(null);
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
      // Presets stay on the context for the API, but a failed read must not blank the studio.
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

  // Enabling a provider keeps Settings open: the user may still be tuning it. The studio
  // just selects it, so leaving Settings lands on a working Generate screen. On a first run
  // the screen was shown because nothing was enabled, so it records a real tab now and the
  // back button appears instead of the view being pulled away mid setup.
  const handleProviderEnabled = useCallback(
    (saved: ProviderConfig) => {
      setSelectedId(saved.id);
      setSettingsRequest((current) => current ?? 'wizard');
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

  const [backendStatus, setBackendStatus] = useState<ProviderStatus | null>(null);

  // The selected provider's backend is polled on a timer, faster while it is starting so
  // the pill settles quickly, slower once it is ready so an idle studio stays quiet.
  useEffect(() => {
    if (provider === null) {
      setBackendStatus(null);
      return;
    }
    const providerId = provider.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delayMs: number): void => {
      timer = setTimeout(() => {
        void poll();
      }, delayMs);
    };
    const poll = async (): Promise<void> => {
      let next: ProviderStatus;
      try {
        next = await getProviderStatus(providerId);
      } catch {
        next = { state: 'offline', detail: 'The provider status could not be read.' };
      }
      if (cancelled) return;
      setBackendStatus(next);
      schedule(next.state === 'ready' ? STATUS_POLL_READY_MS : STATUS_POLL_ACTIVE_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [provider]);

  useEffect(() => {
    persistSelectedProvider(provider === null ? null : provider.id);
  }, [provider]);

  /**
   * Opens Settings. With nothing enabled the wizard is the only useful tab; with a backend
   * that is down the provider form is, because that is where the address is fixed. Every
   * other visit starts on the wizard, which is also what the top bar button says.
   */
  const openSettings = useCallback(
    (preferred?: SettingsTab): void => {
      if (preferred !== undefined) {
        setSettingsRequest(preferred);
        return;
      }
      if (enabledProviders.length === 0) {
        setSettingsRequest('wizard');
        return;
      }
      const unreachable =
        backendStatus !== null && (backendStatus.state === 'offline' || backendStatus.state === 'error');
      setSettingsRequest(unreachable ? 'providers' : 'wizard');
    },
    [backendStatus, enabledProviders.length],
  );

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
      {enabledProviders.length === 0 || settingsRequest !== null ? (
        <SettingsView
          initialTab={settingsRequest ?? 'wizard'}
          canClose={enabledProviders.length > 0}
          onClose={() => {
            setSettingsRequest(null);
          }}
          onProviderEnabled={handleProviderEnabled}
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
                  {backendStatus === null ? null : (
                    <button
                      type="button"
                      className={`topbar-backend-status is-${backendStatus.state}`}
                      title={backendStatus.detail ?? backendStatus.state}
                      onClick={() => {
                        openSettings('providers');
                      }}
                    >
                      <span className="topbar-backend-dot" aria-hidden="true" />
                      {BACKEND_STATUS_LABELS[backendStatus.state]}
                    </button>
                  )}
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
                title="Settings"
                aria-label="Settings"
                onClick={() => {
                  openSettings();
                }}
              >
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M5 8h9M18 8h1M5 16h3M12 16h7" />
                  <circle cx="16" cy="8" r="2" />
                  <circle cx="10" cy="16" r="2" />
                </svg>
                Settings
              </Button>
            </div>
          </header>

          <div
            className={
              view === 'library' ? 'studio-body is-library' : inspectorOpen ? 'studio-body' : 'studio-body is-collapsed'
            }
            style={{ '--rail-width': `${railWidth}px`, '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
          >
            <aside className="rail" aria-label="Library history">
              <Button variant="primary" className="rail-new-btn" onClick={newImage}>
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5.5v13M5.5 12h13" />
                </svg>
                New image
              </Button>

              <section className="rail-section is-history">
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
