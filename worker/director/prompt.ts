import type { CharacterRow, EpisodeRow, ProjectRow, SeasonRow } from '../lib/rows'

export interface DirectorPromptInput {
  project: ProjectRow
  episode: EpisodeRow
  season: SeasonRow | null
  characters: CharacterRow[]
  instructions: string
}

export interface DirectorPrompt {
  system: string
  prompt: string
}

/** The exact JSON contract the Director AI worker must return. */
export const DIRECTOR_JSON_CONTRACT = `{
  "title": "episode working title",
  "objective": "what this episode must accomplish in the season arc",
  "beats": [
    {
      "index": 1,
      "summary": "what happens in this beat",
      "sceneIntent": "what the audience should see and feel",
      "characters": ["names of characters on screen"],
      "emotionalBeat": "the emotional turn of this beat"
    }
  ],
  "sceneCount": 6,
  "imageNotes": "art direction guidance for the illustrator",
  "voiceNotes": "narration and dialogue guidance for the voice worker",
  "continuityWatch": ["anything the next episode must remember"]
}`

const SYSTEM = [
  'You are the Director AI worker inside Manhwa Studio. You plan one episode of a manhwa video series.',
  'You are given the project story bible, the cast, and the episode brief. You do not write the script itself.',
  '',
  'Rules:',
  '- Respect the continuity notes and character descriptions exactly. Never contradict an approved appearance or name.',
  '- Plan a clear beginning, middle and turn. Every beat must move the episode forward.',
  '- The plan is consumed by the Script AI worker, so keep each beat concrete and shootable.',
  '- Respond with a single JSON object and nothing else: no markdown, no code fences, no commentary.',
  '',
  `The JSON must match exactly this shape:\n${DIRECTOR_JSON_CONTRACT}`,
].join('\n')

function bullet(label: string, value: string | null | undefined): string {
  const text = (value ?? '').trim()
  return text.length > 0 ? `- ${label}: ${text}` : `- ${label}: (not provided)`
}

export function buildDirectorPrompt(input: DirectorPromptInput): DirectorPrompt {
  const { project, episode, season, characters, instructions } = input

  const cast = characters.length
    ? characters
        .map((character) =>
          [`- ${character.name} (${character.role})`, character.description ? `    ${character.description}` : '']
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
    bullet('Brief', episode.summary),
    episode.target_duration_seconds
      ? bullet('Target length', `${episode.target_duration_seconds} seconds of finished video`)
      : '',
    '',
    'OWNER INSTRUCTIONS FOR THIS PLAN',
    instructions.trim() || '(none)',
    '',
    'Return only the JSON object described in your instructions.',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system: SYSTEM, prompt }
}
