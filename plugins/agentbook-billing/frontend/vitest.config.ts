import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Mirrors the `standardAlias` block in packages/plugin-build/src/vite.ts.
// These workspace packages ship no prebuilt dist and resolve to source at
// dev/build time via alias, not via package.json main/exports. Vitest needs
// the same aliasing or it cannot resolve them.
//
// @agentbook/i18n is aliased with its `/catalog` SUBPATH listed FIRST —
// order matters, because a bare '@agentbook/i18n' entry would also match
// '@agentbook/i18n/catalog' and send it to the wrong file. The subpath exists
// to keep the locale packs out of plugin bundles, so mis-resolving it here
// would silently test the wrong module.
export default defineConfig({
  // @ts-expect-error - vitest/vite version mismatch
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@agentbook/i18n/catalog',
        replacement: path.resolve(__dirname, '../../../packages/agentbook-i18n/src/catalog-entry.ts'),
      },
      {
        find: '@agentbook/i18n',
        replacement: path.resolve(__dirname, '../../../packages/agentbook-i18n/src/index.ts'),
      },
      {
        find: '@naap/plugin-sdk',
        replacement: path.resolve(__dirname, '../../../packages/plugin-sdk/src'),
      },
      {
        find: '@naap/plugin-utils',
        replacement: path.resolve(__dirname, '../../../packages/plugin-utils/src'),
      },
      { find: '@naap/ui', replacement: path.resolve(__dirname, '../../../packages/ui/src') },
      { find: '@naap/types', replacement: path.resolve(__dirname, '../../../packages/types/src') },
      { find: '@naap/theme', replacement: path.resolve(__dirname, '../../../packages/theme/src') },
      { find: '@naap/utils', replacement: path.resolve(__dirname, '../../../packages/utils/src') },
    ],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
