// Pure helpers for the generate surface. Nothing here touches React or the DOM,
// so the unit suite can import this module directly under Node.

/** The largest prompt the server accepts, mirrored here so the UI can block it early. */
export const PROMPT_MAX_LENGTH = 4000;
/** The size range the server accepts. */
export const MIN_IMAGE_SIZE = 64;
export const MAX_IMAGE_SIZE = 8192;
/** The largest seed the server accepts. */
export const MAX_SEED = 4_294_967_295;

interface CanonicalRatio {
  label: string;
  value: number;
}

// Ordered from the most square to the widest, with vertical counterparts. The
// tolerance below is relative, so large and small presets behave the same.
const CANONICAL_RATIOS: readonly CanonicalRatio[] = [
  { label: '1:1', value: 1 },
  { label: '5:4', value: 5 / 4 },
  { label: '4:5', value: 4 / 5 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:10', value: 16 / 10 },
  { label: '10:16', value: 10 / 16 },
  { label: '21:9', value: 21 / 9 },
  { label: '9:21', value: 9 / 21 },
];

/** Two percent relative tolerance covers presets that are rounded to a multiple of 32. */
const RATIO_TOLERANCE = 0.02;

function greatestCommonDivisor(left: number, right: number): number {
  if (right === 0) return Math.max(1, Math.abs(left));
  return greatestCommonDivisor(right, left % right);
}

/**
 * A readable aspect label. Canonical ratios win over exact reduction, so 5472x3072
 * reads as 16:9 rather than 57:32. Anything unusual falls back to the reduced fraction.
 */
export function ratioOf(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '1:1';
  const actual = width / height;
  for (const candidate of CANONICAL_RATIOS) {
    if (Math.abs(actual - candidate.value) / candidate.value <= RATIO_TOLERANCE) return candidate.label;
  }
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/**
 * Retry batches are renumbered from zero by every adapter, so the incoming index is a
 * position in the retried list. The final stored record confirms the mapping.
 */
export function retryEventIndex(retried: readonly number[], incoming: number): number | null {
  return retried[incoming] ?? null;
}

/** Removes duplicate strings while preserving the first occurrence. */
export function uniqueNotes(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const note of notes) {
    const trimmed = note.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

/** A problem the user can fix before a request is sent, or null when the text is fine. */
export function promptProblem(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return 'Write a prompt first.';
  if (trimmed.length > PROMPT_MAX_LENGTH) return `Keep the prompt under ${PROMPT_MAX_LENGTH} characters.`;
  return null;
}

/** Checks the size the user typed, not the snapped size that will be sent. */
export function sizeProblem(width: number, height: number): string | null {
  for (const value of [width, height]) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return 'Width and height must be whole numbers.';
    }
    if (value < MIN_IMAGE_SIZE || value > MAX_IMAGE_SIZE) {
      return `Width and height must be ${MIN_IMAGE_SIZE} to ${MAX_IMAGE_SIZE} px.`;
    }
  }
  return null;
}

/** An empty seed is allowed and means a fresh seed per image. */
export function seedProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return 'Seed must be a whole number from 0 to 4294967295.';
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SEED) return 'Seed must be a whole number from 0 to 4294967295.';
  return null;
}

/**
 * Reads the H3 prompt expander switch from a ComfyUI API graph. Returns null when the
 * text is not JSON, or when the graph has no node 22 ComfySwitchNode switch.
 */
export function readH3ExpanderState(templateJson: string): boolean | null {
  const graph = parseGraph(templateJson);
  if (graph === null) return null;
  const node = graph['22'];
  if (!isRecord(node) || node['class_type'] !== 'ComfySwitchNode') return null;
  const inputs = node['inputs'];
  if (!isRecord(inputs) || typeof inputs['switch'] !== 'boolean') return null;
  return inputs['switch'];
}

/**
 * Flips node 22's switch and returns the rewritten graph, or null when the text is not
 * a graph with an H3 prompt expander. Formatting is normalised to two-space JSON.
 */
export function setH3ExpanderState(templateJson: string, enabled: boolean): string | null {
  const graph = parseGraph(templateJson);
  if (graph === null) return null;
  const node = graph['22'];
  if (!isRecord(node) || node['class_type'] !== 'ComfySwitchNode') return null;
  const inputs = node['inputs'];
  if (!isRecord(inputs) || typeof inputs['switch'] !== 'boolean') return null;
  const next = { ...graph, '22': { ...node, inputs: { ...inputs, switch: enabled } } };
  return JSON.stringify(next, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGraph(templateJson: string): Record<string, unknown> | null {
  const trimmed = templateJson.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
