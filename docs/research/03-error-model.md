# 03 Error Model (MiniMax-H3-Image)

Slice: the `base_resp.status_code` catalogue, which codes are retryable, how rate
limiting and insufficient balance surface, and what 422, 402 and 500 mean for
image generation.

Headline finding: the H3 image endpoints do **not** use `base_resp`. `base_resp`
survives on the legacy `/v1/image_generation` endpoint, which is where the
"always HTTP 200" behaviour lives.

## Facts

1. H3 image endpoints never send `base_resp`. Errors use a real HTTP status plus
   `type`, `error{type,message,http_code}`, `request_id`. [S3][S4]

2. Live unauthenticated `POST /v1/images/generations` returned HTTP 401 with
   `error.type` `authorized_error` and a message ending `(1004)`. [live]

3. Legacy `POST /v1/image_generation` returned HTTP 200 with
   `base_resp.status_code` 1004 for the same auth failure, where `status_code` 0
   means success. [S6][live]

4. A single image can fail inside a 200 via `data[].error.code`, so inspect every
   item. If all images fail the call returns 402, 422 or 500. [S3][S5]

5. 402 means insufficient balance or plan quota. The internal code is in the
   trailing parenthesis of `error.message`: 1008, 2053, 2067 or 2068. [S3]

6. 429 means rate limited: 1002 (images-per-minute limit exceeded, each request
   counts as `n` images) or 2056 (M Plan usage limit reached). [S3][S2]

7. 422 means content safety rejected the work: 1026 (input or enhanced prompt
   flagged) or 1027 (generated image withheld). [S3]

8. 500 is the catch all when all images fail otherwise, e.g.
   `internal error (1000)`. Catalogue says retry later for 1000, 1001, 1024,
   1033, 1039, 2064, 2066, 2160. [S3][S1]

## Gaps

- Only 401 is live verified. Without an API key no 400, 402, 422, 429 or 500
  response shape was observed; those shapes come from the spec examples only.
- Auth is checked before body validation, so the live probe could not reach any
  parameter validation path. Whether an invalid body under a valid key returns
  400 or 422 is not live confirmed.
- The rate limit tables (RPM, TPM, IPM figures per model) render client side and
  were not captured. No numeric IPM quota is stated here.
- No `Retry-After` header appears anywhere in either H3 spec. Whether a live 429
  sends one is unverified.
- Catalogue codes to HTTP status is only partly stated for H3: 2013 to 400, 1004
  to 401, 1000 to 500. Where 1001, 1024, 1033, 1039, 2064 and 2066 land is
  undocumented.
- The code catalogue is shared across every MiniMax product, so many entries
  (1040 input audio sensitive, 1043 asr similarity, 2037 to 2054 voice codes)
  plainly cannot arise on image generation. No page marks which subset applies.
- Whether 429 concurrency codes 1045 and 2045 to 2047 can fire on image calls is
  not stated; the 429 description names only 1002 and 2056.
- Whether the streaming `error` event reuses the same `http_code` values as the
  non-streaming response is stated but not observed live.
- Whether H3 video and Context-IR endpoints still use `base_resp` is out of scope
  and unverified.

## Sources

- [S1] Error Codes, https://platform.minimax.io/docs/api-reference/errorcode
- [S2] Rate Limits, https://platform.minimax.io/docs/guides/rate-limits
- [S3] MiniMax H3-Image Generations OpenAPI spec (openapi 3.1.0, server
  `https://api.minimax.io`),
  https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json
- [S4] MiniMax Image Generation `edits` OpenAPI spec,
  https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json
- [S5] Text-to-Image (MiniMax-H3-Image),
  https://platform.minimax.io/docs/api-reference/image-generation-h3-generations
- [S6] Text to Image Generation (legacy, `image-01`),
  https://platform.minimax.io/docs/api-reference/image-generation-t2i
- [live] Two unauthenticated probes at 2026-11-17T05:02Z:
  `POST https://api.minimax.io/v1/images/generations` gave HTTP 401 with the
  `authorized_error` envelope; `POST https://api.minimax.io/v1/image_generation`
  gave HTTP 200 with `base_resp.status_code` 1004.

Note: the `.md` forms of S1 and S2 returned HTTP 200 with empty bodies, so the
HTML forms were read instead. The string `base_resp` appears zero times in both
H3 image specs S3 and S4. The H3 `/docs/api-reference/image/generation/api/openapi.json`
bundle has an empty `paths` object and carries no image endpoint definitions.
