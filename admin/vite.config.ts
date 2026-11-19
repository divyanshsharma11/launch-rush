import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The backend serves the built page at /admin/ (src/controllers/admin-page.js), so every asset URL starts there.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
