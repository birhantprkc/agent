import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // OpenTUI's native FFI only resolves under `bun test` (Bun's own runner,
    // no worker/VM isolation) — vitest, even invoked via `bun run vitest`,
    // spawns its own worker/VM context that doesn't inherit it. Component
    // tests under src/ui-opentui/ run via `bun run test:opentui` instead
    // (see package.json).
    exclude: ['**/node_modules/**', 'src/ui-opentui/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    passWithNoTests: true,
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/cli/index.ts'],
    },
  },
});
