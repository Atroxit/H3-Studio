import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthImage } from '../../src/core/png';
import {
  ComfyUIError,
  applyModelVariant,
  applyPromptEnhancer,
  attachReferenceImages,
  createComfyUIAdapter,
  defaultWorkflowTemplate,
  expandMultiSeedGraph,
  formatReferencePrompt,
} from '../../src/core/providers/comfyui';
import { LibraryStore } from '../../src/core/store';
import type {
  GenerationEvent,
  GenerationRequest,
  ProviderConfig,
} from '../../src/core/types';
import { GenerationHub, type BatchStreamEvent } from '../../src/server/jobs';

// A real PNG, used as the bytes ComfyUI serves from /view.
const PNG_BYTES = synthImage({ width: 16, height: 16, seed: 7, label: 'comfyui test' });

const BASE_REQUEST: GenerationRequest = {
  prompt: 'a brass lighthouse at dusk',
  width: 512,
  height: 512,
  count: 1,
};

interface StubResponse {
  status: number;
  body: unknown;
}

interface StubConfig {
  promptResponse?: StubResponse;
  historyResponse?: (poll: number) => StubResponse;
  uploadResponse?: StubResponse;
  viewBytes?: Uint8Array;
  onHistory?: (poll: number) => void;
}

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface Stub {
  baseUrl: string;
  requests: RecordedRequest[];
  historyPolls: () => number;
  close: () => Promise<void>;
}

const openStubs: Stub[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function inputsOf(node: Record<string, unknown>): Record<string, unknown> {
  return record(node['inputs']);
}

function nodesOfType(graph: Record<string, unknown>, classType: string): Record<string, unknown>[] {
  return Object.values(graph).filter(
    (node): node is Record<string, unknown> => isRecord(node) && node['class_type'] === classType,
  );
}

function nodeOf(graph: Record<string, unknown>, nodeId: string): Record<string, unknown> {
  const node = graph[nodeId];
  if (!isRecord(node)) throw new Error(`missing node ${nodeId}`);
  return node;
}

function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve(undefined);
        return;
      }
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        // A multipart upload has no JSON body. It is recorded as raw text.
        resolve(text);
        return;
      }
      resolve(JSON.parse(text) as unknown);
    });
  });
}

function sendJson(response: ServerResponse, payload: StubResponse): void {
  response.writeHead(payload.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload.body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function startStub(config: StubConfig = {}): Promise<Stub> {
  return new Promise((resolve, reject) => {
    const requests: RecordedRequest[] = [];
    let polls = 0;

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const method = request.method ?? 'GET';
      const path = request.url ?? '/';
      const body = method === 'POST' ? await readRequestBody(request) : undefined;
      requests.push({ method, path, body });

      if (method === 'POST' && path === '/prompt') {
        sendJson(response, config.promptResponse ?? { status: 200, body: { prompt_id: 'prompt-1', number: 1 } });
        return;
      }
      if (method === 'POST' && path === '/upload/image') {
        sendJson(response, config.uploadResponse ?? { status: 200, body: { name: 'reference.png', subfolder: '' } });
        return;
      }
      if (method === 'GET' && path.startsWith('/history/')) {
        polls += 1;
        config.onHistory?.(polls);
        sendJson(response, config.historyResponse?.(polls) ?? { status: 200, body: {} });
        return;
      }
      if (method === 'GET' && path.startsWith('/view')) {
        if (config.viewBytes === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('missing');
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from(config.viewBytes));
        return;
      }
      if (method === 'GET' && path === '/system_stats') {
        sendJson(response, { status: 200, body: { system: { os: 'test' } } });
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }

    const server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('stub server did not bind a port'));
        return;
      }
      const stub: Stub = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        historyPolls: () => polls,
        close: () => closeServer(server),
      };
      openStubs.push(stub);
      resolve(stub);
    });
  });
}

function comfyConfig(baseUrl: string, options: Record<string, unknown> = {}): ProviderConfig {
  return { id: 'comfy-test', kind: 'comfyui', label: 'ComfyUI test', baseUrl, options };
}

function context(): { signal: AbortSignal; events: GenerationEvent[] } {
  const events: GenerationEvent[] = [];
  const { signal } = new AbortController();
  return { signal, events };
}

function postedGraph(stub: Stub): Record<string, unknown> {
  const posted = stub.requests.find((entry) => entry.method === 'POST' && entry.path === '/prompt');
  if (posted === undefined) throw new Error('no POST /prompt request recorded');
  return record(record(posted.body)['prompt']);
}

