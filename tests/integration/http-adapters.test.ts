// Integration tests for the two HTTP JSON providers. Each test starts a real node:http
// server on the loopback interface and asserts both the outgoing request and the outcome.

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A1111Adapter } from '../../src/core/providers/a1111';
import { OpenAIImagesAdapter } from '../../src/core/providers/openai-images';
import type {
  GeneratedItem,
  GenerationContext,
  GenerationEvent,
  GenerationOutcome,
  ProviderConfig,
} from '../../src/core/types';

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status: number;
  body: string;
  contentType?: string;
}

type Handler = (request: RecordedRequest, index: number) => Reply | Promise<Reply>;

interface TestServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const openServers: TestServer[] = [];
const tempDirs: string[] = [];

function startServer(handler: Handler): Promise<TestServer> {
  return new Promise<TestServer>((resolve, reject) => {
    const requests: RecordedRequest[] = [];
    const server: Server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        const record: RecordedRequest = {
          method: incoming.method ?? '',
          url: incoming.url ?? '',
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(record);
        void (async () => {
          try {
            const reply = await handler(record, requests.length - 1);
            response.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' });
            response.end(reply.body);
          } catch {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end('{"error":"test server failure"}');
          }
        })();
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | string | null;
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not report a port'));
        return;
      }
      const testServer: TestServer = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      };
      openServers.push(testServer);
      resolve(testServer);
    });
  });
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) await server.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function requestAt(server: TestServer, index: number): RecordedRequest {
  const found = server.requests[index];
  if (found === undefined) throw new Error(`no request recorded at index ${index}`);
  return found;
}

