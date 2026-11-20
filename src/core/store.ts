import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPngSize } from './png';
import type {
  BatchFailure,
  BatchRecord,
  BatchStatus,
  LibraryIndex,
  Preset,
  StoredImage,
} from './types';

export interface StoreOptions {
  rootDir: string;
}

const INDEX_FILE = 'index.json';
const JOURNAL_FILE = 'journal.ndjson';
const IMAGES_DIR = 'images';
const REFERENCES_DIR = 'references';

const BATCH_STATUSES = new Set<string>([
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
]);

/**
 * Raised when the on-disk snapshot exists but cannot be trusted. The store never resets it
 * silently.
 *
 * Durability policy: a snapshot that exists and does not parse is always fatal, journal or
 * not. Rebuilding it from the journal would be guessing about bytes we did not write, and one
 * bad read would become silent data loss. The single exception is a snapshot that is missing
 * altogether while the journal still holds complete records: there the journal is the only
 * source of truth, so it is replayed and init writes a fresh snapshot from it.
 */
export class CorruptIndexError extends Error {
  readonly path: string;

  constructor(reason: string, indexPath: string) {
    super(`${reason}: ${indexPath}`);
    this.name = 'CorruptIndexError';
    this.path = indexPath;
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

/** One mutation, as replayed on load and as applied to memory. */
type JournalRecord =
  | { t: 'batch.create'; batch: BatchRecord }
  | { t: 'batch.image'; batchId: string; image: StoredImage }
  | { t: 'batch.failure'; batchId: string; failure: BatchFailure }
  | {
      t: 'batch.finish';
      batchId: string;
      status: BatchStatus;
      finishedAt: string;
      revisedPrompt?: string;
      durationMs?: number;
      seed?: number;
    }
  | { t: 'batch.delete'; batchId: string }
  | { t: 'preset.create'; preset: Preset }
  | { t: 'preset.delete'; presetId: string };

/** What one mutation produced: the record to persist (or none) and the value to return. */
interface Transaction<T> {
  record: JournalRecord | null;
  result: T;
}

function emptyIndex(): LibraryIndex {
  return { version: 1, batches: [], presets: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoredImage(value: unknown): value is StoredImage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.batchId === 'string' &&
    typeof value.index === 'number' &&
    typeof value.filename === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.sha256 === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.providerId === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.durationMs === undefined || typeof value.durationMs === 'number')
  );
}

function isBatchStatus(value: unknown): value is BatchStatus {
  return typeof value === 'string' && BATCH_STATUSES.has(value);
}

function isBatchFailure(value: unknown): value is BatchFailure {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

function isBatchRecord(value: unknown): value is BatchRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.requested === 'number' &&
    isBatchStatus(value.status) &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.images) &&
    value.images.every(isStoredImage) &&
    Array.isArray(value.failures) &&
    value.failures.every(isBatchFailure)
  );
}

function isPreset(value: unknown): value is Preset {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.count === 'number' &&
    typeof value.createdAt === 'string'
  );
}

function isLibraryIndex(value: unknown): value is LibraryIndex {
  if (!isRecord(value)) return false;
  const { version, batches, presets } = value;
  return (
    version === 1 &&
    Array.isArray(batches) &&
    batches.every(isBatchRecord) &&
    Array.isArray(presets) &&
    presets.every(isPreset)
  );
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function parseIndex(raw: string, indexPath: string): LibraryIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptIndexError('Library index is not valid JSON', indexPath);
  }
  if (!isLibraryIndex(parsed)) {
    throw new CorruptIndexError('Library index has an unexpected shape', indexPath);
  }
  return parsed;
}

