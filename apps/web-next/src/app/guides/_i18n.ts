/**
 * Locale for the marketing guides.
 *
 * English lives at /guides/… and Chinese at /guides/zh/…, the same URL shape
 * the documentation uses. These pages are React rather than MDX, so there is
 * no content tree to mirror: each guide has a translated twin under zh/ that
 * shares this layout, guides.css, and the interactive components. The prose is
 * duplicated because prose in two languages IS two pieces of prose; the
 * structure, styling and behaviour are not.
 *
 * GUIDE_ROUTES is the single list of what exists. The parity test walks it, so
 * adding an English guide without a Chinese twin fails CI rather than dropping
 * a reader onto a 404 from the language switcher.
 */

export type GuidesLocale = 'en' | 'zh';

/** Every guide, keyed by the path after /guides. '' is the index. */
export const GUIDE_ROUTES = [
  '',
  'chatbot-mcp',
  'workflows',
  'students',
  'sales-rep',
  'sales-rep/how-it-works',
  'sales-rep/materials',
  'sales-rep/earnings',
  'startup-founders',
] as const;

export function guidesLocaleOf(pathname: string): GuidesLocale {
  return /^\/guides\/zh(\/|$)/.test(pathname) ? 'zh' : 'en';
}

/** URL for a guide in a given language. */
export function guidesHref(route: string, locale: GuidesLocale): string {
  const base = locale === 'zh' ? '/guides/zh' : '/guides';
  return route ? `${base}/${route}` : base;
}

/** The counterpart URL of the page being viewed, and the language it is in. */
export function guidesCounterpart(pathname: string): { href: string; to: GuidesLocale } {
  const locale = guidesLocaleOf(pathname);
  const route = pathname.replace(/^\/guides(\/zh)?\/?/, '').replace(/\/+$/, '');
  const to: GuidesLocale = locale === 'en' ? 'zh' : 'en';
  return { href: guidesHref(route, to), to };
}

/**
 * Chrome shared by every guide page.
 *
 * Plain strings only — the footer's two links are JSX, so its sentence is
 * split around them rather than smuggling markup through here.
 */
export const GUIDES_UI: Record<GuidesLocale, {
  allGuides: string;
  getStarted: string;
  back: string;
  switchTo: string;
  switchLabel: string;
  footerPre: string;
  footerApp: string;
  footerOr: string;
  footerRegister: string;
  footerPost: string;
}> = {
  en: {
    allGuides: 'All guides',
    getStarted: 'Get started',
    back: '← All guides',
    // The label is written in the language being switched TO — a reader who
    // cannot read this page still has to be able to read the way out.
    switchTo: '中文',
    switchLabel: '切换到中文',
    footerPre: 'Need more? Open the ',
    footerApp: 'app',
    footerOr: ' or ',
    footerRegister: 'create an account',
    footerPost: '. Every guide takes 2–3 minutes.',
  },
  zh: {
    allGuides: '全部指南',
    getStarted: '立即开始',
    back: '← 返回全部指南',
    switchTo: 'English',
    switchLabel: 'Switch to English',
    footerPre: '还需要帮助？打开',
    footerApp: '应用',
    footerOr: '，或者',
    footerRegister: '注册账户',
    footerPost: '。每篇指南只需 2–3 分钟。',
  },
};
