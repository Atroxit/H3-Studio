// The studio context. It lives in its own module so the generation store and the
// frame can share it without an import cycle.

import { createContext, useContext } from 'react';
import type { Preset, ProviderConfig } from '../core/types';
import type { StudioStats } from './api';

export type StudioView = 'generate' | 'library';

/** The values a batch or preset can hand to the Generate composer. */
export interface PromptSettings {
  prompt: string;
  width?: number;
  height?: number;
  count?: number;
  negativePrompt?: string;
  /** Selects the provider that made the batch, when it is still enabled. */
  providerId?: string;
}

export interface StudioContextValue {
  /** Every provider config the server knows about, enabled or not. */
  providers: ProviderConfig[];
  /** The provider the generate screen should target. Null when nothing is enabled. */
  provider: ProviderConfig | null;
  selectProvider: (providerId: string) => void;
  /** Library totals from /api/stats. Null until the first load succeeds. */
  stats: StudioStats | null;
  presets: Preset[];
  /** The view currently on screen. */
  view: StudioView;
  selectView: (view: StudioView) => void;
  /** Loads a stored batch onto the Generate canvas. */
  openBatch: (batchId: string) => void;
  /** Switches to Generate and clears the canvas for a brand new image. */
  newImage: () => void;
  /** Switches to Generate and opens this batch with this image as the alteration source. */
  alterImage: (batchId: string, imageId: string) => void;
  /** Fills the Generate composer from a saved preset and switches to Generate. */
  applyPreset: (preset: Preset) => void;
  /** Fills the Generate composer from a batch or viewer and switches to Generate. */
  useSettings: (settings: PromptSettings) => void;
  /** Shows the studio toast, used for copy and retry confirmations. */
  notify: (message: string, tone?: 'success' | 'error') => void;
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
