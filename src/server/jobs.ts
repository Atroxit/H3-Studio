// The generation job runner. One job per batch: it drives an adapter, persists every
// finished item to the library, and replays the event stream to any subscriber.
//
// Event buffering: every event is kept in memory in arrival order. A subscriber that
// arrives late gets the whole buffer replayed, then the live events. A finished job
// keeps its buffer for a while so the stream can still be replayed, then it is dropped.
//
// Cancellation: the contract has no cancel route, so a job is aborted only when its
// last subscriber disconnects while it is still running. That keeps a browser tab
// close from burning CPU, and keeps two tabs from cancelling each other.

import { setTimeout as scheduleTimer } from 'node:timers';
import { createAdapter } from '../core/providers/registry';
import { LibraryStore, createId } from '../core/store';
import type {
  AppliedPromptTheme,
  BatchRecord,
  BatchStatus,
  GeneratedItem,
  GenerationEvent,
  GenerationRequest,
  ItemFailure,
  ProviderAdapter,
  ProviderConfig,
} from '../core/types';

/** SSE heartbeat interval. The route in app.ts writes the comment. */
export const HEARTBEAT_MS = 15_000;
/** How long a finished job keeps its replay buffer for late subscribers. */
const EVENT_RETENTION_MS = 5 * 60_000;

export type BatchStreamEvent = GenerationEvent | { type: 'batch'; batch: BatchRecord };

export type BatchEventListener = (event: BatchStreamEvent) => void;

/** Defaults to the provider registry. Tests inject it to exercise the failure path. */
export type AdapterFactory = (config: ProviderConfig) => ProviderAdapter;

/** The slice of the library a job needs. app.ts hands in its serialized store. */
export type JobStore = Pick<
  LibraryStore,
  'createBatch' | 'saveImage' | 'recordFailure' | 'finishBatch' | 'getBatch'
>;

export interface GenerationHubOptions {
  store: JobStore;
  adapterFactory?: AdapterFactory;
  retentionMs?: number;
}

export interface Subscription {
  close: () => void;
}

interface JobState {
  batchId: string;
  providerId: string;
  requested: number;
  startedAt: number;
  controller: AbortController;
  buffer: BatchStreamEvent[];
  listeners: Set<BatchEventListener>;
  settled: boolean;
  images: number;
  failures: number;
  /** The batch as created. Only used if the store cannot be read back at the end. */
  created: BatchRecord;
}

/** Item events carry image bytes to the adapter, never to a browser: the store owns them. */
function wireItem(item: GeneratedItem): GeneratedItem {
  return {
    index: item.index,
    ok: item.ok,
    width: item.width,
    height: item.height,
    seed: item.seed,
    durationMs: item.durationMs,
    failure: item.failure,
    revisedPrompt: item.revisedPrompt,
  };
}

export class GenerationHub {
  private readonly store: JobStore;
  private readonly adapterFactory: AdapterFactory;
  private readonly retentionMs: number;
  private readonly jobs = new Map<string, JobState>();

  constructor(options: GenerationHubOptions) {
    this.store = options.store;
    this.adapterFactory = options.adapterFactory ?? createAdapter;
    this.retentionMs = options.retentionMs ?? EVENT_RETENTION_MS;
  }

  /**
   * Creates the batch record and starts the job. The job runs on its own afterwards.
   * sourceImageId names the library image an alteration started from, when there is one.
   * meta carries the pre-theme prompt and the applied theme tags, when the composer used
   * any: the adapter only needs the composed prompt, but the record keeps both.
   */
  async start(
    config: ProviderConfig,
    request: GenerationRequest,
    sourceImageId?: string,
    meta: { basePrompt?: string; appliedThemes?: AppliedPromptTheme[] } = {},
  ): Promise<BatchRecord> {
    const startedAt = Date.now();
    const batch = await this.store.createBatch({
      id: createId('batch'),
      providerId: config.id,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      requested: request.count,
      status: 'running',
      seed: request.seed,
      modelVariant: request.modelVariant,
      textEncoderVariant: request.textEncoderVariant,
      enhancePrompt: request.enhancePrompt,
      promptEnhancer: request.promptEnhancer,
      sourceImageId,
      basePrompt: meta.basePrompt,
      appliedThemes: meta.appliedThemes,
    });
    const state: JobState = {
      batchId: batch.id,
      providerId: config.id,
      requested: request.count,
      startedAt,
      controller: new AbortController(),
      buffer: [],
      listeners: new Set(),
      settled: false,
      images: 0,
      failures: 0,
      created: batch,
    };
    this.jobs.set(batch.id, state);
    void this.run(state, config, request).catch((error: unknown) => {
      // run handles its own failures. This is the last resort: a rejected job must not
      // take the server down or leave a stream open forever.
      console.error('h3-studio: generation job threw', error);
      if (!state.settled) this.settle(state, { ...state.created, status: 'failed' });
    });
    return batch;
  }

  has(batchId: string): boolean {
    return this.jobs.has(batchId);
  }

