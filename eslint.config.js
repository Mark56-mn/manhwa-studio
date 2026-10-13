import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-worker/**', 'node_modules/**', '.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Declaration merging (`declare global { namespace Cloudflare { interface Env ... } }`)
    // is only possible with an interface that may declare no members of its own.
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    files: ['worker/**/*.ts', 'test/**/*.ts', 'vite.config.ts', 'vitest.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.worker } },
  },
)