afterEach(async () => {
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

describe('ComfyUI adapter', () => {
  it('returns bytes from a completed prompt', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-1', number: 1, node_errors: {} } },
      historyResponse: () => ({
        status: 200,
        body: {
          'prompt-1': {
            outputs: { '9': { images: [{ filename: 'h3_00001_.png', subfolder: '', type: 'output' }] } },
          },
        },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000 }));
    const run = context();

    const outcome = await adapter.generate(BASE_REQUEST, { signal: run.signal, onEvent: (event) => run.events.push(event) });

    expect(outcome.providerId).toBe('comfy-test');
    expect(outcome.items).toHaveLength(1);
    const item = outcome.items[0];
    if (item === undefined) throw new Error('expected one generated item');
    expect(item.ok).toBe(true);
    expect(item.seed).toBeTypeOf('number');
    const bytes = item.bytes;
    if (bytes === undefined) throw new Error('expected image bytes');
    expect(bytes).toEqual(PNG_BYTES);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const posted = stub.requests.find((entry) => entry.method === 'POST' && entry.path === '/prompt');
    if (posted === undefined) throw new Error('no POST /prompt request recorded');
    expect(record(posted.body)['client_id']).toBe('h3-studio');

    const view = stub.requests.find((entry) => entry.path.startsWith('/view'));
    if (view === undefined) throw new Error('no GET /view request recorded');
    expect(view.path).toContain('filename=h3_00001_.png');
    expect(view.path).toContain('subfolder=');
    expect(view.path).toContain('type=output');

    const progress = run.events.filter(
      (event): event is Extract<GenerationEvent, { type: 'progress' }> => event.type === 'progress',
    );
    expect(progress.length).toBeGreaterThan(0);
    for (const event of progress) {
      expect(event.stage).toBe('sampling');
      expect(event.percent ?? 0).toBeGreaterThan(0);
      expect(event.percent ?? 0).toBeLessThanOrEqual(95);
    }
  });

  it('surfaces node_errors as a failure naming the node', async () => {
    const stub = await startStub({
      promptResponse: {
        status: 200,
        body: {
          prompt_id: 'prompt-2',
          number: 2,
          node_errors: {
            '6': {
              class_type: 'EmptyLatentImage',
              errors: [{ message: 'Value not in list', details: 'ckpt_name: nope.safetensors not in list' }],
            },
          },
        },
      },
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000 }));
    const run = context();
    const generation = adapter.generate(BASE_REQUEST, { signal: run.signal, onEvent: () => {} });

    await expect(generation).rejects.toBeInstanceOf(ComfyUIError);
    await expect(generation).rejects.toThrow(/node 6: Value not in list ckpt_name: nope\.safetensors not in list/);
    expect(stub.historyPolls()).toBe(0);
  });

  it('fails with a timeout message when history never resolves', async () => {
    const stub = await startStub({ promptResponse: { status: 200, body: { prompt_id: 'prompt-3' } } });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 15, timeoutMs: 120 }));
    const run = context();
    const started = Date.now();
    const generation = adapter.generate(BASE_REQUEST, { signal: run.signal, onEvent: () => {} });

    await expect(generation).rejects.toThrow(/timed out after 120 ms waiting for prompt prompt-3/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(stub.historyPolls()).toBeGreaterThan(1);
  });

  it('clears the poll timer and rejects when aborted', async () => {
    let markFirstPoll: () => void = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      markFirstPoll = resolve;
    });
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-4' } },
      onHistory: (poll) => {
        if (poll === 1) markFirstPoll();
      },
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 5000, timeoutMs: 60_000 }));
    const controller = new AbortController();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const started = Date.now();

    const generation = adapter.generate(BASE_REQUEST, {
      signal: controller.signal,
      onEvent: () => {},
    });
    await firstPoll;
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    try {
      await expect(generation).rejects.toThrow(/aborted/);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
    // The 5000 ms poll timer was cleared, so the rejection arrives long before it could fire.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stub.historyPolls()).toBe(1);
  });

  it('tells ComfyUI to interrupt when the generation is aborted', async () => {
    let markFirstPoll: () => void = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      markFirstPoll = resolve;
    });
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-abort' } },
      onHistory: (poll) => {
        if (poll === 1) markFirstPoll();
      },
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 5000, timeoutMs: 60_000 }));
    const controller = new AbortController();
    const generation = adapter.generate(BASE_REQUEST, { signal: controller.signal, onEvent: () => {} });

    await firstPoll;
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    await expect(generation).rejects.toThrow(/aborted/);
    const interrupts = stub.requests.filter((entry) => entry.method === 'POST' && entry.path === '/interrupt');
    expect(interrupts).toHaveLength(1);
    const body = interrupts[0]?.body;
    if (!isRecord(body)) throw new Error('expected a JSON interrupt body');
    expect(body['prompt_id']).toBe('prompt-abort');
  });

  it('substitutes placeholders inside the posted graph', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-5' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-5': { outputs: { '9': { images: [{ filename: 'h3_00005_.png', subfolder: 'batch' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000, ckptName: 'sd15.safetensors' }),
    );
    const request: GenerationRequest = {
      prompt: 'a brass lighthouse',
      negativePrompt: 'blurry, low detail',
      width: 832,
      height: 1216,
      count: 1,
      seed: 424242,
      steps: 28,
      guidance: 6.5,
    };
    const run = context();

    await adapter.generate(request, { signal: run.signal, onEvent: () => {} });

    const graph = postedGraph(stub);
    const classTypes = Object.values(graph).map((node) => record(node)['class_type']);
    expect(classTypes).toEqual(
      expect.arrayContaining([
        'CheckpointLoaderSimple',
        'CLIPTextEncode',
        'EmptyLatentImage',
        'KSampler',
        'VAEDecode',
        'SaveImage',
      ]),
    );

    const textNodes = nodesOfType(graph, 'CLIPTextEncode');
    expect(textNodes).toHaveLength(2);
    const positive = textNodes.find((node) => inputsOf(node)['text'] === 'a brass lighthouse');
    const negative = textNodes.find((node) => inputsOf(node)['text'] === 'blurry, low detail');
    expect(positive).toBeDefined();
    expect(negative).toBeDefined();

    const latent = nodesOfType(graph, 'EmptyLatentImage');
    if (latent[0] === undefined) throw new Error('missing EmptyLatentImage node');
    const latentInputs = inputsOf(latent[0]);
    expect(latentInputs['width']).toBe(832);
    expect(latentInputs['height']).toBe(1216);
    expect(latentInputs['batch_size']).toBe(1);

    const sampler = nodesOfType(graph, 'KSampler');
    if (sampler[0] === undefined) throw new Error('missing KSampler node');
    const samplerInputs = inputsOf(sampler[0]);
    expect(samplerInputs['seed']).toBe(424242);
    expect(samplerInputs['steps']).toBe(28);
    expect(samplerInputs['cfg']).toBe(6.5);

    const loader = nodesOfType(graph, 'CheckpointLoaderSimple');
    if (loader[0] === undefined) throw new Error('missing CheckpointLoaderSimple node');
    expect(inputsOf(loader[0])['ckpt_name']).toBe('sd15.safetensors');
    expect(JSON.stringify(graph)).not.toContain('{{');
  });

  it('uses the workflow template from options when provided', async () => {
    const customTemplate = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{ckpt}}' } },
      '2': { class_type: 'SaveImage', inputs: { filename_prefix: '{{prompt}}', images: ['1', 0] } },
    };
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-6' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-6': { outputs: { '2': { images: [{ filename: 'custom.png', subfolder: '' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(customTemplate),
      }),
    );
    const run = context();

    await adapter.generate(BASE_REQUEST, { signal: run.signal, onEvent: () => {} });

    const graph = postedGraph(stub);
    expect(Object.keys(graph)).toEqual(['1', '2']);
    const saver = nodesOfType(graph, 'SaveImage');
    if (saver[0] === undefined) throw new Error('missing SaveImage node');
    expect(inputsOf(saver[0])['filename_prefix']).toBe(BASE_REQUEST.prompt);
  });

  it('reports a working health check from system_stats', async () => {
    const stub = await startStub();
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl));

    await expect(adapter.health()).resolves.toEqual({ ok: true });
    expect(stub.requests.some((entry) => entry.method === 'GET' && entry.path === '/system_stats')).toBe(true);
  });

  it('reports capabilities for a text to image pipeline', async () => {
    const adapter = createComfyUIAdapter(comfyConfig('http://127.0.0.1:1'));
    const capabilities = await adapter.capabilities();

    expect(capabilities.seed).toBe(true);
    expect(capabilities.negativePrompt).toBe(true);
    expect(capabilities.adjustableSteps).toBe(true);
    expect(capabilities.fixedSteps).toBeNull();
    expect(capabilities.guidance).toBe(true);
    expect(capabilities.maxReferenceImages).toBe(0);
    expect(capabilities.maxBatch).toBe(4);
    expect(capabilities.arbitrarySize).toBe(true);
    expect(capabilities.sizeMultiple).toBe(8);
    expect(capabilities.presets.map((preset) => preset.id)).toEqual([
      '512x512',
      '768x768',
      '832x1216',
      '1216x832',
    ]);
    expect(capabilities.outputFormats).toEqual(['png']);
    expect(capabilities.streamingProgress).toBe(true);
    const notes = capabilities.notes.join(' ');
    expect(notes).toContain('different graph');
    expect(notes).toContain('polled');
  });

  it('merges a capabilities override over the defaults field by field', async () => {
    const adapter = createComfyUIAdapter(
      comfyConfig('http://127.0.0.1:1', {
        capabilities: {
          maxBatch: 2,
          sizeMultiple: 64,
          presets: [
            { id: 'h3-1024', label: '1024 x 1024', width: 1024, height: 1024 },
            { id: 'h3-1536', label: '1536 x 864', width: 1536, height: 864 },
          ],
          notes: ['The H3 graph takes a size and a seed, and nothing else.'],
        },
      }),
    );

    const capabilities = await adapter.capabilities();

    expect(capabilities.maxBatch).toBe(2);
    expect(capabilities.sizeMultiple).toBe(64);
    expect(capabilities.presets.map((preset) => preset.id)).toEqual(['h3-1024', 'h3-1536']);
    expect(capabilities.presets[0]?.label).toBe('1024 x 1024');
    expect(capabilities.notes).toEqual(['The H3 graph takes a size and a seed, and nothing else.']);
    // Fields the override does not name keep the text to image defaults.
    expect(capabilities.seed).toBe(true);
    expect(capabilities.negativePrompt).toBe(true);
    expect(capabilities.adjustableSteps).toBe(true);
    expect(capabilities.fixedSteps).toBeNull();
    expect(capabilities.guidance).toBe(true);
    expect(capabilities.maxReferenceImages).toBe(0);
    expect(capabilities.arbitrarySize).toBe(true);
    expect(capabilities.outputFormats).toEqual(['png']);
    expect(capabilities.streamingProgress).toBe(true);
  });

  it('can declare a model with fixed sampling and no negative prompt', async () => {
    const adapter = createComfyUIAdapter(
      comfyConfig('http://127.0.0.1:1', {
        capabilities: { negativePrompt: false, fixedSteps: 6, adjustableSteps: false, guidance: false },
      }),
    );

    const capabilities = await adapter.capabilities();

    expect(capabilities.negativePrompt).toBe(false);
    expect(capabilities.fixedSteps).toBe(6);
    expect(capabilities.adjustableSteps).toBe(false);
    expect(capabilities.guidance).toBe(false);
    // Everything else still describes a text to image graph.
    expect(capabilities.seed).toBe(true);
    expect(capabilities.maxBatch).toBe(4);
    expect(capabilities.sizeMultiple).toBe(8);
    expect(capabilities.presets).toHaveLength(4);
    expect(capabilities.notes).toHaveLength(2);
  });

  it('rejects an unknown capability name instead of ignoring it', async () => {
    const adapter = createComfyUIAdapter(comfyConfig('http://127.0.0.1:1', { capabilities: { seeds: true } }));

    const failure = await adapter.capabilities().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ComfyUIError);
    if (!(failure instanceof ComfyUIError)) throw new Error('expected a ComfyUIError');
    expect(failure.code).toBe('invalid_capabilities');
    expect(failure.message).toContain('options.capabilities.seeds');
    expect(failure.message).toContain('negativePrompt');
  });

  it('rejects a wrong capability type and a malformed preset with the field named', async () => {
    const wrongType = createComfyUIAdapter(comfyConfig('http://127.0.0.1:1', { capabilities: { maxBatch: '4' } }));
    await expect(wrongType.capabilities()).rejects.toThrow(
      /options\.capabilities\.maxBatch must be a positive integer/,
    );
    await expect(wrongType.capabilities()).rejects.toMatchObject({ code: 'invalid_capabilities' });

    const badPreset = createComfyUIAdapter(
      comfyConfig('http://127.0.0.1:1', {
        capabilities: { presets: [{ id: 'wide', label: 'Wide', width: 0, height: 512 }] },
      }),
    );
    await expect(badPreset.capabilities()).rejects.toThrow(/options\.capabilities\.presets\[0\]\.width/);

    const unknownPresetField = createComfyUIAdapter(
      comfyConfig('http://127.0.0.1:1', {
        capabilities: { presets: [{ id: 'wide', label: 'Wide', width: 512, height: 512, shade: 2 }] },
      }),
    );
    await expect(unknownPresetField.capabilities()).rejects.toThrow(
      /options\.capabilities\.presets\[0\]\.shade is not a size preset field/,
    );
  });

  it('ships a default text to image template with the contract node classes', () => {
    const classTypes = Object.values(defaultWorkflowTemplate).map((node) => node.class_type);
    expect(classTypes.filter((type) => type === 'CLIPTextEncode')).toHaveLength(2);
    expect(classTypes).toEqual(
      expect.arrayContaining([
        'CheckpointLoaderSimple',
        'EmptyLatentImage',
        'KSampler',
        'VAEDecode',
        'SaveImage',
      ]),
    );
    const serialized = JSON.stringify(defaultWorkflowTemplate);
    for (const placeholder of [
      '{{prompt}}',
      '{{negativePrompt}}',
      '{{width}}',
      '{{height}}',
      '{{seed}}',
      '{{steps}}',
      '{{cfg}}',
      '{{ckpt}}',
      '{{batch}}',
    ]) {
      expect(serialized).toContain(placeholder);
    }
  });

  it('emits an item event with the PNG bytes on success', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-item' } },
      historyResponse: () => ({
        status: 200,
        body: {
          'prompt-item': {
            outputs: { '9': { images: [{ filename: 'h3_item.png', subfolder: '', type: 'output' }] } },
          },
        },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000 }));
    const run = context();

    const outcome = await adapter.generate(BASE_REQUEST, {
      signal: run.signal,
      onEvent: (event) => run.events.push(event),
    });

    const itemEvents = run.events.filter(
      (event): event is Extract<GenerationEvent, { type: 'item' }> => event.type === 'item',
    );
    expect(itemEvents).toHaveLength(1);
    const first = itemEvents[0];
    if (first === undefined) throw new Error('expected one item event');
    expect(first.index).toBe(0);
    expect(first.item.ok).toBe(true);
    expect(first.item.bytes).toEqual(PNG_BYTES);
    expect(outcome.items).toHaveLength(1);
  });

  it('saves the PNG into a LibraryStore through GenerationHub', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-hub' } },
      historyResponse: () => ({
        status: 200,
        body: {
          'prompt-hub': {
            outputs: { '9': { images: [{ filename: 'h3_hub.png', subfolder: '', type: 'output' }] } },
          },
        },
      }),
      viewBytes: PNG_BYTES,
    });
    const rootDir = await mkdtemp(path.join(tmpdir(), 'h3-comfy-hub-'));
    try {
      const store = new LibraryStore({ rootDir });
      await store.init();
      const config = comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 5000 });
      const hub = new GenerationHub({ store, adapterFactory: (candidate) => createComfyUIAdapter(candidate) });
      const batch = await hub.start(config, BASE_REQUEST);

      const events: BatchStreamEvent[] = [];
      hub.subscribe(batch.id, (event) => {
        events.push(event);
      });
      const deadline = Date.now() + 5000;
      while (!events.some((event) => event.type === 'batch') && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      const closing = events.find((event) => event.type === 'batch');
      if (closing === undefined || closing.type !== 'batch') throw new Error('no batch event was published');
      expect(closing.batch.status).toBe('complete');
      expect(closing.batch.images).toHaveLength(1);

      const stored = closing.batch.images[0];
      if (stored === undefined) throw new Error('expected one stored image');
      const read = await store.readImage(stored.id);
      if (read === null) throw new Error('expected the image bytes in the library');
      expect(Uint8Array.from(read.bytes)).toEqual(PNG_BYTES);
      expect(read.meta.width).toBe(16);
      expect(read.meta.height).toBe(16);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('marks a ComfyUI runtime execution_error as a retryable failed item', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-runtime' } },
      historyResponse: () => ({
        status: 200,
        body: {
          'prompt-runtime': {
            status: {
              status_str: 'error',
              completed: false,
              messages: [
                ['execution_start', { prompt_id: 'prompt-runtime' }],
                [
                  'execution_error',
                  {
                    prompt_id: 'prompt-runtime',
                    node_id: '7',
                    node_type: 'KSampler',
                    exception_message: 'HIP out of memory',
                    exception_type: 'torch.OutOfMemoryError',
                  },
                ],
              ],
            },
          },
        },
      }),
    });
    const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000 }));
    const run = context();

    const outcome = await adapter.generate(BASE_REQUEST, {
      signal: run.signal,
      onEvent: (event) => run.events.push(event),
    });

    expect(outcome.items).toHaveLength(1);
    const item = outcome.items[0];
    if (item === undefined) throw new Error('expected one item');
    expect(item.ok).toBe(false);
    expect(item.failure?.code).toBe('execution_error');
    expect(item.failure?.retryable).toBe(true);
    expect(item.failure?.message).toContain('KSampler');
    expect(item.failure?.message).toContain('HIP out of memory');

    const itemEvents = run.events.filter(
      (event): event is Extract<GenerationEvent, { type: 'item' }> => event.type === 'item',
    );
    expect(itemEvents).toHaveLength(1);
    expect(itemEvents[0]?.index).toBe(0);
    expect(itemEvents[0]?.item.failure?.code).toBe('execution_error');
  });

  it('runs a sequential batch when the template has no batch placeholder', async () => {
    const sequentialTemplate = {
      '1': {
        class_type: 'KSampler',
        inputs: { seed: '{{seed}}', steps: '{{steps}}', width: '{{width}}', height: '{{height}}' },
      },
      '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'h3-studio', images: ['1', 0] } },
    };
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-seq' } },
      historyResponse: (poll) => {
        if (poll === 1) {
          return {
            status: 200,
            body: {
              'prompt-seq': {
                status: {
                  status_str: 'error',
                  messages: [
                    ['execution_error', { node_id: '1', node_type: 'KSampler', exception_message: 'slot zero died' }],
                  ],
                },
              },
            },
          };
        }
        return {
          status: 200,
          body: { 'prompt-seq': { outputs: { '2': { images: [{ filename: 'slot_one.png', subfolder: '' }] } } } },
        };
      },
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(sequentialTemplate),
      }),
    );
    const request: GenerationRequest = { prompt: 'two plates', width: 512, height: 512, count: 2, seed: 1000 };
    const run = context();

    const outcome = await adapter.generate(request, {
      signal: run.signal,
      onEvent: (event) => run.events.push(event),
    });

    const posts = stub.requests.filter((entry) => entry.method === 'POST' && entry.path === '/prompt');
    expect(posts).toHaveLength(2);
    const seeds = posts.map((entry) => {
      const graph = record(record(entry.body)['prompt']);
      const sampler = nodesOfType(graph, 'KSampler')[0];
      if (sampler === undefined) throw new Error('missing KSampler in a posted graph');
      return inputsOf(sampler)['seed'];
    });
    expect(seeds).toEqual([1000, 1001]);

    expect(outcome.items).toHaveLength(2);
    expect(outcome.items[0]?.index).toBe(0);
    expect(outcome.items[0]?.ok).toBe(false);
    expect(outcome.items[0]?.failure?.code).toBe('execution_error');
    expect(outcome.items[1]?.index).toBe(1);
    expect(outcome.items[1]?.ok).toBe(true);
    expect(outcome.items[1]?.bytes).toEqual(PNG_BYTES);

    const itemEvents = run.events.filter(
      (event): event is Extract<GenerationEvent, { type: 'item' }> => event.type === 'item',
    );
    expect(itemEvents.map((event) => event.index)).toEqual([0, 1]);
    expect(itemEvents[0]?.item.ok).toBe(false);
    expect(itemEvents[1]?.item.ok).toBe(true);
  });

  it('falls back to capabilities.fixedSteps when the request omits steps', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-steps' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-steps': { outputs: { '9': { images: [{ filename: 'fixed.png', subfolder: '' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        capabilities: { fixedSteps: 6, adjustableSteps: false },
      }),
    );
    const run = context();

    await adapter.generate(BASE_REQUEST, { signal: run.signal, onEvent: () => {} });

    const sampler = nodesOfType(postedGraph(stub), 'KSampler')[0];
    if (sampler === undefined) throw new Error('missing KSampler node');
    expect(inputsOf(sampler)['steps']).toBe(6);
  });
});

