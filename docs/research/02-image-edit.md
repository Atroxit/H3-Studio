# 02 Image Edit Contract (MiniMax-H3-Image)

Host: `https://api.minimax.io`. Endpoint: `POST /v1/images/edits`.
Confidence: **verified** = OpenAPI spec or live request confirms it, **documented** = a docs page states it, **inferred** = follows from several pages.

## Facts

1. `POST https://api.minimax.io/v1/images/edits` requires `model`, `prompt`, `images`; model is `MiniMax-H3-Image` or `MiniMax-H3-Image-Highspeed`. **verified**
2. JSON `images` is an array of 1 to 16 objects, each requiring `image_url` (`minItems: 1`, `maxItems: 16`). **verified**
3. `image_url` accepts a public URL, `mm_file://{file_id}` (File Upload, purpose `image_generation_input`), or `data:image/<format>;base64,<Base64>`. **documented**
4. The same path also takes `multipart/form-data` for OpenAI SDK `images.edit`: repeat `image` or `image[]`, one file each. `mask` returns 400. **verified**
5. Order is semantic: list or upload order is the Picture number, and samples address references in the prompt as image 1, image 2. **documented**
6. Per image: JPG, JPEG, PNG, WEBP, HEIC, HEIF; each at most 64 MiB; sides 128 to 8192 px; aspect ratio at most 4:1; 1 to 16 files. **verified**
7. Total request body is capped at 64 MiB; Base64 is about 4/3 of file size, so use public URLs or `mm_file://` near the cap. **documented**
8. Live unauthenticated POST returns 401, not 200: `type:error`, `error.type:authorized_error`, message ends `(1004)`, `http_code:401`. **verified**

Notes on the data URI form: `<format>` must be lowercase. Edits always apply prompt enhancement and return it in `data[].revised_prompt`.

## Gaps

- No API key exists here, so no authenticated request confirmed runtime enforcement of the 16 image cap, the 64 MiB body cap, or the dimension limits. Facts 1 to 7 rest on the spec and docs, not a successful edit.
- The pages do not say whether `mm_file://` files uploaded with purpose `image_generation_input` expire, or how long they stay referenceable.
- Whether one request may mix forms, for example some `images[].image_url` public URLs and some uploaded files, is not stated.
- Whether the 64 MiB body limit is measured before or after multipart boundaries and headers is not stated.
- Whether the OpenAI SDK `images.edit` accepts data URI strings in the `image[]` file fields is not stated.
- Whether prompt enhancement can be disabled on the edits endpoint is not stated; the guide says edits always apply it.
- Whether reference count or reference resolution affects token cost and IPM counting, beyond `usage.input_tokens_details.image_tokens`, is not stated.
- The prompt syntax expected for disambiguating up to 16 references is not formally specified beyond the two reference samples.

## Sources

- https://platform.minimax.io/docs/llms.txt (index used to locate the pages below)
- https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md (Image Edit API page; embeds the full OpenAPI 3.1.0 spec)
- https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json (standalone OpenAPI spec, fetched and parsed: 3.1.0, server `https://api.minimax.io`, required `[model, prompt, images]`, multipart required `[model, prompt, image]`, `images` and `image` both 1 to 16)
- https://platform.minimax.io/docs/guides/image-generation.md (guide: Image Edit section, three `image_url` forms, reference image limits table, 64 MiB body note)
- Live probe: `POST https://api.minimax.io/v1/images/edits` with a JSON body and no Authorization header returned HTTP 401 carrying the `authorized_error` envelope in Fact 8.
