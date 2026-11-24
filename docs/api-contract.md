# API and module contracts

Written by the lead before the build wave. Every agent codes against this file. Do not change it unilaterally; if a shape is wrong, report it.

Stack: Node 24, TypeScript strict, Express 5, React 19, Vite 7, vitest 3. Ports: server 4317, vite dev 4318. No native modules, no new runtime dependencies beyond those in `package.json`. Node built-ins and the installed packages only.

## Domain types

`src/core/types.ts` is the single source of truth and is already written. Do not redefine these types; import them.

## Internal module contracts

### `src/core/png.ts` (owner: provider-core)

```ts
export interface Rgb { r: number; g: number; b: number }
/** Encode raw RGB rows into a valid PNG. Deterministic: same input, same bytes. */
export function encodePng(width: number, height: number, rows: Uint8Array): Uint8Array;
/** A deterministic stand-in image: soft gradient plus a band whose colour derives from the prompt hash. */
export function synthImage(input: { width: number; height: number; seed: number; label: string }): Uint8Array;
/** Read width and height from a PNG buffer. Throws when the buffer is not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number };
```

### `src/core/providers/registry.ts` (owner: provider-core)

```ts
export function createAdapter(config: ProviderConfig): ProviderAdapter;
export function defaultProviderConfigs(): ProviderConfig[];
```

`createAdapter` switches on `config.kind` and returns the matching adapter. `defaultProviderConfigs` returns the mock provider plus one disabled config per real kind, with sensible default URLs:

- mock, label "Mock (offline)", baseUrl "mock://local"
- comfyui, label "ComfyUI", baseUrl "http://127.0.0.1:8188"
- openai-images, label "SGLang or vLLM image server", baseUrl "http://127.0.0.1:30000"
- a1111, label "Automatic1111 or Forge", baseUrl "http://127.0.0.1:7860"

### `src/core/store.ts` (owner: store)

Filesystem library, no database, atomic writes, no native modules.

```ts
export interface StoreOptions { rootDir: string }
export class LibraryStore {
  constructor(options: StoreOptions);
  async init(): Promise<void>;
  async listBatches(limit?: number): Promise<BatchRecord[]>;
  async getBatch(id: string): Promise<BatchRecord | null>;
  async createBatch(input: Omit<BatchRecord, 'images' | 'failures' | 'createdAt'> & { createdAt?: string }): Promise<BatchRecord>;
  async saveImage(batchId: string, index: number, bytes: Uint8Array, meta: { providerId: string }): Promise<StoredImage>;
  async recordFailure(batchId: string, failure: BatchFailure): Promise<void>;
  async finishBatch(batchId: string, status: BatchStatus, extra?: { revisedPrompt?: string; durationMs?: number; seed?: number }): Promise<BatchRecord>;
  async readImage(imageId: string): Promise<{ meta: StoredImage; bytes: Uint8Array } | null>;
  async deleteBatch(batchId: string): Promise<boolean>;
  async listPresets(): Promise<Preset[]>;
  async createPreset(input: Omit<Preset, 'id' | 'createdAt'>): Promise<Preset>;
  async deletePreset(id: string): Promise<boolean>;
  async stats(): Promise<{ batchCount: number; imageCount: number; bytes: number }>;
  /** Path of an image on disk, for streaming responses. */
  imagePath(meta: StoredImage): string;
}
export function createId(prefix: string): string;
```

Layout under `rootDir`: `index.json`, `images/<imageId>.png`, `references/<refId>.<ext>`. Writes are atomic: write to `<file>.tmp` then rename. Corrupt `index.json` must be detected and reported, never silently reset.

### `src/server/system.ts` (owner: system)

Hardware detection and auto-tune. Pure and unit tested, so the wizard never depends on the machine it runs on.

```ts
export function tierFor(vramGb: number | null): HardwareTier;
export function vendorFromGpuName(name: string, deviceType?: string): GpuVendor;
export function cleanGpuName(raw: string): string;
export function buildLaunchArgs(settings: LaunchArgSettings): string[];
export function mergeLaunchArgs(current: readonly string[], next: readonly string[]): string[];
export function parseRocmVersion(pytorchVersion: string | null | undefined): readonly [number, number] | null;
export function supportsDynamicVram(vendor: GpuVendor, pytorchVersion: string | null | undefined): boolean;
export function recommendForHardware(input: HardwareInput): { recommended: RecommendedSettings; models: ModelCatalogEntry[] };
export function applyProfileOverrides(recommended: RecommendedSettings, overrides: ProfileOverrides): RecommendedSettings;
export function detectSystemProfile(settings: { list(): ProviderConfig[] }): Promise<SystemProfile>;
```

`HardwareInput` carries `vramGb`, `ramTotalGb`, `vendor`, optional `installedFiles` and optional
`pytorchVersion`. `supportsDynamicVram` mirrors ComfyUI's own gate (PyTorch 2.8 or newer, and on AMD
a ROCm 7.14 or newer wheel); `detectSystemProfile` feeds it the PyTorch version from `/system_stats`.
When it is true the High tier plan keeps smart memory and the prompt cache enabled, so
`--cache-none` and `--disable-smart-memory` are not part of `launchArgs`. When it is false (older
runtimes or an unreadable version) both flags are emitted exactly as before.

