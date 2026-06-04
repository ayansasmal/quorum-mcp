import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    exclude: ['tests/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: [
        'src/server.js',        // bundled entry point — not unit-testable
        'src/quorum-file.js',   // file I/O bootstrapper
        'src/prompts/loader.js',// prompt template loader
        'src/install/postinstall.js', // npm postinstall script
        'src/config/loader.js', // S3/file config loader — integration territory
        'src/config/migrations.js', // DB schema migrations — integration territory
      ],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 75,
        branches: 75,
        functions: 75,
      },
    },
  },
})
