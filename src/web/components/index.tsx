// Shared controls for every H3 Studio surface. Each one is keyboard reachable,
// carries a real label, and shows the global focus ring from base.css.

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

export function Spinner({ size = 16, label = 'Loading' }: { size?: number; label?: string }): ReactNode {
  const showsLabel = label.length > 0;
  return (
    <span className="spinner" role={showsLabel ? 'status' : undefined} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {showsLabel ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Disables the button and shows a spinner in place of the icon slot. */
  busy?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  type = 'button',
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      className={cx('button', variant === 'primary' && 'is-primary', variant === 'ghost' && 'is-ghost', size === 'sm' && 'is-sm', className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={12} label="" /> : null}
      {children}
    </button>
  );
}

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
}

/** A single line text input with a real label, a hint, and an error slot. */
export function Field({ label, hint, error, className, ...rest }: FieldProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = cx(error === undefined ? undefined : errorId, hint === undefined ? undefined : hintId);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        className={cx('field-input', className)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy.length > 0 ? describedBy : undefined}
      />
      {hint !== undefined ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error !== undefined ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

export interface SegmentedControlProps<Value extends string> {
  /** Accessible name for the group. Rendered for screen readers only. */
  label: string;
  options: ReadonlyArray<SegmentedOption<Value>>;
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
}

/** A row of exclusive choices. Native radios keep arrow key behaviour. */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps<Value>): ReactNode {
  const name = useId();
  return (
    <fieldset className="seg">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="seg-option">
          <input
            className="seg-input"
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => {
              onChange(option.value);
            }}
          />
          <span className="seg-label">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export interface SliderProps {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
  /** Formats the value shown next to the label. */
  format?: (value: number) => string;
  disabled?: boolean;
}

export function Slider({ label, min, max, step = 1, value, onChange, hint, format, disabled = false }: SliderProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="slider">
      <div className="slider-head">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <output className="slider-value" htmlFor={id}>
          {format === undefined ? value : format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => {
          onChange(event.target.valueAsNumber);
        }}
      />
      {hint !== undefined ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

/** Modal panel: Escape closes, focus moves in on open and returns on close. */
export function Dialog({ open, title, onClose, children, actions }: DialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <h2 className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {actions === undefined ? null : <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastProps {
  message: string;
  tone?: ToastTone;
  onClose: () => void;
  /** Milliseconds before the toast closes itself. Zero keeps it until dismissed. */
  timeoutMs?: number;
}

export function Toast({ message, tone = 'info', onClose, timeoutMs = 5000 }: ToastProps): ReactNode {
  useEffect(() => {
    if (timeoutMs <= 0) return undefined;
    const timer = window.setTimeout(onClose, timeoutMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [onClose, timeoutMs]);

  return (
    <div className={cx('toast', `is-${tone}`)} role="status" aria-live="polite">
      <span className="toast-message">{message}</span>
      <button type="button" className="icon-button toast-close" onClick={onClose} aria-label="Dismiss message">
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps): ReactNode {
  return (
    <div className="empty-state">
      {icon === undefined ? null : <span className="empty-state-icon">{icon}</span>}
      <h3 className="empty-state-title">{title}</h3>
      {description === undefined ? null : <p className="empty-state-description">{description}</p>}
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}
