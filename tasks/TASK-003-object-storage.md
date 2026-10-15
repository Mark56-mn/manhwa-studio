# TASK-003  Object storage + assets (Phase B)

## 1. Objective

Provision R2 object storage for the deployed environment, add an `assets` table to
record metadata about generated media (never store binaries in D1), and implement
real upload/read paths that exercise the bucket binding end to end. This unblocks
TASK-004 (image generation) which needs somewhere to store the generated images.

## 2. Current verified repository state (before this task)

- Phase A deployed and verified: Worker (Hono) + React 19 SPA + D1 + Sign in
  with Freebuff. See `handoffs/HANDOFF-001-online-foundation.md`.
- Phase B TASK-002 complete and verified: multi-provider adapter layer
  (`openai`, `openrouter`, `anthropic`, `google`, `custom`), real provider
  verification recorded in `provider_checks`, immutable `script_versions` with
  parsed `scenes`, append-only `script_approvals`, episode workspace UI.
  See `handoffs/HANDOFF-002-provider-and-script.md`.
- `npm run verify` = typecheck + lint + test + build, all green.
- 40 vitest specs inside workerd against a real D1.
- The `FILES` binding is declared in `worker/env.ts` but not yet used anywhere.
- `mediaStorageStatus()` in `worker/capabilities.ts` reports `not_configured`
  when the binding is absent and `configured_unverified` when it is attached.
- No `assets` table exists; no migration includes one yet.

## 3. User-facing outcome

- Settings  Integrations: Media storage (R2) capability shows
  `connected_verified` once the bucket is attached and a real read/write cycle
  has succeeded.
- The studio can upload a file to R2 and retrieve it by its storage key, with
  metadata recorded in the `assets` table.
- Every asset row references its project, episode and type, with a
  `storage_key` that is the R2 object key.

## 4. Relevant files and components

New:

- `migrations/0003_phase_b_assets.sql`  `assets` table (id, project_id, episode_id,
  type, storage_key, content_type, content_length, checksum, metadata_json,
  status, created_at).
- `worker/routes/assets.ts`  upload asset, list assets, get asset metadata,
  delete asset, download asset.
- `worker/lib/assetService.ts`  R2 upload/download/delete with proper
  content-type and metadata.
- `src/lib/api.ts`  client functions for asset endpoints.
- `test/assets.spec.ts`  specs for upload, list, get, delete, download.

Changed:

- `worker/lib/constants.ts`  add `REQUIRED_TABLES` entry for `assets`.
- `worker/lib/rows.ts`  `AssetRow` interface and `serializeAsset`.
- `worker/migrations.ts`  include the new migration.
- `worker/capabilities.ts`  `mediaStorageStatus` performs a real
  read/write test and records the result.
- `worker/app.ts`  route mounting for `/api/assets/*`.
- `src/App.tsx`, `src/lib/router.tsx`  route for asset management UI.
- `worker/env.ts`  no change (FILES binding already declared).
- `tasks/ROADMAP.md`, `AGENT_HANDOFF.md`, `tasks/README.md`.

## 5. Required implementation

1. **Migration `0003_phase_b_assets.sql`.** Adds the `assets` table with:
   - `id` primary key
   - `project_id` foreign key to projects
   - `episode_id` optional foreign key to episodes
   - `type` (image, audio, video, script, other)
   - `storage_key` (R2 object key, unique)
   - `content_type` (MIME type)
   - `content_length` (bytes)
   - `checksum` (SHA-256 of the content)
   - `metadata_json` (arbitrary JSON for provider/model/dimensions/etc.)
   - `status` (uploading, uploaded, failed)
   - `created_at`
   Indexes on `(project_id, created_at DESC)` and `(storage_key)`.

2. **Asset service.** `worker/lib/assetService.ts` with:
   - `uploadAsset(env, projectId, episodeId, type, contentType, body, metadata)`
     generates a storage key, computes SHA-256, uploads to R2, inserts row.
   - `downloadAsset(env, storageKey)` downloads from R2.
   - `getAsset(db, id)` reads the row.
   - `listAssets(db, projectId)` lists assets for a project.
   - `deleteAsset(env, db, id)` deletes from R2 and D1.

3. **Asset routes.** `worker/routes/assets.ts`:
   - `POST /api/projects/:projectId/assets/upload`  multipart or raw body
   - `GET /api/projects/:projectId/assets`  list
   - `GET /api/assets/:id`  metadata
   - `GET /api/assets/:id/download`  download
   - `DELETE /api/assets/:id`  delete

4. **Media storage verification.** Extend `mediaStorageStatus` to perform a
   real write/read/delete cycle on the attached bucket and record the result in
   `provider_checks` (capability = 'media-storage', provider = 'r2'). Only then
   does the capability become `connected_verified`.

5. **Ownership enforcement.** All asset operations are scoped to the owner's
   projects; cross-owner reads/deletes return 404.

6. **Honest failure.** If the FILES binding is absent, the capability reports
   `not_configured` and asset endpoints return 503. If the binding exists but
   operations fail, the capability reports `failed` with the actual error.

## 6. Explicit non-goals

- Image generation itself (TASK-004). This task only provides the storage that
  TASK-004 will write to.
- Voice and video generation (TASK-005/006).
- Public/private access control on the bucket (every object is private; the
  Worker is the only reader/writer).
- Bucket lifecycle policies or CORS.
- Streaming uploads.

## 7. Acceptance criteria

1. `npm run typecheck`, `npm run lint`, `npm run build` all pass.
2. `npm run test` passes, including new specs covering:
   - upload with metadata insertion, list, get, download, delete
   - cross-owner isolation on every asset endpoint
   - 503 when FILES binding is absent
   - media storage capability reports `not_configured` without binding,
     `configured_unverified` with binding attached but not yet tested,
     `connected_verified` after a real read/write cycle
   - idempotent uploads (same storage_key refused or overwritten based on
     configuration decision  default: refuse duplicate storage_key)
3. Deployed preview: `/api/health` reports `ready` with the new `assets` table
   present; `/api/integrations` reports Media storage as `connected_verified`
   once the bucket is attached and a verification cycle runs.
4. Existing 40 specs stay green.
5. No secret value is committed, logged or returned to the browser.
6. `POST /api/bootstrap` applies the new migration to an existing Phase-B
   database and still refuses inconsistent states.

## 8. Commands and tests to run

```
npm run typecheck
npm run lint
npm run test
npm run build
npm run db:migrate:local      # applies 0003 locally
node scripts/verify-local.mjs  # 54+ HTTP checks on built Worker in workerd
```

## 9. Deployment or environment dependencies

- An R2 bucket named `FILES` attached to the Worker (binding name `FILES`).
- The bucket must exist before the Worker can use it; the Worker only
  reads/writes, it does not create the bucket.
- No additional secrets are required for R2 access within Cloudflare.

## 10. Risks and fallback decisions

- **R2 not available in the build environment.** Mitigation: the code
  detects the absence of the FILES binding and reports `not_configured`; all
  asset routes return 503. This keeps the software working without R2.
- **Bucket name collision.** Mitigation: the storage_key is prefixed with
  `projects/{projectId}/assets/` to avoid collisions across projects.
- **Large file uploads timing out.** Mitigation: the Worker has a generous
  timeout, but very large files should be streamed in Phase C; this task
  assumes files fit in memory for simplicity.
- **Checksum mismatch on download.** Mitigation: the checksum is computed on
  upload and verified on download; a mismatch is reported as `failed` and the
  asset row is marked accordingly.
