// Provider configuration on disk. One JSON file under the data directory, written
// atomically, seeded from the provider registry the first time the server starts.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defaultProviderConfigs } from '../core/providers/registry';
import { createId } from '../core/store';
import type { ProviderConfig, ProviderKind } from '../core/types';

export interface ProviderSettingsOptions {
  rootDir: string;
}

const SETTINGS_FILE = 'providers.json';

const providerKindSchema = z.enum(['mock', 'comfyui', 'openai-images', 'a1111']);

const MAX_WORKFLOW_TEMPLATE_LENGTH = 512_000;

/** The capability fields a provider may override, checked at the primitive level. */
const capabilitiesSchema = z
  .object({
    seed: z.boolean(),
    negativePrompt: z.boolean(),
    adjustableSteps: z.boolean(),
    fixedSteps: z.number().nullable(),
    guidance: z.boolean(),
    maxReferenceImages: z.number(),
    maxBatch: z.number(),
    arbitrarySize: z.boolean(),
    sizeMultiple: z.number(),
    presets: z.array(
      z
        .object({ id: z.string(), label: z.string(), width: z.number(), height: z.number() })
        .strict(),
    ),
    outputFormats: z.array(z.string()),
    streamingProgress: z.boolean(),
    notes: z.array(z.string()),
  })
  .partial()
  .strict();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function receivedKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * A saved template must be the API format graph the adapter substitutes into, so a malformed
 * one is refused at save time with a readable 400 instead of failing during a generation.
 */
function checkWorkflowTemplate(raw: unknown, ctx: z.RefinementCtx): void {
  if (raw === undefined) return;
  if (typeof raw !== 'string') {
    ctx.addIssue({
      code: 'custom',
      path: ['workflowTemplate'],
      message: `Invalid input: expected a JSON string, received ${receivedKind(raw)}`,
    });
    return;
  }
  if (raw.length > MAX_WORKFLOW_TEMPLATE_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['workflowTemplate'],
      message: `Invalid input: expected at most ${MAX_WORKFLOW_TEMPLATE_LENGTH} characters, received ${raw.length}`,
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.addIssue({
      code: 'custom',
      path: ['workflowTemplate'],
      message: `Invalid input: expected valid JSON, received text that does not parse (${detail})`,
    });
    return;
  }
  if (!isPlainObject(parsed)) {
    ctx.addIssue({
      code: 'custom',
      path: ['workflowTemplate'],
      message: `Invalid input: expected an object of node id to node, received ${receivedKind(parsed)}`,
    });
    return;
  }
  for (const [nodeId, node] of Object.entries(parsed)) {
    if (!isPlainObject(node)) {
      ctx.addIssue({
        code: 'custom',
        path: ['workflowTemplate', nodeId],
        message: `Invalid input: expected a node object with a string class_type and an object inputs, received ${receivedKind(node)}`,
      });
      continue;
    }
    if (typeof node['class_type'] !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['workflowTemplate', nodeId, 'class_type'],
        message: `Invalid input: expected a string, received ${receivedKind(node['class_type'])}`,
      });
    }
    if (!isPlainObject(node['inputs'])) {
      ctx.addIssue({
        code: 'custom',
        path: ['workflowTemplate', nodeId, 'inputs'],
        message: `Invalid input: expected an object, received ${receivedKind(node['inputs'])}`,
      });
    }
  }
}

/** Options are open across providers, but these two are read by an adapter, so they are checked here. */
function checkCapabilities(raw: unknown, ctx: z.RefinementCtx): void {
  if (raw === undefined) return;
  const result = capabilitiesSchema.safeParse(raw);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', ...issue.path],
      message: issue.message,
    });
  }
}

const providerOptionsSchema = z.record(z.string(), z.unknown()).superRefine((options, ctx) => {
  checkWorkflowTemplate(options['workflowTemplate'], ctx);
  checkCapabilities(options['capabilities'], ctx);
});

/** The persisted shape of one provider. Also the validation for a request body. */
export const providerConfigSchema = z.object({
  id: z.string().min(1).max(128),
  kind: providerKindSchema,
  label: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  options: providerOptionsSchema.optional(),
});

/** POST /api/providers: the id is assigned by the server. */
export const providerInputSchema = providerConfigSchema.omit({ id: true });

/** PATCH /api/providers/:id: the id travels in the path, never in the body. */
export const providerPatchSchema = providerInputSchema.partial();

const settingsFileSchema = z.array(providerConfigSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'the file does not match the provider shape';
  const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${location}${issue.message}`;
}

function parseProviders(raw: string, filePath: string): ProviderConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Provider settings are not valid JSON: ${filePath}`);
  }
  const result = settingsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Provider settings are not valid (${describeIssues(result.error)}): ${filePath}`);
  }
  return result.data;
}

export class ProviderSettings {
  private readonly rootDir: string;
  private readonly filePath: string;
  private providers: ProviderConfig[] = [];
  /** Every write runs through this chain so no read-modify-write is lost. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ProviderSettingsOptions) {
    this.rootDir = options.rootDir;
    this.filePath = path.join(options.rootDir, SETTINGS_FILE);
  }

  /** Loads the file, or writes the defaults when it does not exist yet. */
  async init(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (raw === null) {
      this.providers = defaultProviderConfigs();
      await this.persist();
      return;
    }
    this.providers = parseProviders(raw, this.filePath);
  }

  list(): ProviderConfig[] {
    return this.providers.map((config) => ({ ...config }));
  }

  get(id: string): ProviderConfig | null {
    const config = this.providers.find((candidate) => candidate.id === id);
    return config === undefined ? null : { ...config };
  }

  async create(input: Omit<ProviderConfig, 'id'>): Promise<ProviderConfig> {
    return this.enqueue(async () => {
      const config: ProviderConfig = { ...input, id: this.allocateId(input.kind) };
      this.providers = [...this.providers, config];
      await this.persist();
      return { ...config };
    });
  }

  /** Returns null when no provider carries that id. */
  async update(id: string, patch: Partial<Omit<ProviderConfig, 'id'>>): Promise<ProviderConfig | null> {
    return this.enqueue(async () => {
      const position = this.providers.findIndex((candidate) => candidate.id === id);
      if (position === -1) return null;
      const current = this.providers[position];
      if (current === undefined) return null;
      const next: ProviderConfig = { ...current, ...patch, id };
      const replaced = [...this.providers];
      replaced[position] = next;
      this.providers = replaced;
      await this.persist();
      return { ...next };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const position = this.providers.findIndex((candidate) => candidate.id === id);
      if (position === -1) return false;
      this.providers = this.providers.filter((candidate) => candidate.id !== id);
      await this.persist();
      return true;
    });
  }

  /** The kind doubles as the id when it is free, so seeded ids stay readable in the browser. */
  private allocateId(kind: ProviderKind): string {
    const taken = new Set(this.providers.map((config) => config.id));
    if (!taken.has(kind)) return kind;
    let candidate = createId('provider');
    while (taken.has(candidate)) candidate = createId('provider');
    return candidate;
  }

  private async persist(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.providers, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