`detectSystemProfile` probes in this order, every step time bounded (2500 ms at most) and never throwing: ComfyUI `/system_stats` for the exact device name, VRAM, ComfyUI and PyTorch versions; `nvidia-smi`; on Windows the driver class registry key, whose `HardwareInformation.qwMemorySize` is the real 64-bit VRAM (WMI `AdapterRAM` caps at 4 GB); on macOS `system_profiler`. Installed models come from `/object_info/{UNETLoader,CLIPLoader,VAELoader}` when ComfyUI answers, and always from `models/{diffusion_models,text_encoders,vae}` plus `extra_model_paths.yaml` under the provider's `launch.cwd`.

### `src/core/zip.ts` (owner: store)

```ts
export interface ZipEntry { name: string; bytes: Uint8Array }
/** Minimal store-method ZIP writer, deflate-raw via node:zlib. No dependencies. */
export function buildZip(entries: ZipEntry[]): Uint8Array;
```

## HTTP API

JSON in and out. Errors are `{ error: { message, code } }` with a matching HTTP status. Image bytes are never inlined in JSON.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | none | `{ ok: true, version: string }` |
| GET | `/api/providers` | none | `ProviderConfig[]` |
| POST | `/api/providers` | `ProviderConfig` without id | `ProviderConfig` |
| PATCH | `/api/providers/:id` | partial `ProviderConfig` | `ProviderConfig` |
| DELETE | `/api/providers/:id` | none | `{ ok: true }` |
| GET | `/api/providers/:id/health` | none | `{ ok: boolean, detail?: string }` |
| GET | `/api/providers/:id/capabilities` | none | `ProviderCapabilities` |
| POST | `/api/references` | JSON `{ filename, mimeType, dataBase64 }` | `ReferenceImage` |
| POST | `/api/generations` | `{ providerId, prompt, negativePrompt?, width, height, count, seed?, steps?, guidance?, referenceIds?, enhancePrompt?, promptEnhancer?, modelVariant?, textEncoderVariant? }` | `{ batchId }` (202) |
| GET | `/api/generations/:batchId/events` | none | SSE stream |
| GET | `/api/batches` | query `limit` | `BatchRecord[]` |
| GET | `/api/batches/:id` | none | `BatchRecord` |
| DELETE | `/api/batches/:id` | none | `{ ok: true }` |
| POST | `/api/batches/:id/retry` | `{ indices: number[] }` | `{ batchId }` (202) |
| GET | `/api/images/:id` | query `download` and `format` | image bytes, `image/png` or `image/jpeg` |
| POST | `/api/export` | `{ imageIds: string[], format: "png" \| "jpeg" }` | zip bytes, `application/zip` |
| GET | `/api/presets` | none | `Preset[]` |
| POST | `/api/presets` | `Omit<Preset, "id" \| "createdAt">` | `Preset` |
| DELETE | `/api/presets/:id` | none | `{ ok: true }` |
| GET | `/api/stats` | none | `{ batchCount, imageCount, bytes, providerCount }` |
| GET | `/api/system/profile` | none | `SystemProfile` |
| POST | `/api/system/apply-profile` | `{ providerId?, reserveVramGb?, previewMethod?, disablePinnedMemory?, rocmFlashAttention? }` | `{ ok: true, profile: SystemProfile, provider: ProviderConfig, applied: { width, height, modelVariant, textEncoderVariant, promptEnhancer } }` |

`GET /api/system/profile` measures the machine (CPU, RAM, GPU, VRAM), asks ComfyUI for its version and the model files it can see, and returns the recommended `RecommendedSettings` plus the seven file `ModelCatalogEntry` list. It never throws on a machine with no GPU: the tier falls back to `entry`.

`POST /api/system/apply-profile` re-measures, applies the optional overrides, then writes the recommended `launch.args` and `launch.env` into the ComfyUI provider in `providers.json`. A custom `--port` or `--listen` and any flag the plan does not manage are preserved; flags the plan owns are replaced.

### SSE event shapes on `/api/generations/:batchId/events`

One JSON object per `data:` line, no event names, ending with a `batch` event then the stream closing.

```ts
{ type: 'progress', index: number, stage: string, step?: number, totalSteps?: number, percent?: number }
{ type: 'item', index: number, item: GeneratedItem }
{ type: 'batch', batch: BatchRecord }
```

The server must send `retry: 0` and a heartbeat comment every 15 seconds. A cancelled generation emits `batch` with status `cancelled`.

## Web module contracts

One page, three views switched in `src/web/App.tsx` (owner: ui-shell): `setup` when no provider is enabled, `generate` and `library`. Styling: plain CSS with tokens in `src/web/styles/tokens.css`. No CSS framework, no icon package; inline SVG only.

| Directory | Owner | Contents |
|---|---|---|
| `src/web/styles/` | ui-shell | tokens.css, base.css |
| `src/web/components/` | ui-shell | Button, Field, SegmentedControl, Slider, Dialog, Toast, EmptyState, Spinner |
| `src/web/api.ts` | ui-shell | typed fetch client for every endpoint above |
| `src/web/features/generate/` | generate-ui | composer, controls, progress grid, partial failure tiles |
| `src/web/features/library/` | library-ui | batch rows, image viewer, selection, export, presets |

Design language, from the approved mockup `docs/mockups/a-studio-canvas.html`: near-black canvas `#14100e` to `#1b1614`, panel `#211b18`, hairline `#3a2f29`, text `#efe6dd`, muted `#a3938a`, single accent `#e0b183`, accent text on accent `#221a14`. Rail metadata at least 10 px. Visible focus ring on every interactive control. No em dash anywhere in copy.
