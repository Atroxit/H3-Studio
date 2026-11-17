// The HTTP surface from docs/api-contract.md, built as one express app.
// Everything lives under options.dataDir, so a test can point the app at a temp
// directory and drive it over a real loopback socket without a fixed port.

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createAdapter } from '../core/providers/registry';
import { LibraryStore, createId } from '../core/store';
import type {
  BatchRecord,
  GenerationRequest,
  ProviderConfig,
  ReferenceImage,
  StoredImage,
} from '../core/types';
import { buildZip, type ZipEntry } from '../core/zip';
import type { BatchStreamEvent, Subscription } from './jobs';
import { GenerationHub, HEARTBEAT_MS } from './jobs';
import { ProviderSettings, providerInputSchema, providerPatchSchema } from './settings';

const API_VERSION = '0.1.0';
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const MAX_REFERENCE_BASE64_LENGTH = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 4;
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_IDS = 200;
const MAX_GENERATION_COUNT = 10;
const MIN_IMAGE_SIZE = 64;
const MAX_IMAGE_SIZE = 4096;
const MAX_BATCH_LIST = 500;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const JPEG_MESSAGE =
  'JPEG output needs an encoder, and this build ships without one. Use the PNG format instead.';

const generationSchema = z.object({
  providerId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(4000),
  negativePrompt: z.string().max(4000).optional(),
  width: z.number().int().min(MIN_IMAGE_SIZE).max(MAX_IMAGE_SIZE),
  height: z.number().int().min(MIN_IMAGE_SIZE).max(MAX_IMAGE_SIZE),
  count: z.number().int().min(1).max(MAX_GENERATION_COUNT),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  guidance: z.number().min(0).max(50).optional(),
  referenceIds: z.array(z.string().min(1).max(128)).max(8).optional(),
});

const referenceSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  dataBase64: z.string().min(1).max(MAX_REFERENCE_BASE64_LENGTH),
});

const retrySchema = z.object({
  indices: z.array(z.number().int().min(0).max(99)).min(1).max(MAX_GENERATION_COUNT),
});

const exportSchema = z.object({
  imageIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_IMAGE_IDS),
  format: z.enum(['png', 'jpeg']),
});

const presetSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().max(4000),
  width: z.number().int().min(MIN_IMAGE_SIZE).max(MAX_IMAGE_SIZE),
  height: z.number().int().min(MIN_IMAGE_SIZE).max(MAX_IMAGE_SIZE),
  count: z.number().int().min(1).max(MAX_GENERATION_COUNT),
});

/**
 * The built web app, when it exists. H3_WEB_ROOT wins because a bundled copy of this
 * server, which is how the desktop shell runs it, has no module URL to resolve against.
 * The process.cwd() fallback keeps `node dist/server/main.cjs` working from the repo root.
 */
function resolveWebRoot(): string {
  const override = (process.env.H3_WEB_ROOT ?? '').trim();
  if (override.length > 0) return path.resolve(override);
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');
  } catch {
    return path.resolve(process.cwd(), 'dist/web');
  }
}

