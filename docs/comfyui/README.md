# ComfyUI graph for MiniMax H3 Image text to image

`h3-image-api-template.json` is a ComfyUI **API format** graph: a map of node id to
`{ class_type, inputs }`. It is meant to be pasted into the ComfyUI provider option
`workflowTemplate` (a JSON string). The adapter in `src/core/providers/comfyui.ts` parses it,
replaces the request placeholders, and POSTs it to `/prompt` as `{ "prompt": graph }`. The four
loaders and the sampler stay literal because H3 needs its own graph; this file is that graph.

It has 17 nodes: the 16 nodes of the official subgraph, plus the `SaveImage` node the workflow
used at the top level.

## Provenance

* Source file: `docs/comfyui/reference/image_minimax_h3_image_t2i.json`, the official ComfyUI
  template "Text to Image (MiniMax H3 Image)".
* The source is **UI format**: 5 top level nodes (`SaveImage`, `ResolutionSelector`, the subgraph
  instance, and two `MarkdownNote` nodes) plus one subgraph definition that holds the real 16 node
  graph. The file records workflow version `0.4` and `frontendVersion` `1.58.5`.
* Real provenance: **ComfyUI template pack 0.11.104**, which needs **ComfyUI 0.45.0 or newer**.
  The graph depends on node types that older builds do not ship
  (`MiniMaxH3ImageConditioning`, `TextGenerateV2`, `ComfySwitchNode`, `JsonExtractString`,
  `StringReplace`).
* Verified on 2026-11-19 against the installed pack **0.11.111** on ComfyUI `v0.46.0`: the
  shipped `image_minimax_h3_image_t2i.json` matched
  `docs/comfyui/reference/image_minimax_h3_image_t2i.json` byte for byte, so the derivation still
  describes the template the server actually ships.
* The API graph was **derived mechanically** from the subgraph, not retyped by hand. A throwaway
  script inside `%TEMP%` read the subgraph's `widgets_values_named` for every widget value, the
  subgraph's `links` table for every edge (using the link's `origin_id` and `origin_slot`, and the
  target node's input slot for the input name), and treated an edge from the subgraph input node
  (negative id) as a port, so the port keeps its widget default. Node ids are the subgraph's own
  ids, so every node here can be matched one to one against the UI file. `SaveImage` keeps its top
  level id `9`.

## Widget mapping

Order of the subgraph instance widgets, then where each value landed.

| Subgraph widget | UI default | API node and input |
| --- | --- | --- |
| `prompt` (port `replace`) | long sample prompt | node `24` `PrimitiveStringMultiline.value` = `{{prompt}}` |
| `enable_PE` (boolean) | `true` on the instance, `false` on the switch node | node `22` `ComfySwitchNode.switch` = `false` |
| `seed` | `42` | node `7` `KSampler.seed` = `{{seed}}` |
| `width` | `3104` | node `5` `MiniMaxH3ImageConditioning.width` = `{{width}}` |
| `height` | `3104` | node `5` `MiniMaxH3ImageConditioning.height` = `{{height}}` |
| `sampler` | `euler` | node `7` `KSampler.sampler_name` |
| `scheduler` | `simple` | node `7` `KSampler.scheduler` |
| diffusion model | `minimax_h3_image_pruned_int8_convrot.safetensors` | node `1` `UNETLoader.unet_name` |
| text encoder | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | node `2` `CLIPLoader.clip_name` |
| vae | `minimax_h3_image_vae_fp16.safetensors` | node `3` `VAELoader.vae_name` |
| prompt expander (`PE_model`) | `qwen3.5_9b_w4a8_gptq.safetensors` | node `16` `CLIPLoader.clip_name` |

Two values are not on the instance and stay literal:

* steps: the inner `KSampler` widget, default `6`, becomes `{{steps}}` on node `7`.
* cfg: the same `KSampler` widget, default `1`, stays the number `1`.

The three filenames match the model files on disk exactly, so the defaults are usable without edits.

## Placeholders

Five placeholders, one occurrence each:

| Placeholder | Where | What it feeds |
| --- | --- | --- |
| `{{prompt}}` | node `24` value | the positive prompt, entering the graph where the subgraph prompt port entered |
| `{{width}}` | node `5` width | `MiniMaxH3ImageConditioning` canvas width |
| `{{height}}` | node `5` height | `MiniMaxH3ImageConditioning` canvas height |
| `{{seed}}` | node `7` seed | `KSampler` seed |
| `{{steps}}` | node `7` steps | `KSampler` steps |

