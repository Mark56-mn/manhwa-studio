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
  // ---- Unified AI provider keys (TASK-003) ------------------------------
  // Each provider reads only its own key. The legacy SCRIPT_API_KEY is honoured
  // solely for the provider explicitly selected by SCRIPT_PROVIDER.
  OPENROUTER_API_KEY?: string
  /** Default https://openrouter.ai/api/v1. */
  OPENROUTER_BASE_URL?: string
  NVIDIA_API_KEY?: string
  /** Default https://integrate.api.nvidia.com/v1. */
  NVIDIA_BASE_URL?: string
  /** Google Gemini through Google AI Studio (official Generative Language API). */
  GEMINI_API_KEY?: string
  GOOGLE_API_KEY?: string
  GEMINI_BASE_URL?: string
  BASETEN_API_KEY?: string
  /** Default https://inference.baseten.co/v1. */
  BASETEN_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  CUSTOM_API_KEY?: string
  CUSTOM_BASE_URL?: string

  // ---- Router role defaults and safety (TASK-003) -----------------------
  /** Default Director AI provider/model when no per-role setting is saved. */
  DIRECTOR_PROVIDER?: string
  DIRECTOR_MODEL?: string
  /** 'true' allows the router to use a non-free model. Default: free-only. */
  AI_ALLOW_PAID?: string
  /** Maximum provider attempts per task. Default 4. */
  AI_MAX_ATTEMPTS?: string
  /** Per-attempt provider timeout in milliseconds. Default 120000. */
  AI_TASK_TIMEOUT_MS?: string

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
