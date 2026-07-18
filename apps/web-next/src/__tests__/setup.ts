import '@testing-library/jest-dom';
import { vi, beforeEach, afterEach } from 'vitest';

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Mock Next.js image component
vi.mock('next/image', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  default: function MockImage(props: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createElement } = require('react');
    return createElement('img', props);
  },
}));

// Mock fetch for API tests. Default to a rejected promise (not a bare vi.fn(), which
// returns undefined) so any unmocked call still gets promise-like behavior — this is what
// lets @react-pdf/renderer's yoga-wasm dependency fall back to its synchronous wasm decode
// instead of crashing on `fetch(...).then` where `.then` is read off `undefined`.
global.fetch = vi.fn().mockRejectedValue(new Error('fetch is not mocked in this test'));

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after tests
afterEach(() => {
  vi.restoreAllMocks();
});
