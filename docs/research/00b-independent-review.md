# 00b Independent Review of `00-contract-summary.md`

Reviewer: `agent-32`. I did not write the summary or the seven slices.
Date: 2026-11-17. Sources fetched and live probes run between 05:48 and 06:10 UTC.

Scope: the ten most load-bearing factual claims in `00-contract-summary.md`, where
load-bearing means a client implementer breaks without the claim. Slice-level
contradictions and refuted claims outside the ten are listed after the table.

Method:

1. Fetched every source directly with an HTTPS GET and recorded its byte length.
2. Parsed the OpenAPI JSON schemas with a JSON parser instead of reading prose about them.
   Every schema row below cites `components.schemas.<Name>.properties.<field>`.
3. Repeated the unauthenticated live probes instead of trusting the recorded results.
4. Re-derived each price, range, enum and status code from the fetched text.

Tooling caveat carried from the slices and reproduced here: `web_fetch` returns HTTP 200
with an empty body for the API reference `.md` pages and the OpenAPI JSON. All primary
sources below were fetched with `Invoke-WebRequest` and `curl.exe` instead. Sizes recorded
in section 5. No API key was available, so no authenticated call was made, and nothing
below claims runtime enforcement.

## 1. The ten load-bearing claims

| # | Claim as written in the summary | Verdict | Exact source | What breaks if a client trusts the summary |
| --- | --- | --- | --- | --- |
| 1 | Four endpoint paths: `POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/files/upload`, `POST /v1/h3_image_context_ir`, host `https://api.minimax.io` | **CONFIRMED** | `h3-image-generations.json` `servers[0].url` = `https://api.minimax.io`, `paths` = `/v1/images/generations` only. `h3-image-edits.json` `paths` = `/v1/images/edits` only, with both `application/json` and `multipart/form-data` request bodies. `h3-image-context-ir.json` `paths` = `/v1/h3_image_context_ir` only. `file/management/api/openapi.json` `paths` = `/v1/files/upload`, `/v1/files/retrieve`, `/v1/files/list`, `/v1/files/retrieve_content`, `/v1/files/delete` | Nothing. Paths and host are correct. |
| 2 | Section 1.1 and 2.1: `seed` does not exist, "No `seed` property exists in the request schema", no reproducibility control | **CONFIRMED for `api.minimax.io`, REFUTED as an unscoped statement** | Hosted: the string `seed` occurs 0 times in `h3-image-generations.json`, `h3-image-edits.json` and `h3-image-context-ir.json`, and 0 times in `guides/image-generation.md`, `image-generation-h3-generations.md`, `image-generation-h3-edits.md`. Model card https://huggingface.co/MiniMaxAI/MiniMax-H3-Image, "Request parameters" table, row `seed`: "Recommended / Recommended / Integer", with `generator_device`: "cpu recommended / Same seed, same initial noise on every machine". The card's own text defines those paths together with a local `sglang serve` command | A hosted-only client is safe. A client that also targets the published self-hosted contract, which serves the same `/v1/images/generations` and `/v1/images/edits` paths, would omit a documented reproducibility field and lose the guarantee the card states. The summary never cites the model card and never scopes the claim to the hosted API. |
| 3 | Section 1.1 and 2.1: `n` is min 1, max 10, default 1, on both endpoints | **CONFIRMED** | `H3ImageGenerationReq.properties.n`: `type: integer, minimum: 1, maximum: 10, default: 1`. `H3ImageEditReq.properties.n` and `H3ImageEditMultipartReq.properties.n`: identical. `guides/rate-limits.md`: "each request counts as `n` images" | Nothing. Range and default are correct on all three request schemas. |
| 4 | Section 2.3: reference images 1 to 16, formats JPG/JPEG/PNG/WEBP/HEIC/HEIF, at most 64 MiB per file, sides 128 to 8192 px, ratio at most 4:1, total body at most 64 MiB | **CONFIRMED**, with one unit defect | `H3ImageEditReq.properties.images`: `minItems: 1, maxItems: 16`, description table "Format | JPG, JPEG, PNG, WEBP, HEIC, HEIF; Single file size | ≤ 64 MiB; Width/height range | [128, 8192] px; Aspect ratio (long/short side) | ≤ 4:1; Count | 1 to 16; total request body ≤ 64 MiB". `H3ImageEditMultipartReq.properties.image`: `minItems: 1, maxItems: 16` | Nothing breaks. Defect: the summary merges the upload page's "64 MB" with the edit spec's "64 MiB" into one figure. 64 MB is about 61 MiB, so a client validating at exactly 64 MiB accepts files the upload page may reject. |
| 5 | Nothing is claimed about decoding: the summary presents the 11 schema properties as the whole server-side control surface and never mentions sampling steps or guidance | **PARTLY. Fixed in the model-card contract, unstated in the hosted docs. The omission is real but does not contradict any hosted fact** | Model card, Highlights: "The checkpoint is distilled to 6 sampling steps (6 NFEs) with no classifier-free guidance". Model card parameter table: `num_inference_steps` "Omit or 6 / Other values return HTTP 400", `guidance_scale` "Omit or 1 / Other values return HTTP 400", `negative_prompt` "Not supported / Rejected". Hosted: `steps`, `num_inference_steps`, `guidance`, `guidance_scale`, `negative_prompt` each occur 0 times in all three H3 specs and 0 times in `guides/image-generation.md` | No hosted client breaks, because the values are fixed server-side and not exposed. A self-hosted client breaks: sending any value other than 6 and 1 returns HTTP 400 on that serving contract, and the summary's claim that the 11 properties are the whole surface would not warn it. |
| 6 | Section 1.1: `size` area 655,360 to 20,000,000 px, aspect ratio 1:3 to 3:1 inclusive, never scaled or rounded, out of bounds 400; `area` of `1K`/`2K`/`4K` default `4K`; `2K` at `16:9` gives `2720x1536`; `aspect_ratio` parts 1 to 300 | **CONFIRMED** | `H3ImageGenerationReq.properties.size.description`: "The area (width × height) must be between 655,360 and 20,000,000 pixels and the aspect ratio between 1:3 and 3:1, bounds inclusive; otherwise 400 is returned, and the size is never scaled or rounded. In this form, do not set `aspect_ratio` or `area` (not even to `auto`)". `properties.aspect_ratio.description`: "X and Y are integers from 1 to 300 and the ratio is between 1:3 and 3:1". `properties.area.description`: "`1K`, `2K` and `4K` target areas of 1024 × 1024, 2048 × 2048 and 4096 × 4096 pixels ... `2K` with `16:9` outputs 2720 × 1536". `guides/image-generation.md` L45 and Output Size section repeat all of it | Nothing. Every size number matches. Note the summary attributes the 1 to 300 bound to "source 07"; it is in the generations schema itself and in the guide. |
| 7 | Section 4.1 and 4.2: input text $2.30, input image $1.50, output image $3.80 per M tokens for `MiniMax-H3-Image`; $2.30 / $3.00 / $7.60 for Highspeed; example totals 1K $0.02179, 2K $0.02333, 4K $0.06879 and $0.03529 / $0.03622 / $0.13001; edits $0.02654 with one reference and $0.03563 with three | **CONFIRMED for the rates and units. The 4K example totals are quoted as current when the source now strikes them through** | `pricing/overview.md` header row: "| **Model** | **Input Text** $ / M tokens | **Input Image** $ / M tokens | **Output Image** $ / M tokens |", then L315 `MiniMax-H3-Image` Standard $2.30 / $1.50 / $3.80, L316 Highspeed $2.30 / $3.00 / $7.60. Example table L341 $0.02179, L348 $0.02333, L357 "~~$0.06879~~ **$0.03439** Limited-time 50% off", L438 $0.03529, L445 $0.03622, L454 "~~$0.13001~~ **$0.06501**", edits L367 $0.02654 (1 reference) and L393 $0.03563 (3 references) | The units are right, so cost code does not break. The 4K figures are wrong by 2x for any request that qualifies for the offer described at L309: a client that budgets $0.06879 or $0.13001 per 4K image overestimates by 100 percent while the offer runs, which at review time ends 2026-11-17 16:00 UTC. A 4K output at 4096 x 4096 is 16,777,216 px, above the 16,600,000 px threshold, so the offered sizes qualify. |
| 8 | Section 3.1 and 3.3: the H3 endpoints return a real HTTP status with an `error` envelope and no `base_resp`, while some other MiniMax endpoints return HTTP 200 with `base_resp.status_code`; `data[].error` must be inspected on every 200 | **CONFIRMED** | Specs: `base_resp` occurs 0 times in the three H3 specs and 8 times in `file/management/api/openapi.json`. Documented statuses on `/v1/images/generations`: 200, 400, 401, 402 (naming 1008, 2053, 2067, 2068), 422, 429 (naming 1002, 2056), 500. `OaiError`: `type` "Always `error`", `error` -> `OaiErrorDetail`, plus `created`, `data`, `usage`, `request_id`. `OaiErrorDetail.http_code`: `type: string`. `ImagesResponse.data.description`: "If at least one image succeeds, the HTTP status is 200 ... if all images fail, a 402, 422 or 500 error response is returned. Only successful images are charged." Live, reproduced at 06:05 UTC: `POST /v1/images/generations`, `/v1/images/edits`, `/v1/h3_image_context_ir` each returned HTTP 401 with `{"type":"error","error":{"type":"authorized_error","message":"login fail: ... (1004)","http_code":"401"},"request_id":"..."}` and no `base_resp`; `POST /v1/files/upload` and legacy `POST /v1/image_generation` each returned HTTP 200 with `{"base_resp":{"status_code":1004,...}}` | Nothing. This is the most carefully sourced section of the summary. Two nits: section 3.3 item 8 says to handle both numeric and string `http_code`, but only a string is documented and only a string was observed; and the section 1.1 wording "the edits endpoint returns 400 for `mask`" is prose from the edits page, not a schema constraint. |
| 9 | Section 1.1: "The request schema has exactly 11 properties"; `prompt` length "not documented (no length bound published)"; `disable_prompt_enhanced` "Exact type not stated in the sources; send a boolean and confirm against a live call" | **CONFIRMED for the count, REFUTED for the other two** | `H3ImageGenerationReq`: 11 properties, `required: [model, prompt]`. `properties.prompt`: `maxLength: 32000`, description "up to 32000 characters (counted as Unicode characters, excluding leading and trailing whitespace); an empty or whitespace-only prompt returns 400". `guides/image-generation.md` L24: "Prompt length | ≤ 32000 characters; with prompt enhancement disabled, only about the first 4096 tokens take effect". `properties.disable_prompt_enhanced`: `type: boolean, default: false` | A client that omits length validation accepts and sends prompts the server rejects with 400 at 32001 characters, and loses the 4096-token truncation rule that decides what the model actually reads. The boolean type is settled, so the summary's "confirm against a live call" is unnecessary work. |
| 10 | Section 2.1: on `/v1/images/edits`, "`size` / `aspect_ratio` / `area` ... the edits sources read do not list them", `output_format` "likely exists; still unconfirmed", `output_compression` "Unconfirmed for edits" | **REFUTED** | `H3ImageEditReq` and `H3ImageEditMultipartReq` both define all 11 fields: `model`, `prompt`, `images`/`image`, `n`, `size`, `aspect_ratio`, `area`, `output_format` (enum png/jpeg/jpg/webp, default jpeg), `response_format`, `stream`, `output_compression` (integer 0 to 100, default 95). Field descriptions are the same text as the generations schema. `image-generation-h3-edits.md` L343 and L531 also discuss `aspect_ratio` `auto` on both edit encodings, and its 200 example sends a `size` | This is the worst defect found. A client built to the summary ships an edit screen with no size, area, format or compression control, and its parser or request model may reject the fields as unknown. Every edit runs at the server defaults (`size: auto`, `area: 4K`, `output_format: jpeg`), which at 4096 x 4096 is the most expensive output tier and cannot be turned down. |