const WEB_ROOT = resolveWebRoot();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The request failed.';
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status = error.status ?? error.statusCode;
  return typeof status === 'number' ? status : null;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, code } });
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'The request body is not valid.';
  const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${location}${issue.message}`;
}

/** Parses a body, or answers 400 with the contract error envelope and returns null. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    fail(res, 400, 'invalid_body', firstIssue(result.error));
    return null;
  }
  return result.data;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

function slugify(text: string, maxLength: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'image';
}

/** A filename a person recognises when the browser saves or unpacks it. */
function imageFilename(batch: BatchRecord | null, image: StoredImage): string {
  const stem = batch === null ? 'h3-studio' : slugify(batch.prompt, 40);
  return `${stem}-${String(image.index + 1).padStart(2, '0')}.png`;
}

function uniqueEntryName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);
  let counter = 2;
  while (taken.has(`${stem}-${counter}${extension}`)) counter += 1;
  const resolved = `${stem}-${counter}${extension}`;
  taken.add(resolved);
  return resolved;
}

/**
 * The library index is a file that is replaced by renaming a temporary file over it.
 * On Windows that rename is refused with EPERM while any read of the same file is open,
 * and this server reads the index on most requests while a job is writing items. Running
 * every store call through one queue makes this process's reads and writes mutually
 * exclusive, which is what removes the loss. Calls take milliseconds, so the queue is
 * almost always empty. See notes: the store itself has no read/write coordination.
 */
class QueuedLibrary {
  readonly init: LibraryStore['init'];
  readonly listBatches: LibraryStore['listBatches'];
  readonly getBatch: LibraryStore['getBatch'];
  readonly createBatch: LibraryStore['createBatch'];
  readonly saveImage: LibraryStore['saveImage'];
  readonly recordFailure: LibraryStore['recordFailure'];
  readonly finishBatch: LibraryStore['finishBatch'];
  readonly readImage: LibraryStore['readImage'];
  readonly deleteBatch: LibraryStore['deleteBatch'];
  readonly listPresets: LibraryStore['listPresets'];
  readonly createPreset: LibraryStore['createPreset'];
  readonly deletePreset: LibraryStore['deletePreset'];
  readonly stats: LibraryStore['stats'];

  private tail: Promise<void> = Promise.resolve();

  constructor(store: LibraryStore) {
    this.init = () => this.run(() => store.init());
    this.listBatches = (limit) => this.run(() => store.listBatches(limit));
    this.getBatch = (id) => this.run(() => store.getBatch(id));
    this.createBatch = (input) => this.run(() => store.createBatch(input));
    this.saveImage = (batchId, index, bytes, meta) => this.run(() => store.saveImage(batchId, index, bytes, meta));
    this.recordFailure = (batchId, failure) => this.run(() => store.recordFailure(batchId, failure));
    this.finishBatch = (batchId, status, extra) => this.run(() => store.finishBatch(batchId, status, extra));
    this.readImage = (imageId) => this.run(() => store.readImage(imageId));
    this.deleteBatch = (batchId) => this.run(() => store.deleteBatch(batchId));
    this.listPresets = () => this.run(() => store.listPresets());
    this.createPreset = (input) => this.run(() => store.createPreset(input));
    this.deletePreset = (id) => this.run(() => store.deletePreset(id));
    this.stats = () => this.run(() => store.stats());
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createApp(options: { dataDir: string }): Express {
  const dataDir = path.resolve(options.dataDir);
  const referencesDir = path.join(dataDir, 'references');
  const store = new QueuedLibrary(new LibraryStore({ rootDir: dataDir }));
  const settings = new ProviderSettings({ rootDir: dataDir });
  const hub = new GenerationHub({ store });
  /** Reference metadata for this process. Ids are resolved from disk after a restart. */
  const references = new Map<string, ReferenceImage>();

  // The signature is synchronous, so startup work runs once and every request waits on it.
  const ready = (async (): Promise<void> => {
    await mkdir(dataDir, { recursive: true });
    await store.init();
    await settings.init();
  })();
  void ready.catch(() => undefined);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_JSON_BYTES }));
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    ready.then(next, next);
  });

  async function findReference(id: string): Promise<ReferenceImage | null> {
    const known = references.get(id);
    if (known !== undefined) return known;
    let entries: string[];
    try {
      entries = await readdir(referencesDir);
    } catch {
      return null;
    }
    for (const name of entries) {
      const dot = name.lastIndexOf('.');
      if (dot <= 0) continue;
      if (name.slice(0, dot) !== id) continue;
      const mimeType = MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
      if (mimeType === undefined) continue;
      return { id, filename: name, mimeType, path: path.join(referencesDir, name) };
    }
    return null;
  }

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, version: API_VERSION });
  });

  app.get('/api/providers', (_req: Request, res: Response) => {
    res.json(settings.list());
  });

  app.post('/api/providers', async (req: Request, res: Response) => {
    const input = parseBody(providerInputSchema, req.body, res);
    if (input === null) return;
    const config = await settings.create(input);
    res.status(201).json(config);
  });

  app.patch('/api/providers/:id', async (req: Request, res: Response) => {
    const patch = parseBody(providerPatchSchema, req.body, res);
    if (patch === null) return;
    const id = routeParam(req, 'id');
    const updated = await settings.update(id, patch);
    if (updated === null) {
      fail(res, 404, 'unknown_provider', `No provider with id "${id}".`);
      return;
    }
    res.json(updated);
  });

  app.delete('/api/providers/:id', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const removed = await settings.delete(id);
    if (!removed) {
      fail(res, 404, 'unknown_provider', `No provider with id "${id}".`);
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/providers/:id/health', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const config = settings.get(id);
    if (config === null) {
      fail(res, 404, 'unknown_provider', `No provider with id "${id}".`);
      return;
    }
    try {
      res.json(await createAdapter(config).health());
    } catch (error) {
      fail(res, 502, 'provider_error', messageOf(error));
    }
  });

  app.get('/api/providers/:id/capabilities', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const config = settings.get(id);
    if (config === null) {
      fail(res, 404, 'unknown_provider', `No provider with id "${id}".`);
      return;
    }
    try {
      res.json(await createAdapter(config).capabilities());
    } catch (error) {
      fail(res, 502, 'provider_error', messageOf(error));
    }
  });

  app.post('/api/references', async (req: Request, res: Response) => {
    const input = parseBody(referenceSchema, req.body, res);
    if (input === null) return;
    const mimeType = (input.mimeType.split(';')[0] ?? '').trim().toLowerCase();
    const extension = EXTENSION_BY_MIME[mimeType];
    if (extension === undefined) {
      fail(
        res,
        400,
        'unsupported_mime',
        `Unsupported reference mime type "${input.mimeType}". Use image/png, image/jpeg or image/webp.`,
      );
      return;
    }
    if (!BASE64_PATTERN.test(input.dataBase64)) {
      fail(res, 400, 'invalid_base64', 'dataBase64 is not a padded base64 string.');
      return;
    }
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.byteLength === 0) {
      fail(res, 400, 'empty_reference', 'dataBase64 decoded to no bytes.');
      return;
    }
    if (bytes.byteLength > MAX_REFERENCE_BYTES) {
      fail(
        res,
        400,
        'reference_too_large',
        `Reference images are capped at ${MAX_REFERENCE_BYTES} bytes, received ${bytes.byteLength}.`,
      );
      return;
    }
    const id = createId('ref');
    const storedName = `${id}.${extension}`;
    const storedPath = path.join(referencesDir, storedName);
    await writeFile(storedPath, bytes);
    const reference: ReferenceImage = { id, filename: input.filename, mimeType, path: storedPath };
    references.set(id, reference);
    res.status(201).json(reference);
  });

  app.post('/api/generations', async (req: Request, res: Response) => {
    const input = parseBody(generationSchema, req.body, res);
    if (input === null) return;
    const config = settings.get(input.providerId);
    if (config === null) {
      fail(res, 404, 'unknown_provider', `No provider with id "${input.providerId}".`);
      return;
    }
    // Adapters read reference bytes from disk, so the ids become absolute paths here.
    const referencePaths: string[] = [];
    for (const referenceId of input.referenceIds ?? []) {
      const reference = await findReference(referenceId);
      if (reference === null) {
        fail(res, 400, 'unknown_reference', `No uploaded reference with id "${referenceId}".`);
        return;
      }
      referencePaths.push(reference.path);
    }
    const request: GenerationRequest = {
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      width: input.width,
      height: input.height,
      count: input.count,
      seed: input.seed,
      steps: input.steps,
      guidance: input.guidance,
      referenceIds: referencePaths,
    };
    const batch = await hub.start(config, request);
    res.status(202).json({ batchId: batch.id });
  });

  app.get('/api/generations/:batchId/events', async (req: Request, res: Response) => {
    const batchId = routeParam(req, 'batchId');
    const openStream = (): void => {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write('retry: 0\n\n');
    };

    // A live job answers from memory: its batch exists, so the stream never needs the
    // library index. Only a batch this process is not running is read from disk.
    if (!hub.has(batchId)) {
      const stored = await store.getBatch(batchId);
      if (stored === null) {
        fail(res, 404, 'unknown_batch', `No batch with id "${batchId}".`);
        return;
      }
      // No job here: replay what the library knows and close.
      openStream();
      res.write(`data: ${JSON.stringify({ type: 'batch', batch: stored })}\n\n`);
      res.end();
      return;
    }

    openStream();

    let ended = false;
    let subscription: Subscription | null = null;
    const heartbeat = setInterval(() => {
      if (ended) return;
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    const finish = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      res.end();
    };

    const write = (event: BatchStreamEvent): void => {
      if (ended) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'batch') finish();
    };

    res.on('close', () => {
      clearInterval(heartbeat);
      if (subscription !== null) subscription.close();
    });

    subscription = hub.subscribe(batchId, write);
    if (subscription === null) finish();
  });

  app.get('/api/batches', async (req: Request, res: Response) => {
    const raw = queryParam(req, 'limit');
    let limit: number | undefined;
    if (raw !== undefined) {
      if (!/^\d+$/.test(raw)) {
        fail(res, 400, 'invalid_query', 'limit must be a non negative integer.');
        return;
      }
      limit = Math.min(Number.parseInt(raw, 10), MAX_BATCH_LIST);
    }
    res.json(await store.listBatches(limit));
  });

  app.get('/api/batches/:id', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const batch = await store.getBatch(id);
    if (batch === null) {
      fail(res, 404, 'unknown_batch', `No batch with id "${id}".`);
      return;
    }
    res.json(batch);
  });

  app.delete('/api/batches/:id', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    // Stop the job first, so it cannot write an item into a batch that is going away.
    hub.cancel(id);
    const removed = await store.deleteBatch(id);
    if (!removed) {
      fail(res, 404, 'unknown_batch', `No batch with id "${id}".`);
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/batches/:id/retry', async (req: Request, res: Response) => {
    const input = parseBody(retrySchema, req.body, res);
    if (input === null) return;
    const id = routeParam(req, 'id');
    const batch = await store.getBatch(id);
    if (batch === null) {
      fail(res, 404, 'unknown_batch', `No batch with id "${id}".`);
      return;
    }
    if (new Set(input.indices).size !== input.indices.length) {
      fail(res, 400, 'invalid_indices', 'indices must not repeat.');
      return;
    }
    const outside = input.indices.find((index) => index >= batch.requested);
    if (outside !== undefined) {
      fail(
        res,
        400,
        'invalid_indices',
        `Index ${outside} is outside the ${batch.requested} images this batch requested.`,
      );
      return;
    }
    const config = settings.get(batch.providerId);
    if (config === null) {
      fail(res, 404, 'unknown_provider', `The provider "${batch.providerId}" this batch used is gone.`);
      return;
    }
    // A retry is a new batch: same prompt, size, provider and seed, one image per index.
    const retried = await hub.start(config, {
      prompt: batch.prompt,
      negativePrompt: batch.negativePrompt,
      width: batch.width,
      height: batch.height,
      count: input.indices.length,
      seed: batch.seed,
    });
    res.status(202).json({ batchId: retried.id });
  });

  app.get('/api/images/:id', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const image = await store.readImage(id);
    if (image === null) {
      fail(res, 404, 'unknown_image', `No image with id "${id}".`);
      return;
    }
    const format = queryParam(req, 'format');
    if (format !== undefined && format !== 'png') {
      if (format === 'jpeg' || format === 'jpg') {
        fail(res, 415, 'unsupported_format', JPEG_MESSAGE);
        return;
      }
      fail(res, 400, 'invalid_query', `Unknown image format "${format}". Use png.`);
      return;
    }
    const download = queryParam(req, 'download');
    const asAttachment = download !== undefined && !['', '0', 'false', 'no'].includes(download);
    const batch = await store.getBatch(image.meta.batchId);
    res.setHeader('Content-Type', 'image/png');
    if (asAttachment) {
      res.setHeader('Content-Disposition', `attachment; filename="${imageFilename(batch, image.meta)}"`);
    }
    res.send(Buffer.from(image.bytes));
  });

  app.post('/api/export', async (req: Request, res: Response) => {
    const input = parseBody(exportSchema, req.body, res);
    if (input === null) return;
    if (input.format === 'jpeg') {
      fail(res, 415, 'unsupported_format', JPEG_MESSAGE);
      return;
    }
    const entries: ZipEntry[] = [];
    const taken = new Set<string>();
    for (const imageId of input.imageIds) {
      const image = await store.readImage(imageId);
      if (image === null) {
        fail(res, 404, 'unknown_image', `No image with id "${imageId}".`);
        return;
      }
      const batch = await store.getBatch(image.meta.batchId);
      entries.push({
        name: uniqueEntryName(taken, imageFilename(batch, image.meta)),
        bytes: image.bytes,
      });
    }
    const archive = buildZip(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="h3-studio-export.zip"');
    res.send(Buffer.from(archive));
  });

  app.get('/api/presets', async (_req: Request, res: Response) => {
    res.json(await store.listPresets());
  });

  app.post('/api/presets', async (req: Request, res: Response) => {
    const input = parseBody(presetSchema, req.body, res);
    if (input === null) return;
    res.status(201).json(await store.createPreset(input));
  });

  app.delete('/api/presets/:id', async (req: Request, res: Response) => {
    const id = routeParam(req, 'id');
    const removed = await store.deletePreset(id);
    if (!removed) {
      fail(res, 404, 'unknown_preset', `No preset with id "${id}".`);
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/stats', async (_req: Request, res: Response) => {
    const stats = await store.stats();
    res.json({ ...stats, providerCount: settings.list().length });
  });

  app.use('/api', (req: Request, res: Response) => {
    fail(res, 404, 'not_found', `No API route for ${req.method} ${req.originalUrl}.`);
  });

  const indexHtml = path.join(WEB_ROOT, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(WEB_ROOT));
    // Anything that is not an API call belongs to the single page app.
    app.get(/^\/(?!api(\/|$)).*/, (_req: Request, res: Response) => {
      res.sendFile(indexHtml);
    });
  }

  app.use((req: Request, res: Response) => {
    fail(res, 404, 'not_found', `Nothing is served at ${req.method} ${req.originalUrl}. Run the web build first.`);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = errorStatus(error);
    if (status !== null && status >= 400 && status < 500) {
      const code = status === 400 ? 'invalid_body' : status === 413 ? 'payload_too_large' : 'invalid_request';
      fail(res, status, code, messageOf(error));
      return;
    }
    console.error('h3-studio: request failed', error);
    fail(res, 500, 'internal_error', messageOf(error));
  });

  return app;
}
