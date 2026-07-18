import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Test files matching this pattern render real PDFs via @react-pdf/renderer.
// Its yoga-layout dependency loads a wasm binary through a real `fetch()`
// call, which the "unit" project's fetch stub (setup-fetch-mock.ts) breaks
// with "Cannot read properties of undefined (reading 'then')". These files
// run as a separate project that inherits everything else from the root
// config (plugins, resolve aliases, coverage, jest-dom/Next mocks) via
// `extends: true`, but skips that one setup file.
const PDF_TEST_GLOB = 'src/**/*-pdf.test.{js,ts,jsx,tsx}';
const TEST_EXCLUDE = ['node_modules', '.next', 'dist'];

const resolveAlias = {
  '@': path.resolve(__dirname, './src'),
  '@naap/ui': path.resolve(__dirname, '../../packages/ui/src'),
  '@naap/types': path.resolve(__dirname, '../../packages/types/src'),
  '@naap/utils': path.resolve(__dirname, '../../packages/utils/src'),
  '@naap/plugin-sdk': path.resolve(__dirname, '../../packages/plugin-sdk/src'),
  '@agentbook-core': path.resolve(__dirname, '../../plugins/agentbook-core/backend/src'),
  '@agentbook/jurisdictions': path.resolve(__dirname, '../../packages/agentbook-jurisdictions/src'),
};

export default defineConfig({
  // @ts-expect-error - vitest/vite version mismatch
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // Base mocks/hygiene shared by every project. The fetch stub lives in
    // its own file (setup-fetch-mock.ts) so the "pdf" project can inherit
    // this one via `extends: true` without inheriting that stub too.
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        '.next/',
      ],
      thresholds: {
        global: {
          branches: 70,
          functions: 70,
          lines: 70,
          statements: 70,
        },
      },
    },
    alias: {
      '@/': path.resolve(__dirname, './src/'),
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          exclude: [...TEST_EXCLUDE, PDF_TEST_GLOB],
          setupFiles: ['./src/__tests__/setup-fetch-mock.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'pdf',
          include: [PDF_TEST_GLOB],
          exclude: TEST_EXCLUDE,
        },
      },
    ],
  },
  resolve: {
    alias: resolveAlias,
  },
});
