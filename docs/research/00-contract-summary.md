# 00 Consolidated Contract Summary (MiniMax H3 Image API)

Closing document for the seven research slices. It merges them into one build contract for
`MiniMax-H3-Image` and `MiniMax-H3-Image-Highspeed` on host `https://api.minimax.io`.

Provenance tags used per row: **verified** (OpenAPI spec or live request), **documented** (a docs
page states it), **not documented** (no source lists it). No field name appears here unless a
source names it. Where a field is absent from the schemas, the row says so instead of guessing.

Two endpoints carry the whole product surface: `POST /v1/images/generations` (text-to-image) and
`POST /v1/images/edits` (1 to 16 reference images). Two supporting endpoints stage inputs and
inspect prompts: `POST /v1/files/upload` and `POST /v1/h3_image_context_ir`.

---

## 1. Text-to-image contract

Endpoint: `POST https://api.minimax.io/v1/images/generations`. Bearer auth. Not idempotent; a
retry charges again. The server waits up to 600 s, so client timeouts must exceed 600 s.

### 1.1 Request fields

The request schema has exactly 11 properties. `model` and `prompt` are the only required ones.

| Field | Required | Type | Documented values and limits | Client notes |
| --- | --- | --- | --- | --- |
| `model` | yes | string | `MiniMax-H3-Image` or `MiniMax-H3-Image-Highspeed`, identical parameters | No default model is documented; always send it explicitly |
| `prompt` | yes | string | `maxLength` 32000, counted as Unicode characters excluding leading and trailing whitespace; an empty or whitespace-only prompt returns 400 | Counts as input text tokens; enhancement rewrites it before generation. With `disable_prompt_enhanced: true` the model reads only about the first 4096 tokens and the rest has no effect, so validate length in the client and warn above the useful bound |
| `disable_prompt_enhanced` | no | boolean, default `false` | Sets whether enhancement is off; enhancement is on by default. When `true` the request must fix the aspect ratio: either `size` is `WIDTHxHEIGHT`, or `size` is omitted or `auto` with an explicit `X:Y` `aspect_ratio` (`area` optional, default `4K`) | Hard precondition: when `true` and `size` is not `WIDTHxHEIGHT` and `aspect_ratio` is omitted or `auto`, the request returns 400. Enforce this in the client before the call |
| `n` | no | integer | min 1, max 10, default 1 | Counts as `n` images against the images-per-minute limit; the reply may contain fewer successes than `n` |
| `size` | no | string | `WIDTHxHEIGHT` (e.g. `2720x1536`) or `auto`; default `auto` | Area 655,360 to 20,000,000 px, aspect ratio 1:3 to 3:1 inclusive; never scaled or rounded; out of bounds returns 400 |
| `aspect_ratio` | no | string | `X:Y`, e.g. `16:9`; default `auto` | Ratio 1:3 to 3:1; source 07 also states a 1 to 300 bound on the numeric parts. Sending this together with an explicit `WIDTHxHEIGHT` `size` returns 400 even when set to `auto` |
| `area` | no | string | `1K`, `2K`, `4K`; default `4K` | Only meaningful with `size` omitted or `auto`; `2K` at `16:9` yields `2720x1536`. Sending it with an explicit `WIDTHxHEIGHT` returns 400 |
| `output_format` | no | string | `png`, `jpeg`, `jpg`, `webp` | Drives the b64 area cap (see `response_format`) |
| `response_format` | no | string | `url` (default) or `b64_json` | `b64_json` is not supported with `stream`. b64 is capped by total area (`n` x width x height): 20,000,000 px for `png`, 80,000,000 px for `jpeg`/`webp`, else 400 |
| `stream` | no | boolean | `true` returns `text/event-stream` | Forces `response_format: url`; see section 5 |
| `output_compression` | no | integer | 0 to 100 | Applies to `jpeg` and `webp` only |
| `seed` | no | not documented on the hosted API | **Not documented on `api.minimax.io`.** No `seed` property exists in the hosted request schema. The self-hosted serving contract does publish one: the model card lists `seed` as an integer, recommended, on the same path, next to `generator_device` ("cpu recommended", "Same seed, same initial noise on every machine") | Against the hosted API, reproducibility cannot be requested. Whether an undocumented field is rejected or silently ignored is not documented, so do not send one to `api.minimax.io`. A client that also targets a local server keeps a documented `seed` field for that path |
| `mask` | no | not documented | **Not documented** for this endpoint; the edits endpoint returns 400 for `mask` | No inpainting surface exists |

**Decoding constraints apply only on the self-hosted serving contract.** The model card at
https://huggingface.co/MiniMaxAI/MiniMax-H3-Image documents the same two paths for a locally served
model and fixes the decoding values: `num_inference_steps` must be omitted or `6` and
`guidance_scale` must be omitted or `1`, with any other value returning HTTP 400, and
`negative_prompt` is not supported and is rejected (the card states the rejection without naming a
status code for it). The card also states that the checkpoint is "distilled to 6 sampling steps
(6 NFEs) with no classifier-free guidance". None of these fields appears in the hosted surface:
`seed`, `generator_device`, `num_inference_steps`, `guidance_scale` and `negative_prompt` each occur
0 times in `h3-image-generations.json`, `h3-image-edits.json` and `guides/image-generation.md`. The
hosted API therefore exposes no sampling control, and a self-hosted client must send no step or
guidance override at all.

### 1.2 Response fields

HTTP 200 is returned if at least one image succeeded, so per-item inspection is mandatory.

