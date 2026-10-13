export interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  FREEBUFF_CLIENT_ID: string
  FREEBUFF_ISSUER?: string
  APP_ORIGIN: string
  APP_VERSION?: string
  // Planned Phase B/C/D provider configuration. None of these are required by
  // this build; capability status reports honestly when they are absent.
  SCRIPT_PROVIDER?: string
  SCRIPT_API_KEY?: string
  SCRIPT_MODEL?: string
  IMAGE_PROVIDER?: string
  IMAGE_API_KEY?: string
  IMAGE_MODEL?: string
  VOICE_PROVIDER?: string
  VOICE_API_KEY?: string
  VOICE_VOICE_ID?: string
  RENDER_WORKER_URL?: string
  RENDER_WORKER_TOKEN?: string
  YOUTUBE_CLIENT_ID?: string
  YOUTUBE_CLIENT_SECRET?: string
  YOUTUBE_REFRESH_TOKEN?: string
}
