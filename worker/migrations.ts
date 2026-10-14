import { REQUIRED_TABLES } from './lib/constants'
import initSql from '../migrations/0001_init.sql'
import phaseBSql from '../migrations/0002_phase_b_scripts.sql'
import aiRouterSql from '../migrations/0003_ai_router.sql'
import assetsSql from '../migrations/0004_assets.sql'

export interface Migration {
  /** Recorded in d1_migrations, matching what `wrangler d1 migrations` writes. */
  name: string
  sql: string
}

/** Source of truth: the SQL files in ./migrations, bundled at build time. */
export const MIGRATIONS: Migration[] = [
  { name: '0001_init.sql', sql: initSql },
  { name: '0002_phase_b_scripts.sql', sql: phaseBSql },
  { name: '0003_ai_router.sql', sql: aiRouterSql },
  { name: '0004_assets.sql', sql: assetsSql },
]

export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? 'none'

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
  /** True when d1_migrations itself exists (a database we have already run). */
  tracked: boolean
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
  return { missing: [...missing], applied, pending, tracked: tables.has('d1_migrations') }
}

export type BootstrapStatus = 'already_initialized' | 'initialized' | 'upgraded' | 'refused' | 'failed'

export interface BootstrapResult {
  status: BootstrapStatus
  applied: string[]
  missing: string[]
  recorded: string[]
  detail: string
}

/**
 * Brings the database up to date with the migrations bundled into this build.
 *
 * This exists because the deployed database cannot always be reached with the
 * wrangler CLI. It is deliberately conservative:
 *   - it only ever runs the project's own bundled migrations, never arbitrary SQL;
 *   - every statement is idempotent (`IF NOT EXISTS`), and a migration is applied
 *     in one atomic batch together with its d1_migrations row;
 *   - it refuses a schema that has tables but no migration history, or that is
 *     missing required tables no pending migration could create, so a human can
 *     look first instead of the studio guessing.
 */
export async function bootstrapDatabase(db: D1Database): Promise<BootstrapResult> {
  const before = await inspectSchema(db)
  const presentTables = REQUIRED_TABLES.length - before.missing.length

  if (!before.tracked && presentTables > 0) {
    return {
      status: 'refused',
      applied: [],
      missing: before.missing,
      recorded: before.applied,
      detail: `This database already contains ${presentTables} of ${REQUIRED_TABLES.length} studio tables but has no migration history. Automatic changes are refused; inspect it first, or run: npm run db:migrate:remote.`,
    }
  }

  if (before.pending.length === 0) {
    if (before.missing.length === 0) {
      return {
        status: 'already_initialized',
        applied: [],
        missing: [],
        recorded: before.applied,
        detail: 'The schema is up to date; nothing was changed.',
      }
    }
    return {
      status: 'refused',
      applied: [],
      missing: before.missing,
      recorded: before.applied,
      detail: `No migration is pending, yet ${before.missing.length} required table(s) are missing (${before.missing.join(', ')}). Refusing to guess; apply migrations deliberately with wrangler d1 migrations apply.`,
    }
  }

  const pending = MIGRATIONS.filter((migration) => before.pending.includes(migration.name))
  const appliedNames = pending.map((migration) => migration.name)
  const isFreshDatabase = presentTables === 0 && before.applied.length === 0

  try {
    // The history table comes first: it must exist before it can be written to.
    await db.batch(splitStatements(MIGRATIONS_TABLE).map((statement) => db.prepare(statement)))

    // One atomic batch per migration: its statements, then its history row.
    for (const migration of pending) {
      await db.batch([
        ...splitStatements(migration.sql).map((statement) => db.prepare(statement)),
        db
          .prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, ?)')
          .bind(migration.name, new Date().toISOString()),
      ])
    }
  } catch (error) {
    const after = await inspectSchema(db).catch(() => before)
    return {
      status: 'failed',
      applied: [],
      missing: after.missing,
      recorded: after.applied,
      detail: `Applying ${appliedNames.join(', ')} failed; each migration is atomic, so the failing one wrote nothing. ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    }
  }

  const after = await inspectSchema(db)
  if (after.missing.length > 0) {
    return {
      status: 'failed',
      applied: appliedNames,
      missing: after.missing,
      recorded: after.applied,
      detail: `Applied ${appliedNames.join(', ')} but ${after.missing.length} required table(s) are still missing.`,
    }
  }

  const verb = isFreshDatabase ? 'Created' : 'Upgraded'
  return {
    status: isFreshDatabase ? 'initialized' : 'upgraded',
    applied: appliedNames,
    missing: [],
    recorded: after.applied,
    detail: `${verb} the studio schema (${appliedNames.join(', ')}).`,
  }
}