| Field | Presence | Type | Meaning | Client notes |
| --- | --- | --- | --- | --- |
| `data` | always | array of `n` items | One item per requested image, in image order | Length is `n`, not the success count; failures occupy their slot |
| `data[].url` | on success with `response_format: url` | string | Image location | "Not guaranteed to remain available"; no TTL is documented, so download immediately |
| `data[].b64_json` | on success with `response_format: b64_json` | string | Base64 image payload | Subject to the area cap above |
| `data[].size` | on success | string | Realised image size | Not documented whether this echoes `WIDTHxHEIGHT` or the derived value as a string |
| `data[].revised_prompt` | on success | string | The prompt actually used after enhancement | Store it: it is the only reproducibility handle that exists. What it holds when enhancement fails is not documented |
| `data[].error.code` | on failure | string | Internal error code, quoted in the payload, for example `"1027"` and `"1000"` | `ImageObject.properties.error.properties.code` is declared `type: string`, so model it as a string and not as an integer. Only "common values" 1000, 1001, 1008, 1026, 1027 appear in the generations slice; the full list is on the Error Codes page |
| `data[].error.message` | on failure | string | Human message | The internal code also appears in the trailing parenthesis of the message |
| `usage.generated_images` | always | integer | Count of successful images; may be less than `n` | This is the billing counter |
| `usage.total_tokens` | always | integer | Equals `input_tokens` + `output_tokens` | Sum of the two below |
| `usage.input_tokens` | always | integer | Total input tokens | Bill at the input text and input image rates |
| `usage.input_tokens_details.text_tokens` | always | integer | Text share of input tokens | Includes tokens generated by prompt enhancement |
| `usage.input_tokens_details.image_tokens` | always | integer | Image share of input tokens; 0 for text-to-image | Non-zero on edits |
| `usage.output_tokens` | always | integer | Total output tokens | Bill at the output image rate |
| `usage.output_tokens_details.image_tokens` | always | integer | Image share of output tokens | The dominant cost term |
| top-level `request_id` | always | string | Request ID, described as the trace ID: "Provide it when reporting an issue" | `ImagesResponse.properties.request_id` is declared `type: string`, it is present in the 200 example on the generations page, and it appears in the live 401 error body. Log it with every call and attach it to support reports; the streaming `completed` and `error` events carry the same field |

---

## 2. Image edit contract

Endpoint: `POST https://api.minimax.io/v1/images/edits`. Same host, same models, bearer auth, and
the same synchronous-with-optional-SSE behaviour. Two body encodings are accepted on the same
path: JSON and `multipart/form-data` (for OpenAI SDK `images.edit`).

### 2.1 Request fields, JSON form

`H3ImageEditReq` has exactly 11 properties: `model`, `prompt`, `images`, `n`, `size`,
`aspect_ratio`, `area`, `output_format`, `response_format`, `stream` and `output_compression`. Only
`model`, `prompt` and `images` are required. The size family and the format, delivery and streaming
fields are documented here with the same values and defaults as on generations; `mask` and
`disable_prompt_enhanced` are not among the 11.

| Field | Required | Type | Documented values and limits | Client notes |
| --- | --- | --- | --- | --- |
| `model` | yes | string | `MiniMax-H3-Image` or `MiniMax-H3-Image-Highspeed` | Same two models as text-to-image |
| `prompt` | yes | string | `maxLength` 32000, counted as Unicode characters excluding leading and trailing whitespace; an empty or whitespace-only prompt returns 400 | Samples address references as "image 1", "image 2". Enhancement is always applied here, and the prompt description carries no 4096-token truncation note because enhancement is never off |
| `images` | yes | array, `minItems` 1, `maxItems` 16 | Array of objects, each requiring `image_url` | Order is semantic: list order defines the reference number used in the prompt |
| `images[].image_url` | yes | string | One of: public URL, `mm_file://{file_id}`, or `data:image/<format>;base64,<Base64>` | `<format>` must be lowercase. Base64 is about 4/3 of file size, so prefer URLs or `mm_file://` near the body cap |
| `n` | no | integer | 1 to 10, default 1 (stated for both endpoints) | Counts as `n` images against the images-per-minute limit |
| `size` | no | string | default `auto`; either `WIDTHxHEIGHT` or `auto`, with the generations rules: area 655,360 to 20,000,000 px, aspect ratio 1:3 to 3:1 inclusive, never scaled or rounded, out of bounds returns 400 | With an explicit `WIDTHxHEIGHT`, do not send `aspect_ratio` or `area`, not even as `auto`, or the request returns 400 |
| `aspect_ratio` | no | string | default `auto`; `X:Y` with X and Y integers from 1 to 300 and a ratio between 1:3 and 3:1, inclusive | Only valid when `size` is omitted or `auto`; sending it while `size` is `WIDTHxHEIGHT` returns 400. `auto` lets enhancement choose the ratio from the reference images and the prompt |
| `area` | no | string | `1K`, `2K`, `4K`; default `4K`. Targets are 1024 x 1024, 2048 x 2048 and 4096 x 4096 px, with width and height derived from the ratio, so `2K` at `16:9` gives `2720x1536` | Only valid when `size` is omitted or `auto`; sending it with an explicit `WIDTHxHEIGHT` returns 400. Because `4K` is the default, an edit that sets no size runs at the most expensive tier |
| `output_format` | no | string | `png`, `jpeg`, `jpg`, `webp`; default `jpeg` | `jpg` is equivalent to `jpeg` and the response always reports `jpeg`; `png` ignores compression |
| `response_format` | no | string | `url` (default) or `b64_json`; `b64_json` is not supported with streaming | Same area caps as generations: 20,000,000 px for `png`, 80,000,000 px for `jpeg`/`webp`, else 400 |
| `stream` | no | boolean | default `false`; `true` returns `text/event-stream` and requires `response_format: url` | Edit streams use the `image_edit.*` event names. Errors raised before the response headers are sent arrive as ordinary HTTP errors, so check the status before parsing SSE |
| `output_compression` | no | integer | 0 to 100, default 95 | Applies to `jpeg` and `webp` only and is ignored for `png`; values outside the range return 400 |
| `disable_prompt_enhanced` | not accepted | absent from schema | Not present in either edits request schema; the guide states edits always apply prompt enhancement | Enhancement cannot be turned off on this endpoint, so no aspect-ratio precondition applies here |
| `mask` | not usable | not documented | Not supported; sending `mask` returns 400 | Inpainting is impossible through this API |
| `seed` | no | not documented on the hosted API | **Not documented on `api.minimax.io`**; absent from the hosted edits spec. The self-hosted model card publishes `seed` and `generator_device` for the same path | No reproducibility control through the hosted API. A client that also targets a local server keeps a documented `seed` field for that path |