/** A graph shaped like the H3 image template: one conditioning node that takes pictures. */
const REFERENCE_TEMPLATE = {
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '{{prompt}}' } },
  '2': {
    class_type: 'MiniMaxH3ImageConditioning',
    inputs: { prompt: ['1', 0], width: '{{width}}', height: '{{height}}' },
  },
  '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'h3-studio', images: ['2', 0] } },
};

describe('ComfyUI reference images', () => {
  it('wires one LoadImage per reference into the conditioning node', () => {
    const graph = attachReferenceImages(REFERENCE_TEMPLATE, ['first.png', 'nested/second.png']);

    const conditioning = nodesOfType(graph, 'MiniMaxH3ImageConditioning')[0];
    if (conditioning === undefined) throw new Error('missing conditioning node');
    const conditioningInputs = inputsOf(conditioning);
    expect(conditioningInputs['images.image_1']).toEqual(['ref_image_1', 0]);
    expect(conditioningInputs['images.image_2']).toEqual(['ref_image_2', 0]);

    const loaders = nodesOfType(graph, 'LoadImage');
    expect(loaders).toHaveLength(2);
    const first = graph['ref_image_1'];
    const second = graph['ref_image_2'];
    if (!isRecord(first) || !isRecord(second)) throw new Error('missing LoadImage nodes');
    expect(inputsOf(first)).toEqual({ image: 'first.png', upload: 'image' });
    expect(inputsOf(second)).toEqual({ image: 'nested/second.png', upload: 'image' });

    // The template itself is untouched, so the next request starts from the same graph.
    expect(nodesOfType(REFERENCE_TEMPLATE, 'LoadImage')).toHaveLength(0);
    expect(inputsOf(REFERENCE_TEMPLATE['2'])).not.toHaveProperty('images.image_1');
  });

  it('returns the graph unchanged when there are no references', () => {
    expect(attachReferenceImages(REFERENCE_TEMPLATE, [])).toBe(REFERENCE_TEMPLATE);
  });

  it('rejects a graph without a reference conditioning node', () => {
    const graph: Record<string, unknown> = {
      '1': { class_type: 'KSampler', inputs: { seed: 1 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    };
    let failure: unknown = null;
    try {
      attachReferenceImages(graph, ['first.png']);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ComfyUIError);
    if (!(failure instanceof ComfyUIError)) throw new Error('expected a ComfyUIError');
    expect(failure.code).toBe('unsupported_references');
    expect(failure.message).toContain('does not have a reference image conditioning node');
  });

  it('names the first picture in an alteration prompt only when H3 needs it', () => {
    expect(formatReferencePrompt('make it snow', REFERENCE_TEMPLATE, true)).toBe('Edit <Picture 1>. make it snow');
    expect(formatReferencePrompt('  make it snow  ', REFERENCE_TEMPLATE, true)).toBe(
      'Edit <Picture 1>. make it snow',
    );
    expect(formatReferencePrompt('Edit <Picture 2>. make it snow', REFERENCE_TEMPLATE, true)).toBe(
      'Edit <Picture 2>. make it snow',
    );
    expect(formatReferencePrompt('make it snow', REFERENCE_TEMPLATE, false)).toBe('make it snow');
    expect(formatReferencePrompt('make it snow', defaultWorkflowTemplate, true)).toBe('make it snow');
  });

  it('uploads reference paths once and queues a graph with the picture wired in', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'h3-comfy-ref-'));
    const referencePath = path.join(rootDir, 'source.png');
    await writeFile(referencePath, PNG_BYTES);
    try {
      const stub = await startStub({
        promptResponse: { status: 200, body: { prompt_id: 'prompt-ref' } },
        uploadResponse: { status: 200, body: { name: 'source.png', subfolder: 'h3' } },
        historyResponse: () => ({
          status: 200,
          body: { 'prompt-ref': { outputs: { '3': { images: [{ filename: 'altered.png', subfolder: '' }] } } } },
        }),
        viewBytes: PNG_BYTES,
      });
      const adapter = createComfyUIAdapter(
        comfyConfig(stub.baseUrl, {
          pollIntervalMs: 10,
          timeoutMs: 2000,
          workflowTemplate: JSON.stringify(REFERENCE_TEMPLATE),
        }),
      );
      const run = context();

      const outcome = await adapter.generate(
        { ...BASE_REQUEST, prompt: 'make it snow', referenceIds: [referencePath] },
        { signal: run.signal, onEvent: () => {} },
      );

      expect(outcome.items).toHaveLength(1);
      expect(outcome.items[0]?.ok).toBe(true);

      const uploads = stub.requests.filter((entry) => entry.method === 'POST' && entry.path === '/upload/image');
      expect(uploads).toHaveLength(1);
      const rawUpload = uploads[0]?.body;
      expect(typeof rawUpload).toBe('string');
      if (typeof rawUpload !== 'string') throw new Error('expected the multipart body');
      expect(rawUpload).toContain('name="image"; filename="source.png"');
      expect(rawUpload).toContain('name="type"');

      const graph = postedGraph(stub);
      const loaders = nodesOfType(graph, 'LoadImage');
      expect(loaders).toHaveLength(1);
      const loader = loaders[0];
      if (loader === undefined) throw new Error('missing LoadImage node');
      expect(inputsOf(loader)['image']).toBe('h3/source.png');

      const conditioning = nodesOfType(graph, 'MiniMaxH3ImageConditioning')[0];
      if (conditioning === undefined) throw new Error('missing conditioning node');
      expect(inputsOf(conditioning)['images.image_1']).toEqual(['ref_image_1', 0]);

      const promptNode = nodesOfType(graph, 'PrimitiveStringMultiline')[0];
      if (promptNode === undefined) throw new Error('missing prompt node');
      expect(inputsOf(promptNode)['value']).toBe('Edit <Picture 1>. make it snow');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('fails before uploading when the template has no reference node', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'h3-comfy-noref-'));
    const referencePath = path.join(rootDir, 'source.png');
    await writeFile(referencePath, PNG_BYTES);
    try {
      const stub = await startStub();
      const adapter = createComfyUIAdapter(comfyConfig(stub.baseUrl, { pollIntervalMs: 10, timeoutMs: 2000 }));
      const run = context();

      await expect(
        adapter.generate({ ...BASE_REQUEST, referenceIds: [referencePath] }, { signal: run.signal, onEvent: () => {} }),
      ).rejects.toMatchObject({ code: 'unsupported_references' });
      expect(stub.requests.some((entry) => entry.path === '/upload/image')).toBe(false);
      expect(stub.requests.some((entry) => entry.path === '/prompt')).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

/** The prompt enhancer leg of the H3 template: one switch picks raw prompt or expansion. */
const ENHANCER_TEMPLATE = {
  '5': {
    class_type: 'MiniMaxH3ImageConditioning',
    inputs: { prompt: ['22', 0], width: '{{width}}', height: '{{height}}' },
  },
  '22': {
    class_type: 'ComfySwitchNode',
    inputs: { switch: false, on_false: ['24', 0], on_true: ['26', 0] },
  },
  '24': { class_type: 'PrimitiveStringMultiline', inputs: { value: '{{prompt}}' } },
  '26': { class_type: 'JsonExtractString', inputs: { json_string: ['15', 0], key: 'expanded_caption' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'h3-studio', images: ['5', 0] } },
};

function switchOf(graph: Record<string, unknown>): unknown {
  const node = graph['22'];
  if (!isRecord(node)) throw new Error('missing the ComfySwitchNode');
  return inputsOf(node)['switch'];
}

/** The enhancer leg plus the fast 9B CLIP file the graph loads. */
const ENHANCER_CLIP_TEMPLATE: Record<string, unknown> = {
  ...ENHANCER_TEMPLATE,
  '16': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: 'qwen3.5_9b_w4a8_gptq.safetensors', type: 'minimax', device: 'default' },
  },
};

function clipNameOf(graph: Record<string, unknown>): unknown {
  return inputsOf(nodeOf(graph, '16'))['clip_name'];
}

describe('ComfyUI prompt enhancer', () => {
  it('returns the graph untouched when the request says nothing', () => {
    expect(applyPromptEnhancer(ENHANCER_TEMPLATE, undefined, false)).toBe(ENHANCER_TEMPLATE);
    expect(applyPromptEnhancer(ENHANCER_TEMPLATE, undefined, true)).toBe(ENHANCER_TEMPLATE);
  });

  it('toggles the switch node without changing the template', () => {
    const on = applyPromptEnhancer(ENHANCER_TEMPLATE, true, false);
    expect(switchOf(on)).toBe(true);
    expect(switchOf(ENHANCER_TEMPLATE)).toBe(false);

    const off = applyPromptEnhancer(on, false, false);
    expect(switchOf(off)).toBe(false);
    expect(switchOf(on)).toBe(true);
    // The raw prompt node is still wired in, so turning the switch back on works.
    const raw = on['24'];
    if (!isRecord(raw)) throw new Error('missing the raw prompt node');
    expect(inputsOf(raw)['value']).toBe('{{prompt}}');
  });

  it('forces the enhancer off during an alteration', () => {
    expect(switchOf(applyPromptEnhancer(ENHANCER_TEMPLATE, true, true))).toBe(false);
    expect(switchOf(applyPromptEnhancer(ENHANCER_TEMPLATE, false, true))).toBe(false);
  });

  it('retargets the enhancer CLIP for each named mode', () => {
    const fast = applyPromptEnhancer(ENHANCER_CLIP_TEMPLATE, undefined, false, 'qwen3.5_9b');
    expect(clipNameOf(fast)).toBe('qwen3.5_9b_w4a8_gptq.safetensors');
    expect(switchOf(fast)).toBe(true);

    const best = applyPromptEnhancer(ENHANCER_CLIP_TEMPLATE, undefined, false, 'qwen3.8_27b');
    expect(clipNameOf(best)).toBe('qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors');
    expect(switchOf(best)).toBe(true);

    // The template itself is never mutated.
    expect(clipNameOf(ENHANCER_CLIP_TEMPLATE)).toBe('qwen3.5_9b_w4a8_gptq.safetensors');
    expect(switchOf(ENHANCER_CLIP_TEMPLATE)).toBe(false);
  });

  it('forces the 27B enhancer off during an alteration', () => {
    const on = applyPromptEnhancer(ENHANCER_CLIP_TEMPLATE, undefined, false, 'qwen3.8_27b');
    expect(switchOf(on)).toBe(true);
    const off = applyPromptEnhancer(on, undefined, true, 'qwen3.8_27b');
    expect(switchOf(off)).toBe(false);
  });

  it('leaves a CLIPLoader that is not an H3 enhancer alone', () => {
    const graph: Record<string, unknown> = {
      '16': { class_type: 'CLIPLoader', inputs: { clip_name: 'sd15-clip.safetensors' } },
      '22': { class_type: 'ComfySwitchNode', inputs: { switch: false } },
    };
    expect(clipNameOf(applyPromptEnhancer(graph, true, false, 'qwen3.8_27b'))).toBe('sd15-clip.safetensors');
    // No switch beside it either, so nothing in this graph is the H3 enhancer.
    expect(inputsOf(nodeOf(applyPromptEnhancer(graph, true, false, 'qwen3.8_27b'), '22'))['switch']).toBe(true);
  });

  it('returns a graph without a switch node unchanged', () => {
    const graph: Record<string, unknown> = {
      '1': { class_type: 'KSampler', inputs: { seed: 1 } },
    };
    expect(applyPromptEnhancer(graph, true, false)).toBe(graph);
  });

  it('posts the enhancer state the request asked for', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-enhance' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-enhance': { outputs: { '9': { images: [{ filename: 'enhanced.png', subfolder: '' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(ENHANCER_TEMPLATE),
      }),
    );
    const run = context();

    await adapter.generate(
      { ...BASE_REQUEST, enhancePrompt: true },
      { signal: run.signal, onEvent: () => {} },
    );

    expect(switchOf(postedGraph(stub))).toBe(true);
  });

  it('posts the 27B enhancer clip when the request names it', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-enhance-27b' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-enhance-27b': { outputs: { '9': { images: [{ filename: 'best.png', subfolder: '' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(ENHANCER_CLIP_TEMPLATE),
      }),
    );
    const run = context();

    await adapter.generate(
      { ...BASE_REQUEST, promptEnhancer: 'qwen3.8_27b' },
      { signal: run.signal, onEvent: () => {} },
    );

    const graph = postedGraph(stub);
    expect(switchOf(graph)).toBe(true);
    expect(clipNameOf(graph)).toBe('qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors');
  });
});

/** A graph with one H3 diffusion loader next to a generic checkpoint loader. */
function variantTemplate(): Record<string, unknown> {
  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'minimax_h3_image_pruned_int8_convrot.safetensors', weight_dtype: 'default' },
    },
    '2': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'v1-5-pruned-emaonly.safetensors', weight_dtype: 'default' },
    },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'h3-studio', images: ['1', 0] } },
  };
}

