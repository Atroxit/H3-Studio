# H3 Studio

A local image generation studio. It runs on this machine, keeps every image it makes, and drives whichever image model server you already run: ComfyUI, Automatic1111 or Forge, an SGLang or vLLM-Omni server serving MiniMax H3 Image, or any server that speaks the OpenAI image API. Nothing in the studio is tied to one model: the controls you see are built from what the connected provider says it can do, so a provider that cannot do seeds or negative prompts never shows them.

Requirements: Node 24 or newer and npm. Microsoft Edge is needed only by the optional screenshot helper described at the end.

## The two commands

```powershell
npm install
npm run dev
```

`npm run dev` runs `scripts/dev.mjs`, which starts the API server with tsx on `http://127.0.0.1:4317` and the Vite dev server on `http://127.0.0.1:4318`. Output from the two servers is prefixed `[api]` and `[web]`. Open `http://127.0.0.1:4318`. Ctrl+C stops both. If either server stops on its own, the script stops the other one and exits non-zero, so a dead half of the pair is never left behind.

```powershell
npm run verify
```

`npm run verify` is `npm run typecheck && npm run test && npm run build`. It type checks the whole repository with `tsc --noEmit`, runs the vitest suite in `tests/`, and builds the web app into `dist/web`.

## The desktop app

```powershell
npm run desktop
```

That builds the web app, bundles the server into `dist/server/main.cjs` with esbuild, and opens H3 Studio in its own Electron window with no browser chrome. The window loads the same app from a loopback port the shell picks at startup, and the server runs as a child process that stops when the window closes. The desktop build keeps its library in `%APPDATA%\h3-studio\library`, which is separate from the `~/.h3-studio` default that `npm run dev` uses, so the two do not share images.

Use `npm run desktop` rather than calling Electron directly. It clears `ELECTRON_RUN_AS_NODE` before launching, and with that variable set, which happens when you start from inside another Electron based tool, Electron runs as plain Node and no window appears.


## Where your images live

The library is a plain directory, created on first start. By default it is `.h3-studio` in your home directory; set `H3_DATA_DIR` to put it somewhere else.

```text
~/.h3-studio/
  index.json              snapshot of batches, failures and presets
  journal.ndjson          append only log of every change since that snapshot
  providers.json          your provider settings, including any API key you entered
  images/<imageId>.png    every generated image, byte for byte
  references/<refId>.<ext>  reference images you attached
```

An image is copied into `images/` as it arrives, so the library keeps working even if the provider that made it goes away. Every read is served from memory, and every change is appended to the journal before it is applied, which is what stops a polling browser from blocking a generation on Windows. Deleting the directory starts you with an empty library; nothing outside it belongs to the app.

## Connecting a backend

Every backend is set up the same way: open **Providers**, enter the base URL, choose **Test connection**, then choose **Enable**. The studio only targets one enabled provider at a time; the top bar switches between enabled ones.

### ComfyUI

The ComfyUI HTTP API is always on, so there is no flag to add: the server only has to be running and reachable.

1. Start ComfyUI so it listens on its HTTP port, for example `python main.py --listen 127.0.0.1 --port 8188`.
2. Set the ComfyUI base URL to that address. The default is `http://127.0.0.1:8188`. **Test connection** calls `GET /system_stats`.
3. **Enable**, then generate. The adapter queues a graph with `POST /prompt`, polls `GET /history/<prompt_id>` for progress, and fetches the image from `GET /view`.
4. The built in workflow is a stock checkpoint pipeline, so the checkpoint it names must exist on that ComfyUI install. The name comes from the provider's `ckptName` option or its `model` field, and defaults to `v1-5-pruned-emaonly.safetensors`. If that file is missing, ComfyUI rejects the prompt and the studio shows its node error.
5. Reference images are not supported by this adapter, and progress is polled rather than streamed by ComfyUI.

### Automatic1111 or Forge

The web UI only exposes its API when it is launched with `--api`.

1. Start it with the flag: `webui.bat --api` on Windows, or `./webui.sh --api` elsewhere. Add `--listen` only if it should accept connections from another machine.
2. Set the base URL, default `http://127.0.0.1:7860`. **Test connection** calls `GET /sdapi/v1/options`.
3. Generation uses `POST /sdapi/v1/txt2img`, one image per request, with the sampler from the provider's `samplerName` option (default `Euler a`).

### SGLang or vLLM-Omni, including MiniMax H3 Image

Any server that accepts the OpenAI image request shape works, including the hosted MiniMax endpoint.

