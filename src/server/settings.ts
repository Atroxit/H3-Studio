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

/** The persisted shape of one provider. Also the validation for a request body. */
export const providerConfigSchema = z.object({
  id: z.string().min(1).max(128),
  kind: providerKindSchema,
  label: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
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
