import { Hono } from 'hono'

import { findCharacter, findProject, logActivity } from '../db'
import { CHARACTER_ROLES } from '../lib/constants'
import { conflict, notFound } from '../lib/errors'
import { newId } from '../lib/ids'
import { Input, readJson } from '../lib/input'
import { serializeCharacter } from '../lib/rows'
import { nowIso } from '../lib/time'

import type { CharacterRow } from '../lib/rows'
import type { AppBindings } from '../app'

const CHARACTER_FIELDS = ['name', 'role', 'description', 'appearance'] as const

export const characterRoutes = new Hono<AppBindings>()

characterRoutes.get('/projects/:projectId/characters', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const rows = await c.env.DB.prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY name')
    .bind(project.id)
    .all<CharacterRow>()
  return c.json({ characters: (rows.results ?? []).map(serializeCharacter) })
})

characterRoutes.post('/projects/:projectId/characters', async (c) => {
  const ownerId = c.get('user').sub
  const project = await findProject(c.env.DB, c.req.param('projectId'), ownerId)
  if (!project) throw notFound('Project not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(CHARACTER_FIELDS)
  const name = input.string('name', 120)
  const role = input.enum('role', CHARACTER_ROLES) ?? 'supporting'
  const description = input.optionalString('description', 20000) ?? ''
  const appearance = input.optionalString('appearance', 20000) ?? ''
  input.assertClean()

  const clash = await c.env.DB.prepare('SELECT id FROM characters WHERE project_id = ? AND name = ?')
    .bind(project.id, name)
    .first<{ id: string }>()
  if (clash) throw conflict(`A character named “${name}” already exists in this project`)

  const now = nowIso()
  const id = newId('chr')
  await c.env.DB.prepare(
    `INSERT INTO characters (id, project_id, name, role, description, appearance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, project.id, name, role, description, appearance, now, now)
    .run()

  await logActivity(c.env.DB, {
    projectId: project.id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'character.created',
    summary: `Added character “${name}” (${role}).`,
    metadata: { characterId: id },
  })

  const row = await findCharacter(c.env.DB, id, ownerId)
  if (!row) throw notFound('Character was not created')
  return c.json({ character: serializeCharacter(row) }, 201)
})

characterRoutes.patch('/characters/:characterId', async (c) => {
  const ownerId = c.get('user').sub
  const character = await findCharacter(c.env.DB, c.req.param('characterId'), ownerId)
  if (!character) throw notFound('Character not found')

  const input = new Input(await readJson(c.req.raw))
  input.rejectUnknown(CHARACTER_FIELDS)

  const updates: string[] = []
  const binds: unknown[] = []

  if (input.has('name')) {
    const name = input.string('name', 120)
    updates.push('name = ?')
    binds.push(name)
    const clash = await c.env.DB.prepare(
      'SELECT id FROM characters WHERE project_id = ? AND name = ? AND id != ?',
    )
      .bind(character.project_id, name, character.id)
      .first<{ id: string }>()
    if (clash) throw conflict(`A character named “${name}” already exists in this project`)
  }
  if (input.has('role')) {
    updates.push('role = ?')
    binds.push(input.enum('role', CHARACTER_ROLES) ?? character.role)
  }
  if (input.has('description')) {
    updates.push('description = ?')
    binds.push(input.optionalString('description', 20000) ?? '')
  }
  if (input.has('appearance')) {
    updates.push('appearance = ?')
    binds.push(input.optionalString('appearance', 20000) ?? '')
  }
  input.assertClean()

  if (updates.length === 0) return c.json({ character: serializeCharacter(character) })

  const now = nowIso()
  await c.env.DB.prepare(`UPDATE characters SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...binds, now, character.id)
    .run()

  await logActivity(c.env.DB, {
    projectId: character.project_id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'character.updated',
    summary: `Updated character “${character.name}”.`,
    metadata: { characterId: character.id },
  })

  const row = await findCharacter(c.env.DB, character.id, ownerId)
  if (!row) throw notFound('Character not found')
  return c.json({ character: serializeCharacter(row) })
})

characterRoutes.delete('/characters/:characterId', async (c) => {
  const ownerId = c.get('user').sub
  const character = await findCharacter(c.env.DB, c.req.param('characterId'), ownerId)
  if (!character) throw notFound('Character not found')

  await c.env.DB.prepare('DELETE FROM characters WHERE id = ?').bind(character.id).run()
  await logActivity(c.env.DB, {
    projectId: character.project_id,
    actorType: 'owner',
    actorId: ownerId,
    eventType: 'character.deleted',
    summary: `Removed character “${character.name}”.`,
    metadata: { characterId: character.id },
  })
  return c.body(null, 204)
})
