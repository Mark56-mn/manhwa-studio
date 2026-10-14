# HANDOFF-004 — Object storage + assets (Phase B)

Date: 2026-10-13 · Task: [`tasks/TASK-004-object-storage.md`](../tasks/TASK-004-object-storage.md)
Status: **implemented and verified by automated tests (real R2 round-trip) and the local HTTP suite; not deployed from this environment**

## Outcome

The studio now has real object storage. An owner can upload a file to a project
(optionally attached to an episode), list assets, open the stored bytes and
delete them. The bytes live in the R2 bucket bound as `FILES`; the database holds
only metadata, so no binary is ever written to D1.

The **media-storage capability is honest**: `not_configured` when no bucket is
attached, `configured_unverified` when one is, and `connected_verified` only
after `POST /api/storage/verify` performs a real put → read → compare → delete
round-trip and records it in `provider_checks` (exactly like the script
capability). Attaching a bucket never shows "connected" on its own.

## Files changed

New:

- `migrations/0004_assets.sql` — the `assets` table (metadata only; unique
  `storage_key`; project/episode indexes).
- `worker/storage/service.ts` — server-generated keys, size and content-type
  limits, SHA-256 checksum, `putAsset` / `readAssetObject` / `listAssets` /
  `deleteAsset`, an orphan-safe write (object removed again if the row fails),
  and `verifyStorage` (the real round-trip).
- `worker/routes/assets.ts` — multipart upload, project/episode listing, asset
  metadata, streamed content, delete, and `POST /api/storage/verify`.
- `test/assets.spec.ts` — 11 specs against the real R2 binding.
- `src/components/AssetsPanel.tsx` — the Assets tab on a project.

Changed:

- `worker/capabilities.ts` (DB-aware, resilient media-storage status),
  `worker/routes/health.ts`, `worker/app.ts`, `worker/lib/{constants,rows}.ts`,
  `worker/migrations.ts`, `wrangler.jsonc` (R2 binding), `vitest.config.ts`
  (test R2 binding), `test/{helpers,bootstrap,projects}.spec.ts`,
  `scripts/verify-local.mjs`, `src/lib/api.ts`, `src/pages/ProjectDetail.tsx`,
  `README.md`, `docs/MASTER_BLUEPRINT.md`, `tasks/ROADMAP.md`.

## Decisions taken

1. **Metadata in D1, bytes in R2.** `assets` stores the key and the facts about
   the object; the object itself never enters a database row.
2. **Server-generated storage keys** (`projects/<projectId>/<kind>/<id>`), so a
   crafted filename cannot escape its project prefix.
3. **Object first, row second.** If the metadata insert fails, the object is
   deleted again, so a failed upload never leaves an orphan in the bucket.
4. **Per-kind limits and content-type allow-lists** (images `image/*`, audio
   `audio/*`, video `video/*`, captions text/JSON/SubRip, `other` anything), with
   a 25 MiB general ceiling and 512 KiB for captions, plus a `content-length`
   guard before the body is parsed.
5. **Deletion keeps history.** The row is marked `deleted` and the object is
   removed; the asset disappears from listings and its content 404s.
6. **Reused `provider_checks`** for the storage verification instead of a new
   table, so every capability has one honest source of truth.

## Tests actually run

```
npm run typecheck     OK (app + worker)
npm run lint          OK (0 problems)
npm run test          111 passed / 8 skipped (live) across 9 files
npm run build         OK (dist/ + dist-worker/index.js 305.4 kB)
npm run verify:local  76 passed / 0 failed (built Worker in workerd, fresh D1)
```

New coverage (`test/assets.spec.ts`, 11): real bytes stored and streamed back
with the right content type; server-generated key; listing and kind filtering;
episode attachment and listing; delete hides content and the row; unknown kind
rejected; mismatched content type rejected (415); oversized file rejected (413);
non-object metadata rejected; cross-owner isolation on read/content/delete/list/
upload; 401 without a session and 403 cross-origin; and the media-storage
capability moving from `configured_unverified` to `connected_verified` only after
a real recorded round-trip.

Two existing specs were updated for the now-attached test bucket: the
integrations-reporting spec expects `configured_unverified` (never
`connected_verified`) for media storage, and `verify-local` asserts the same.

## Not tested / blocked

- **Not deployed from this environment.** The preview bundle is unchanged, its
  database has not had `0004_assets.sql` applied, and the site does not yet
  expose the `FILES` R2 binding. `npm run verify:deployed` was **not** run.
- **No browser pass.** The new Assets tab compiles and is covered by
  typecheck/lint, but was not clicked through in a browser or on Android.
- **No live AI provider call** (unchanged from TASK-003: no keys).

## Blocked / required from the owner

To make storage live on a deployment:

1. Provision an R2 bucket and expose it to the Worker as the **`FILES`** binding
   (the local/test configs already declare it as `manhwa-studio-media`).
2. Apply the pending migration on the deployed database (`POST /api/bootstrap`).
3. Open a project → **Assets** to upload a file, or Settings → Integrations to
   see media storage become `connected_verified` after the storage check.

## Known limitations

- A 25 MiB general upload ceiling (512 KiB for captions); larger media will need
  a multipart/streaming upload path in a later task.
- No CDN, signed URLs, thumbnails or malware scanning yet; content is served to
  the signed-in owner only, with `Cache-Control: private, no-store`.
- Assets are not yet generated by an AI worker — this task stores them; TASK-005
  (image) and TASK-006 (voice) will write through this path.

## Exact next task

**`TASK-005` — image generation.** Create `tasks/TASK-005-image-generation.md`
before starting. The next agent must: (1) add an image adapter behind the TASK-003
provider interface (or a dedicated image adapter) selected by configuration, with
a real connection test and honest capability reporting; (2) generate scene art
from `scenes.image_prompt` and the story-bible continuity references, storing the
real file through the TASK-004 asset path and recording provider/model/dimensions;
(3) keep the image capability honest (`not_configured` until a real generation is
recorded); (4) keep every existing spec green and add specs for the new path. Do
not start TASK-006 before TASK-005's handoff is written.

