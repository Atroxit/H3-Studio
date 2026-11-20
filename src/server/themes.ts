// Prompt theme persistence. One JSON file under the data directory, written atomically,
// seeded from the shipped defaults the first time the store is read.
//
// The shipped themes are ordinary records here: deleting one removes it, restoring the
// defaults puts it back, and a user theme sits beside them with a Custom category.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PROMPT_THEMES, PROMPT_THEME_CATEGORIES, normalizeThemeId } from '../core/themes';
import type { PromptTheme, PromptThemeCategory } from '../core/types';

export interface ThemeStoreOptions {
  rootDir: string;
}

/** The shape POST /api/themes accepts, and the limits every stored theme must satisfy. */
export const themeInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(PROMPT_THEME_CATEGORIES),
  snippet: z.string().trim().min(1).max(600),
});

/** The shape PATCH /api/themes/:id accepts: any single field may change. */
export const themePatchSchema = themeInputSchema.partial();

export type ThemeInput = z.infer<typeof themeInputSchema>;
export type ThemePatch = z.infer<typeof themePatchSchema>;

export interface ThemeMutation {
  theme: PromptTheme;
  themes: PromptTheme[];
}

const THEMES_FILE = 'themes.json';

const themeSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  category: z.enum(PROMPT_THEME_CATEGORIES),
  snippet: z.string().trim().min(1).max(600),
  builtIn: z.boolean().optional(),
});

const themesFileSchema = z.array(themeSchema);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && String(error.code) === 'ENOENT'
  );
}

function cloneTheme(theme: PromptTheme): PromptTheme {
  return { ...theme };
}

function cloneDefaults(): PromptTheme[] {
  return DEFAULT_PROMPT_THEMES.map(cloneTheme);
}

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'the file does not match the theme shape';
  const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${location}${issue.message}`;
}

function parseThemes(raw: string, filePath: string): PromptTheme[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Prompt themes are not valid JSON: ${filePath}`);
  }
  const result = themesFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Prompt themes are not valid (${describeIssues(result.error)}): ${filePath}`);
  }
  return result.data.map(cloneTheme);
}

/** The first slug the name can take: `noir`, then `noir-2`, then `noir-3`. */
function allocateId(name: string, taken: ReadonlySet<string>): string {
  const base = normalizeThemeId(name);
  if (!taken.has(base)) return base;
  let counter = 2;
  while (taken.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

export class ThemeStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private themes: PromptTheme[] = [];
  /** Every write runs through this chain so no read-modify-write is lost. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ThemeStoreOptions) {
    this.rootDir = options.rootDir;
    this.filePath = path.join(options.rootDir, THEMES_FILE);
  }

  /** Loads the file, or writes the shipped defaults when it does not exist yet. */
  async init(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (raw === null) {
      this.themes = cloneDefaults();
      await this.persist();
      return;
    }
    this.themes = parseThemes(raw, this.filePath);
  }

  async list(): Promise<PromptTheme[]> {
    return this.themes.map(cloneTheme);
  }

  async create(input: ThemeInput): Promise<ThemeMutation> {
    return this.enqueue(async () => {
      const taken = new Set(this.themes.map((theme) => theme.id));
      const theme: PromptTheme = {
        id: allocateId(input.name, taken),
        name: input.name.trim(),
        category: input.category,
        snippet: input.snippet.trim(),
        builtIn: false,
      };
      this.themes = [...this.themes, theme];
      await this.persist();
      return { theme: cloneTheme(theme), themes: await this.list() };
    });
  }

  /** Returns null when no theme carries that id. */
  async update(id: string, patch: ThemePatch): Promise<ThemeMutation | null> {
    return this.enqueue(async () => {
      const position = this.themes.findIndex((candidate) => candidate.id === id);
      if (position === -1) return null;
      const current = this.themes[position];
      if (current === undefined) return null;
      // The id is the tag the composer persists, so editing a theme never renames it.
      const next: PromptTheme = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.snippet === undefined ? {} : { snippet: patch.snippet.trim() }),
        id,
      };
      const replaced = [...this.themes];
      replaced[position] = next;
      this.themes = replaced;
      await this.persist();
      return { theme: cloneTheme(next), themes: await this.list() };
    });
  }

  async remove(id: string): Promise<{ removed: boolean; themes: PromptTheme[] }> {
    return this.enqueue(async () => {
      if (!this.themes.some((theme) => theme.id === id)) {
        return { removed: false, themes: await this.list() };
      }
      this.themes = this.themes.filter((theme) => theme.id !== id);
      await this.persist();
      return { removed: true, themes: await this.list() };
    });
  }

  /**
   * Puts every shipped theme back in its catalog order, then keeps the user's own themes
   * after them: restoring defaults is a repair, not a wipe of what they wrote.
   */
  async resetDefaults(): Promise<PromptTheme[]> {
    return this.enqueue(async () => {
      const custom = this.themes.filter((theme) => theme.builtIn !== true).map(cloneTheme);
      this.themes = [...cloneDefaults(), ...custom];
      await this.persist();
      return this.list();
    });
  }

  private async persist(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    // Same directory temporary then rename: a crash leaves the previous file intact.
    const temporary = `${this.filePath}.${process.pid}.${(writeCounter += 1)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.themes, null, 2)}\n`, 'utf8');
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

let writeCounter = 0;
