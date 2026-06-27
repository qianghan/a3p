const path = require('path');
const { PrismaPlugin } = require('@prisma/nextjs-monorepo-workaround-plugin');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  // Monorepo: tracing root is the repo root so Next.js can find files
  // from workspace packages (e.g. @naap/database engine binaries).
  outputFileTracingRoot: path.join(__dirname, '../../'),

  // Strip build-tools, non-Linux binaries, and runtime-irrelevant heavy deps
  // from the function bundle so we stay under Vercel's 250MB cap.
  outputFileTracingExcludes: {
    '**': [
      // Cross-platform Prisma engines — keep only the Linux ones for Vercel.
      'packages/database/src/generated/client/libquery_engine-darwin-*.node',
      'packages/database/src/generated/client/libquery_engine-windows-*.node',
      'node_modules/@prisma/engines/libquery_engine-darwin-*.node',
      'node_modules/@prisma/engines/libquery_engine-windows-*.node',
      'node_modules/@prisma/engines/migration-engine-darwin-*',
      'node_modules/@prisma/engines/migration-engine-windows-*',
      // Prisma CLI — only the client is needed at runtime.
      'node_modules/prisma/build/**',
      'node_modules/prisma/preinstall/**',
      // Non-Linux Next.js SWC binaries.
      'node_modules/@next/swc-darwin-*/**',
      'node_modules/@next/swc-win32-*/**',
      'node_modules/@next/swc-linux-x64-musl/**',
      // Sharp variants for arches we don't ship to.
      'node_modules/@img/sharp-darwin-*/**',
      'node_modules/@img/sharp-win32-*/**',
      'node_modules/@img/sharp-libvips-darwin-*/**',
      'node_modules/@img/sharp-libvips-win32-*/**',
      // Build / dev toolchains — never executed at runtime.
      'node_modules/typescript/**',
      'node_modules/@swc/core-darwin-*/**',
      'node_modules/@swc/core-win32-*/**',
      'node_modules/@rspack/**',
      'node_modules/@esbuild/**',
      'node_modules/esbuild/**',
      'node_modules/vite/**',
      'node_modules/@vitejs/**',
      'node_modules/nx/**',
      'node_modules/@nx/**',
      'node_modules/@babel/**',
      'node_modules/@types/**',
      // Test runtimes / browser sims — never imported by API routes.
      'node_modules/happy-dom/**',
      'node_modules/jsdom/**',
      'node_modules/chromium-bidi/**',
      'node_modules/puppeteer/**',
      'node_modules/puppeteer-core/**',
      'node_modules/playwright/**',
      'node_modules/playwright-core/**',
      'node_modules/@playwright/**',
      // Crypto / chain libs not used by the AgentBook API surface.
      'node_modules/viem/**',
      'node_modules/ox/**',
      'node_modules/ethers/**',
      // DOM sanitizer used only in client components.
      'node_modules/isomorphic-dompurify/**',
      // Source maps and source-only files from deps.
      'node_modules/**/*.map',
      'node_modules/**/*.d.ts',
      'node_modules/**/*.md',
      'node_modules/**/*.markdown',
      'node_modules/**/LICENSE',
      'node_modules/**/LICENSE.txt',
      'node_modules/**/CHANGELOG.md',
      'node_modules/**/README.md',
      // Monorepo content that isn't function-runtime.
      'docs/**',
      'tests/**',
      'agentbook/**',
      'examples/**',
      'plugins/*/frontend/dist/**',
      'plugins/*/frontend/src/**',
    ],
  },

  // Transpile monorepo packages with TS sources.
  transpilePackages: [
    '@naap/ui',
    '@naap/types',
    '@naap/theme',
    '@naap/utils',
    '@naap/config',
    '@naap/plugin-sdk',
    '@naap/cache',
  ],

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.vercel-storage.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
  },

  webpack: (config, { isServer }) => {
    // Prisma + Next.js monorepo: PrismaPlugin places engine binaries next
    // to chunks that reference @prisma/client. This works at runtime but
    // produces ~30 duplicates of the ~16MB engine. bin/vercel-build.sh
    // runs a post-build symlink-dedup pass to reclaim the space.
    if (isServer && process.env.NODE_ENV === 'production') {
      config.plugins = [...config.plugins, new PrismaPlugin()];
    }

    // Workspace packages use the `.js` extension convention in TS source
    // (`from './foo.js'`). Webpack needs this alias to resolve to .ts/.tsx.
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
      '.jsx': ['.jsx', '.tsx'],
    };

    config.watchOptions = {
      ...(config.watchOptions || {}),
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
      ],
    };

    return config;
  },

  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  },

  async headers() {
    const allowedOrigins = [
      process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'https://naap.dev',
      'https://*.vercel.app',
    ].filter(Boolean);

    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: allowedOrigins[0] },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS,PATCH' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' },
          { key: 'Access-Control-Max-Age', value: '86400' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()' },
        ],
      },
    ];
  },

  async rewrites() {
    const rewrites = [];
    if (process.env.NODE_ENV === 'development' && process.env.LEGACY_API_PROXY === 'true') {
      const baseSvcUrl = process.env.BASE_SVC_URL || 'http://localhost:4000';
      rewrites.push({
        source: '/api/legacy/:path*',
        destination: `${baseSvcUrl}/api/:path*`,
      });
    }
    return rewrites;
  },

  // Skip type checking during build — CI runs typecheck separately.
  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },

  output: 'standalone',

  logging: {
    fetches: {
      fullUrl: true,
    },
  },
};

module.exports = nextConfig;
