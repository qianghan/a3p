import type { DocLocale } from './content';

/**
 * The docs landing page, per locale.
 *
 * These strings used to be hardcoded arrays inside `app/docs/page.tsx`, which
 * is why `/docs/zh` had no landing at all: there was nothing to translate it
 * into, so the route redirected a Chinese reader straight past the front door
 * and into a quickstart. Every page BEHIND the landing was already translated
 * — the one thing missing was the page that tells you what is there.
 *
 * `href`s are locale-bare and prefixed at render time by `localeHref`, so a
 * translated landing cannot accidentally link back into the English tree.
 */

export interface LandingSection {
  /** Matches the `icon` map in the landing component. */
  icon: 'rocket' | 'settings' | 'sparkles' | 'map' | 'lifebuoy';
  title: string;
  description: string;
  /** Path WITHOUT the /docs prefix or the locale segment. */
  path: string;
}

export interface LandingCopy {
  heroTitle: string;
  heroBody: string;
  popularLabel: string;
  explore: string;
  sections: LandingSection[];
  popular: { label: string; path: string }[];
}

export const DOCS_LANDING: Record<DocLocale, LandingCopy> = {
  en: {
    heroTitle: 'Guides for getting the most out of AgentBook',
    heroBody:
      'Everything you need to set up, configure, and run your books — no accounting knowledge required. Prefer to just ask? The agent answers most of this in chat.',
    popularLabel: 'Popular',
    explore: 'Explore',
    sections: [
      { icon: 'rocket', title: 'Set up', description: 'Create your account, connect a bank, and record your first expense in minutes.', path: 'setup/quickstart' },
      { icon: 'settings', title: 'Configure', description: 'Business profile, accounting basis, bank sync, your accountant, Telegram & alerts.', path: 'configure/business-profile' },
      { icon: 'sparkles', title: 'Working day-to-day', description: 'Expenses, invoices, reports & tax, and getting the most from the agent.', path: 'working/expenses-and-receipts' },
      { icon: 'map', title: 'Regions & taxes', description: "What's supported in the US, Canada, and Australia — and what's different per country.", path: 'regions/overview' },
      { icon: 'lifebuoy', title: 'Troubleshooting', description: 'Bank sync, fixing a category, and sign-in — quick fixes for common snags.', path: 'troubleshooting/bank-not-syncing' },
    ],
    popular: [
      { label: 'Get started in five minutes', path: 'setup/quickstart' },
      { label: 'Which countries does AgentBook support?', path: 'regions/overview' },
      { label: 'AgentBook for students', path: 'setup/for-students' },
      { label: 'Connect your bank', path: 'setup/connect-bank' },
      { label: 'Tax fast-track filing', path: 'working/tax-fast-track' },
      { label: 'How much tax should I set aside?', path: 'working/reports-and-tax' },
      { label: 'Fix a miscategorized expense', path: 'troubleshooting/fix-a-miscategorized-expense' },
    ],
  },
  zh: {
    heroTitle: '用好 AgentBook 的完整指南',
    heroBody:
      '从开通账户到日常记账，这里有你需要的全部内容——不需要任何会计基础。不想读文档？直接在对话里问，助手能回答其中的大部分问题。',
    popularLabel: '热门内容',
    explore: '查看',
    sections: [
      { icon: 'rocket', title: '开始设置', description: '创建账户、连接银行，几分钟内记下第一笔支出。', path: 'setup/quickstart' },
      { icon: 'settings', title: '配置', description: '企业资料、记账基准、银行同步、你的会计师、Telegram 与提醒。', path: 'configure/business-profile' },
      { icon: 'sparkles', title: '日常使用', description: '支出、发票、报表与税务，以及如何让助手发挥最大作用。', path: 'working/expenses-and-receipts' },
      { icon: 'map', title: '地区与税务', description: '美国、加拿大和澳大利亚各支持哪些功能，以及各国之间的差异。', path: 'regions/overview' },
      { icon: 'lifebuoy', title: '疑难排查', description: '银行同步、修正分类、登录问题——常见状况的快速解决办法。', path: 'troubleshooting/bank-not-syncing' },
    ],
    popular: [
      { label: '五分钟快速上手', path: 'setup/quickstart' },
      { label: 'AgentBook 支持哪些国家？', path: 'regions/overview' },
      { label: '面向学生的 AgentBook', path: 'setup/for-students' },
      { label: '连接你的银行账户', path: 'setup/connect-bank' },
      { label: '税务快速申报', path: 'working/tax-fast-track' },
      { label: '我该预留多少税款？', path: 'working/reports-and-tax' },
      { label: '修正分类错误的支出', path: 'troubleshooting/fix-a-miscategorized-expense' },
    ],
  },
};

/** Prefix a bare doc path with /docs and, for a translated landing, the locale. */
export function localeHref(locale: DocLocale, path: string): string {
  return locale === 'en' ? `/docs/${path}` : `/docs/${locale}/${path}`;
}
