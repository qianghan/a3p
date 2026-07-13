import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // @ts-expect-error - vitest/vite version mismatch
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: ['node_modules', '.next', 'dist'],
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
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@naap/ui', replacement: path.resolve(__dirname, '../../packages/ui/src') },
      { find: '@naap/types', replacement: path.resolve(__dirname, '../../packages/types/src') },
      { find: '@naap/utils', replacement: path.resolve(__dirname, '../../packages/utils/src') },
      { find: '@naap/plugin-sdk', replacement: path.resolve(__dirname, '../../packages/plugin-sdk/src') },
      { find: '@agentbook-core', replacement: path.resolve(__dirname, '../../plugins/agentbook-core/backend/src') },
      // Scoped-package alias ('@agentbook/jurisdictions') needs an explicit
      // wildcard regex — unlike the bare '@agentbook-core' key above, Vite's
      // plain-object alias form does NOT prefix-match keys that contain a
      // slash, so 'src/interfaces' subpaths from
      // '@agentbook/jurisdictions/interfaces' etc. were silently unresolved.
      { find: /^@agentbook\/jurisdictions$/, replacement: path.resolve(__dirname, '../../packages/agentbook-jurisdictions/src/index.ts') },
      { find: /^@agentbook\/jurisdictions\/(.*)$/, replacement: path.resolve(__dirname, '../../packages/agentbook-jurisdictions/src/$1') },
    ],
  },
});