function itemAt(outcome: GenerationOutcome, index: number): GeneratedItem {
  const found = outcome.items[index];
  if (found === undefined) throw new Error(`no item reported at index ${index}`);
  return found;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function textOf(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? '' : Buffer.from(bytes).toString('utf8');
}

interface Context {
  ctx: GenerationContext;
  events: GenerationEvent[];
}

function makeContext(signal?: AbortSignal): Context {
  const events: GenerationEvent[] = [];
  const effective = signal ?? new AbortController().signal;
  return { ctx: { signal: effective, onEvent: (event) => events.push(event) }, events };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openAiConfig(baseUrl: string): ProviderConfig {
  return { id: 'openai-test', kind: 'openai-images', label: 'SGLang', baseUrl, model: 'test-model' };
}

function a1111Config(baseUrl: string): ProviderConfig {
  return { id: 'a1111-test', kind: 'a1111', label: 'Automatic1111', baseUrl };
}

describe('OpenAIImagesAdapter', () => {
  it('sends the documented JSON once per image and returns both images', async () => {
    const server = await startServer((_request, index) => {
      const payload = index === 0 ? 'first-image' : 'second-image';
      return { status: 200, body: JSON.stringify({ data: [{ b64_json: b64(payload) }] }) };
    });
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx, events } = makeContext();

    const outcome = await adapter.generate(
      { prompt: 'a red fox', width: 1024, height: 768, count: 2, seed: 42 },
      ctx,
    );

    expect(server.requests).toHaveLength(2);
    expect(requestAt(server, 0).method).toBe('POST');
    expect(requestAt(server, 0).url).toBe('/v1/images/generations');
    expect(requestAt(server, 0).headers['content-type']).toBe('application/json');
    expect(JSON.parse(requestAt(server, 0).body) as unknown).toEqual({
      model: 'test-model',
      prompt: 'a red fox',
      size: '1024x768',
      n: 1,
      response_format: 'b64_json',
      seed: 42,
    });
    expect(JSON.parse(requestAt(server, 1).body) as unknown).toEqual({
      model: 'test-model',
      prompt: 'a red fox',
      size: '1024x768',
      n: 1,
      response_format: 'b64_json',
      seed: 42,
    });

    expect(outcome.providerId).toBe('openai-test');
    expect(outcome.items).toHaveLength(2);
    expect(itemAt(outcome, 0).ok).toBe(true);
    expect(itemAt(outcome, 0).index).toBe(0);
    expect(itemAt(outcome, 0).width).toBe(1024);
    expect(itemAt(outcome, 0).height).toBe(768);
    expect(itemAt(outcome, 0).seed).toBe(42);
    expect(textOf(itemAt(outcome, 0).bytes)).toBe('first-image');
    expect(textOf(itemAt(outcome, 1).bytes)).toBe('second-image');

    const stages = events.filter((event) => event.type === 'progress').map((event) => event.stage);
    expect(stages).toEqual(['requesting', 'requesting']);
    expect(events.filter((event) => event.type === 'item')).toHaveLength(2);
  });

  it('reports a per item error as a retryable failed item', async () => {
    const server = await startServer((_request, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ data: [{ b64_json: b64('ok-image') }] }) };
      return {
        status: 200,
        body: JSON.stringify({ data: [{ error: { message: 'worker crashed', code: 'server_error' } }] }),
      };
    });
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 2 }, ctx);

    expect(server.requests).toHaveLength(2);
    expect(itemAt(outcome, 0).ok).toBe(true);
    const failed = itemAt(outcome, 1);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.message).toBe('worker crashed');
    expect(failed.failure?.code).toBe('server_error');
    expect(failed.failure?.retryable).toBe(true);
  });

  it('marks a safety refusal inside a per item error as not retryable', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ error: { message: 'blocked by policy', code: 'content_filter' } }] }),
    }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 1 }, ctx);

    const failed = itemAt(outcome, 0);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.code).toBe('content_filter');
    expect(failed.failure?.retryable).toBe(false);
  });

  it('treats a top level base_resp error inside HTTP 200 as a failure', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'invalid prompt' } }),
    }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 2 }, ctx);

    expect(server.requests).toHaveLength(1);
    expect(outcome.items).toHaveLength(2);
    for (const item of outcome.items) {
      expect(item.ok).toBe(false);
      expect(item.failure?.message).toBe('invalid prompt');
      expect(item.failure?.code).toBe('1002');
      expect(item.bytes).toBeUndefined();
    }
  });

  it('treats a top level error object inside HTTP 200 as a failure', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ error: { message: 'quota exhausted', code: 'insufficient_quota' } }),
    }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 1 }, ctx);

    const failed = itemAt(outcome, 0);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.message).toBe('quota exhausted');
    expect(failed.failure?.code).toBe('insufficient_quota');
  });

  it('fails every index on a non 200 status and stops issuing requests', async () => {
    const server = await startServer(() => ({
      status: 500,
      body: JSON.stringify({ error: { message: 'upstream failed', code: 'internal' } }),
    }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 3 }, ctx);

    expect(server.requests).toHaveLength(1);
    expect(outcome.items).toHaveLength(3);
    expect(outcome.items.map((item) => item.index)).toEqual([0, 1, 2]);
    const failed = itemAt(outcome, 0);
    expect(failed.failure?.message).toBe('upstream failed');
    expect(failed.failure?.code).toBe('internal');
    expect(failed.failure?.retryable).toBe(true);
  });

  it('returns the finished items and stops when aborted mid batch', async () => {
    const secondRequest = deferred();
    const server = await startServer((_request, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ data: [{ b64_json: b64('first-image') }] }) };
      secondRequest.resolve();
      return new Promise<Reply>(() => {});
    });
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const controller = new AbortController();
    const { ctx } = makeContext(controller.signal);

    const generating = adapter.generate({ prompt: 'a red fox', width: 1024, height: 1024, count: 3 }, ctx);
    await secondRequest.promise;
    controller.abort();
    const outcome = await generating;

    expect(server.requests).toHaveLength(2);
    expect(outcome.items).toHaveLength(1);
    expect(itemAt(outcome, 0).ok).toBe(true);
    expect(textOf(itemAt(outcome, 0).bytes)).toBe('first-image');
  });

  it('posts reference images to the edits endpoint as multipart form data in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h3-refs-'));
    tempDirs.push(dir);
    const firstPath = join(dir, 'first.png');
    const secondPath = join(dir, 'second.png');
    await writeFile(firstPath, new Uint8Array([1, 2, 3]));
    await writeFile(secondPath, new Uint8Array([4, 5, 6]));

    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ b64_json: b64('edited-image'), revised_prompt: 'a fox in snow' }] }),
    }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate(
      {
        prompt: 'a red fox',
        width: 1024,
        height: 1024,
        count: 1,
        seed: 9,
        referenceIds: [firstPath, secondPath],
      },
      ctx,
    );

    const recorded = requestAt(server, 0);
    expect(recorded.url).toBe('/v1/images/edits');
    expect(recorded.headers['content-type']).toContain('multipart/form-data; boundary=');
    expect(recorded.body.split('name="image"').length - 1).toBe(2);
    expect(recorded.body).toContain('name="prompt"');
    expect(recorded.body).toContain('a red fox');
    expect(recorded.body).toContain('name="response_format"');
    expect(recorded.body).toContain('b64_json');
    expect(recorded.body.indexOf('filename="first.png"')).toBeLessThan(
      recorded.body.indexOf('filename="second.png"'),
    );

    expect(itemAt(outcome, 0).ok).toBe(true);
    expect(textOf(itemAt(outcome, 0).bytes)).toBe('edited-image');
    expect(outcome.revisedPrompt).toBe('a fox in snow');
  });

  it('fails clearly when the server does not implement edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h3-refs-'));
    tempDirs.push(dir);
    const referencePath = join(dir, 'first.png');
    await writeFile(referencePath, new Uint8Array([1, 2, 3]));

    const server = await startServer(() => ({ status: 404, body: '{"detail":"not found"}' }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate(
      { prompt: 'a red fox', width: 1024, height: 1024, count: 1, referenceIds: [referencePath] },
      ctx,
    );

    const failed = itemAt(outcome, 0);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.message).toContain('does not implement image edits');
    expect(failed.failure?.retryable).toBe(false);
  });

  it('reports health from the models endpoint', async () => {
    const server = await startServer(() => ({ status: 200, body: '{"data":[]}' }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));

    const result = await adapter.health();

    expect(result.ok).toBe(true);
    expect(requestAt(server, 0).method).toBe('GET');
    expect(requestAt(server, 0).url).toBe('/v1/models');
  });

  it('reports an unhealthy server without throwing', async () => {
    const server = await startServer(() => ({ status: 503, body: '{"error":"loading"}' }));
    const adapter = new OpenAIImagesAdapter(openAiConfig(server.baseUrl));

    const result = await adapter.health();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('declares the documented capabilities', async () => {
    const adapter = new OpenAIImagesAdapter(openAiConfig('http://127.0.0.1:1'));

    const capabilities = await adapter.capabilities();

    expect(capabilities.seed).toBe(true);
    expect(capabilities.negativePrompt).toBe(false);
    expect(capabilities.adjustableSteps).toBe(false);
    expect(capabilities.fixedSteps).toBeNull();
    expect(capabilities.guidance).toBe(false);
    expect(capabilities.maxReferenceImages).toBe(0);
    expect(capabilities.maxBatch).toBe(10);
    expect(capabilities.arbitrarySize).toBe(true);
    expect(capabilities.sizeMultiple).toBe(8);
    expect(capabilities.presets.map((preset) => preset.id)).toEqual([
      '1024x1024',
      '1344x768',
      '768x1344',
      '1536x864',
      '864x1536',
    ]);
    expect(capabilities.outputFormats).toEqual(['png']);
    expect(capabilities.streamingProgress).toBe(false);
    expect(capabilities.notes).toHaveLength(1);
    expect(capabilities.notes[0]).toContain('MiniMax');
  });
});

