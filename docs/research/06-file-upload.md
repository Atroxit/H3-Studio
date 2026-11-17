# 06 File Upload (purpose image_generation_input)

Slice: the File Upload API used to stage reference images for MiniMax-H3-Image
editing, the file_id lifecycle and expiry, mm_file:// reference resolution, and
the documented size and format limits.

## Facts

1. Upload is `POST https://api.minimax.io/v1/files/upload` as
   `multipart/form-data`; the body requires `purpose` and `file`. [S1][S2]

2. A 200 body has `file` (`file_id` int64, `bytes`, `created_at` Unix seconds,
   `filename`, `purpose`) plus `base_resp` (`status_code`, `status_msg`). [S2]

3. Unauthenticated `POST /v1/files/upload` returned HTTP 200 with
   `base_resp.status_code` 1004, login fail. So check `status_code`, not HTTP
   status. [S1][live]

4. `purpose=image_generation_input` stages H3-Image edit reference images; the
   client cites them in `images[].image_url` as `mm_file://{file_id}`.
   [S1][S2][S3][S4]

5. Accepted formats: jpg, jpeg, png, webp, heic, heif at 64 MB per file.
   [S1][S2]

6. Upload validates Image Edit limits: 128 to 8192 px per side, ratio at most
   4:1, 1 to 16 images. Failing files get 400 and are not retained.
   [S1][S2][S3]

7. A `file_id` is valid for 7 days; after expiry the edit request returns file
   expired and you must re-upload. [S1][S2]

8. Edit reference bodies total at most 64 MiB, and base64 runs about 4/3 of file
   size, so docs advise URLs or `mm_file://` instead. [S3]

## Gaps

- No expiry error code or HTTP status is documented for an expired `file_id`;
  the pages only say the request "returns file expired".
- Whether the 7 day clock starts at `created_at`, at first use, or at upload
  completion is not stated.
- Whether an expired file disappears from `GET /v1/files/list` (which accepts
  `purpose=image_generation_input`) is not stated.
- Whether `mm_file://{file_id}` works in the `multipart/form-data` form of
  `/v1/images/edits`, or only in the JSON `images[].image_url` path, is not
  stated.
- Server-side heic/heif dimension parsing is stated for `video_generation_input`
  only; the same behaviour for `image_generation_input` is not spelled out.
- The schema defines a single `file` field, so whether one upload call can carry
  multiple images (repeated fields) is undocumented.
- Whether a `file_id` uploaded under another purpose can be used as an
  `image_generation_input` reference is not stated.
- No rate limit or max request body size is documented for the upload endpoint
  itself, beyond the per-file 64 MB limit.

## Sources

- [S1] Upload File, https://platform.minimax.io/docs/api-reference/file-management-upload.md
- [S2] MiniMax File Management API OpenAPI spec,
  https://platform.minimax.io/docs/api-reference/file/management/api/openapi.json
- [S3] Image Edit (MiniMax-H3-Image), https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md
- [S4] Image Generation Guide, https://platform.minimax.io/docs/guides/image-generation.md
- [live] Unauthenticated probe, `POST https://api.minimax.io/v1/files/upload`,
  observed HTTP 200 plus `base_resp.status_code` 1004 at 2026-11-17T05:0x UTC.