function unetNameOf(graph: Record<string, unknown>, nodeId: string): unknown {
  const node = graph[nodeId];
  if (!isRecord(node)) throw new Error(`missing node ${nodeId}`);
  return inputsOf(node)['unet_name'];
}

describe('ComfyUI model variant', () => {
  it('returns the graph untouched when the request names no variant', () => {
    const graph = variantTemplate();
    expect(applyModelVariant(graph, undefined)).toBe(graph);
  });

  it('switches an H3 UNETLoader between the two official weights', () => {
    const graph = variantTemplate();

    const fast = applyModelVariant(graph, 'w4a8');
    expect(unetNameOf(fast, '1')).toBe('minimax_h3_image_pruned_w4a8.safetensors');
    // The template itself is never mutated.
    expect(unetNameOf(graph, '1')).toBe('minimax_h3_image_pruned_int8_convrot.safetensors');

    const max = applyModelVariant(fast, 'int8_convrot');
    expect(unetNameOf(max, '1')).toBe('minimax_h3_image_pruned_int8_convrot.safetensors');
  });

  it('leaves a non-H3 UNETLoader node untouched', () => {
    const graph = variantTemplate();
    expect(unetNameOf(applyModelVariant(graph, 'w4a8'), '2')).toBe('v1-5-pruned-emaonly.safetensors');
  });

  it('returns the graph unchanged when no H3 UNETLoader is present', () => {
    const graph: Record<string, unknown> = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'sd15.safetensors' } },
      '2': { class_type: 'KSampler', inputs: { seed: 1 } },
    };
    expect(applyModelVariant(graph, 'w4a8')).toBe(graph);
  });

  it('posts the w4a8 UNet filename to ComfyUI', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-variant' } },
      historyResponse: () => ({
        status: 200,
        body: { 'prompt-variant': { outputs: { '9': { images: [{ filename: 'variant.png', subfolder: '' }] } } } },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(variantTemplate()),
      }),
    );
    const run = context();

    await adapter.generate(
      { ...BASE_REQUEST, modelVariant: 'w4a8' },
      { signal: run.signal, onEvent: () => {} },
    );

    expect(unetNameOf(postedGraph(stub), '1')).toBe('minimax_h3_image_pruned_w4a8.safetensors');
    expect(unetNameOf(postedGraph(stub), '2')).toBe('v1-5-pruned-emaonly.safetensors');
  });
});

