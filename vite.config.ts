/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    // Only the project's own suite: tool worktrees under .claude/ and gitignored scratch/ hold stale copies of tests.
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '.claude/**', 'scratch/**'],
    // Whole-battle tests take seconds each and share the CPU with the rest of the parallel run.
    testTimeout: 30000,
  },
})