The adapter treats an input whose string is exactly `{{name}}` as a whole value replacement, so
numeric request fields arrive as JSON numbers, not strings. The prompt value is a string and stays a
string.

Placeholders that exist in the adapter but are deliberately **not** used here:

* `{{cfg}}`: H3 Image is a distilled model and the official graph samples at cfg `1`. A request
  level guidance value must not move it.
* `{{ckpt}}`: the graph has three separate loaders with fixed file names, no checkpoint node.
* `{{batch}}`: this graph has no `batch_size` input. One queued prompt produces one image. The
  adapter detects the missing placeholder and, for `count > 1`, runs one prompt per slot
  sequentially with `seed + slot`. A live batch of two at 2048x2048 completed in `319.36s`
  (about 159 seconds per image) with two distinct PNGs, so `capabilities.maxBatch` can be 4 with
  this template.
* `{{negativePrompt}}`: unused, see the next section.

## The negative prompt path, kept exactly as the original

`MiniMaxH3ImageConditioning` (node `5`) has a single conditioning output. The original feeds that
same output both to `KSampler.positive` (node `7`) and to `ConditioningZeroOut` (node `6`), whose
result goes to `KSampler.negative`. That is kept unchanged:

* node `5` output `0` -> node `6` input `conditioning`
* node `6` output `0` -> node `7` input `negative`
* node `5` output `0` -> node `7` input `positive`

H3 Image does not accept a negative prompt, so there is no text encoder path for one and nothing
was invented to add one. The zeroed conditioning is what the template uses to satisfy the sampler.

## Nodes kept although a text to image run does not execute them

The switch default is `false`, which means `ComfySwitchNode` (node `22`) passes `on_false`, the raw
prompt from node `24`. ComfyUI only executes what the output nodes need, so the caption expander
branch is present but idle:

* node `16` `CLIPLoader` (the 9B expander text encoder)
* node `17` `PrimitiveStringMultiline` (system prompt)
* node `20` `PrimitiveStringMultiline` (task prompt template, with `{input text}`)
* node `19` `StringReplace` (fills `{input text}` in the task prompt with the user prompt)
* node `15` `TextGenerateV2` (runs the expander)
* node `26` `JsonExtractString` (pulls `expanded_caption` out of the JSON reply)

They are kept so the file stays faithful to the template, and so the expander is one edit away:
set `node "22".inputs.switch` to `true` and the raw prompt is passed through `JsonExtractString`
instead. That path loads the 9B expander model, so it is slower and needs
`qwen3.5_9b_w4a8_gptq.safetensors` as well.

The switch node itself is kept for the same reason: it is the only visible statement of which prompt
path is in use.

`PreviewAny` (node `18`) is also kept. It is the node the template uses to sample the switch output;
its `STRING` output is what actually reaches node `5`.

## What is not in the file, and why

* The subgraph wrapper, its input node and its output node. API format has no subgraph construct.
  The wrapper's ports became the widget defaults and the five placeholders above.
* `ResolutionSelector` (top level node `14`, `1:1 (Square)`, 4 megapixels, multiple of 32). It is a
  UI helper that drove the instance width and height. Sizes come from the request instead.
* The two `MarkdownNote` nodes, and node positions, colours, groups and the canvas state.
* There was never a latent or batch node: `MiniMaxH3ImageConditioning` output slot `1` is the
  `LATENT` that goes to `KSampler.latent_image`.
* `SaveImage` was **added** from the top level (node `9`, prefix `minimax_h3_image_t2i`) and wired to
  `VAEDecode` output `0`. ComfyUI executes an API prompt only through its output nodes, and the
  adapter reads finished images from `/history` outputs, so the graph needs this node to return
  anything.

## Requirements

* ComfyUI installed and reachable, version **0.45.0 or newer**, with the template pack nodes
  present. The live verification used `v0.46.0` (`v0.46.0-2-gd5d59c401`), Python 3.12.13 in an
  isolated venv at `E:\ComfyUI`, `comfyui-frontend-package` `1.59.6`, `comfy-kitchen` `0.2.41`
  with its native `hip` backend active, and PyTorch `2.9.1+rocm7.2.1` from AMD's ROCm 7.2.1
  Windows repository.
