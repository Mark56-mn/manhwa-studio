/**
 * Parsing a language model's answer is a validation step, not a formatting
 * step. Anything that does not satisfy the contract is reported as `unparsed`
 * together with the raw text, so the owner always sees what really came back.
 */

export interface ParsedDialogueLine {
  speaker: string
  line: string
}

export interface ParsedScene {
  heading: string
  description: string
  narration: string
  dialogue: ParsedDialogueLine[]
  imagePrompt: string
}

export interface ParsedScript {
  title: string
  logline: string
  scenes: ParsedScene[]
  continuityNotes: string
}

export type ParseOutcome =
  | { ok: true; script: ParsedScript; detail: string }
  | { ok: false; detail: string }

const MAX_SCENES = 200
const MAX_TEXT = 20000

function asText(value: unknown, max = MAX_TEXT): string {
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeDialogue(value: unknown): ParsedDialogueLine[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        // Tolerate a bare string line, but do not invent a speaker.
        const line = asText(entry, 2000)
        return line ? { speaker: 'Unknown', line } : null
      }
      const speaker = asText(record.speaker ?? record.character ?? record.name, 120)
      const line = asText(record.line ?? record.text ?? record.dialogue, 2000)
      if (!line) return null
      return { speaker: speaker || 'Unknown', line }
    })
    .filter((entry): entry is ParsedDialogueLine => entry !== null)
}

/** Strips a ```json … ``` wrapper if the model added one anyway. */
function stripFence(text: string): { text: string; hadFence: boolean } {
  const trimmed = text.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  if (fence && typeof fence[1] === 'string') return { text: fence[1].trim(), hadFence: true }
  return { text: trimmed, hadFence: false }
}

export function parseScriptText(raw: string): ParseOutcome {
  if (raw.trim().length === 0) return { ok: false, detail: 'The provider returned an empty response.' }

  const { text, hadFence } = stripFence(raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return {
        ok: false,
        detail: 'The response was not JSON and contained no JSON object. The raw text is stored so nothing is lost.',
      }
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch (error) {
      return {
        ok: false,
        detail: `The response could not be parsed as JSON (${error instanceof Error ? error.message : 'unknown error'}). The raw text is stored so nothing is lost.`,
      }
    }
  }

  const root = asRecord(parsed)
  if (!root) return { ok: false, detail: 'The JSON response was not an object.' }

  const rawScenes = root.scenes
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    return { ok: false, detail: 'The JSON response had no non-empty "scenes" array.' }
  }

  const scenes: ParsedScene[] = []
  for (const entry of rawScenes.slice(0, MAX_SCENES)) {
    const record = asRecord(entry)
    if (!record) continue
    const scene: ParsedScene = {
      heading: asText(record.heading ?? record.title, 300),
      description: asText(record.description ?? record.action ?? record.visual),
      narration: asText(record.narration ?? record.voiceover ?? record.voice_over),
      dialogue: normalizeDialogue(record.dialogue ?? record.lines),
      imagePrompt: asText(record.imagePrompt ?? record.image_prompt ?? record.prompt, 4000),
    }
    if (scene.heading || scene.description || scene.narration || scene.dialogue.length > 0) scenes.push(scene)
  }

  if (scenes.length === 0) {
    return {
      ok: false,
      detail: 'The "scenes" array contained no usable scene (no heading, description, narration or dialogue).',
    }
  }

  const script: ParsedScript = {
    title: asText(root.title, 300),
    logline: asText(root.logline, 1000),
    scenes: scenes.map((scene, index) => ({
      ...scene,
      heading: scene.heading || `SCENE ${index + 1}`,
    })),
    continuityNotes: asText(root.continuityNotes ?? root.continuity_notes, 8000),
  }

  const notes = [
    hadFence ? 'recovered from a fenced code block' : null,
    scenes.length < rawScenes.length ? `${rawScenes.length - scenes.length} unusable scene(s) were dropped` : null,
  ].filter((entry): entry is string => entry !== null)

  return {
    ok: true,
    script,
    detail: notes.length > 0 ? `Parsed ${scenes.length} scene(s); ${notes.join('; ')}.` : `Parsed ${scenes.length} scene(s).`,
  }
}
