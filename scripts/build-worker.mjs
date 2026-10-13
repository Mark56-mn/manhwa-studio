// Bundles the Worker into a single ES module at dist-worker/index.js.
// Sites deploys prebuilt Workers, so the runtime never sees TypeScript.
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('dist-worker', { recursive: true, force: true })

const result = await build({
  entryPoints: ['worker/index.ts'],
  outfile: 'dist-worker/index.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser', 'import'],
  loader: { '.sql': 'text' },
  legalComments: 'none',
  logLevel: 'info',
})

if (result.errors.length > 0) process.exit(1)
