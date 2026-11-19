// Shared controls for every H3 Studio surface. Each one is keyboard reachable,
// carries a real label, and shows the global focus ring from base.css.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  /** Marks the field invalid when the message is shown elsewhere on the screen. */
  invalid?: boolean;
}

/** A single line text input with a real label, a hint, and an error slot. */
export function Field({ label, hint, error, invalid = false, className, ...rest }: FieldProps): ReactNode {
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
        aria-invalid={error === undefined && !invalid ? undefined : true}
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

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  /** Renders the option as unavailable; this reason becomes the option's title. */
  disabledReason?: string;
}

export interface SelectProps<Value extends string = string> {
  /** Visible label above the trigger. Use ariaLabel instead when space has no room for one. */
  label?: string;
  /** Accessible name for the trigger when there is no visible label. */
  ariaLabel?: string;
  value: Value | null;
  options: ReadonlyArray<SelectOption<Value>>;
  onChange: (value: Value) => void;
  /** Shown in the trigger when no option is selected. */
  placeholder?: string;
  disabled?: boolean;
  /** One line of explanation under the trigger, like a Field hint. */
  hint?: string;
  className?: string;
}

/** The tallest the popover grows before the list scrolls instead. */
const SELECT_MAX_HEIGHT = 288;
const SELECT_GAP = 4;
const SELECT_MARGIN = 8;

/**
 * Places the fixed popover under the trigger and flips it above when the space
 * below is too small. Geometry travels in custom properties, so no inline style
 * lands on the markup.
 */
function placePopover(popover: HTMLDivElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  popover.style.setProperty('--select-left', `${Math.round(rect.left)}px`);
  popover.style.setProperty('--select-width', `${Math.round(rect.width)}px`);
  popover.style.setProperty('--select-max-height', `${SELECT_MAX_HEIGHT}px`);

  const natural = popover.offsetHeight;
  const below = window.innerHeight - rect.bottom - SELECT_MARGIN - SELECT_GAP;
  const above = rect.top - SELECT_MARGIN - SELECT_GAP;
  const placeAbove = below < natural && above > below;
  const available = Math.max(64, placeAbove ? above : below);
  const height = Math.min(natural, available);

  popover.style.setProperty('--select-max-height', `${height}px`);
  const top = placeAbove ? rect.top - SELECT_GAP - height : rect.bottom + SELECT_GAP;
  popover.style.setProperty('--select-top', `${Math.round(Math.max(SELECT_MARGIN, top))}px`);
}

function ChevronDownIcon(): ReactNode {
  return (
    <svg className="icon select-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5L12 15l5.5-5.5" />
    </svg>
  );
}

