# 05 Streaming and Prompt Enhancement (MiniMax-H3-Image)

Slice: SSE streaming event names and fields, `image_index`, the `response_format` restriction, and the
H3-Image-Context-IR endpoint that returns an enhanced prompt without generating images.
API host: `https://api.minimax.io`. Models: `MiniMax-H3-Image`, `MiniMax-H3-Image-Highspeed`.

## Facts

1. Claim: `POST /v1/h3_image_context_ir` with `model` and `prompt` returns only the enhanced prompt; `MiniMax-H3-Image-Highspeed` returns 400.
   - Detail: it generates no images. The server waits up to 600 seconds, so set the client timeout to at least 600 seconds.
   - Source: https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-context-ir.json
   - Confidence: verified (OpenAPI spec)

2. Claim: Context-IR responds with `created`, `revised_prompt`, optional `aspect_ratio`, `usage` (`total_tokens` equals `input_tokens`) and `request_id`.
   - Detail: `aspect_ratio` is returned only when enhancement decides the ratio, that is `size` omitted or `auto` and `aspect_ratio` omitted or `auto`.
   - Source: https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-context-ir.json
   - Confidence: verified (OpenAPI spec)

3. Claim: `stream: true` makes both image endpoints return `text/event-stream`, and only `response_format: "url"` is allowed; `b64_json` is not supported.
   - Detail: while waiting, a `: keepalive` comment line is sent every 15 seconds and can be ignored.
   - Source: https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json
   - Confidence: verified (OpenAPI spec), keepalive from the streaming page

4. Claim: Event names are `image_generation.partial_succeeded`, `partial_failed`, `completed`, the same three with `image_edit.` for edits, and `error`.
   - Detail: each event is an `event:` line plus a JSON `data:` line, events separated by a blank line.
   - Source: https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md
   - Confidence: documented

5. Claim: `partial_succeeded` requires `type`, `image_index` (0-based, 0 to n-1) and `url`, plus `created`, `model`, `size`, `output_format`, `revised_prompt`.
   - Detail: events arrive in completion order, so match images by `image_index`, never by arrival order.
   - Source: https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md
   - Confidence: documented

6. Claim: `partial_failed` carries `type`, `image_index`, `code` (internal code, e.g. `1027`) and `message`; other images keep streaming.
   - Detail: it marks a single image that failed or was withheld by the content safety check.
   - Source: https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md
   - Confidence: documented

7. Claim: The stream ends with `completed` (`usage` plus `request_id`) or `error` (`error.http_code`; usage all zeros, not billed).
   - Detail: `completed` is the last event and is pushed only when at least one image succeeded; its `usage` holds `generated_images`, `total_tokens`, `input_tokens`, `output_tokens` and detail objects. `http_code` is 422 if all images were withheld, 402 if all failed for insufficient balance, else 500.
   - Source: https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md
   - Confidence: documented

8. Claim: Live unauthenticated POST to both endpoints returned HTTP 401 JSON with `type`, `error` and `request_id`; no 200 `base_resp` body was seen.
   - Detail: body was `{"type":"error","error":{"type":"authorized_error","message":"... (1004)","http_code":"401"},"request_id":"..."}`, for both no token and an invalid token.
   - Source: live request to https://api.minimax.io/v1/h3_image_context_ir and https://api.minimax.io/v1/images/generations, 2026-11-17
   - Confidence: verified (live request)

## Gaps

- No OpenAPI schema exists for the SSE event payloads. Event field types come from prose on the Streaming Events page only.
- The spec says `b64_json` is "not supported with streaming" but states no error code or HTTP status for that combination.
- Whether `image_index` stays stable across a retried or reconnected stream is not stated.
- Whether `completed` also carries a consolidated per-image list is not stated; only `usage` and `request_id` are listed.
- The Context-IR spec has no `stream` field, so streaming enhancement responses are undocumented, and whether they are planned is not stated.
- No SSE `id:` or `retry:` fields are described, and resuming a dropped connection is undocumented.
- Context-IR rate limits are not stated beyond generic 429 error codes (`1002` RPM, `2056` M Plan limit).
- Whether these endpoints can ever answer 200 with a `base_resp` error body was not observed; only 401 was seen.
- The Streaming Events and Context-IR `.md` URLs returned HTTP 200 with empty bodies through the fetch tool;
  content came from a direct HTTPS GET of the same URLs, so the rendered pages were not visually checked.

## Sources

- https://platform.minimax.io/docs/llms.txt (index used to locate the pages; URLs were not guessed)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-streaming.md (Streaming Events)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-context-ir.md (H3-Image-Context-IR page)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-context-ir.json (OpenAPI spec)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json (OpenAPI spec, `stream` and `response_format`)
- Live probe: https://api.minimax.io/v1/h3_image_context_ir and https://api.minimax.io/v1/images/generations (unauthenticated)
