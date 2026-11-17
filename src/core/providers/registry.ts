import type { ProviderAdapter, ProviderConfig, ProviderKind } from '../types';

type AdapterFactory = (config: ProviderConfig) => ProviderAdapter;

interface AdapterModule {
  readonly module: string;
  readonly create: string;
}

const ADAPTER_MODULES: Record<ProviderKind, AdapterModule> = {
  mock: { module: './mock', create: 'createMockAdapter' },
  comfyui: { module: './comfyui', create: 'createComfyUIAdapter' },
  'openai-images': { module: './openai-images', create: 'createOpenAIImagesAdapter' },
  a1111: { module: './a1111', create: 'createA1111Adapter' },
};

const MOCK_CONFIG: ProviderConfig = {
  id: 'mock',
  kind: 'mock',
  label: 'Mock (offline)',
  baseUrl: 'mock://local',
  enabled: true,
};

const REAL_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  {
    id: 'comfyui',
    kind: 'comfyui',
    label: 'ComfyUI',
    baseUrl: 'http://127.0.0.1:8188',
    enabled: false,
  },
  {
    id: 'openai-images',
    kind: 'openai-images',
    label: 'SGLang or vLLM image server',
    baseUrl: 'http://127.0.0.1:30000',
    enabled: false,
  },
  {
    id: 'a1111',
    kind: 'a1111',
    label: 'Automatic1111 or Forge',
    baseUrl: 'http://127.0.0.1:7860',
    enabled: false,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The adapter module for a kind is imported on first use, so one missing adapter file
 * cannot break the kinds that do exist.
 */
async function loadFactory(kind: ProviderKind): Promise<AdapterFactory> {
  const entry = ADAPTER_MODULES[kind];
  let loaded: unknown;
  try {
    loaded = await import(entry.module);
  } catch {
    throw new Error(`No provider adapter module for kind "${kind}" (expected ${entry.module})`);
  }
  const exported = isRecord(loaded) ? loaded[entry.create] : undefined;
  if (typeof exported !== 'function') {
    throw new Error(`Provider adapter module for kind "${kind}" does not export ${entry.create}`);
  }
  // The import is opaque at compile time: the module shape is trusted once the export is a function.
  return exported as AdapterFactory;
}

export function createAdapter(config: ProviderConfig): ProviderAdapter {
  let pending: Promise<ProviderAdapter> | undefined;
  const resolve = (): Promise<ProviderAdapter> => {
    pending ??= loadFactory(config.kind).then((factory) => factory(config));
    return pending;
  };
  return {
    id: config.id,
    label: config.label,
    kind: config.kind,
    health: async () => (await resolve()).health(),
    capabilities: async () => (await resolve()).capabilities(),
    generate: async (request, ctx) => (await resolve()).generate(request, ctx),
  };
}

export function defaultProviderConfigs(): ProviderConfig[] {
  return [MOCK_CONFIG, ...REAL_PROVIDER_CONFIGS].map((config) => ({ ...config }));
}
