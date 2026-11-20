// Concept C's hardware LED budget bar: twenty discrete ticks, lit from the left, coloured by
// how the estimated peak sits against the card. It is decoration over a real number, so the
// meter role carries the value and the ticks are hidden from assistive tech.

import type { ReactNode } from 'react';
import type { VramStatus } from '../features/generate/vram';

/** One tick per 5% of the budget: coarse enough to read at a glance, fine enough to be honest. */
const SEGMENTS = 20;

export interface VramLedMeterProps {
  fillPercent: number;
  status: VramStatus;
  /** The estimated peak, in the same unit as max. */
  value: number;
  /** The scale the peak is measured against, such as the detected GPU's VRAM. */
  max: number;
  /** Accessible name for the meter. */
  label?: string;
  /** sm for the Generate inspector, md for the Setup Wizard. */
  size?: 'sm' | 'md';
}

export function VramLedMeter({
  fillPercent,
  status,
  value,
  max,
  label = 'Estimated peak VRAM',
  size = 'sm',
}: VramLedMeterProps): ReactNode {
  const litCount = Math.max(1, Math.min(SEGMENTS, Math.round((fillPercent / 100) * SEGMENTS)));

  return (
    <div
      className={size === 'md' ? 'vram-led-meter is-md' : 'vram-led-meter'}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      {Array.from({ length: SEGMENTS }, (_unused, index) => (
        <span
          key={index}
          className={index < litCount ? `vram-led-tick is-lit is-${status}` : 'vram-led-tick'}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
