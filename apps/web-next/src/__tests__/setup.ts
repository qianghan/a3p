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

// Mock next/font/google — the real loader needs network access + a webpack
// font-loader transform that doesn't exist under vitest. Vitest validates
// mock factories against their real named exports, so a catch-all Proxy
// doesn't satisfy it — every font actually imported somewhere needs its own
// named export here.
vi.mock('next/font/google', () => {
  const fontLoader = () => ({
    className: 'mock-font-class',
    style: { fontFamily: 'mock' },
    variable: '--font-mock',
  });
  return {
    Fraunces: fontLoader,
    Newsreader: fontLoader,
    Inter: fontLoader,
    JetBrains_Mono: fontLoader,
  };
});

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
