import { vi } from 'vitest';

// Mock fetch for API tests. Kept out of setup.ts so the "pdf" Vitest project
// (real PDFs via @react-pdf/renderer, which needs a real fetch() to load
// yoga-layout's wasm binary) can inherit the rest of setup.ts via `extends`
// without also inheriting this stub.
global.fetch = vi.fn();