### 2.2 Request fields, multipart form

| Field | Required | Type | Documented values and limits | Client notes |
| --- | --- | --- | --- | --- |
| `model` | yes | string | Same two models | |
| `prompt` | yes | string | `maxLength` 32000, as in the JSON form | |
| `image` or `image[]` | yes | file, repeated | 1 to 16 files, one file each | Repeat the field per file; upload order defines the reference number |
| `mask` | no | file | Rejected with 400 | Do not offer |
| `n` / `size` / `aspect_ratio` / `area` / `output_format` / `response_format` / `stream` / `output_compression` | no | same types as the JSON form | `H3ImageEditMultipartReq` defines all eight with the same defaults and limits: `n` 1 to 10, `size` `auto`, `aspect_ratio` `auto`, `area` `4K`, `output_format` `jpeg`, `response_format` `url`, `stream` false, `output_compression` 95 | Apply the same validation rules as the JSON form, including the `size` versus `aspect_ratio` and `area` conflicts |
| `mm_file://` in multipart | not documented | not documented | Not documented whether a `mm_file://{file_id}` string is accepted in the multipart file fields | Unconfirmed: assume it works only in the JSON `images[].image_url` path until tested |

### 2.3 Reference image constraints

| Constraint | Limit | Status |
| --- | --- | --- |
| Formats per reference | JPG, JPEG, PNG, WEBP, HEIC, HEIF | verified |
| Per file size | at most 64 MiB (upload endpoint documents 64 MB per file) | verified |
| Sides | 128 to 8192 px, inclusive | verified |
| Aspect ratio per reference | at most 4:1 | verified |
| Reference count | 1 to 16 files | verified |
| Total request body | at most 64 MiB, all forms and references included | documented |
| Base64 inflation | about 4/3 of file size; docs advise public URLs or `mm_file://` instead of data URIs near the cap | documented |
| `file_id` lifetime | 7 days from upload, then the edit request returns file expired and the client must re-upload | documented |
| Order semantics | list or upload order is the Picture number; prompt addresses references as image 1, image 2 | documented |
| Mixing forms in one request | not documented whether public URLs and uploaded files may be mixed in one `images` array | not documented |
| Whether the 64 MiB is measured before or after multipart boundaries | not documented | not documented |
| Whether reference count or resolution affects token cost and IPM beyond `usage.input_tokens_details.image_tokens` | not documented | not documented |
| Prompt syntax for disambiguating up to 16 references | not formally specified beyond the two reference samples | not documented |
| Enforcement of the caps at runtime | no authenticated call was made; only the spec and docs state them | unverified at runtime |

### 2.4 Response fields

Same envelope as text-to-image: `data[]` of `n` items in image order, successes carrying `url` (or
`b64_json`), `size` and `revised_prompt`, failures carrying only `error{code,message}`; `usage`
with the same seven counters, except `usage.input_tokens_details.image_tokens` is non-zero because
references are billed as input images. Edit responses always include the enhanced prompt in
`data[].revised_prompt`.

### 2.5 File upload staging

`POST https://api.minimax.io/v1/files/upload` as `multipart/form-data`, body requires `purpose`
and `file`.

| Aspect | Value | Status |
| --- | --- | --- |
| Purpose value | `image_generation_input` | documented |
| Success body | `file` object (`file_id` int64, `bytes`, `created_at` Unix seconds, `filename`, `purpose`) plus `base_resp` (`status_code`, `status_msg`) | documented |
| Formats | jpg, jpeg, png, webp, heic, heif at 64 MB per file | documented |
| Validation | Upload enforces the edit limits (128 to 8192 px per side, ratio at most 4:1, 1 to 16 images); failing files get 400 and are not retained | documented |
| Citation form | `mm_file://{file_id}` in `images[].image_url` | documented |
| Expiry | 7 days; the edit call then returns file expired | documented |
| Expiry error code or HTTP status | not documented (no code is listed; sources only say "returns file expired") | not documented |
| Whether the 7 day clock starts at `created_at`, first use, or upload completion | not documented | not documented |
| Whether an expired file disappears from `GET /v1/files/list` | not documented | not documented |
| Multiple files per upload call | not documented; the schema defines a single `file` field | not documented |
| Reuse of a `file_id` uploaded under another purpose | not documented | not documented |
| Rate limit or body cap on upload itself | not documented beyond the per-file 64 MB limit | not documented |

---

## 3. Error handling rules

### 3.1 Where errors arrive: base_resp versus real HTTP status

The required rule for this contract is that **MiniMax reports application errors inside an HTTP
200 body via `base_resp.status_code`, where `status_code` 0 means success**; a client must read
`base_resp.status_code` and never trust the HTTP status alone. This is directly confirmed by two
live unauthenticated probes and by the file management spec:

- `POST /v1/image_generation` (legacy image endpoint) returned **HTTP 200** with
  `base_resp.status_code` 1004 for a missing key.
- `POST /v1/files/upload` returned **HTTP 200** with `base_resp.status_code` 1004 for a missing
  key, alongside the usual `file` object shape in the schema.
- The legacy `/v1/image_generation` endpoint is where the always-200 behaviour lives.

**Divergence the build must not miss.** The two H3 image endpoints are the exception. The string
`base_resp` appears zero times in both H3 image specs (`h3-image-generations.json`,
`h3-image-edits.json`), and live unauthenticated calls to `/v1/images/generations`,
`/v1/images/edits` and `/v1/h3_image_context_ir` all returned a **real HTTP 401** with an
`error` envelope and no `base_resp`. Therefore the correct client rule is layered:

1. Parse the body as JSON and check for `base_resp` first. If present, branch on
   `base_resp.status_code`: 0 is success, anything else is a failure regardless of HTTP status.
2. If `base_resp` is absent, branch on the HTTP status and read `error.type`,
   `error.message`, `error.http_code` and `request_id`.
3. Regardless of both, on any 200 generation response iterate every `data[]` item and check for
   `data[].error`, because a single image can fail inside a successful call.

