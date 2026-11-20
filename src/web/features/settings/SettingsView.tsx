// The Settings screen: hardware scan, the Setup Wizard, the provider form and the
// performance defaults, on one designed surface that matches Generate and Library.
//
// It replaces the whole studio instead of covering it, exactly like the old setup screen
// did, so nothing here sits on a broken 100vh frame: the screen is a flex column, the
// header never scrolls away, and only the tab body scrolls.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProviderConfig, SystemProfile } from '../../../core/types';
import { getSystemProfile } from '../../api';
import { isProviderEnabled, useStudio } from '../../studio';
import { describeError, hardwarePillText } from './helpers';
import { PerformancePanel } from './PerformancePanel';
import { ProvidersPanel } from './ProvidersPanel';
import { SetupWizard } from './SetupWizard';
import './settings.css';

export type SettingsTab = 'wizard' | 'providers' | 'performance';

const TABS: readonly { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'wizard', label: 'Setup Wizard', hint: 'Scan this machine and tune everything' },
  { id: 'providers', label: 'Providers', hint: 'Connect and configure backends' },
  { id: 'performance', label: 'Performance & Defaults', hint: 'Canvas, models and launch flags' },
];

export interface SettingsViewProps {
  /** Which tab opens first. The wizard is the default when nothing is enabled yet. */
  initialTab: SettingsTab;
  /** False when no provider is enabled: there is no studio to go back to. */
  canClose: boolean;
  onClose: () => void;
  /** Called with a provider that was just enabled, so the studio selects it. */
  onProviderEnabled: (saved: ProviderConfig) => void;
}

function SparkleIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4.5l1.6 4.4L18 10.5l-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6z" />
      <path d="M17.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

function PlugIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 01-11 0z" />
      <path d="M12 16v4.5" />
    </svg>
  );
}

function SlidersIcon(): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 8h9M18 8h1M5 16h3M12 16h7" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="10" cy="16" r="2" />
    </svg>
  );
}

const TAB_ICONS: Readonly<Record<SettingsTab, () => ReactNode>> = {
  wizard: SparkleIcon,
  providers: PlugIcon,
  performance: SlidersIcon,
};

export function SettingsView({
  initialTab,
  canClose,
  onClose,
  onProviderEnabled,
}: SettingsViewProps): ReactNode {
  const studio = useStudio();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [profile, setProfile] = useState<SystemProfile | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const tabRefs = useRef<Map<SettingsTab, HTMLButtonElement | null>>(new Map());

  const enabledCount = useMemo(
    () => studio.providers.filter(isProviderEnabled).length,
    [studio.providers],
  );

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const next = await getSystemProfile();
      setProfile(next);
      setScanError(null);
    } catch (error) {
      setScanError(describeError(error));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  // The setup screen replaces the studio, so the control that opened it is gone. Moving
  // focus to the heading keeps a keyboard user anchored on the screen they just opened.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const selectTab = useCallback((next: SettingsTab): void => {
    setTab(next);
  }, []);

  const handleTabKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, current: SettingsTab): void => {
      const order = TABS.map((entry) => entry.id);
      const position = order.indexOf(current);
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') nextIndex = (position + 1) % order.length;
      else if (event.key === 'ArrowLeft') nextIndex = (position - 1 + order.length) % order.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = order.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      const next = order[nextIndex];
      if (next === undefined) return;
      selectTab(next);
      tabRefs.current.get(next)?.focus();
    },
    [selectTab],
  );

  const pillText = profile === null ? (scanning ? 'Scanning hardware' : 'Hardware not read yet') : hardwarePillText(profile);

  return (
    <div className="settings-screen">
      {/* In the desktop shell the studio top bar is gone, so this strip keeps a place to
          drag the window from. The browser renders nothing here. */}
      <div className="settings-drag" aria-hidden="true" />

      <header className="settings-top">
        <div className="settings-inner is-head">
          <div className="settings-head-row">
            {canClose ? (
              <button type="button" className="settings-back" onClick={onClose}>
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M14.5 6.5L9 12l5.5 5.5" />
                </svg>
                Back to studio
              </button>
            ) : (
              <span className="settings-back is-placeholder" aria-hidden="true" />
            )}
            <div className="settings-title-block">
              <h1 className="settings-title" ref={titleRef} tabIndex={-1}>
                Settings
              </h1>
              <p className="settings-subtitle">Hardware, models and launch tuning for this machine.</p>
            </div>
            <button
              type="button"
              className={profile === null ? 'settings-hardware-pill is-idle' : 'settings-hardware-pill'}
              title={profile === null ? 'Hardware detection has not answered yet' : `Detected ${profile.detectedAt}`}
              onClick={() => {
                void scan();
              }}
              aria-label={`${pillText}. Scan again`}
            >
              <span className="settings-hardware-dot" aria-hidden="true" />
              <span className="settings-hardware-text">{pillText}</span>
            </button>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((entry) => {
              const Icon = TAB_ICONS[entry.id];
              const active = entry.id === tab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${entry.id}`}
                  aria-selected={active}
                  aria-controls={`settings-panel-${entry.id}`}
                  tabIndex={active ? 0 : -1}
                  title={entry.hint}
                  className={active ? 'settings-tab is-active' : 'settings-tab'}
                  ref={(element) => {
                    tabRefs.current.set(entry.id, element);
                  }}
                  onClick={() => {
                    selectTab(entry.id);
                  }}
                  onKeyDown={(event) => {
                    handleTabKey(event, entry.id);
                  }}
                >
                  <Icon />
                  <span className="settings-tab-label">{entry.label}</span>
                  {entry.id === 'providers' ? (
                    <span
                      className={enabledCount > 0 ? 'settings-tab-count is-live' : 'settings-tab-count'}
                      aria-label={`${enabledCount} enabled`}
                    >
                      <span className="settings-tab-dot" aria-hidden="true" />
                      {enabledCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="settings-scroll">
        <div className="settings-inner">
          <section
            role="tabpanel"
            id={`settings-panel-${tab}`}
            aria-labelledby={`settings-tab-${tab}`}
            className="settings-panel"
          >
            {tab === 'wizard' ? (
              <SetupWizard
                profile={profile}
                scanning={scanning}
                scanError={scanError}
                canClose={canClose}
                onRescan={scan}
                onProfile={setProfile}
                onClose={onClose}
              />
            ) : null}
            {tab === 'providers' ? <ProvidersPanel onProviderEnabled={onProviderEnabled} /> : null}
            {tab === 'performance' ? (
              <PerformancePanel
                profile={profile}
                scanning={scanning}
                scanError={scanError}
                onRescan={scan}
                onProfile={setProfile}
              />
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
