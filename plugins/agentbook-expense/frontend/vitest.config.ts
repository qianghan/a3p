import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Mirrors the `standardAlias` block in packages/plugin-build/src/vite.ts
// (used by the real dev/build config via createPluginConfig): these
// workspace packages ship no prebuilt dist and resolve to source at
// dev/build time via alias, not via package.json main/exports. Vitest
// needs the same aliasing or it fails to resolve them.
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
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
