/**
 * P0-9: SEO basics — sitemap of public, indexable routes.
 *
 * Only marketing/content pages are listed. Authenticated app routes
 * ((dashboard), (auth), /api, /app, /cpa-portal, /pay) are excluded here
 * and disallowed in robots.ts.
 */
import type { MetadataRoute } from 'next';

const GUIDE_SLUGS = [
  'chatbot-mcp',
  'connect-ai',
  'mcp-admin',
  'sales-rep',
  'sales-rep/earnings',
  'sales-rep/how-it-works',
  'sales-rep/materials',
  'startup-founders',
  'students',
  'workflows',
];

const STATIC_ROUTES: Array<{ path: string; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }> = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/demo', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/changelog', changeFrequency: 'weekly', priority: 0.5 },
  { path: '/guides', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/legal/terms', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/legal/privacy', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://agentbook.brainliber.com').replace(/\/$/, '');

  const guideEntries: MetadataRoute.Sitemap = GUIDE_SLUGS.flatMap((slug) => [
    {
      url: `${base}/guides/${slug}`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    },
    {
      url: `${base}/guides/zh/${slug}`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    },
  ]);

  return [
    ...STATIC_ROUTES.map((r) => ({
      url: `${base}${r.path}`,
      changeFrequency: r.changeFrequency,
      priority: r.priority,
    })),
    ...guideEntries,
  ];
}