## 2. Contradictions between slices

1. **Error contract, slice 03 against the summary's own headline.** Slice 03's headline
   finding is "the H3 image endpoints do not use `base_resp`". The summary's section 3.1
   opens by asserting the opposite as "the required rule for this contract": that MiniMax
   reports application errors inside an HTTP 200 body via `base_resp.status_code`. It then
   exempts every endpoint the product uses. Slice 06 is the origin of the wrong
   generalisation, because `/v1/files/upload` does answer 200 plus `base_resp`. A client
   written to the first sentence will parse a `base_resp` that the two image endpoints never
   send.
2. **Parameter surface, slice 01 against slice 02.** Slice 01 lists the full 11-property
   schema for generations. Slice 02 never lists `size`, `aspect_ratio`, `area`,
   `output_format`, `response_format`, `stream` or `output_compression` for edits, even
   though `h3-image-edits.json` defines all seven with descriptions copied from the
   generations schema. Slice 02's "sources" line claims the spec was "fetched and parsed"
   and accurately quotes `required` and the 1 to 16 bounds from it, so the omission is a
   reading error, not a missing source. The summary inherits it as "not documented".
3. **4K pricing, slice 04 against the live page.** Slice 04 records 4K totals of $0.06879
   and $0.13001 as the documented example totals. The page still contains those strings but
   renders them struck through next to $0.03439 and $0.06501 under the 50 percent offer.
   The summary repeats the pre-offer numbers in section 4.2 while section 4.4 correctly
   warns that the offer exists, so the document contradicts itself on the 4K unit price.
