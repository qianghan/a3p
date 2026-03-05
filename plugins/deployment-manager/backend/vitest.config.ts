import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/server.ts',
        'src/store/PrismaDeploymentStore.ts',
        'src/store/IDeploymentStore.ts',
        'src/store/index.ts',
        'src/scripts/**',
        'src/types/**',
        'src/services/ArtifactRegistry.ts',
        'src/routes/artifacts.ts',
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
    },
  },
});
