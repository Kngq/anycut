import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Dedicated test config: vite.config.ts pulls in the Electron build plugins, which aren't needed
// (and try to spawn Electron) for unit tests. Covers renderer/shared AND main-process pure logic.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts']
  }
})