4. **Reference limits, slice 06 against slice 02.** Slice 06 makes the upload endpoint
   enforce "1 to 16 images" as though a batch limit applied to one upload call, while its
   own gap list says multiple files per upload call are not documented and the schema
   defines a single `file` field. Slice 02 correctly treats 1 to 16 as the count across an
   edit request. The summary carries both readings without resolving which one is real.
5. **`seed`, slice 01 and slice 07 against the model card.** Slices 01 and 07 state
   absolutely that no `seed` exists anywhere. That is true of the hosted schemas and false
   of the model card, which publishes `seed` on the same two paths for the self-hosted
   serving contract. No slice cites the model card, so no slice could catch this.
6. **Code 2056, slice 03 against the M Plan pages.** Slice 03 and the summary both say to
   pause until the weekly window changes. The Error Codes page says "wait for the resource
   release in the next 5-hour window", while the M Plan Introduction says image models are
   subject only to the weekly limit. The two primary pages disagree and the summary picks
   one silently.
7. **`http_code` type.** Slice 03 quotes `http_code` without a type. The spec declares
   `type: string` and only a string was observed. The summary's instruction to handle "both
   the numeric and string forms" is an invention with no source in any slice.

## 3. Refuted or unsupported claims outside the ten

| Claim | Status | Source |
| --- | --- | --- |
| Section 1.2: `data[].error.code` is type `integer` | **REFUTED** | `ImageObject.properties.error.properties.code`: `type: string`, with values quoted as `"1027"`, `"1000"`. A client with an integer field fails to deserialize the core partial-failure path, which is the one path the summary spends section 3 defending. |
| Section 1.2: top-level `request_id` "not documented" for the non-streaming response | **REFUTED** | `ImagesResponse.properties.request_id`: `type: string`, "Request ID (the trace ID). Provide it when reporting an issue", present in the 200 example and in the live 401 body. |
| Section 1.2: `data[].size` "not documented whether this echoes `WIDTHxHEIGHT`" | **REFUTED** | `ImageObject.properties.size`: "Actual image size, formatted as `WIDTHxHEIGHT`". |
| Section 3.2: code 2013, "The sources do not state its description" | **REFUTED** | `errorcode.md`: "2013 | invalid parameters | Please check the request parameters." |
| Section 5.1: "No OpenAPI schema exists; field types come from prose on the Streaming Events page only" | **REFUTED** | `h3-image-generations.json` defines `ImageStreamEvent` (`oneOf` `ImageStreamPartialSucceeded`, `ImageStreamPartialFailed`, `ImageStreamCompleted`, `ImageStreamError`), and the 200 response declares the `text/event-stream` schema. |
| Section 5.4: Context-IR response holds `created`, `revised_prompt`, `aspect_ratio`, `usage`, `request_id`, and `total_tokens` equals `input_tokens` | **CONFIRMED** | `H3ImageContextIRResponse`: exactly those five properties. `H3ImageContextIRUsage`: `total_tokens`, `input_tokens`. Request `model` enum is `[MiniMax-H3-Image]` only. |
| Section 5.4: Highspeed "returns 400" on Context-IR | **UNSUPPORTED as stated** | The request `model` enum admits only `MiniMax-H3-Image` and the guide says "This endpoint supports `MiniMax-H3-Image` only". Rejection is implied by the enum but the 400 is never stated. |
| Section 5.4: response of Context-IR is `created`, `revised_prompt`, ... | **CONFIRMED**, but the summary omits that the Context-IR request also takes `images` (1 to 16), `size`, `aspect_ratio` and `area` | `H3ImageContextIRReq`: 6 properties, `required: [model, prompt]`. |
| Section 2.1: edits "always apply prompt enhancement" | **CONFIRMED** | `guides/image-generation.md` L197: "Image edits always apply prompt enhancement". `image-generation-h3-edits.md` L9 repeats it. Consistent with `disable_prompt_enhanced` being absent from both edit request schemas. |
| Section 1 and 2: 600 s server wait, not idempotent, retry charges again | **CONFIRMED** | `image-generation-h3-generations.md` L13 and L45, `image-generation-h3-edits.md` L13 and L46: "The server waits up to 600 seconds; set the client timeout to at least 600 seconds ... not idempotent ... a retry generates and charges again". |
| Section 5.1: 15 s keepalive | **CONFIRMED** | `image-generation-h3-streaming.md` L14: "an SSE comment line `: keepalive` is sent every 15 seconds and can be ignored; the response headers are returned with the first keepalive (about 15 seconds) at the latest". |
| Section 2.3 and 4.4: image IPM 1000 per model, text-to-image and edit share it, `n` counts as `n`, RPM and TPM unset | **CONFIRMED** | `guides/rate-limits.md`, Image table, columns RPM | TPM | IPM: `Text-to-Image / Image Edit | MiniMax-H3-Image` has IPM 1000 with RPM and TPM both shown as unset dashes; the same row shape applies to Highspeed; `H3-Image-Context-IR | MiniMax-H3-Image` has RPM 200 with TPM and IPM unset. Note text: "each have their own IPM quota; Text-to-Image and Image Edit with the same model share that model's quota, and each request counts as `n` images". |
| Section 4.4: standalone enhancement $2.30 per M input tokens, RPM 200 | **CONFIRMED** | `pricing/overview.md` L518 and L522: `H3-Image-Context-IR | $2.30`. `rate-limits.md`: RPM 200. |
| Section 4.4: 4K offer ends 2026-11-17 16:00 UTC for final images of at least 16,600,000 px | **CONFIRMED** | `pricing/overview.md` L309. |
| Section 2.1: "the edits sources read do not list" the size family | **REFUTED** | See claim 10. |

## 4. Verdict

CONTESTED. The endpoint paths, the absence of `seed` on the hosted API, the `n` range,
the reference limits, the size and megapixel rules, the token rates and units, and the
layered error-reporting rule all check out against primary sources and live probes. But
three load-bearing claims are refuted outright and one is quoted 2x high:

1. The edits endpoint does document `size`, `aspect_ratio`, `area`, `output_format`,
   `response_format`, `stream` and `output_compression`, so the summary's "not documented,
   do not expose size controls" is wrong and would ship an edit screen stuck on `4K` `jpeg`
   defaults.
2. `data[].error.code` is a **string**, not the `integer` the summary states, on the
   partial-failure path that section 3 tells every client to inspect.
3. `prompt` has a published `maxLength` of 32000 and `disable_prompt_enhanced` is a
   documented boolean defaulting to `false`, both listed as unknown.
4. The 4K example totals $0.06879 and $0.13001 are struck through in favour of $0.03439
   and $0.06501 for the qualifying sizes while the offer runs.

Fixing those four, plus restoring the documented `request_id`, `data[].size` semantics and
the 2013 description, would make the summary buildable.