1. Serve the model with an OpenAI compatible image endpoint. The deployment commands for MiniMax H3 Image are on its model card at <https://huggingface.co/MiniMaxAI/MiniMax-H3-Image>; both vLLM and SGLang are documented there.
2. Point the studio at the server root, for example `http://127.0.0.1:30000`. **Test connection** calls `GET /v1/models`.
3. Set the model name in the provider record if the server expects one; without it the request sends `default`.
4. Generation is `POST /v1/images/generations` with `response_format` set to `b64_json`, one image per request. The adapter also implements multipart `POST /v1/images/edits` when reference images are supplied, but it reports no reference support in its capabilities, so the UI does not offer them yet.
5. The capability record notes that the hosted MiniMax API rejects the `seed` parameter while a self hosted SGLang or vLLM server accepts it. If you point this provider at a remote address such as `https://api.minimax.io`, your prompts and images leave this machine and the API key is sent as a bearer token.

### The offline mock

The mock provider is enabled by default, needs no model and no network, and is the quickest way to confirm the studio itself works. Its images are synthetic gradients, not model output. A prompt containing `FAIL_ONE` fails the first item with a retryable error, which exercises partial batches and the retry action.

## The provider capability model

`GET /api/providers/:id/capabilities` returns `ProviderCapabilities` for the connected provider, and the generate screen renders controls from that record rather than from assumptions. A control the provider does not support is not shown.

| Provider | Seed | Negative prompt | Steps | Guidance | Reference images | Max batch | Progress |
|---|---|---|---|---|---|---|---|
| `mock` | yes | yes | adjustable | yes | 4 | 10 | per image |
| `comfyui` | yes | yes | adjustable | yes | none | 4 | polled from history |
| `openai-images` | self hosted only | no | fixed by the server | no | none | 10 | per image |
| `a1111` | yes | yes | adjustable | yes | none | 8 | per image |

All four accept arbitrary width and height in multiples of 8, and all four return PNG.

## What is verified and what is not

Verified on this machine when this was written:

- `npx tsc --noEmit` is clean, and `npm run build` produces `dist/web`.
- The vitest suite passes: 68 tests in 6 files, covering PNG encoding, the ZIP writer, the library store and the mock provider as unit tests, plus ComfyUI and the two HTTP adapters as integration tests.
- The ComfyUI and HTTP adapter integration tests run against stub HTTP servers started inside the tests. They assert the request shapes the adapters send and how they handle success and error responses. They do not contact a real ComfyUI, Automatic1111, SGLang or vLLM server.
- The only images this repository has ever generated came from the mock provider. The integration tests serve canned PNG bytes from stub servers, so an adapter returning bytes there is not model output.

Not verified, stated plainly:

- No real backend has been connected. There is no GPU model downloaded on this machine, no API key, and no ComfyUI, Automatic1111, SGLang or vLLM server was started. Generation against a real server has not been tested, and the setup steps above describe what the adapters send, not an exchange that was observed end to end.
- The hosted MiniMax API was only probed without credentials, which returned HTTP 401. No authenticated generation, edit or prompt enhancement call has been made.
- Provider health checks, progress reporting and long batches have been exercised only against stubs, never against real servers.
- The studio is a development build with `npm run dev`; it was not packaged or installed as a desktop application.

## Licence note for MiniMax H3 Image weights

MiniMax H3 Image ships under a community licence whose applicable territory excludes the United Kingdom, the European Union, Korea and the United States. If you are in one of those places, do not download or serve those weights. The terms can change, so read the licence in the model repository at <https://huggingface.co/MiniMaxAI/MiniMax-H3-Image> before you download anything. This caveat is about the model weights only: the studio contains no model weights and can be used with any provider you are entitled to run.

## Troubleshooting

**`npm run dev` stops immediately and `[api]` or `[web]` reports `EADDRINUSE`.** Port 4317 or 4318 is already taken, often by a studio instance you left running. Find the owner with `Get-NetTCPConnection -LocalPort 4317` (or 4318), stop that process, and run `npm run dev` again. The script deliberately stops the other server and exits non-zero instead of leaving half the pair alive.

**Test connection fails against Automatic1111 or Forge with HTTP 404.** The UI was started without `--api`, or the base URL points at the wrong port or a path inside the UI. Restart it with `--api` and check that `http://127.0.0.1:7860/sdapi/v1/options` answers in a browser.

**ComfyUI connects but every generation fails with a node error naming `CheckpointLoaderSimple`.** The workflow asks for a checkpoint that install does not have. The default is `v1-5-pruned-emaonly.safetensors`. Install a checkpoint in ComfyUI's `models/checkpoints`, then set the provider's `model` field to that file name (the setup card only edits the base URL, so use `PATCH /api/providers/comfyui` with `{ "model": "your-checkpoint.safetensors" }`), and retry. The error text includes the node and the reason ComfyUI gave.

## Optional developer scripts

`node scripts/screenshot.mjs <url> <output.png>` renders a page at 1440 by 1000 with the installed Edge in headless mode and writes a PNG. It looks for `msedge.exe` in the Program Files locations; set `H3_EDGE_PATH` to a full path if Edge lives elsewhere. Run without arguments to see the usage line.
