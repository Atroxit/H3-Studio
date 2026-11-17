# 01 Text-to-Image: request and response contract

Slice: `POST /v1/images/generations` on MiniMax-H3-Image. Extracted from the
published docs plus the OpenAPI 3.1.0 spec, and one unauthenticated live probe.

## Facts

1. Endpoint is `POST https://api.minimax.io/v1/images/generations` with bearer
   auth; `model` (`MiniMax-H3-Image` or `MiniMax-H3-Image-Highspeed`, identical
   parameters) and `prompt` are the only required fields. A live unauthenticated
   POST returned HTTP 401 `authorized_error` code `1004`, with no `base_resp`.
   Source: api-reference md + live probe. Confidence: verified.

2. The request schema has exactly 11 properties and no `seed`: `model`, `prompt`,
   `disable_prompt_enhanced`, `n`, `size`, `aspect_ratio`, `area`,
   `output_format`, `response_format`, `stream`, `output_compression`.
   Source: h3-image-generations.json `H3ImageGenerationReq`. Confidence: verified.

3. `n` is an integer with minimum 1, maximum 10, default 1. Each request counts
   as `n` images against the images-per-minute limit.
   Source: OpenAPI spec `n` + 429 doc. Confidence: verified.

4. `size` accepts `WIDTHxHEIGHT` (e.g. `2720x1536`) with area between 655,360 and
   20,000,000 px and aspect ratio between 1:3 and 3:1, bounds inclusive;
   otherwise 400, and the size is never scaled or rounded.
   Source: api-reference md `size`. Confidence: documented.

5. With `size` omitted or `auto` (the default), `aspect_ratio` (default `auto`)
   and `area` (`1K`/`2K`/`4K`, default `4K`) derive width and height; `2K` at
   `16:9` yields `2720x1536`. Setting either one while `size` is `WIDTHxHEIGHT`
   returns 400, even when set to `auto`.
   Source: api-reference md `size`, `area`. Confidence: documented.

6. `response_format` is `url` (default) or `b64_json`; `b64_json` is not
   supported with `stream` and is capped by total area (`n` x width x height):
   20,000,000 px for `png`, 80,000,000 px for `jpeg`/`webp`, else 400.
   Source: api-reference md `response_format`. Confidence: documented.

7. `data` always holds `n` items in image order: successes carry `url` (or
   `b64_json`), `size` and `revised_prompt`; failures carry only
   `error{code,message}`. HTTP is 200 if at least one image succeeds, so check
   every `data[].error`.
   Source: `ImagesResponse.data`, `ImageObject`. Confidence: documented.

8. `usage` reports `generated_images` (may be less than `n`), `total_tokens`
   (= `input_tokens` + `output_tokens`), `input_tokens_details{text_tokens,
   image_tokens}` (image tokens are 0 for text-to-image) and
   `output_tokens_details{image_tokens}`. Only successful images are billed.
   Source: `ImageUsage`. Confidence: documented.

## Gaps

- `seed`: the request schema has no `seed` property and no page in this slice
  describes determinism or reproducibility. Whether an unknown field such as
  `seed` is rejected or silently ignored is not stated, and the live probe
  stops at 401 before parameter validation, so it cannot be tested without a key.
- Default `model`: `model` is required, but no default model is documented.
- Full per-image `error.code` list: only "common values" (1000, 1001, 1008, 1026,
  1027) appear in this slice; the complete list lives on the Error Codes page,
  which was not part of this slice.
- URL lifetime: the docs say the returned URL "is not guaranteed to remain
  available" but state no TTL, so a client cannot know how soon to download.
- `png` with `n` > 1: the b64 table example says "1 image of any size" for the
  20,000,000 px `png` cap; whether several small `png` images fit under that cap
  is not explicitly stated.
- `revised_prompt` when enhancement is on but fails: code 1026 covers an enhanced
  prompt failing the safety check, but what `revised_prompt` holds in that case
  is not described.
- Also documented on the same page but outside this slice: the server waits up
  to 600 s, the endpoint is not idempotent, and a retry charges again.

## Sources

- https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md
  (primary reference; embeds the OpenAPI definition, error examples, streaming)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json
  (OpenAPI 3.1.0 spec: request schema, response schemas, error responses)
- https://platform.minimax.io/docs/guides/image-generation.md
  (guide: model specs, Output Size, Prompt Enhancement, Partial Failures)
- Live probe: unauthenticated `POST https://api.minimax.io/v1/images/generations`
  returned HTTP 401 with `{"type":"error","error":{"type":"authorized_error",
  "message":"login fail: Please carry the API secret key in the 'Authorization'
  field of the request header (1004)","http_code":"401"},"request_id":"..."}`