/** Returns the record a journal line describes, or null when the line is not one we wrote. */
function asJournalRecord(value: unknown): JournalRecord | null {
  if (!isRecord(value)) return null;
  const type = value.t;
  if (type === 'batch.create') {
    const batch = value.batch;
    return isBatchRecord(batch) ? { t: type, batch } : null;
  }
  if (type === 'batch.image') {
    const batchId = value.batchId;
    const image = value.image;
    if (typeof batchId !== 'string' || !isStoredImage(image)) return null;
    return { t: type, batchId, image };
  }
  if (type === 'batch.failure') {
    const batchId = value.batchId;
    const failure = value.failure;
    if (typeof batchId !== 'string' || !isBatchFailure(failure)) return null;
    return { t: type, batchId, failure };
  }
  if (type === 'batch.finish') {
    const batchId = value.batchId;
    const status = value.status;
    const finishedAt = value.finishedAt;
    if (typeof batchId !== 'string' || !isBatchStatus(status) || typeof finishedAt !== 'string') {
      return null;
    }
    const { revisedPrompt, durationMs, seed } = value;
    return {
      t: type,
      batchId,
      status,
      finishedAt,
      ...(typeof revisedPrompt === 'string' ? { revisedPrompt } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
      ...(typeof seed === 'number' ? { seed } : {}),
    };
  }
  if (type === 'batch.delete') {
    const batchId = value.batchId;
    return typeof batchId === 'string' ? { t: type, batchId } : null;
  }
  if (type === 'preset.create') {
    const preset = value.preset;
    return isPreset(preset) ? { t: type, preset } : null;
  }
  if (type === 'preset.delete') {
    const presetId = value.presetId;
    return typeof presetId === 'string' ? { t: type, presetId } : null;
  }
  return null;
}

/**
 * Applies one record. The same function runs on load and after a successful append, so the
 * journal and memory cannot drift apart.
 *
 * Replay is tolerant: a record naming a batch or preset that is no longer there is skipped
 * rather than raised, because a journal can legitimately describe a batch that a later record
 * deletes. Live application is exact, and a live record is only ever built after the target
 * was checked, so it cannot take a skipping path either.
 */
function applyRecord(index: LibraryIndex, record: JournalRecord, mode: 'live' | 'replay'): void {
  const replay = mode === 'replay';
  switch (record.t) {
    case 'batch.create': {
      if (replay && index.batches.some((batch) => batch.id === record.batch.id)) return;
      index.batches.push(record.batch);
      return;
    }
    case 'batch.image': {
      const batch = index.batches.find((candidate) => candidate.id === record.batchId);
      if (!batch) return;
      if (replay && batch.images.some((image) => image.id === record.image.id)) return;
      batch.images.push(record.image);
      return;
    }
    case 'batch.failure': {
      const batch = index.batches.find((candidate) => candidate.id === record.batchId);
      if (!batch) return;
      batch.failures.push(record.failure);
      return;
    }
    case 'batch.finish': {
      const batch = index.batches.find((candidate) => candidate.id === record.batchId);
      if (!batch) return;
      batch.status = record.status;
      batch.finishedAt = record.finishedAt;
      if (record.revisedPrompt !== undefined) batch.revisedPrompt = record.revisedPrompt;
      if (record.durationMs !== undefined) batch.durationMs = record.durationMs;
      if (record.seed !== undefined) batch.seed = record.seed;
      return;
    }
    case 'batch.delete': {
      const position = index.batches.findIndex((batch) => batch.id === record.batchId);
      if (position === -1) return;
      index.batches.splice(position, 1);
      return;
    }
    case 'preset.create': {
      if (replay && index.presets.some((preset) => preset.id === record.preset.id)) return;
      index.presets.push(record.preset);
      return;
    }
    case 'preset.delete': {
      const position = index.presets.findIndex((preset) => preset.id === record.presetId);
      if (position === -1) return;
      index.presets.splice(position, 1);
      return;
    }
  }
}

/**
 * Reads the journal. The tail segment is dropped unless the file ends with a newline: a crash
 * during an append leaves a fragment with no terminator, and half a record must never be
 * applied. A malformed interior line is skipped instead of raised, for the same reason: a torn
 * line cannot be repaired from disk, and failing init over one bad byte would strand a library
 * that is otherwise readable.
 */
async function readJournal(
  journalPath: string,
): Promise<{ records: JournalRecord[]; bytes: number }> {
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { records: [], bytes: 0 };
    throw error;
  }
  const lines = raw.split('\n');
  lines.pop(); // an empty string after the last newline, or the unterminated tail fragment
  const records: JournalRecord[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asJournalRecord(parsed);
    if (record !== null) records.push(record);
  }
  return { records, bytes: Buffer.byteLength(raw, 'utf8') };
}