All H3 image error bodies share the shape
`{"type":"error","error":{"type":...,"message":...,"http_code":...},"request_id":...}`. The
internal code is embedded in the trailing parenthesis of `error.message`, for example
`login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)`.

### 3.2 Documented codes and what each means for a client

| Code | Documented HTTP status | Meaning | Client action |
| --- | --- | --- | --- |
| 0 | 200 | Success (`base_resp.status_code` only) | Proceed; still inspect `data[].error` |
| 1000 | 500 | Internal error, catch-all when all images fail | Catalogue says retry later; exponential backoff with a hard attempt cap |
| 1001 | not documented | Listed in the generations slice as a common per-image value and in the retryable catalogue | Treat as transient: retry with backoff |
| 1002 | 429 | Images-per-minute limit exceeded; each request counts as `n` images | Retry after backoff, and reduce `n` or request rate; no numeric IPM breach body is documented |
| 1004 | 401 | Authorization failure, missing or invalid key | Never retry. Surface a configuration error to the owner |
| 1008 | 402 | Insufficient balance or plan quota | Do not retry. Surface a billing state and block generation prompts |
| 1024 | not documented | Listed in the retryable catalogue | Retry with backoff |
| 1026 | 422 | Input prompt or enhanced prompt flagged by the content safety check | Do not auto-retry the same prompt. Show a prompt-revision path. Note the enhanced prompt can trigger this even when the user prompt looks clean |
| 1027 | 422 when all images are withheld; per-image code when only some fail | Generated image withheld by the content safety check | Retry is meaningful (a re-roll can pass); otherwise surface as filtered output, not as a system error |
| 1033 | not documented | Listed in the retryable catalogue | Retry with backoff |
| 1039 | not documented | Listed in the retryable catalogue | Retry with backoff |
| 2013 | 400 | The catalogue code that the H3 spec maps to 400. The sources do not state its description | Do not retry. Treat every 400 as a request defect: size family conflict, out of bounds area, b64 plus stream, or `mask` |
| 2053 | 402 | Insufficient balance or plan quota variant | Do not retry; billing state |
| 2056 | 429 | M Plan usage limit reached | Do not retry on a short backoff. Pause until the weekly window or Credits state changes |
| 2064 | not documented | Listed in the retryable catalogue | Retry with backoff |
| 2066 | not documented | Listed in the retryable catalogue | Retry with backoff |
| 2067 | 402 | Insufficient balance or plan quota variant | Do not retry; billing state |
| 2068 | 402 | Insufficient balance or plan quota variant | Do not retry; billing state |
| 2160 | not documented | Listed in the retryable catalogue | Retry with backoff |

Codes the catalogue also lists that plainly cannot arise on image generation (1040 input audio
sensitive, 1043 ASR similarity, 2037 to 2054 voice codes) are not implemented. Whether the 429
concurrency codes 1045 and 2045 to 2047 can fire on image calls is not documented, so map them to
the generic 429 path.

### 3.3 Structural rules a client must implement

1. HTTP 200 means "at least one image succeeded", never "everything succeeded". Iterate `data[]`.
2. When every image fails, the call returns 402, 422 or 500, not 200.
3. Compare `usage.generated_images` with `n` to detect partial success before showing a cost.
4. No `Retry-After` header appears in either H3 spec. Whether a live 429 sends one is unverified,
   so back off on a local schedule and use the header only if it appears.
5. Only successful images are billed, including inside a 200 partial failure.
6. Auth is checked before body validation, so a 401 does not imply the body was valid.
7. The catalogue is shared across all MiniMax products and no page marks the image subset. Only
   the codes above are mapped; unknown codes must fall through to a generic "generation failed"
   state carrying the raw code and message.
8. Whether the streaming `error` event reuses the same `http_code` values is stated but not
   observed live. Handle both the numeric and string forms of `http_code`.

---

## 4. Cost model

### 4.1 Published token rates (USD per million tokens, pay-as-you-go)

| Model | Input text | Input image | Output image |
| --- | --- | --- | --- |
| `MiniMax-H3-Image` | $2.30 | $1.50 | $3.80 |
| `MiniMax-H3-Image-Highspeed` | $2.30 | $3.00 | $7.60 |

Source table label: "Model / Input Text / Input Image / Output Image, $ per M tokens". Billing is
per million tokens, split three ways. Apply these rates to the counters in `usage`
(`input_tokens_details.text_tokens`, `input_tokens_details.image_tokens`,
`output_tokens_details.image_tokens`).

### 4.2 Published example totals per generated image (text-to-image)

The pricing page calls these illustrative, not quoted rates.

| Model | 1K | 2K | 4K, pre-offer price | 4K, price while the offer runs |
| --- | --- | --- | --- | --- |
| `MiniMax-H3-Image` | $0.02179 | $0.02333 | $0.06879 | $0.03439 |
| `MiniMax-H3-Image-Highspeed` | $0.03529 | $0.03622 | $0.13001 | $0.06501 |

The 4K column pair records what the page renders: the higher figure is struck through as the original
price, and the lower figure is shown beside it as the promotional price under "Limited-time 50% off".
The offer applies when the final delivered image has at least 16,600,000 px, and it runs "from now
until November 17, 2026, at 16:00 UTC (exclusive)". A 4096 x 4096 output is 16,777,216 px, so the 4K
example sizes qualify. At the time of this correction (2026-11-17 05:52 UTC) the offer is still open,
so $0.03439 and $0.06501 are the figures that apply today; after 16:00 UTC on 2026-11-17 the offer is
closed and the struck-through $0.06879 and $0.13001 are the figures the page carries. Source:
https://platform.minimax.io/docs/pricing/overview.md.

### 4.3 Published example totals for edits

Edit examples list each reference under an "Input image (each)" column and cost more than
text-to-image. For `MiniMax-H3-Image` at 1K output: $0.02654 with one reference image and $0.03563
with three.

### 4.4 Other documented cost facts

