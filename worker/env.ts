export interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  FREEBUFF_CLIENT_ID: string
  FREEBUFF_ISSUER?: string
  APP_ORIGIN: string
  APP_VERSION?: string

  // ---- Phase B/C/D provider configuration -------------------------------
  // None of these are required: every capability reports honestly when its
  // variables are absent, and no secret is ever sent to the browser.

  /** Script AI (implemented). `openai` | `openrouter` | `anthropic` | `google` | `custom`. */
  SCRIPT_PROVIDER?: string
  SCRIPT_API_KEY?: string
  SCRIPT_MODEL?: string
  /** Only for SCRIPT_PROVIDER=custom (an OpenAI-compatible endpoint). */
  SCRIPT_BASE_URL?: string
  /** Upper bound on generated script length. */
  SCRIPT_MAX_OUTPUT_TOKENS?: string
  /** Convenience aliases accepted in place of SCRIPT_API_KEY. */
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GOOGLE_API_KEY?: string
  GEMINI_API_KEY?: string
  OPENROUTER_API_KEY?: string

  /** Image AI (TASK-004 — no adapter in this build yet). */
  IMAGE_PROVIDER?: string
  IMAGE_API_KEY?: string
  IMAGE_MODEL?: string

  /** Voice AI (TASK-005 — no adapter in this build yet). */
  VOICE_PROVIDER?: string
  VOICE_API_KEY?: string
  VOICE_VOICE_ID?: string

  /** Video renderer (Phase C). */
  RENDER_WORKER_URL?: string
  RENDER_WORKER_TOKEN?: string

  /** YouTube publishing (Phase D). */
  YOUTUBE_CLIENT_ID?: string
  YOUTUBE_CLIENT_SECRET?: string
  YOUTUBE_REFRESH_TOKEN?: string

  /** Object storage for generated media (TASK-003). */
  FILES?: R2Bucket
}
