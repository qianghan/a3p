/**
 * P0-9: SEO basics — crawler rules.
 *
 * Public marketing/content routes are crawlable. Everything behind auth
 * (API, app dashboard, CPA portal, checkout) is disallowed.
 */
import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://agentbook.brainliber.com').replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/app/', '/cpa-portal/', '/pay/', '/settings/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
