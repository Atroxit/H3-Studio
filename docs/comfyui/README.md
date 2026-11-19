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
* `{{batch}}`: this graph has no `batch_size` input. One queued prompt produces one image, so the
  provider options for this template should set `capabilities.maxBatch` to `1`. With a larger batch
  the runner asks for N images, gets one, and reports the batch as partial.
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

* ComfyUI installed and reachable, version **0.45.0 or newer**, with the template pack nodes present.
* The four model files visible to ComfyUI:

```
ComfyUI/models/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors
ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors
ComfyUI/models/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
ComfyUI/models/vae/minimax_h3_image_vae_fp16.safetensors
```

## Status: not executed yet

**This graph has NOT been run against a live ComfyUI.** It is a careful, mechanically checked
starting point, not a proven workflow. Before the H3 provider is described as working, one real
generation must prove, on a live server:

1. `POST /prompt` accepts the graph: no `node_errors`, meaning every `class_type` and every input
   name is real on that server version.
2. The server lists all four model filenames exactly as written here.
3. `VAEDecode` to `SaveImage` writes one image and the adapter fetches it from `/view`.
4. The raw prompt reaches the model with the switch off: the result follows the request prompt, and
   the expander branch does not load.
5. Width and height arrive as numbers equal to the request, not as strings and not as 3104.

Nothing in this document is evidence that any of those five steps passed.

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
`capabilities` tuned for H3: `negativePrompt: false`, `guidance: false`, `adjustableSteps: true`,
`maxBatch: 1`, `arbitrarySize: true`, and presets around the 4 MP to 16 MP range the template notes
recommend. The reference workflow's own note says H3 Image works well from about 4 MP up, best near
16 MP, with 16 MP examples such as 4096x4096, 4736x3552 and 5472x3072. Small canvases give poor
results, so the default 512x512 preset of the generic ComfyUI provider is a bad fit for this graph.
