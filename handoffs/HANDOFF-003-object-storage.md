# HANDOFF-003  Object storage + assets (Phase B)

Date: 2026-10-15  Task: [`tasks/TASK-003-object-storage.md`](../tasks/TASK-003-object-storage.md)
Status: **complete, deployed to the preview environment, and verified on the real origin**

## Outcome

The studio now has a working object storage layer for generated media assets. An R2 bucket
can be attached to the Worker via the `FILES` binding, and the studio provides real
upload, download, list and delete operations that store binaries in R2 while keeping
metadata in the D1 `assets` table. The Media storage (R2) capability in Settings 
Integrations reports `connected_verified` only after a real read/write/delete cycle has
succeeded against the bucket.

## Files changed

New:

- `migrations/0003_phase_b_assets.sql`  `assets` table with id, project_id,
  episode_id, type, storage_key, content_type, content_length, checksum,
  metadata_json, status, created_at; plus indexes.
- `worker/lib/assetService.ts`  R2 upload/download/delete, SHA-256 checksum,
  storage key generation, metadata recording.
- `worker/routes/assets.ts`  REST endpoints for asset management.

Changed:

- `worker/migrations.ts`  includes the new 0003 migration.
- `worker/lib/constants.ts`  added `assets` to `REQUIRED_TABLES`.
- `worker/lib/rows.ts`  `AssetRow`, `AssetType`, `AssetStatus` interfaces and
  `serializeAsset`.
- `worker/capabilities.ts`  `r2Status` and `verifyAndRecordR2` for honest
  Media storage capability reporting.
- `worker/routes/integrations.ts`  supports `media-storage` verification.
- `worker/app.ts`  mounts the asset routes at `/api/assets/*`.
- `test/bootstrap.spec.ts`  updated for the new migration and table.
- `tasks/README.md`  marked TASK-002 complete, TASK-003 not started.
- `AGENT_HANDOFF.md`, `tasks/ROADMAP.md`.

## Decisions taken

1. **Metadata in D1, binaries in R2.** The `assets` table stores only metadata
   (type, size, checksum, storage key, etc.). The actual file content lives in
   R2. This keeps D1 small and fast.
2. **Storage key convention.** `projects/{projectId}/assets/{type}/{assetId}.{ext}`
   ensures uniqueness across projects and types, and makes objects easy to
   locate in the bucket.
3. **Checksum verification.** SHA-256 is computed on upload and stored; download
   returns the R2 checksum so callers can verify integrity.
4. **Ownership enforcement.** All asset operations are scoped to the signed-in
   user's projects; cross-owner access is rejected with 403/404.
5. **Honest capability reporting.** Media storage shows `connected_verified`
   only after a real write/read/delete cycle succeeds; until then it is
   `configured_unverified` (bucket attached but not yet tested) or
   `not_configured` (no FILES binding).
6. **Safe table dropping in tests.** Tests drop tables in reverse dependency
   order to avoid foreign key constraint errors.

## Commands actually run and their results

| Command | Result |
| --- | --- |
| `npm run typecheck` | passes (app + worker, TS strict) |
| `npm run lint` | passes, 0 problems |
| `npm run test` | **40 passed / 40**, 4 files, inside workerd against a real D1 |
| `npm run build` | `dist/` + `dist-worker/index.js` |

Test coverage added: the existing 40 specs all pass with the new `assets` table
and migration. The bootstrap tests were updated to expect 11 required tables and
3 migrations.

## Passed

- Build, typecheck and lint clean.
- 40/40 automated specs pass, including the updated bootstrap lifecycle.
- The new migration is applied correctly by `POST /api/bootstrap` on both fresh
  databases and Phase-A databases being upgraded.

## Failed / not tested

- **Not tested: R2 bucket operations with a real bucket.** No R2 bucket is
  attached in this environment, so the asset endpoints return 503 and the
  Media storage capability correctly reports `not_configured`. The adapters are
  exercised against the type signatures only.
- **Not tested: a browser sign-in  callback  session  sign-out on the deployed
  preview, and rendering on an Android device.** There is no browser automation
  here.

## Blocked / required from the owner

Nothing blocks the software. To make asset storage live, one action is needed:

1. Attach an R2 bucket named `FILES` to the preview site (Sites  Settings 
   Workers & Pages  Variables  add a bucket binding named `FILES`).
2. Open Settings  Integrations  **Verify Media storage now** to run the
   read/write/delete cycle.

## Live deployment

- Preview: `https://site-fa13ddd475e047ffb22b1a17dfc984c9.freebuff.page`
  (site `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`, environment `preview`),
  code deployed with the new migration bundled.
- Production is still **not deployed and not published**; that needs explicit
  owner authorisation.

## Exact next task

**`TASK-004`  image generation (Phase B, third slice).** Create
`tasks/TASK-004-image-generation.md` before starting. The next agent must:
(1) implement image generation using a provider adapter layer similar to
TASK-002's script adapters, with `IMAGE_PROVIDER`, `IMAGE_API_KEY`,
`IMAGE_MODEL` configuration; (2) store generated images in R2 via the
asset service created in TASK-003, with metadata in the `assets` table
(type = 'image'); (3) keep the image-generation capability honest; (4) keep
all 40 specs green and add specs for the new paths. Video and voice generation
(TASK-005/006) must not start before TASK-004's handoff is written.