/** A linear pipeline with no {{batch}} placeholder, so the adapter can fan it out. */
const MULTI_SEED_TEMPLATE: Record<string, unknown> = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{ckpt}}' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
  '6': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      model: ['1', 0],
      positive: ['4', 0],
      latent_image: ['6', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'h3-studio', images: ['8', 0] } },
};

describe('ComfyUI multi seed expansion', () => {
  it('returns null for a single image request', () => {
    expect(expandMultiSeedGraph(defaultWorkflowTemplate, 1, 10)).toBeNull();
  });

  it('clones the sampler, decode and save nodes and shares the text encode', () => {
    const expanded = expandMultiSeedGraph(defaultWorkflowTemplate, 3, 700);
    if (expanded === null) throw new Error('expected the default graph to expand');

    expect(nodesOfType(expanded.graph, 'KSampler')).toHaveLength(3);
    expect(nodesOfType(expanded.graph, 'VAEDecode')).toHaveLength(3);
    expect(nodesOfType(expanded.graph, 'SaveImage')).toHaveLength(3);
    // One text encode pair and one latent serve all three samplers.
    expect(nodesOfType(expanded.graph, 'CLIPTextEncode')).toHaveLength(2);
    expect(nodesOfType(expanded.graph, 'EmptyLatentImage')).toHaveLength(1);

    expect([...expanded.samplerSlots.entries()]).toEqual([
      ['7', 0],
      ['batch_sampler_1', 1],
      ['batch_sampler_2', 2],
    ]);
    expect(expanded.saveNodeIds).toEqual(['9', 'batch_save_1', 'batch_save_2']);

    expect(inputsOf(nodeOf(expanded.graph, '7'))['seed']).toBe('{{seed}}');
    expect(inputsOf(nodeOf(expanded.graph, 'batch_sampler_1'))['seed']).toBe(701);
    expect(inputsOf(nodeOf(expanded.graph, 'batch_sampler_2'))['seed']).toBe(702);
    for (const sampler of nodesOfType(expanded.graph, 'KSampler')) {
      expect(inputsOf(sampler)['positive']).toEqual(['4', 0]);
    }
    expect(inputsOf(nodeOf(expanded.graph, 'batch_decode_1'))['samples']).toEqual(['batch_sampler_1', 0]);
    expect(inputsOf(nodeOf(expanded.graph, 'batch_save_1'))['images']).toEqual(['batch_decode_1', 0]);

    // The template itself is never mutated.
    expect(Object.keys(defaultWorkflowTemplate)).toHaveLength(7);
  });

  it('returns null when the graph is not one linear sampler pipeline', () => {
    const noDecode: Record<string, unknown> = {
      '1': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    };
    expect(expandMultiSeedGraph(noDecode, 2, 5)).toBeNull();

    const twoSamplers: Record<string, unknown> = {
      ...defaultWorkflowTemplate,
      extra: { class_type: 'KSampler', inputs: { seed: 3 } },
    };
    expect(expandMultiSeedGraph(twoSamplers, 2, 5)).toBeNull();
  });

  it('queues one prompt for a three image batch and returns every slot', async () => {
    const stub = await startStub({
      promptResponse: { status: 200, body: { prompt_id: 'prompt-multi' } },
      historyResponse: () => ({
        status: 200,
        body: {
          'prompt-multi': {
            outputs: {
              '9': { images: [{ filename: 'slot_0.png', subfolder: '' }] },
              batch_save_1: { images: [{ filename: 'slot_1.png', subfolder: '' }] },
              batch_save_2: { images: [{ filename: 'slot_2.png', subfolder: '' }] },
            },
          },
        },
      }),
      viewBytes: PNG_BYTES,
    });
    const adapter = createComfyUIAdapter(
      comfyConfig(stub.baseUrl, {
        pollIntervalMs: 10,
        timeoutMs: 2000,
        workflowTemplate: JSON.stringify(MULTI_SEED_TEMPLATE),
      }),
    );
    const run = context();

    const outcome = await adapter.generate(
      { ...BASE_REQUEST, count: 3, seed: 500 },
      { signal: run.signal, onEvent: (event) => run.events.push(event) },
    );

    const posts = stub.requests.filter((entry) => entry.method === 'POST' && entry.path === '/prompt');
    expect(posts).toHaveLength(1);
    const posted = posts[0];
    if (posted === undefined) throw new Error('no POST /prompt request recorded');
    const graph = record(record(posted.body)['prompt']);
    expect(nodesOfType(graph, 'KSampler')).toHaveLength(3);
    expect(nodesOfType(graph, 'CLIPTextEncode')).toHaveLength(1);
    for (const sampler of nodesOfType(graph, 'KSampler')) {
      expect(inputsOf(sampler)['positive']).toEqual(['4', 0]);
    }

    expect(outcome.items).toHaveLength(3);
    expect(outcome.items.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(outcome.items.map((item) => item.seed)).toEqual([500, 501, 502]);
    expect(outcome.items.every((item) => item.ok)).toBe(true);

    const views = stub.requests.filter((entry) => entry.path.startsWith('/view'));
    expect(views.map((entry) => new URLSearchParams(entry.path.split('?')[1] ?? '').get('filename'))).toEqual([
      'slot_0.png',
      'slot_1.png',
      'slot_2.png',
    ]);

    const itemEvents = run.events.filter(
      (event): event is Extract<GenerationEvent, { type: 'item' }> => event.type === 'item',
    );
    expect(itemEvents.map((event) => event.index)).toEqual([0, 1, 2]);
  });
});
