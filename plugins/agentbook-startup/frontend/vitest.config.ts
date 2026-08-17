import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Mirrors the `standardAlias` block in packages/plugin-build/src/vite.ts.
// These workspace packages ship no prebuilt dist and resolve to source at
// dev/build time via alias, not via package.json main/exports. Without this,
// StartupDiscoveryPage.test.tsx fails to load with "Failed to resolve entry
// for package @naap/plugin-sdk" — which it did, invisibly, for as long as the
// CI step masked plugin-test failures with `|| echo`.
export default defineConfig({
  // @ts-expect-error - vitest/vite version mismatch
  plugins: [react()],
  resolve: {
    alias: {
      '@naap/plugin-sdk': path.resolve(__dirname, '../../../packages/plugin-sdk/src'),
      '@naap/plugin-utils': path.resolve(__dirname, '../../../packages/plugin-utils/src'),
      '@naap/ui': path.resolve(__dirname, '../../../packages/ui/src'),
      '@naap/types': path.resolve(__dirname, '../../../packages/types/src'),
      '@naap/theme': path.resolve(__dirname, '../../../packages/theme/src'),
      '@naap/utils': path.resolve(__dirname, '../../../packages/utils/src'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