/** Size and modification time of a file, used to notice that a snapshot was replaced. */
async function signatureOf(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return `${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Byte size of a file, or null when it does not exist. */
async function sizeOf(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function compareNewestFirst(left: BatchRecord, right: BatchRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function findBatch(index: LibraryIndex, batchId: string): BatchRecord {
  const batch = index.batches.find((candidate) => candidate.id === batchId);
  if (!batch) throw new Error(`Unknown batch: ${batchId}`);
  return batch;
}

/**
 * Library persistence: a snapshot in index.json, an append-only journal.ndjson, and an
 * in-memory index that answers every read.
 *
 * Why it is shaped this way: on Windows, renaming a temporary over index.json fails with EPERM
 * while any handle has that file open, and the server reads the library on almost every
 * request, so rewriting one index file lost writes whenever a client polled. Appending to a
 * journal succeeds under a reader, so each mutation now appends exactly one line; the snapshot
 * is written once per init, under a unique temporary name, before any reader exists.
 *
 * Instances do not share memory. A second instance that appends is noticed through the journal
 * size, and the next read rebuilds memory from the snapshot plus the journal, so a write from
 * another instance (a second process, or a test using its own store) is visible without a lock.
 */
export class LibraryStore {
  private readonly indexPath: string;
  private readonly journalPath: string;
  private readonly imagesDir: string;
  private readonly referencesDir: string;
  /** Authoritative state for reads. Rebuilt from disk by init and by the staleness check. */
  private index: LibraryIndex = emptyIndex();
  private memoryReady = false;
  /** Index signature captured when memory was built, so a replaced snapshot is not masked. */
  private snapshotSignature: string | null = null;
  /** Journal size already accounted for in memory; a different size means another writer. */
  private journalBytes = 0;
  /** Every mutation runs through this chain, so journal order matches applied order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: StoreOptions) {
    this.indexPath = path.join(options.rootDir, INDEX_FILE);
    this.journalPath = path.join(options.rootDir, JOURNAL_FILE);
    this.imagesDir = path.join(options.rootDir, IMAGES_DIR);
    this.referencesDir = path.join(options.rootDir, REFERENCES_DIR);
  }

  /**
   * Creates the layout, loads index.json, replays the journal on top of it, then compacts:
   * the snapshot is written under a unique temporary name and renamed into place, and the
   * journal is truncated to empty. Both steps are safe here because init runs before the
   * server serves a request; it is also the only place the snapshot is ever written.
   *
   * A crash between the snapshot rename and the truncation replays records that the snapshot
   * already holds. Replay is by id for creates, images and deletes, and by assignment for
   * finish, so replaying is harmless; the one residue would be a duplicated failure entry,
   * which is recorded rather than hidden.
   */
  async init(): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(this.imagesDir, { recursive: true });
      await mkdir(this.referencesDir, { recursive: true });
      await this.load({ bootstrap: true });
      await this.writeAtomic(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
      await writeFile(this.journalPath, '', 'utf8');
      this.snapshotSignature = await signatureOf(this.indexPath);
      this.journalBytes = 0;
    });
  }

  async listBatches(limit?: number): Promise<BatchRecord[]> {
    const index = await this.readIndex();
    const ordered = [...index.batches].sort(compareNewestFirst);
    return limit === undefined ? ordered : ordered.slice(0, Math.max(limit, 0));
  }

  async getBatch(id: string): Promise<BatchRecord | null> {
    const index = await this.readIndex();
    return index.batches.find((batch) => batch.id === id) ?? null;
  }

  async createBatch(
    input: Omit<BatchRecord, 'images' | 'failures' | 'createdAt'> & { createdAt?: string },
  ): Promise<BatchRecord> {
    const batch: BatchRecord = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
      images: [],
      failures: [],
    };
    return this.transact(() => ({ record: { t: 'batch.create', batch }, result: batch }));
  }

  async saveImage(
    batchId: string,
    index: number,
    bytes: Uint8Array,
    meta: { providerId: string; durationMs?: number },
  ): Promise<StoredImage> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { width, height } = readPngSize(bytes);
    const id = createId('img');
    const filename = `${id}.png`;
    const durationMs =
      meta.durationMs === undefined || !Number.isFinite(meta.durationMs)
        ? undefined
        : Math.max(0, Math.round(meta.durationMs));
    const image: StoredImage = {
      id,
      batchId,
      index,
      filename,
      bytes: bytes.byteLength,
      sha256,
      width,
      height,
      providerId: meta.providerId,
      createdAt: new Date().toISOString(),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    return this.transact(async (current) => {
      findBatch(current, batchId);
      // Bytes land first: a journal line must never name a file that is not on disk yet.
      await this.writeAtomic(path.join(this.imagesDir, filename), bytes);
      return { record: { t: 'batch.image', batchId, image }, result: image };
    });
  }

  async recordFailure(batchId: string, failure: BatchFailure): Promise<void> {
    await this.transact((index) => {
      findBatch(index, batchId);
      return { record: { t: 'batch.failure', batchId, failure }, result: undefined };
    });
  }

  async finishBatch(
    batchId: string,
    status: BatchStatus,
    extra?: { revisedPrompt?: string; durationMs?: number; seed?: number },
  ): Promise<BatchRecord> {
    const finishedAt = new Date().toISOString();
    return this.transact((index) => {
      const batch = findBatch(index, batchId);
      return { record: { t: 'batch.finish', batchId, status, finishedAt, ...extra }, result: batch };
    });
  }

  async readImage(imageId: string): Promise<{ meta: StoredImage; bytes: Uint8Array } | null> {
    const index = await this.readIndex();
    for (const batch of index.batches) {
      const meta = batch.images.find((image) => image.id === imageId);
      if (meta) {
        const bytes = await readFile(this.imagePath(meta));
        return { meta, bytes };
      }
    }
    return null;
  }

  /**
   * Finds one stored image and the path its bytes live at. Bytes are not read: an adapter
   * wants a path on disk, and reading a multi megabyte file here would only duplicate it.
   */
  async findImage(id: string): Promise<{ meta: StoredImage; path: string } | null> {
    const index = await this.readIndex();
    for (const batch of index.batches) {
      const meta = batch.images.find((image) => image.id === id);
      if (meta) return { meta, path: this.imagePath(meta) };
    }
    return null;
  }

  async deleteBatch(batchId: string): Promise<boolean> {
    const batch = await this.transact((index) => {
      const found = index.batches.find((candidate) => candidate.id === batchId);
      if (!found) return { record: null, result: null };
      return { record: { t: 'batch.delete', batchId }, result: found };
    });
    if (batch === null) return false;
    for (const image of batch.images) {
      await rm(this.imagePath(image), { force: true });
    }
    return true;
  }

  async listPresets(): Promise<Preset[]> {
    const index = await this.readIndex();
    return [...index.presets];
  }

  async createPreset(input: Omit<Preset, 'id' | 'createdAt'>): Promise<Preset> {
    const preset: Preset = {
      ...input,
      id: createId('preset'),
      createdAt: new Date().toISOString(),
    };
    return this.transact(() => ({ record: { t: 'preset.create', preset }, result: preset }));
  }

  async deletePreset(id: string): Promise<boolean> {
    return this.transact((index) => {
      if (!index.presets.some((preset) => preset.id === id)) return { record: null, result: false };
      return { record: { t: 'preset.delete', presetId: id }, result: true };
    });
  }

  async stats(): Promise<{ batchCount: number; imageCount: number; bytes: number }> {
    const index = await this.readIndex();
    let imageCount = 0;
    let bytes = 0;
    for (const batch of index.batches) {
      imageCount += batch.images.length;
      for (const image of batch.images) bytes += image.bytes;
    }
    return { batchCount: index.batches.length, imageCount, bytes };
  }

  imagePath(meta: StoredImage): string {
    return path.join(this.imagesDir, meta.filename);
  }

  /**
   * Answers from memory. The only file touches are metadata comparisons against the values
   * captured when memory was built: index.json's size and modification time, and the journal's
   * size. They open no handle, so no rename or append can be blocked by them, and no index
   * data is read.
   *
   * The check exists because a snapshot that was deleted, truncated or replaced underneath us
   * must be reported rather than masked by stale memory, and because a second instance may
   * have appended to the journal (a restart-shaped write, as in the API integration test).
   * A changed journal is handled by rebuilding memory from the snapshot plus the whole journal,
   * which is safe because every in-memory change is already on disk before it is applied.
   */
  private async readIndex(): Promise<LibraryIndex> {
    if (!this.memoryReady) {
      await this.enqueue(() => this.load());
      return this.index;
    }
    if (await this.isCurrent()) return this.index;
    await this.enqueue(() => this.load());
    return this.index;
  }

  private async isCurrent(): Promise<boolean> {
    if ((await signatureOf(this.indexPath)) !== this.snapshotSignature) return false;
    return ((await sizeOf(this.journalPath)) ?? 0) === this.journalBytes;
  }

  /** Builds memory from the snapshot plus the journal. Writes only when bootstrapping nothing. */
  private async load(options: { bootstrap?: boolean } = {}): Promise<void> {
    let snapshot: string | null = null;
    try {
      snapshot = await readFile(this.indexPath, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const { records, bytes } = await readJournal(this.journalPath);
    let index: LibraryIndex;
    if (snapshot === null) {
      if (records.length === 0 && options.bootstrap !== true) {
        throw new CorruptIndexError('Library index is missing', this.indexPath);
      }
      index = emptyIndex();
    } else {
      index = parseIndex(snapshot, this.indexPath);
    }
    for (const record of records) applyRecord(index, record, 'replay');
    this.index = index;
    this.memoryReady = true;
    this.snapshotSignature = await signatureOf(this.indexPath);
    // Count only what replay actually applied. Under-counting makes the next read reload and
    // converge; over-counting would count a record as applied that never reached memory, and
    // nothing would ever correct it. Decoding can also inflate a torn multi byte tail, so
    // never claim more bytes than the file holds.
    this.journalBytes = Math.min(bytes, (await sizeOf(this.journalPath)) ?? bytes);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Appends one journal line, then applies that same record to memory, then returns. Appends
   * are serialized by the queue, so the file order is the applied order, and a failure to
   * append leaves both memory and the journal untouched.
   */
  private transact<T>(
    work: (index: LibraryIndex) => Transaction<T> | Promise<Transaction<T>>,
  ): Promise<T> {
    return this.enqueue(async () => {
      if (!this.memoryReady) await this.load();
      const { record, result } = await work(this.index);
      if (record !== null) {
        const line = `${JSON.stringify(record)}\n`;
        await appendFile(this.journalPath, line, 'utf8');
        this.journalBytes += Buffer.byteLength(line, 'utf8');
        applyRecord(this.index, record, 'live');
      }
      return result;
    });
  }

  /**
   * Same-directory temporary file then rename: a crash leaves the previous file intact.
   *
   * The temporary name is unique per write because a fixed one collides between writers.
   * The rename is retried because Windows refuses to replace a file while any handle has
   * it open, including another reader of this same file. This path is only used for image
   * bytes under a fresh name and for the snapshot during init: no hot path renames a file
   * a reader may hold.
   */
  private async writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
    const temporary = `${target}.${process.pid}.${(atomicCounter += 1)}.tmp`;
    await writeFile(temporary, data);
    try {
      await renameWithRetry(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

let atomicCounter = 0;
const RENAME_ATTEMPTS = 12;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (!RENAME_RETRY_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
    }
  }
}
