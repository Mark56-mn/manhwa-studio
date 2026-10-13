import { REQUIRED_TABLES } from './lib/constants'
import initSql from '../migrations/0001_init.sql'

export interface Migration {
  /** Recorded in d1_migrations, matching what `wrangler d1 migrations` writes. */
  name: string
  sql: string
}

/** Source of truth: the SQL files in ./migrations, bundled at build time. */
export const MIGRATIONS: Migration[] = [{ name: '0001_init.sql', sql: initSql }]

/**
 * Splits a migration file into statements. D1's `exec()` cannot handle
 * multi-line statements, so statements are prepared individually and applied
 * together in one atomic batch instead. Handles `--` comments and quoted
 * strings (including escaped '' quotes).
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString = false
  let inComment = false

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index)
    const next = sql.charAt(index + 1)

    if (inComment) {
      if (char === '\n') {
        inComment = false
        current += char
      }
      continue
    }

    if (inString) {
      current += char
      if (char === "'") {
        if (next === "'") {
          current += next
          index += 1
        } else {
          inString = false
        }
      }
      continue
    }

    if (char === '-' && next === '-') {
      inComment = true
      index += 1
      continue
    }

    if (char === "'") {
      inString = true
      current += char
      continue
    }

    if (char === ';') {
      if (current.trim().length > 0) statements.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim().length > 0) statements.push(current.trim())
  return statements
}

export interface SchemaState {
  /** Tables from REQUIRED_TABLES that do not exist yet. */
  missing: string[]
  /** Migration names recorded as applied. */
  applied: string[]
  pending: string[]
}

export const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

async function tableNames(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
  return new Set((result.results ?? []).map((row) => row.name))
}

async function appliedMigrations(db: D1Database, tables: Set<string>): Promise<string[]> {
  if (!tables.has('d1_migrations')) return []
  const result = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()
  return (result.results ?? []).map((row) => row.name)
}

export async function inspectSchema(db: D1Database): Promise<SchemaState> {
  const tables = await tableNames(db)
  const applied = await appliedMigrations(db, tables)
  const missing = REQUIRED_TABLES.filter((table) => !tables.has(table))
  const pending = MIGRATIONS.filter((migration) => !applied.includes(migration.name)).map((m) => m.name)
  return { missing: [...missing], applied, pending }
}

export interface BootstrapResult {
  status: 'already_initialized' | 'initialized' | 'refused' | 'failed'
  applied: string[]
  missing: string[]
  detail: string
}

/**
 * Creates the schema in a completely empty database.
 *
 * Deliberately conservative: it only runs when none of the required tables
 * exist, it is idempotent (every statement uses IF NOT EXISTS), and it refuses
 * to touch a partially present schema so a human can look first. Progress is
 * recorded in d1_migrations, the same table `wrangler d1 migrations` uses.
 */
export async function bootstrapDatabase(db: D1Database): Promise<BootstrapResult> {
  const before = await inspectSchema(db)

  if (before.missing.length === 0) {
    return {
      status: 'already_initialized',
      applied: [],
      missing: [],
      detail: 'The database already has every required table; nothing was changed.',
    }
  }

  const present = REQUIRED_TABLES.length - before.missing.length
  if (present > 0) {
    return {
      status: 'refused',
      applied: [],
      missing: before.missing,
      detail: `The schema is partially present (${present} of ${REQUIRED_TABLES.length} tables). Automatic initialization is refused; apply migrations deliberately with wrangler d1 migrations apply, or inspect the database first.`,
    }
  }

  const pending = MIGRATIONS.filter((migration) => !before.applied.includes(migration.name))
  const applied = pending.map((migration) => migration.name)
  try {
    // One atomic batch: schema, then the migration records.
    const statements = [
      ...splitStatements(MIGRATIONS_TABLE).map((statement) => db.prepare(statement)),
      ...pending.flatMap((migration) =>
        splitStatements(migration.sql).map((statement) => db.prepare(statement)),
      ),
      ...pending.map((migration) =>
        db
          .prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, ?)')
          .bind(migration.name, new Date().toISOString()),
      ),
    ]
    await db.batch(statements)
  } catch (error) {
    return {
      status: 'failed',
      applied: [],
      missing: before.missing,
      detail: `Initialization failed (the batch is atomic, so nothing was written): ${
        error instanceof Error ? error.message : 'unknown error'
      }. It is safe to retry.`,
    }
  }

  const after = await inspectSchema(db)
  if (after.missing.length > 0) {
    return {
      status: 'failed',
      applied,
      missing: after.missing,
      detail: `Applied ${applied.length} migration(s) but ${after.missing.length} required table(s) are still missing.`,
    }
  }

  return {
    status: 'initialized',
    applied,
    missing: [],
    detail: `Created the studio schema (${applied.join(', ') || 'no migrations needed'}).`,
  }
}
