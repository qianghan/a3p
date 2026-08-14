import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '使用指南 — AgentBook',
  description: '简短、可立即上手的指南：聊天与 Claude 连接器、日常工作流、学生生活，以及成为合作伙伴赚取收入。',
};

const GUIDES = [
  { n: '01', href: '/guides/zh/chatbot-mcp', title: '聊天与 Claude 连接器', blurb: '在应用里、Telegram 上，或直接从 Claude 与 AgentBook 对话。' },
  { n: '02', href: '/guides/zh/workflows', title: '日常工作流', blurb: '你最常用的三件事：记账、报税、个人理财。' },
  { n: '03', href: '/guides/zh/students', title: '学生生活', blurb: '为学生打造的记账、住房与奖学金助手。' },
  { n: '04', href: '/guides/zh/sales-rep', title: '成为合作伙伴', blurb: '推荐 AgentBook，赚取 20% 分成——把它变成持续收入。' },
  { n: '05', href: '/guides/zh/startup-founders', title: '写给创业者', blurb: '从第一天就把账做干净：现金消耗、可用月数、开票与创业税务。' },
];

export default function GuidesIndexZh() {
  return (
    <main>
      <div className="gd-eyebrow">使用指南</div>
      <h1 className="gd-h1">几分钟就能上手</h1>
      <p className="gd-lede">简短、以行动为先的指南。挑一篇，照着做，完成。大多只需 2–3 分钟。</p>

      <div className="gd-cards">
        {GUIDES.map((g) => (
          <Link key={g.href} href={g.href} className="gd-tile">
            <div className="gd-num">{g.n}</div>
            <h3>{g.title}</h3>
            <p>{g.blurb}</p>
            <div className="gd-go">阅读 &rarr;</div>
          </Link>
        ))}
      </div>

      <Link href="/" className="gd-back">&larr; 返回首页</Link>
    </main>
  );
}
