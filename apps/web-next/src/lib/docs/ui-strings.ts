import type { DocLocale } from './content';

/**
 * The docs chrome, per locale.
 *
 * A fully translated page still reads as half-finished when the furniture
 * around it — "On this page", "Next", the breadcrumb — stays in English. These
 * are the only chrome strings the docs render; keeping them in one map means
 * adding a locale is one object, not a hunt through three components.
 */
export const DOCS_UI: Record<DocLocale, {
  home: string; onThisPage: string; previous: string; next: string;
  search: string; backToApp: string; backToAppShort: string;
}> = {
  en: {
    home: 'Docs', onThisPage: 'On this page', previous: 'Previous', next: 'Next',
    search: 'Search docs...', backToApp: 'Back to the app', backToAppShort: 'Back to App',
  },
  zh: {
    home: '文档', onThisPage: '本页内容', previous: '上一篇', next: '下一篇',
    search: '搜索文档…', backToApp: '返回应用', backToAppShort: '返回应用',
  },
};
