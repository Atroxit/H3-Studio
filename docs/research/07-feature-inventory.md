# 07 Feature Inventory: premium image app features vs MiniMax-H3-Image

Slice: what a premium image generation app offers today, and whether MiniMax-H3-Image
supports each feature natively. Model: `MiniMax-H3-Image`, variant `MiniMax-H3-Image-Highspeed`.
Host: `https://api.minimax.io`.

## Facts

1. **Endpoints (native).** Only two image endpoints exist: `POST /v1/images/generations`
   (text-to-image) and `POST /v1/images/edits` (1 to 16 reference images). Both are
   synchronous, with optional SSE when `stream: true`. Source: image guide, generations spec.
2. **Batch generation (native).** `n` is an integer, range 1 to 10, default 1, on both
   endpoints. If at least one image succeeds the HTTP status is 200; failed slots in `data[]`
   carry only `error`, and only successful images are charged. Source: generations spec, guide.
3. **Size and aspect presets (native).** Set `aspect_ratio` as `X:Y` (1 to 300, ratio 1:3 to
   3:1) with `area` of `1K`, `2K` or `4K`, or set `size` as `WIDTHxHEIGHT` (area 655,360 to
   20,000,000 px). Mixing the two forms returns 400. Source: generations spec, guide.
4. **Prompt builder (native, and server side).** Prompt enhancement is on by default; disable
   with `disable_prompt_enhanced`. The prompt actually used returns per image in
   `data[].revised_prompt`. Source: generations spec, guide.
5. **Standalone prompt enhancement (native).** H3-Image-Context-IR returns the enhanced prompt
   synchronously without generating images. It supports `MiniMax-H3-Image` only, not the
   Highspeed variant. Source: context-IR spec, guide.
6. **Seed control (not native).** No image endpoint defines a `seed` field; the string does not
   appear in the generations, edits, context-IR or streaming specs. Reproducibility has to be
   carried by the exact `revised_prompt` text. Source: OpenAPI specs on the pages read.
7. **Inpainting (not native).** The guide lists masked edits among unsupported features and the
   edits spec states `mask` "is not supported and returns 400". Preview images and transparent
   backgrounds are also listed as unsupported. Source: image guide, edits spec.
8. **Export and cost (partly native).** `output_format` accepts png, jpeg, jpg or webp;
   `response_format` accepts `url` or `b64_json`; `output_compression` 0 to 100 applies to
   jpeg and webp. Each response returns `usage.generated_images` and token counts, priced at
   $2.30 per M input text tokens and $3.80 per M output image tokens for standard. Source:
   generations spec, pricing page.

## Gaps

- **Upscaling.** No upscale endpoint appears in the image specs or pricing tables. The only
  2K regeneration offering (MiniMax-H3-Regeneration, 768P to 2K) is for video. Whether image
  upscaling is planned or reachable by re-requesting at `area: 4K` is not stated.
- **History and library.** Unanswered by the image pages. The image response `url` is documented
  as "not guaranteed to remain available" and the file list endpoint only covers reference
  inputs (`purpose: image_generation_input`), not generated outputs. Whether any server side
  listing of generated images exists is not documented anywhere I read.
- **Favourites and collections.** No page mentions favourites, collections, tags or albums.
  Nothing in the API supports them, so they would be client side only.
- **Keyboard workflow.** Purely a client concern; no API page addresses it. No statement exists
  about hotkeys, command palettes or a shortcut model to align with.
- **Export beyond image files.** No page mentions sidecar metadata, manifest, ZIP batch export,
  or embedding the prompt in EXIF or PNG chunks.
- **Cost display.** Token counts are returned per request, but no page states a pre-generation
  cost estimate endpoint for images. Whether a client must estimate locally from the price
  table is not stated.
- **Consistency across a batch.** No page states whether the `n` images in one request share a
  seed or differ. Item 6 only establishes that no seed input exists.
- **Live confirmation of success path.** No API key exists on this machine, so the authenticated
  200 response shape is documented but not executed. An unauthenticated call to
  `POST /v1/images/generations` on this date returned HTTP 401 with body
  `{"type":"error","error":{"type":"authorized_error","message":"... (1004)","http_code":"401"},"request_id":"..."}`.
  Note this is a 401, not the 200 with `base_resp` shape that the legacy file endpoints use.

## Sources

- https://platform.minimax.io/docs/llms.txt (index used to locate every page below)
- https://platform.minimax.io/docs/guides/image-generation.md (guide, model specs, unsupported list)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md (OpenAPI: request and response schemas)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md (OpenAPI: reference images, `mask` returns 400)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-context-ir.md (standalone prompt enhancement)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md (SSE events)
- https://platform.minimax.io/docs/api-reference/file-management-list.md (file purposes, `base_resp` shape)
- https://platform.minimax.io/docs/pricing/overview.md (image token prices, video regeneration only)
- https://platform.minimax.io/docs/guides/rate-limits.md (image IPM 1000 per model)
- https://api.minimax.io/v1/images/generations (live unauthenticated request, HTTP 401 observed)
