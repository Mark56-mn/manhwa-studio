import { readFileSync } from 'node:fs'

import type { Plugin } from 'vite'

/**
 * Loads .sql files as text modules, so the Vite build, the vitest worker
 * bundle and the deployed Worker bundle (wrangler's Text rule) all see the
 * migration SQL the same way.
 */
export function sqlText(): Plugin {
  return {
    name: 'manhwa-sql-text',
    enforce: 'pre',
    load(id) {
      const path = id.split('?')[0] ?? id
      if (!path.endsWith('.sql')) return null
      return `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`
    },
  }
}