function CheckIcon(): ReactNode {
  return (
    <svg className="icon select-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * A listbox select that draws its own popover: trigger, portal, fixed placement,
 * full keyboard control and ARIA state. A value with a disabledReason renders as
 * unavailable, with the reason in its title.
 */
export function Select<Value extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = 'Choose one',
  disabled = false,
  hint,
  className,
}: SelectProps<Value>): ReactNode {
  const id = useId();
  const listId = `${id}-list`;
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex === -1 ? null : options[selectedIndex] ?? null;
  const currentText = selected === null ? placeholder : selected.label;

  const isUnavailable = (index: number): boolean => {
    const option = options[index];
    return option === undefined || option.disabledReason !== undefined;
  };

  const firstEnabled = (): number => {
    for (let index = 0; index < options.length; index += 1) {
      if (!isUnavailable(index)) return index;
    }
    return -1;
  };

  const lastEnabled = (): number => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!isUnavailable(index)) return index;
    }
    return -1;
  };

  /** Moves one enabled option in a direction and stops at the ends, like a native list. */
  const stepTo = (direction: 1 | -1): number => {
    if (options.length === 0) return -1;
    if (activeIndex < 0 || isUnavailable(activeIndex)) {
      return direction === 1 ? firstEnabled() : lastEnabled();
    }
    let index = activeIndex;
    for (let tries = 0; tries < options.length; tries += 1) {
      index += direction;
      if (index < 0 || index >= options.length) return activeIndex;
      if (!isUnavailable(index)) return index;
    }
    return activeIndex;
  };

  const openList = (): void => {
    if (disabled || options.length === 0) return;
    const start = selectedIndex >= 0 && !isUnavailable(selectedIndex) ? selectedIndex : firstEnabled();
    if (start < 0) return;
    setActiveIndex(start);
    setOpen(true);
  };

  const closeList = (): void => {
    setOpen(false);
  };

  const closeAndReturnFocus = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const commit = (index: number): void => {
    const option = options[index];
    if (option === undefined || option.disabledReason !== undefined) return;
    onChange(option.value);
    closeAndReturnFocus();
  };

  // Geometry runs before paint, so the popover never shows at the wrong place.
  useLayoutEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    placePopover(popover, trigger);
  }, [open]);

  // Focus follows the active option, with no scrolling of the page or the trigger.
  useLayoutEffect(() => {
    if (!open) return;
    const option = optionRefs.current[activeIndex];
    if (option === null || option === undefined) return;
    option.focus({ preventScroll: true });
    const list = listRef.current;
    if (list === null) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, activeIndex]);

  // A click anywhere outside the trigger and the popover closes the list.
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      closeList();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open]);

  // A scrolling page would leave a fixed popover behind, so any outside scroll
  // or a resize closes it. Scrolling the option list itself is allowed.
  useEffect(() => {
    if (!open) return undefined;
    const handleScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target) === true) return;
      closeList();
    };
    const handleResize = (): void => closeList();
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [open]);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndReturnFocus();
      return;
    }
    if (event.key === 'Tab') {
      // The list does not trap focus: closing hands Tab back to the trigger,
      // and the browser continues from there.
      closeAndReturnFocus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(stepTo(event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? firstEnabled() : lastEnabled());
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(activeIndex);
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (open) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openList();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    }
  };

  const triggerLabelledBy = label === undefined ? undefined : `${labelId} ${valueId}`;

  return (
    <div className={cx('select', className)}>
      {label === undefined ? null : (
        <span className="field-label" id={labelId}>
          {label}
        </span>
      )}
      <button
        type="button"
        ref={triggerRef}
        className="select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={triggerLabelledBy}
        aria-label={label === undefined && ariaLabel !== undefined ? `${ariaLabel}: ${currentText}` : undefined}
        onClick={() => {
          if (open) closeAndReturnFocus();
          else openList();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span id={valueId} className={selected === null ? 'select-value is-placeholder' : 'select-value'}>
          {currentText}
        </span>
        <ChevronDownIcon />
      </button>
      {hint === undefined ? null : <span className="field-hint">{hint}</span>}
      {open
        ? createPortal(
            <div className="select-popover" ref={popoverRef}>
              <div
                className="select-list"
                role="listbox"
                id={listId}
                aria-label={ariaLabel ?? label ?? 'Options'}
                ref={listRef}
                onKeyDown={handleListKeyDown}
              >
                {options.map((option, index) => {
                  const isSelected = index === selectedIndex;
                  const isDisabled = option.disabledReason !== undefined;
                  return (
                    <div
                      key={option.value}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={isDisabled ? true : undefined}
                      title={option.disabledReason}
                      tabIndex={-1}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      className={cx(
                        'select-option',
                        isSelected && 'is-selected',
                        index === activeIndex && 'is-active',
                        isDisabled && 'is-disabled',
                      )}
                      onClick={() => {
                        commit(index);
                      }}
                      onPointerEnter={() => {
                        if (!isDisabled) setActiveIndex(index);
                      }}
                    >
                      <span className="select-option-label">{option.label}</span>
                      {isSelected ? <CheckIcon /> : null}
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
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
    <div className={disabled ? 'slider is-disabled' : 'slider'}>
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
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
