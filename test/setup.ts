import { applyD1Migrations, env } from 'cloudflare:test'

// Every test runs against a real D1 database with the project's migrations
// applied, so schema mistakes fail the test run instead of production.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
