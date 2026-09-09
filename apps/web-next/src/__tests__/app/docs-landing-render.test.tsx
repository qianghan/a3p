import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocsLanding } from '@/components/docs/docs-landing';
import { DocsSidebarProvider } from '@/components/docs/docs-sidebar-context';
import { DOCS_LANDING } from '@/lib/docs/landing';

/**
 * The mobile sidebar reads context the docs LAYOUT provides, so the landing
 * is wrapped here the same way the layout wraps it. Wrapped rather than
 * mocked: a stub would also have hidden the fact that the real sidebar
 * renders navigation in the right locale.
 */
const renderLanding = (locale: 'en' | 'zh') =>
  render(<DocsSidebarProvider><DocsLanding locale={locale} /></DocsSidebarProvider>);

/**
 * Render the landing and read what a person would read.
 *
 * The catalog tests prove the Chinese strings EXIST. That is not the same as
 * the page showing them: this repo has shipped translation work where every
 * static guard was green and the page in front of the user was still English,
 * because the wiring — not the content — was the missing part. So this
 * renders the component and asserts on the DOM.
 */

// next/link renders an <a>; the sidebar reads the content tree at module load,
// which is fine here — these are the real navigation and the real copy.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

describe('the Chinese landing renders in Chinese', () => {
  it('shows the translated hero and every translated section title', () => {
    renderLanding('zh');
    const zh = DOCS_LANDING.zh;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh.heroTitle);
    for (const s of zh.sections) {
      // getAllByText, not getByText: the sidebar renders the same section
      // labels — which is itself worth knowing, since it means the sidebar
      // is translated too and not quietly English beside a Chinese page.
      expect(screen.getAllByText(s.title).length, `missing section: ${s.title}`).toBeGreaterThan(0);
    }
    for (const p of zh.popular) {
      expect(screen.getAllByText(p.label).length, `missing link: ${p.label}`).toBeGreaterThan(0);
    }
  });

  it('shows no English section title on the Chinese page', () => {
    // The specific failure worth catching: a section added in English and
    // rendered untranslated, which a key-existence check cannot see.
    const { container } = renderLanding('zh');
    const text = container.textContent ?? '';
    for (const s of DOCS_LANDING.en.sections) {
      expect(text, `English leaked into the zh landing: "${s.title}"`).not.toContain(s.title);
    }
    expect(text).not.toContain(DOCS_LANDING.en.heroTitle);
  });

  it('links from the Chinese landing stay inside /docs/zh', () => {
    // A translated page whose links all go to English is worse than no
    // translation: the reader clicks once and is back where they started.
    const { container } = renderLanding('zh');
    const hrefs = [...container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('/docs/') && h !== '/docs');
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) {
      expect(h, `escapes the zh tree: ${h}`).toMatch(/^\/docs\/zh(\/|$)/);
    }
  });

  it('offers a way back to English, labelled in English', () => {
    const { container } = renderLanding('zh');
    const back = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/docs');
    expect(back).toBeTruthy();
    // The label is in the language being switched TO, so a reader who cannot
    // read the current page can still find the way out.
    expect(back!.textContent).toContain('English');
  });

  it('the English landing is unchanged and links to the English tree', () => {
    const { container } = renderLanding('en');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(DOCS_LANDING.en.heroTitle);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.startsWith('/docs/setup/'))).toBe(true);
    expect(hrefs.filter((h) => h.startsWith('/docs/zh/')).length).toBe(0);
  });
});