| Fact | Value | Unit and note |
| --- | --- | --- |
| Standalone enhancement (`MiniMax-H3-Image-Context-IR`) | $2.30 per M input tokens, RPM limit 200 | Separate paid call; `Highspeed` returns 400 on it |
| Prompt enhancement billing | Enhancement output is billed as input text | Two requests at the same size can cost different amounts |
| Charging rule | Only successful images are charged | A withheld image carries only `error` in `data[]` |
| Legacy `image-01` | $0.0035 per image flat | Not an H3 rate; listed only to prevent conflation |
| 4K promotion | Limited-time 50% discount "from now until November 17, 2026, at 16:00 UTC (exclusive)", for final delivered images of at least 16,600,000 px. While the offer runs the 4K example totals are $0.03439 for `MiniMax-H3-Image` and $0.06501 for Highspeed; the struck-through pre-offer totals are $0.06879 and $0.13001 | USD per image, from the 4K example row. The offer is open at 2026-11-17 05:52 UTC, so the discounted totals apply until 16:00 UTC today, and the struck-through totals apply after 16:00 UTC today. Behaviour for a request that starts before and finishes after the cutoff is not documented |
| Image rate limit | IPM 1000 per model, not shared across models | Text-to-image and edit on the same model share that model's quota; `n` images count as `n`. RPM and TPM are shown as unset for these rows |
| Free quota | not documented | No free allowance is published for the H3 image endpoints |

### 4.5 What cannot be computed

- No formula is published for how output image tokens derive from pixel area, so the exact cost of
  an arbitrary `WIDTHxHEIGHT` cannot be derived from the docs. Only the example totals exist, so a
  client cost estimate must interpolate or show a range.
- Whether input text tokens are billed once per request or once per generated image when `n` > 1
  is not documented. The same question applies to input image tokens with several references.
- Whether `response_format` (url versus b64_json) or streaming changes token counts and therefore
  price is not documented.
- M Plan quota consumption per generated image is not quantified.

---

## 5. Streaming and prompt enhancement semantics

### 5.1 Streaming transport

| Item | Documented behaviour |
| --- | --- |
| Trigger | `stream: true` on either image endpoint, which then returns `text/event-stream` |
| `response_format` restriction | Only `url` is allowed. `b64_json` is not supported with streaming; no error code or HTTP status is documented for that combination |
| Keepalive | A `: keepalive` comment line every 15 s while waiting, which can be ignored |
| Framing | Each event is an `event:` line plus a JSON `data:` line, events separated by a blank line |
| Event names, generations | `image_generation.partial_succeeded`, `image_generation.partial_failed`, `image_generation.completed`, plus `error` |
| Event names, edits | `image_edit.partial_succeeded`, `image_edit.partial_failed`, `image_edit.completed`, plus `error` |
| SSE `id:` / `retry:` fields | Not described. Resuming a dropped connection is not documented |
| Event payload schema | No OpenAPI schema exists; field types come from prose on the Streaming Events page only |
| Timeout | The server waits up to 600 s, so set the client timeout to at least 600 s |

### 5.2 Event payloads

| Event | Fields | Semantics |
| --- | --- | --- |
| `*.partial_succeeded` | required `type`, `image_index` (0-based, 0 to `n`-1), `url`; also `created`, `model`, `size`, `output_format`, `revised_prompt` | One image is ready. Events arrive in completion order, so match images by `image_index`, never by arrival order |
| `*.partial_failed` | `type`, `image_index`, `code` (internal code, e.g. `1027`), `message` | One image failed or was withheld; the other images keep streaming |
| `*.completed` | `usage` plus `request_id` | Last event, pushed only when at least one image succeeded. `usage` holds `generated_images`, `total_tokens`, `input_tokens`, `output_tokens` and the detail objects |
| `error` | `error.http_code` | Terminal. Usage is all zeros and the request is not billed. `http_code` is 422 if all images were withheld, 402 if all failed for insufficient balance, else 500 |

### 5.3 Client implementation for progressive results

1. Send `stream: true` with `response_format` defaulted to `url`.
2. Read the response as an event stream, not as a JSON document. Skip every line starting with `:`
   (keepalive) and dispatch on the event name, not on the data shape.
3. Allocate `n` slots up front, indexed 0 to `n`-1, and fill slot `image_index` on each
   `partial_succeeded`. Never append in arrival order.
4. Download the `url` as soon as its event arrives; no TTL is documented.
5. Mark slot `image_index` as failed with `code` and `message` on `partial_failed`, and keep the
   remaining slots live.
6. Treat `completed` as the only success terminator and read `usage` from it for the cost display.
7. Treat `error` as the only failure terminator after the stream opened; do not bill the user.
8. Keep a client-side watchdog at or above 600 s plus a small margin, and do not auto-resume: no
   resume protocol exists, and a retry charges again because the endpoint is not idempotent.

### 5.4 Prompt enhancement semantics

| Aspect | Behaviour |
| --- | --- |
| Default | Enhancement is on by default on generations and is disabled with `disable_prompt_enhanced` |
| Where the result is visible | Per image in `data[].revised_prompt`, and in streaming `partial_succeeded` events as `revised_prompt` |
| Billing | Enhancement output is billed as input text |
| Safety interaction | Code 1026 covers an enhanced prompt failing the safety check, so enhancement can trigger a rejection the user prompt alone would not. What `revised_prompt` holds in that case is not documented |
| On edits | Edits always apply enhancement, and the enhanced prompt returns in `data[].revised_prompt`. Whether it can be disabled is not documented |
| Standalone enhancement endpoint | `POST https://api.minimax.io/v1/h3_image_context_ir` with `model` and `prompt` returns only the enhanced prompt and generates no images |
| Model support on that endpoint | `MiniMax-H3-Image` only; `MiniMax-H3-Image-Highspeed` returns 400 |
| Response of that endpoint | `created`, `revised_prompt`, optional `aspect_ratio`, `usage` (where `total_tokens` equals `input_tokens`), `request_id` |
| When `aspect_ratio` appears | Only when enhancement decides the ratio, that is `size` omitted or `auto` and `aspect_ratio` omitted or `auto` |
| Streaming that endpoint | Not documented; the Context-IR spec has no `stream` field |
| Rate limits on that endpoint | Not stated beyond generic 429 codes (`1002` RPM, `2056` M Plan limit) |

