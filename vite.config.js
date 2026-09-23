import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Absolute base, NOT './'. Routing moved off the hash onto real paths
  // (/predict/duel/ID), and a relative base would make that page ask for
  // predict/duel/assets/… - the bundle must resolve from the root no matter
  // how deep the route is.
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
