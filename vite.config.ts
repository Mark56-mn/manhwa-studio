import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { sqlText } from './vite.sql-plugin'

// Vite serves the studio shell during development and bundles it into ./dist
// for deployment. API and auth requests are proxied to the local Worker so the
// browser talks to a single origin, exactly like production.
export default defineConfig({
  plugins: [sqlText(), react()],
  server: {
    port: 3000,
    strictPort: true,
    host: true,
    allowedHosts: [
      'pv-07a6237c3bda-49021fde-fccc-49a9-8b9b-2d0c9f827103.style.dev',
      ...(process.env.VITE_EXTRA_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []),
    ],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/auth/freebuff': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