---

## 6. Capability matrix

Premium image app features against what the API provides.

### 6.1 Supported natively

| Feature | Native support |
| --- | --- |
| Text to image | `POST /v1/images/generations` |
| Image editing with references | `POST /v1/images/edits`, 1 to 16 reference images |
| Batch generation | `n` 1 to 10 on both endpoints, with per-item success and failure reporting |
| Partial failure handling | 200 with per-item `error` objects; only successes billed |
| Size and aspect presets | `size` as `WIDTHxHEIGHT`, or `aspect_ratio` plus `area` (`1K`/`2K`/`4K`) |
| Server-side prompt enhancement | On by default, retrievable as `revised_prompt` |
| Standalone prompt enhancement | `POST /v1/h3_image_context_ir`, standard model only |
| Progressive results | SSE with `partial_succeeded`, `partial_failed`, `completed`, `error` and 15 s keepalives |
| Output format control | `output_format` png/jpeg/jpg/webp, `output_compression` 0 to 100 for jpeg and webp |
| Delivery as URL or inline bytes | `response_format` `url` or `b64_json` (b64 not with streaming, area-capped) |
| Reference image hosting | `POST /v1/files/upload` with `purpose=image_generation_input`, cited as `mm_file://{file_id}` |
| Cost metering per request | `usage` counters in every response and in every `completed` event |
| Two quality tiers | `MiniMax-H3-Image` and `MiniMax-H3-Image-Highspeed`, identical parameters |

### 6.2 Needs client work

| Feature | Why it is client work |
| --- | --- |
| History and library of generated images | The response `url` is not guaranteed to remain available with no documented TTL, and the file list endpoint only covers reference inputs, not generated outputs. The client must download and store at generation time |
| Cost display before generation | No pre-generation cost estimate endpoint exists. The client must estimate locally from the price table, then reconcile against `usage` |
| Accurate cost for arbitrary sizes | No published formula converts pixel area to output tokens, so only example sizes are exact |
| Progressive UI correctness | The client must key images by `image_index`, because arrival order is not index order |
| Retry and backoff policy | No `Retry-After` is documented. The client owns the schedule and the non-idempotent double-charge risk |
| Reproducibility | No `seed` exists on the hosted API. The client must persist the exact `revised_prompt` and treat re-rolling as a new generation. The self-hosted model card does publish `seed` with `generator_device`, so a client that also targets a local server keeps that documented field |
| Batch consistency | Nothing states whether the `n` images of one request are related, so consistency cannot be promised |
| Favourites, collections, tags, albums | No API surface. Client side only |
| Keyboard workflow and shortcuts | Purely client concern; no API alignment statement exists |
| Export beyond image files | Sidecar metadata, manifests, ZIP batch export, and prompt embedding in EXIF or PNG chunks are all client work; no page mentions any of them |
| Reference ordering UX | Order is semantic and the prompt syntax for disambiguation is only shown by two samples, so the client must teach and enforce the numbering |
| Reference lifecycle management | `file_id` expires after 7 days with no documented error code, so the client must track `created_at` and re-upload preemptively |
| Maskless region editing UX | Region targeting must be expressed in prompt plus references, since masks are rejected |
| Undocumented-field policy | Nothing states whether unknown fields are rejected or ignored, so the client must not send any |
| Large-reference transport | The 64 MiB body cap and 4/3 base64 inflation force a strategy choice between public URLs and `mm_file://` |

### 6.3 Impossible through this API

| Feature | Reason |
| --- | --- |
| Seed control and true reproducibility on the hosted API | No `seed` field in the hosted generations, edits, context-IR or streaming specs. The scope is `api.minimax.io`: the self-hosted model card does publish `seed` and `generator_device` on the same paths (see 1.1) |
| Inpainting with masks | `mask` is documented as unsupported and returns 400 |
| Preview images | Listed among unsupported features in the guide |
| Transparent backgrounds | Listed among unsupported features in the guide |
| Server-side image upscaling | No upscale endpoint in the image specs or pricing tables; the only 2K regeneration offering is for video |
| Server-side storage or listing of generated images | No endpoint is documented; the file list covers reference inputs only |
| Server-side favourites or collections | No API surface at all |
| Disabling enhancement on edits | Edits always apply enhancement |
| Pre-generation cost quote endpoint | Not documented for images |
| Resumable or reconnecting streams | No SSE `id:` or `retry:` fields and no resume protocol |
| Streaming with inline base64 | `b64_json` is not supported with `stream` |
| Consistent characters across a batch via API | No identity or reference-locking mechanism beyond passing references, and no batch consistency statement |

---

