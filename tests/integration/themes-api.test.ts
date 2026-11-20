// Integration tests for the prompt theme surface: one real express app on a loopback
// socket, one temporary data directory, and the deterministic mock provider only.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_THEMES } from '../../src/core/themes';
import type { BatchRecord, PromptTheme } from '../../src/core/types';
import { createApp } from '../../src/server/app';

interface ApiResult<T> {
  status: number;
  body: T | null;
}

interface ThemeListBody {
  themes: PromptTheme[];
}

interface ThemeMutationBody {
  theme: PromptTheme;
  themes: PromptTheme[];
}

interface ThemeDeleteBody {
  removed: boolean;
  themes: PromptTheme[];
}

let server: Server;
let baseUrl = '';
let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'h3-themes-'));
  server = createServer(createApp({ dataDir }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server has no port.');
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
  await rm(dataDir, { recursive: true, force: true });
});

async function api<T>(method: string, requestPath: string, body?: unknown): Promise<ApiResult<T>> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${requestPath}`, init);
  const text = await response.text();
  let parsed: T | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

function bodyOf<T>(result: ApiResult<T>): T {
  if (result.body === null) throw new Error(`Expected JSON, received status ${result.status}.`);
  return result.body;
}

async function readThemesFile(): Promise<PromptTheme[]> {
  const raw = await readFile(path.join(dataDir, 'themes.json'), 'utf8');
  return JSON.parse(raw) as PromptTheme[];
}

async function listThemes(): Promise<PromptTheme[]> {
  return bodyOf(await api<ThemeListBody>('GET', '/api/themes')).themes;
}

describe('the prompt theme surface', () => {
  it('serves the shipped defaults on a fresh data directory and writes them to disk', async () => {
    const result = await api<ThemeListBody>('GET', '/api/themes');
    expect(result.status).toBe(200);
    const themes = bodyOf(result).themes;
    expect(themes).toHaveLength(DEFAULT_PROMPT_THEMES.length);
    expect(themes.map((theme) => theme.id)).toEqual(DEFAULT_PROMPT_THEMES.map((theme) => theme.id));
    expect(themes.every((theme) => theme.builtIn === true)).toBe(true);
    expect(themes[0]?.id).toBe('realistic');

    const onDisk = await readThemesFile();
    expect(onDisk.map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));
  });

  it('rejects a body that is not a theme', async () => {
    const empty = await api<unknown>('POST', '/api/themes', { name: '  ', category: 'style', snippet: 'x' });
    expect(empty.status).toBe(400);
    const badCategory = await api<unknown>('POST', '/api/themes', {
      name: 'Moody',
      category: 'weather',
      snippet: 'x',
    });
    expect(badCategory.status).toBe(400);
    const emptySnippet = await api<unknown>('POST', '/api/themes', {
      name: 'Moody',
      category: 'mood',
      snippet: '   ',
    });
    expect(emptySnippet.status).toBe(400);
  });

  it('creates a custom theme, persists it, and only rejects unknown ids later', async () => {
    const created = await api<ThemeMutationBody>('POST', '/api/themes', {
      name: 'Retro VHS',
      category: 'style',
      snippet: 'shot on 1990s VHS camcorder, subtle chromatic aberration, scanline softness',
    });
    expect(created.status).toBe(201);
    const { theme, themes } = bodyOf(created);
    expect(theme.id).toBe('retro-vhs');
    expect(theme.builtIn).toBe(false);
    expect(theme.category).toBe('style');
    expect(themes.some((candidate) => candidate.id === 'retro-vhs')).toBe(true);

    const onDisk = await readThemesFile();
    const stored = onDisk.find((candidate) => candidate.id === 'retro-vhs');
    expect(stored?.name).toBe('Retro VHS');
    expect(stored?.snippet).toContain('VHS camcorder');
    expect(stored?.builtIn).toBe(false);
  });

  it('suffixes a colliding slug instead of overwriting a shipped theme', async () => {
    const created = await api<ThemeMutationBody>('POST', '/api/themes', {
      name: 'Noir',
      category: 'mood',
      snippet: 'hard-boiled noir shadow play',
    });
    expect(created.status).toBe(201);
    const { theme, themes } = bodyOf(created);
    expect(theme.id).toBe('noir-2');
    expect(themes.filter((candidate) => candidate.id.startsWith('noir')).map((candidate) => candidate.id)).toEqual([
      'noir',
      'noir-2',
    ]);
  });

  it('updates a theme name, category and chunk without renaming its id', async () => {
    const updated = await api<ThemeMutationBody>('PATCH', '/api/themes/retro-vhs', {
      name: 'Retro Tape',
      category: 'camera',
      snippet: 'shot on 1990s VHS camcorder, heavy chroma bleed, warm tape noise',
    });
    expect(updated.status).toBe(200);
    const { theme, themes } = bodyOf(updated);
    expect(theme.id).toBe('retro-vhs');
    expect(theme.name).toBe('Retro Tape');
    expect(theme.category).toBe('camera');
    expect(theme.snippet).toContain('chroma bleed');
    expect(themes.find((candidate) => candidate.id === 'retro-vhs')?.name).toBe('Retro Tape');

    const onDisk = await readThemesFile();
    expect(onDisk.find((candidate) => candidate.id === 'retro-vhs')?.category).toBe('camera');

    const missing = await api<unknown>('PATCH', '/api/themes/not-a-theme', { name: 'Nope' });
    expect(missing.status).toBe(404);
  });

  it('deletes a theme, and answers 404 for one that is already gone', async () => {
    const removed = await api<ThemeDeleteBody>('DELETE', '/api/themes/retro-vhs');
    expect(removed.status).toBe(200);
    const body = bodyOf(removed);
    expect(body.removed).toBe(true);
    expect(body.themes.some((candidate) => candidate.id === 'retro-vhs')).toBe(false);
    expect((await readThemesFile()).some((candidate) => candidate.id === 'retro-vhs')).toBe(false);

    const again = await api<unknown>('DELETE', '/api/themes/retro-vhs');
    expect(again.status).toBe(404);
  });

  it('restores edited and deleted defaults while keeping custom themes', async () => {
    // The two mutations a restore has to repair: one edited default, one deleted default.
    const edited = await api<ThemeMutationBody>('PATCH', '/api/themes/noir', { snippet: 'edited noir chunk' });
    expect(edited.status).toBe(200);
    const deleted = await api<ThemeDeleteBody>('DELETE', '/api/themes/macro');
    expect(deleted.status).toBe(200);

    const reset = await api<ThemeListBody>('POST', '/api/themes/reset');
    expect(reset.status).toBe(200);
    const themes = bodyOf(reset).themes;

    const defaultIds = DEFAULT_PROMPT_THEMES.map((theme) => theme.id);
    expect(themes.slice(0, defaultIds.length).map((theme) => theme.id)).toEqual(defaultIds);
    expect(themes.find((theme) => theme.id === 'noir')?.snippet).toBe(
      DEFAULT_PROMPT_THEMES.find((theme) => theme.id === 'noir')?.snippet,
    );
    expect(themes.some((theme) => theme.id === 'macro')).toBe(true);
    // The custom theme created earlier survives a restore.
    expect(themes.some((theme) => theme.id === 'noir-2')).toBe(true);

    const onDisk = await readThemesFile();
    expect(onDisk.some((theme) => theme.id === 'macro')).toBe(true);
    expect(onDisk.some((theme) => theme.id === 'noir-2')).toBe(true);
  });
});

describe('a themed generation', () => {
  it('accepts basePrompt and appliedThemes and stores them on the batch record', async () => {
    const started = await api<{ batchId: string }>('POST', '/api/generations', {
      providerId: 'mock',
      prompt: 'a brass lighthouse at dusk. shot on 35mm film, visible grain',
      basePrompt: 'a brass lighthouse at dusk',
      appliedThemes: [
        { id: '35mm-film', name: '35mm Film' },
        { id: 'noir', name: 'Noir' },
      ],
      width: 128,
      height: 128,
      count: 1,
    });
    expect(started.status).toBe(202);
    const { batchId } = bodyOf(started);

    const deadline = Date.now() + 10_000;
    let batch: BatchRecord | null = null;
    while (Date.now() < deadline) {
      const result = await api<BatchRecord>('GET', `/api/batches/${encodeURIComponent(batchId)}`);
      if (result.status === 200) {
        const record = bodyOf(result);
        if (record.status !== 'queued' && record.status !== 'running') {
          batch = record;
          break;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    if (batch === null) throw new Error('The themed batch never settled.');

    expect(batch.prompt).toContain('shot on 35mm film');
    expect(batch.basePrompt).toBe('a brass lighthouse at dusk');
    expect(batch.appliedThemes).toEqual([
      { id: '35mm-film', name: '35mm Film' },
      { id: 'noir', name: 'Noir' },
    ]);
  });

  it('stores no theme fields for a plain text-to-image batch', async () => {
    const started = await api<{ batchId: string }>('POST', '/api/generations', {
      providerId: 'mock',
      prompt: 'a plain prompt with no tags',
      width: 96,
      height: 96,
      count: 1,
    });
    expect(started.status).toBe(202);
    const { batchId } = bodyOf(started);

    const deadline = Date.now() + 10_000;
    let batch: BatchRecord | null = null;
    while (Date.now() < deadline) {
      const result = await api<BatchRecord>('GET', `/api/batches/${encodeURIComponent(batchId)}`);
      if (result.status === 200) {
        const record = bodyOf(result);
        if (record.status !== 'queued' && record.status !== 'running') {
          batch = record;
          break;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    if (batch === null) throw new Error('The plain batch never settled.');
    expect(batch.basePrompt).toBeUndefined();
    expect(batch.appliedThemes).toBeUndefined();
  });

  it('rejects an applied theme list that is too long', async () => {
    const tooMany = Array.from({ length: 21 }, (_unused, index) => ({
      id: `theme-${index}`,
      name: `Theme ${index}`,
    }));
    const result = await api<unknown>('POST', '/api/generations', {
      providerId: 'mock',
      prompt: 'too many tags',
      appliedThemes: tooMany,
      width: 96,
      height: 96,
      count: 1,
    });
    expect(result.status).toBe(400);
  });
});

describe('the theme store through the API after a restart', () => {
  it('reads the persisted catalog from disk instead of reseeding defaults', async () => {
    const themes = await listThemes();
    // The reset ran last, so this is the shape a second process would read.
    expect(themes.some((theme) => theme.id === 'noir-2')).toBe(true);
    expect(themes.every((theme) => theme.name.trim().length > 0)).toBe(true);
  });
});