  /** Aborts a running job. Returns false when there is nothing left to stop. */
  cancel(batchId: string): boolean {
    const state = this.jobs.get(batchId);
    if (state === undefined || state.settled) return false;
    state.controller.abort();
    return true;
  }

  /**
   * Replays the buffered events to the listener, then streams live ones.
   * Returns null when this process has no job for the batch.
   */
  subscribe(batchId: string, listener: BatchEventListener): Subscription | null {
    const state = this.jobs.get(batchId);
    if (state === undefined) return null;
    for (const event of state.buffer) {
      try {
        listener(event);
      } catch {
        // A subscriber that throws during replay must not stop the job.
      }
    }
    if (state.settled) return { close: () => undefined };
    state.listeners.add(listener);
    return {
      close: () => {
        if (!state.listeners.delete(listener)) return;
        // Nobody is watching and the job still runs: stop paying for it.
        if (state.listeners.size === 0 && !state.settled) state.controller.abort();
      },
    };
  }

  private async run(state: JobState, config: ProviderConfig, request: GenerationRequest): Promise<void> {
    // Every event goes through one chain, so persistence order matches event order.
    let chain: Promise<void> = Promise.resolve();
    const onEvent = (event: GenerationEvent): void => {
      chain = chain.then(() => this.handleEvent(state, event));
    };

    try {
      const adapter = this.adapterFactory(config);
      const outcome = await adapter.generate(request, { signal: state.controller.signal, onEvent });
      await chain;
      const seed = outcome.items.find((item) => item.seed !== undefined)?.seed ?? request.seed;
      await this.finalize(state, this.statusFor(state), {
        revisedPrompt: outcome.revisedPrompt,
        seed,
        durationMs: Date.now() - state.startedAt,
      });
    } catch (error) {
      await chain.catch(() => undefined);
      const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
      try {
        await this.store.recordFailure(state.batchId, {
          index: state.images + state.failures,
          message,
          code: 'job_error',
          retryable: false,
        });
        state.failures += 1;
      } catch {
        // The store is already the failing part. The batch event below is the only signal left.
      }
      await this.finalize(state, 'failed', { durationMs: Date.now() - state.startedAt });
    }
  }

  private statusFor(state: JobState): BatchStatus {
    if (state.controller.signal.aborted) return 'cancelled';
    if (state.failures === 0 && state.images >= state.requested) return 'complete';
    if (state.images > 0) return 'partial';
    return 'failed';
  }

  private async handleEvent(state: JobState, event: GenerationEvent): Promise<void> {
    // Progress and previews are live signals only: a preview is a base64 frame that must
    // never reach the stored batch record, so it is published and dropped.
    if (event.type === 'progress' || event.type === 'preview') {
      this.publish(state, event);
      return;
    }
    const { item } = event;
    const bytes = item.ok ? item.bytes : undefined;
    if (bytes !== undefined) {
      await this.store.saveImage(state.batchId, event.index, bytes, {
        providerId: state.providerId,
        durationMs: item.durationMs,
      });
      state.images += 1;
      this.publish(state, { type: 'item', index: event.index, item: wireItem(item) });
      return;
    }
    if (item.ok) {
      const failure: ItemFailure = {
        message: `The provider reported item ${event.index} as done but sent no image bytes.`,
        code: 'missing_image_bytes',
        retryable: true,
      };
      await this.recordFailure(state, event.index, failure);
      this.publish(state, { type: 'item', index: event.index, item: { index: event.index, ok: false, failure } });
      return;
    }
    await this.recordFailure(state, event.index, item.failure);
    this.publish(state, { type: 'item', index: event.index, item: wireItem(item) });
  }

  private async recordFailure(state: JobState, index: number, failure?: ItemFailure): Promise<void> {
    const resolved: ItemFailure =
      failure ??
      ({
        message: `The provider reported item ${index} as failed without a reason.`,
        code: 'unspecified_failure',
        retryable: false,
      } satisfies ItemFailure);
    await this.store.recordFailure(state.batchId, {
      index,
      message: resolved.message,
      code: resolved.code,
      retryable: resolved.retryable,
    });
    state.failures += 1;
  }

  private publish(state: JobState, event: BatchStreamEvent): void {
    state.buffer.push(event);
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not stop the job or the other subscribers.
      }
    }
  }

  private async finalize(
    state: JobState,
    status: BatchStatus,
    extra: { revisedPrompt?: string; seed?: number; durationMs?: number },
  ): Promise<void> {
    let record: BatchRecord | null = null;
    try {
      record = await this.store.finishBatch(state.batchId, status, extra);
    } catch {
      record = null;
    }
    if (record === null) {
      record = await this.store.getBatch(state.batchId).catch((): BatchRecord | null => null);
    }
    this.settle(state, record ?? { ...state.created, status });
  }

  /** Emits the closing batch event, drops the listeners, and schedules the buffer for eviction. */
  private settle(state: JobState, batch: BatchRecord): void {
    if (state.settled) return;
    state.settled = true;
    this.publish(state, { type: 'batch', batch });
    state.listeners.clear();
    const timer = scheduleTimer(() => {
      this.jobs.delete(state.batchId);
    }, this.retentionMs);
    timer.unref();
  }
}