* `comfy-aimdo` `0.6.0` is installed but `init_devices` returns False on ROCm 7.2, because
  DynamicVRAM needs ROCm 7.14 or newer. The graph runs without it.
* The four model files visible to ComfyUI. The verified install references them without copying
  through `E:\ComfyUI\extra_model_paths.yaml` pointing at `E:/Models/h3-image`, and all four
  appeared in `/object_info`:

```
ComfyUI/models/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors
ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors
ComfyUI/models/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
ComfyUI/models/vae/minimax_h3_image_vae_fp16.safetensors
```

## Status: verified live on 2026-11-19

This graph was run against a live ComfyUI with MiniMax H3 Image INT8 on ROCm 7.2.1 and produced
real images, with **zero edits to `h3-image-api-template.json`**. All five checks below passed:

1. `POST /prompt` accepted the graph with `node_errors: {}`.
2. The server listed all four model filenames exactly as written here.
3. `VAEDecode` to `SaveImage` wrote one image and the adapter fetched it from `/view`.
4. The raw prompt reached the model with the switch off: results followed the request prompt and
   the 9B expander branch did not load.
5. Width and height arrived as numbers equal to the request (`2048x2048`), not as strings and not
   as the graph default `3104`.

Live environment:

| Item | Value |
| --- | --- |
| OS and CPU | Windows 11, Ryzen 9 7950X3D, 31.15 GB RAM, 23.0 GB pagefile (`C:\pagefile.sys`) |
| GPU | AMD Radeon RX 7900 XTX 24 GB, `gfx1100`, driver `32.0.32015.12012` |
| ComfyUI | `v0.46.0` (`v0.46.0-2-gd5d59c401`), Python 3.12.13 venv via `uv` at `E:\ComfyUI` |
| Template pack | `comfyui-workflow-templates` `0.11.111` |
| Frontend | `comfyui-frontend-package` `1.59.6` |
| PyTorch | `2.9.1+rocm7.2.1`, torchvision `0.24.1+rocm7.2.1`, torchaudio `2.9.1+rocm7.2.1`; `torch.cuda.is_available() == True` on the 7900 XTX, GPU matmul passed |
| comfy-kitchen | `0.2.41`, native `hip` backend active (`int8_linear`, `dequantize_int8_convrot_weight_dtype`, `quantize_and_rotate_rowwise`) |
| comfy-aimdo | `0.6.0`, `init_devices` returns False on ROCm 7.2, DynamicVRAM needs ROCm 7.14 or newer |

Launch flags and measured behaviour:

```
python.exe -u main.py --listen 127.0.0.1 --port 8188 --cache-none --disable-pinned-memory --disable-smart-memory
```

* `NORMAL_VRAM` keeps the Qwen3-VL-32B text encoder on `cuda:0` with partial GPU offload: about
  22.1 to 22.6 GB loaded in VRAM and 3.3 to 3.8 GB offloaded. `--lowvram` forced the 32B encoder
  onto the CPU and was discarded.
* The DiT (`minimax_h3_image_pruned_int8_convrot.safetensors`, 20.0 GB) loads 100% into the 24 GB
  card and samples 6 Euler steps at 2048x2048 in about 12 seconds (`2.16 s/it`).
* A direct smoke prompt (`2048x2048`, 6 steps, seed 42, a teacup on an oak table) took `102.75s`
  wall (`102.18s` in ComfyUI history) and wrote
  `E:\ComfyUI\output\minimax_h3_image_t2i_00002_.png` (5,966,084 bytes).
* `E:\ComfyUI\custom_nodes\h3_memory_handoff.py`, under `--cache-none`, discards loaded GPU models
  in place at `post-minimax-clip-encode` (on `comfy.sd.CLIP.encode_from_tokens_scheduled`),
  `pre-load_clip`, `pre-load_diffusion_model` and `pre-VAEDecode`. It pops
  `comfy.model_management.current_loaded_models`, releases the tensors, runs `gc.collect()` twice
  and `torch.cuda.empty_cache()`, and never calls `model_unload()`. Calling `unload_all_models()`
  instead copies the GPU weights into CPU RAM first (observed crash in `unpatch_model` ->
  `model.to("cpu")` -> `alloc_cpu`). Without the handoff, GPU commit plus CPU tensors passed the
  54.15 GB Windows commit limit and the process died with `0xC0000005`.