describe('A1111Adapter', () => {
  it('sends the documented JSON once per image and decodes both images', async () => {
    const server = await startServer((_request, index) => {
      const payload = index === 0 ? 'first-image' : 'second-image';
      return {
        status: 200,
        body: JSON.stringify({ images: [b64(payload)], info: JSON.stringify({ seed: 111, steps: 24 }) }),
      };
    });
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));
    const { ctx, events } = makeContext();

    const outcome = await adapter.generate(
      {
        prompt: 'a red fox',
        negativePrompt: 'blurry',
        width: 768,
        height: 512,
        count: 2,
        seed: 7,
        steps: 24,
        guidance: 6.5,
      },
      ctx,
    );

    expect(server.requests).toHaveLength(2);
    expect(requestAt(server, 0).method).toBe('POST');
    expect(requestAt(server, 0).url).toBe('/sdapi/v1/txt2img');
    expect(requestAt(server, 0).headers['content-type']).toBe('application/json');
    expect(JSON.parse(requestAt(server, 0).body) as unknown).toEqual({
      prompt: 'a red fox',
      negative_prompt: 'blurry',
      width: 768,
      height: 512,
      batch_size: 1,
      seed: 7,
      sampler_name: 'Euler a',
      steps: 24,
      cfg_scale: 6.5,
    });
    expect(JSON.parse(requestAt(server, 1).body) as unknown).toEqual({
      prompt: 'a red fox',
      negative_prompt: 'blurry',
      width: 768,
      height: 512,
      batch_size: 1,
      seed: 7,
      sampler_name: 'Euler a',
      steps: 24,
      cfg_scale: 6.5,
    });

    expect(outcome.items).toHaveLength(2);
    expect(itemAt(outcome, 0).ok).toBe(true);
    expect(itemAt(outcome, 0).width).toBe(768);
    expect(itemAt(outcome, 0).height).toBe(512);
    expect(itemAt(outcome, 0).seed).toBe(111);
    expect(textOf(itemAt(outcome, 0).bytes)).toBe('first-image');
    expect(textOf(itemAt(outcome, 1).bytes)).toBe('second-image');

    const stages = events.filter((event) => event.type === 'progress').map((event) => event.stage);
    expect(stages).toEqual(['requesting', 'requesting']);
  });

  it('reports a per item error from a later request and keeps the finished item', async () => {
    const server = await startServer((_request, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ images: [b64('first-image')], info: '{}' }) };
      return { status: 500, body: JSON.stringify({ error: 'CUDA out of memory', detail: 'CUDA out of memory' }) };
    });
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 512, height: 512, count: 2 }, ctx);

    expect(server.requests).toHaveLength(2);
    expect(itemAt(outcome, 0).ok).toBe(true);
    const failed = itemAt(outcome, 1);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.message).toContain('CUDA out of memory');
    expect(failed.failure?.retryable).toBe(true);
  });

  it('treats a top level error object inside HTTP 200 as a failure', async () => {
    const server = await startServer(() => ({ status: 200, body: JSON.stringify({ error: 'model failed to load' }) }));
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 512, height: 512, count: 2 }, ctx);

    expect(server.requests).toHaveLength(1);
    expect(outcome.items).toHaveLength(2);
    for (const item of outcome.items) {
      expect(item.ok).toBe(false);
      expect(item.failure?.message).toBe('model failed to load');
      expect(item.bytes).toBeUndefined();
    }
  });

  it('fails with a message naming the URL when the server is not A1111', async () => {
    const server = await startServer(() => ({ status: 404, body: '{"detail":"Not Found"}' }));
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));
    const { ctx } = makeContext();

    const outcome = await adapter.generate({ prompt: 'a red fox', width: 512, height: 512, count: 1 }, ctx);

    const failed = itemAt(outcome, 0);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.message).toContain(`${server.baseUrl}/sdapi/v1/txt2img`);
    expect(failed.failure?.retryable).toBe(false);
  });

  it('returns the finished items and stops when aborted mid batch', async () => {
    const secondRequest = deferred();
    const server = await startServer((_request, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ images: [b64('first-image')], info: '{}' }) };
      secondRequest.resolve();
      return new Promise<Reply>(() => {});
    });
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));
    const controller = new AbortController();
    const { ctx } = makeContext(controller.signal);

    const generating = adapter.generate({ prompt: 'a red fox', width: 512, height: 512, count: 3 }, ctx);
    await secondRequest.promise;
    controller.abort();
    const outcome = await generating;

    expect(server.requests).toHaveLength(2);
    expect(outcome.items).toHaveLength(1);
    expect(itemAt(outcome, 0).ok).toBe(true);
    expect(textOf(itemAt(outcome, 0).bytes)).toBe('first-image');
  });

  it('reports health from the options endpoint', async () => {
    const server = await startServer(() => ({ status: 200, body: '{"sd_model_checkpoint":"anything"}' }));
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));

    const result = await adapter.health();

    expect(result.ok).toBe(true);
    expect(requestAt(server, 0).method).toBe('GET');
    expect(requestAt(server, 0).url).toBe('/sdapi/v1/options');
  });

  it('reports an unhealthy server without throwing', async () => {
    const server = await startServer(() => ({ status: 404, body: '{"detail":"Not Found"}' }));
    const adapter = new A1111Adapter(a1111Config(server.baseUrl));

    const result = await adapter.health();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('404');
  });

  it('declares the documented capabilities', async () => {
    const adapter = new A1111Adapter(a1111Config('http://127.0.0.1:1'));

    const capabilities = await adapter.capabilities();

    expect(capabilities.seed).toBe(true);
    expect(capabilities.negativePrompt).toBe(true);
    expect(capabilities.adjustableSteps).toBe(true);
    expect(capabilities.fixedSteps).toBeNull();
    expect(capabilities.guidance).toBe(true);
    expect(capabilities.maxReferenceImages).toBe(0);
    expect(capabilities.maxBatch).toBe(8);
    expect(capabilities.arbitrarySize).toBe(true);
    expect(capabilities.sizeMultiple).toBe(8);
    expect(capabilities.presets.map((preset) => preset.id)).toEqual([
      '512x512',
      '768x768',
      '832x1216',
      '1216x832',
    ]);
    expect(capabilities.outputFormats).toEqual(['png']);
    expect(capabilities.streamingProgress).toBe(false);
  });
});