## 7. Decisions the owner must make before build

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| 1 | Default model | `MiniMax-H3-Image` or `MiniMax-H3-Image-Highspeed` | Default to `MiniMax-H3-Image`. Output image tokens cost $3.80 versus $7.60 per M, and every published example total is lower (for example $0.06879 versus $0.13001 at 4K). Offer Highspeed as an explicit upgrade toggle |
| 2 | Key type | Pay-as-you-go key or M Plan key | Use pay-as-you-go for build and demo (account balance, easy to reason about), and revisit M Plan only when sustained volume is known. The two are not interchangeable, and a plan key never charges the balance |
| 3 | Streaming as the default transport | Always stream, never stream, or adaptive | Stream by default with `response_format: url`. It is the only way to show progressive results, and the 15 s keepalive makes long waits tolerable |
| 4 | Delivery format for stored assets | `url` or `b64_json` | `url` everywhere in the streaming path, and `b64_json` only for single-image flows that need immediate bytes without a second request. Never combine b64 with streaming |
| 5 | Reference image transport | Public URL, `mm_file://{file_id}`, or data URI | `mm_file://` for user-uploaded local files with expiry tracking, public URL for externally hosted references. Avoid data URIs except for small references |
| 6 | Error contract | Trust HTTP status only, or layered `base_resp` plus status plus `data[].error` | Adopt the layered rule in section 3.1. Some MiniMax endpoints report failure inside a 200 `base_resp`, and the H3 endpoints do not, so one code path must tolerate both |
| 7 | Retry policy | No retries, blind retries, or a whitelist | Whitelist only: retry 1000, 1001, 1024, 1033, 1039, 2064, 2066, 2160 and generic 429 with capped exponential backoff. Never retry 1004, 1008, 2053, 2067, 2068, 2013, or 1026 as-is. Accept the double-charge risk on every retry and warn the user |
| 8 | Library and storage model | Client-side storage, or wait for a documented server listing | Build client-side download and storage at generation time. Treat the returned URL as ephemeral because no TTL is documented. This implies a storage and privacy decision, not only a UI one |
| 9 | Cost display fidelity | Hide costs, show estimates, or show estimates reconciled to actuals | Show an estimated range from the published example totals, then show the actual figure derived from `usage` after the call. Do not price 4K off the promo that ends 2026-11-17 16:00 UTC |
| 10 | Reproducibility promise | Promise seed-like regeneration, or store the enhanced prompt | Store the exact `revised_prompt` and replay it. Do not promise bit-exact regeneration; no seed exists on the hosted API (the self-hosted model card does publish one), and batch consistency is undocumented |
| 11 | Region and mask editing | Ship a mask tool, or prompt-only targeting | Do not ship a mask tool. Masks return 400. Expose prompt-based local edits with reference images instead |
| 12 | Standalone prompt preview | Call Context-IR as a product feature, or rely on server-side enhancement | Rely on server-side enhancement and read `revised_prompt`. Context-IR is a separate paid call ($2.30 per M input tokens, RPM 200) that also excludes the Highspeed model, so add it only if prompt preview is a real product feature |
| 13 | Concurrency budget | One shared IPM pool or separate pools | Assume one IPM 1000 pool per model shared by text-to-image and edits, with `n` counting as `n`. Cap client concurrency well below it, since no RPM ceiling or `Retry-After` is documented |
| 14 | Reference limits in the UI | Allow 16 references at full resolution, or constrain earlier | Enforce the 128 to 8192 px, 4:1 ratio, 64 MiB total body and 7 day `file_id` limits in the client before upload, because the caps are stated but were never enforced against a live authenticated call |

---

## Sources

Every URL carried over from the seven input slices, grouped by slice.

### Text to image (01)

- https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md (primary reference; embeds the OpenAPI definition, error examples, streaming)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json (OpenAPI 3.1.0 spec: request schema, response schemas, error responses)
- https://platform.minimax.io/docs/guides/image-generation.md (guide: model specs, Output Size, Prompt Enhancement, Partial Failures)
- Live probe: unauthenticated `POST https://api.minimax.io/v1/images/generations` returned HTTP 401 with `{"type":"error","error":{"type":"authorized_error","message":"login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)","http_code":"401"},"request_id":"..."}`

### Image edit (02)

- https://platform.minimax.io/docs/llms.txt (index used to locate the pages)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md (Image Edit API page; embeds the full OpenAPI 3.1.0 spec)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json (standalone OpenAPI spec: 3.1.0, server `https://api.minimax.io`, required `[model, prompt, images]`, multipart required `[model, prompt, image]`, `images` and `image` both 1 to 16)
- https://platform.minimax.io/docs/guides/image-generation.md (Image Edit section, three `image_url` forms, reference image limits table, 64 MiB body note)
- Live probe: `POST https://api.minimax.io/v1/images/edits` with a JSON body and no Authorization header returned HTTP 401 carrying the `authorized_error` envelope

### Error model (03)

- [S1] Error Codes, https://platform.minimax.io/docs/api-reference/errorcode
- [S2] Rate Limits, https://platform.minimax.io/docs/guides/rate-limits
- [S3] MiniMax H3-Image Generations OpenAPI spec (openapi 3.1.0, server `https://api.minimax.io`), https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json
- [S4] MiniMax Image Generation `edits` OpenAPI spec, https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json
- [S5] Text-to-Image (MiniMax-H3-Image), https://platform.minimax.io/docs/api-reference/image-generation-h3-generations
- [S6] Text to Image Generation (legacy, `image-01`), https://platform.minimax.io/docs/api-reference/image-generation-t2i
- [live] Two unauthenticated probes at 2026-11-17T05:02Z: `POST https://api.minimax.io/v1/images/generations` gave HTTP 401 with the `authorized_error` envelope; `POST https://api.minimax.io/v1/image_generation` gave HTTP 200 with `base_resp.status_code` 1004
- Note: the `.md` forms of S1 and S2 returned HTTP 200 with empty bodies, so the HTML forms were read instead. The string `base_resp` appears zero times in both H3 image specs S3 and S4. The H3 `/docs/api-reference/image/generation/api/openapi.json` bundle has an empty `paths` object and carries no image endpoint definitions

### Pricing (04)

- https://platform.minimax.io/docs/llms.txt (index used to locate pages; no URL was guessed)
- https://platform.minimax.io/docs/pricing/overview.md (token prices, example per-image totals, Context-IR price, 50% 4K promotion; table labels read from the rendered page at https://platform.minimax.io/docs/pricing/overview)
- https://platform.minimax.io/docs/guides/rate-limits.md (Image IPM table, IPM definition, RPM/TPM definitions; table read from the rendered page at https://platform.minimax.io/docs/guides/rate-limits)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md (only successful images charged)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json (usage schema)
- https://platform.minimax.io/docs/m-plan/faq.md (key types, Credits order, weekly window, production guidance)
- https://platform.minimax.io/docs/m-plan/intro.md (tier to image model mapping; rendered HTML used for the table cells)

### Streaming and prompt enhancement (05)

- https://platform.minimax.io/docs/llms.txt (index used to locate the pages; URLs were not guessed)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md (Streaming Events)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-context-ir.md (H3-Image-Context-IR page)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-context-ir.json (OpenAPI spec)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json (OpenAPI spec, `stream` and `response_format`)
- Live probe: https://api.minimax.io/v1/h3_image_context_ir and https://api.minimax.io/v1/images/generations (unauthenticated)

### File upload (06)

