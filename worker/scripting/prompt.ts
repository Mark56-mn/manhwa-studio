import type { CharacterRow, EpisodeRow, ProjectRow, SeasonRow } from '../lib/rows'

export interface ScriptPromptInput {
  project: ProjectRow
  episode: EpisodeRow
  season: SeasonRow | null
  characters: CharacterRow[]
  instructions: string
  maxScenes: number | null
}

export interface ScriptPrompt {
  system: string
  prompt: string
}

/** The exact JSON contract the model must return. */
export const SCRIPT_JSON_CONTRACT = `{
  "title": "episode title",
  "logline": "one sentence",
  "scenes": [
    {
      "heading": "SCENE 1 — short location/time label",
      "description": "what the viewer sees in this frame, for the artist",
      "narration": "voice-over text of this scene",
      "dialogue": [{ "speaker": "character name", "line": "spoken line" }],
      "imagePrompt": "a single-frame illustration prompt including character appearance"
    }
  ],
  "continuityNotes": "anything the next episode must remember"
}`

const SYSTEM = [
  'You are the Script AI worker inside Manhwa Studio. You write production-ready manhwa video scripts.',
  'You are given one project story bible and one episode brief. Continue that story faithfully.',
  '',
  'Rules:',
  '- Respect the continuity notes and character descriptions exactly. Never contradict an approved appearance or name.',
  '- Never invent characters that are not in the cast list or already named in the continuity notes.',
  '- Narration is read aloud by a voice actor: write natural spoken sentences, no stage directions, no camera notes.',
  '- Each scene describes one frame or a short beat an illustrator can draw.',
  '- imagePrompt must restate the relevant character appearance so art stays consistent across scenes.',
  '- Write in the project language.',
  '- Respond with a single JSON object and nothing else: no markdown, no code fences, no commentary.',
  '',
  `The JSON must match exactly this shape:\n${SCRIPT_JSON_CONTRACT}`,
].join('\n')

function bullet(label: string, value: string | null | undefined): string {
  const text = (value ?? '').trim()
  return text.length > 0 ? `- ${label}: ${text}` : `- ${label}: (not provided)`
}

export function buildScriptPrompt(input: ScriptPromptInput): ScriptPrompt {
  const { project, episode, season, characters, instructions, maxScenes } = input

  const cast = characters.length
    ? characters
        .map((character) =>
          [
            `- ${character.name} (${character.role})`,
            character.description ? `    description: ${character.description}` : '',
            character.appearance ? `    appearance: ${character.appearance}` : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        )
        .join('\n')
    : '- (no characters recorded yet)'

  const prompt = [
    'PROJECT',
    bullet('Title', project.title),
    bullet('Genre', project.genre),
    bullet('Tone', project.tone),
    bullet('Logline', project.logline),
    bullet('Language', project.language),
    '',
    'SYNOPSIS',
    project.synopsis.trim() || '(not provided)',
    '',
    'STORY BIBLE / CONTINUITY (authoritative — do not contradict)',
    project.story_bible.trim() || '(not provided)',
    '',
    'CAST',
    cast,
    '',
    'EPISODE',
    bullet('Number', String(episode.episode_number)),
    bullet('Title', episode.title),
    season ? bullet('Season', `${season.season_number}${season.title ? ` — ${season.title}` : ''}`) : '',
    season && season.summary ? bullet('Season summary', season.summary) : '',
    bullet('Brief', episode.summary),
    episode.target_duration_seconds
      ? bullet('Target length', `${episode.target_duration_seconds} seconds of finished video`)
      : '',
    maxScenes ? bullet('Scene count', `about ${maxScenes} scenes`) : '',
    '',
    'OWNER INSTRUCTIONS FOR THIS DRAFT',
    instructions.trim() || '(none)',
    '',
    'Return only the JSON object described in your instructions.',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system: SYSTEM, prompt }
}