* With the handoff, private commit stayed flat at `7.74` to `7.84 GB` between stages, `5.64` to
  `5.69 GB` idle after each prompt, peak working set `23.69 GB`, minimum free VRAM `1.37 GB`, and
  no growth across 4 consecutive prompts.

Not run in this pass: a live 16 MP generation (the presets exist and pass validation, only
2048x2048 was sampled) and the prompt expander with `node "22".inputs.switch` set to `true`.

## Mapping uncertainties

Checked against the UI file, but not provable without a live server. Node ids given so a reviewer can
target them.

* **node `22` `ComfySwitchNode.switch`**, the main judgement call. Two defaults exist in the source:
  the node's own widget is `false`, while the parent subgraph instance passes `enable_PE` as `true`.
  This file uses `false` (raw prompt, expander idle), which matches treating the expander as unused in
  a text to image run. If the shipped template is meant to expand by default, set it to `true`.
* **node `5` `MiniMaxH3ImageConditioning` width and height.** The widget shows `3104`, but in the
  shipped workflow those ports were driven by `ResolutionSelector`, so `3104` is only the value used
  when the port is unlinked. The placeholders make the request decide; treat `3104` as a fallback,
  not as the template's intended resolution.
* **node `15` `TextGenerateV2`.** Widget values were copied verbatim from `widgets_values_named`,
  including the dotted grouped names (`sampling_mode.top_k`, `sampling_mode.top_p`,
  `sampling_mode.min_p`, `sampling_mode.repetition_penalty`, `sampling_mode.presence_penalty`,
  `sampling_mode.seed`, `sampling_mode.temperature`) and `mtp`. Its media inputs
  (`images.image1`, `videos.video1`, `audios.audio1`) are unconnected in the original and are
  omitted here. That the API accepts the dotted names exactly as the frontend writes them is
  unproven. The names come from the UI node, which the frontend builds from the server's own
  `object_info`, so they should match, but only a real `POST /prompt` settles it.
* **node `18` `PreviewAny`.** A preview node used as a pass through because the template does it
  that way. Kept as is rather than bypassed.
* **nodes `19` and `26`** keep their widget defaults (`find` = `{input text}`, `key` =
  `expanded_caption`). They only matter if the switch is turned on.
* **`ComfySwitchNode` input names** (`on_false`, `on_true`, `switch`) are taken from the UI node.
  Its behaviour when the untaken branch is still connected but unexecuted is assumed, not observed.

## How it was checked

A throwaway script outside the repository parses the source UI file and this file, then asserts:
every node has a string `class_type` and an object `inputs`; every array input is a
`[nodeId, outputIndex]` pair whose node id exists in this graph and whose index is inside that
node's real output count; every one of the 16 subgraph node ids survived; every input value matches
the UI file, either as the link the UI file records for that target slot or as the widget value the
UI file stores, with the five placeholders as the only allowed deviation; every placeholder occurs
exactly once. The script was mutation tested (broken link target, wrong output slot, wrong widget
value, wrong link slot, extra input) and failed on each mutation.

## Using it

Store the whole file as the string value of the provider option `workflowTemplate`, with
`capabilities` tuned for H3: `negativePrompt: false`, `guidance: false`, `adjustableSteps: false`,
`fixedSteps: 6`, `maxBatch: 4`, `arbitrarySize: true`, `sizeMultiple: 32`, and presets at 4 MP and
16 MP (`2048x2048`, `4096x4096`, `4736x3552`, `3552x4736`, `5472x3072`, `3072x5472`). That is what
`H3_IMAGE_CAPABILITIES` in `src/web/App.tsx` supplies. Set the provider option `timeoutMs` to
`900000`: a single 2048x2048 image measured `102s` directly in ComfyUI and `157` to `178s` through
the app, and a batch of two ran `319s` as two sequential prompts.

The reference workflow's own note says H3 Image works well from about 4 MP up, best near 16 MP.
Small canvases give poor results, so the default 512x512 preset of the generic ComfyUI provider is a
bad fit for this graph. `src/server/app.ts` now allows canvases up to `8192` per side, so all five
16 MP presets pass validation; only `2048x2048` has actually been sampled so far.