- [S1] Upload File, https://platform.minimax.io/docs/api-reference/file-management-upload.md
- [S2] MiniMax File Management API OpenAPI spec, https://platform.minimax.io/docs/api-reference/file/management/api/openapi.json
- [S3] Image Edit (MiniMax-H3-Image), https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md
- [S4] Image Generation Guide, https://platform.minimax.io/docs/guides/image-generation.md
- [live] Unauthenticated probe, `POST https://api.minimax.io/v1/files/upload`, observed HTTP 200 plus `base_resp.status_code` 1004 at 2026-11-17T05:0x UTC

### Feature inventory (07)

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

### Model card, self-hosted serving contract (added 2026-11-17)

- https://huggingface.co/MiniMaxAI/MiniMax-H3-Image (model card: "Request parameters" table listing `seed`, `generator_device`, `response_format`, `min_generation_area`, `num_inference_steps`, `guidance_scale` and `negative_prompt` for `/v1/images/generations` and `/v1/images/edits`; vLLM and SGLang deployment commands; "The checkpoint is distilled to 6 sampling steps (6 NFEs) with no classifier-free guidance")

---

## Corrections applied 2026-11-17

Findings source: `00b-independent-review.md`. Each finding was re-verified against the primary
sources before being applied. Verification method: direct HTTPS GET with `curl.exe`, because the
API reference `.md` pages and the OpenAPI JSON return an empty body through some fetchers, plus JSON
parsing of the specs so that every type below is read from
`components.schemas.<Name>.properties.<field>`. No authenticated call was made, so nothing below
claims runtime enforcement.

1. **Edits documents the size, format, delivery and streaming fields. Applied.**
   `H3ImageEditReq` and `H3ImageEditMultipartReq` in
   https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json each
   declare 11 properties, including `size` (default `auto`), `aspect_ratio` (default `auto`), `area`
   (`1K`/`2K`/`4K`, default `4K`), `output_format` (`png`/`jpeg`/`jpg`/`webp`, default `jpeg`),
   `response_format` (default `url`), `stream` (default `false`) and `output_compression` (0 to 100,
   default 95). The request example on
   https://platform.minimax.io/docs/api-reference/image-generation-h3-edits sends `size: "auto"`, and
   its 200 example returns `output_format: "jpeg"`. Section 2.1 is now a full field table and 2.2
   gained the matching multipart row.

2. **`data[].error.code` is a string. Applied.**
   `ImageObject.properties.error.properties.code` is `type: string` in both
   https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json and
   https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json, and the
   streaming `ImageStreamPartialFailed.properties.code` is also `type: string`. The row in 1.2
   changed from integer to string, with a note that values arrive quoted.

3. **`prompt` length bound and the `disable_prompt_enhanced` precondition. Applied.**
   `H3ImageGenerationReq.properties.prompt` declares `maxLength: 32000`, and
   `properties.disable_prompt_enhanced` is `type: boolean, default: false` with the description that
   when `true` the request must use `size` `WIDTHxHEIGHT`, or `size` omitted or `auto` with an
   explicit `X:Y` `aspect_ratio`, otherwise 400.
   https://platform.minimax.io/docs/guides/image-generation.md repeats "32000 characters" and the
   "about the first 4096 tokens" truncation when enhancement is off. Both 1.1 rows rewritten. Neither
   edit request schema contains `disable_prompt_enhanced`, so 2.1 records it as absent there.

4. **The 4K example totals quoted are the struck-through pre-offer prices. Applied.**
   https://platform.minimax.io/docs/pricing/overview.md renders `$0.06879` and `$0.13001` inside
   `<s title="Original price">` and `$0.03439` and `$0.06501` inside `strong title="Promotional
   price"` under "Limited-time 50% off", for requests where the final delivered image has at least
   16,600,000 px, running "From now until November 17, 2026, at 16:00 UTC (exclusive)". Section 4.2
   now lists both figures per model, and 4.4 states that the discounted totals apply until 16:00 UTC
   today and the struck-through totals after 16:00 UTC today.

5. **The "no seed" claim is scoped to the hosted API. Applied.**
   `seed`, `generator_device`, `num_inference_steps`, `guidance_scale` and `negative_prompt` each
   occur 0 times in both H3 image specs, in
   https://platform.minimax.io/docs/guides/image-generation.md and in the two API reference pages,
   while https://huggingface.co/MiniMaxAI/MiniMax-H3-Image publishes `seed` ("Recommended",
   "Integer") and `generator_device` ("cpu recommended", "Same seed, same initial noise on every
   machine") for requests to `/v1/images/generations` and `/v1/images/edits`. Scoped in 1.1, 2.1,
   6.2, 6.3 and decision 10, and the model card URL was added to Sources.

6. **Decoding constraints from the model card. Applied.**
   The model card parameter table states `num_inference_steps` "Omit or 6" with "Other values return
   HTTP 400", `guidance_scale` "Omit or 1" with the same 400 note, and `negative_prompt` "Not
   supported / Rejected", alongside "The checkpoint is distilled to 6 sampling steps (6 NFEs) with no
   classifier-free guidance". Applied as a note after the 1.1 table. One qualification: the card
   states that `negative_prompt` is rejected but names no status code for it, so the summary does not
   claim 400 for that field. Source:
   https://huggingface.co/MiniMaxAI/MiniMax-H3-Image.

7. **Top-level `request_id` restored. Applied.**
   `ImagesResponse.properties.request_id` is `type: string`, described as "Request ID (the trace ID).
   Provide it when reporting an issue", and it appears in the 200 example of
   https://platform.minimax.io/docs/api-reference/image-generation-h3-generations as
   `"request_id": "021792308678142a2c883cf675b9804d"` and in the recorded live 401 body. The row in
   1.2 changed from "not documented" to always present.

**Rejected findings: none.** All seven findings reproduced against primary sources. The review also
raised items outside these seven (the `data[].size` semantics, the code 2013 description, the
streaming OpenAPI schema, the 64 MB versus 64 MiB unit mismatch, the `http_code` type note, and the
code 2056 window contradiction). Those were not part of this correction pass and are unchanged here.

