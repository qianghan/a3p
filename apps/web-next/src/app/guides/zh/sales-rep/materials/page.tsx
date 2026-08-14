import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '推广素材包 — 给 AgentBook 合作伙伴的分享卡片',
  description:
    '可直接发布的社交卡片与文案，展示 AgentBook 的价值。下载、加上你的推荐链接、分享出去。',
};

const CARDS = [
  { file: 'hours-back', title: '别再自己做账', blurb: '覆盖面最广的切入点——情绪上的回报。适合作为冷启动的第一条。' },
  { file: 'receipts', title: '拍下收据', blurb: '「等等，它真的直接就做了？」的演示瞬间。' },
  { file: 'get-paid', title: '刷卡就能收款', blurb: '适合那些总在催发票的自由职业者。' },
  { file: 'tax', title: '心里有数的税额', blurb: '在 1–4 月和每个季度最能打动人。' },
  { file: 'ai-bookkeeper', title: '一个你可以发消息的 AI 记账员', blurb: '一句话说清整个产品。' },
];

const CAPTIONS = [
  '我不再自己做账了。AgentBook 是一个你直接发消息就能用的 AI 记账员——拍张收据、发张发票，你的税务在后台就一直是做好的状态。它甚至会在现金或税务出问题之前提醒你。来试试：[你的链接]',
  '自由职业者们：你的收据可以自己入账。拍照 → AgentBook 识别金额、商家和日期 → 直接进账簿。不用表格，四月也不用手忙脚乱。[你的链接]',
  '真正让报税季变得「无聊」（褒义）的东西：AgentBook 全年保持实时税务估算，我随时知道该预留多少。年终只需导出一次。[你的链接]',
];

export default function MaterialsPageZh() {
  return (
    <main>
      <div className="gd-eyebrow">合作伙伴手册</div>
      <h1 className="gd-h1">推广素材包</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>今天就发一条。挑一张卡片，加上你的推荐链接，分享出去——不需要做任何设计。</p>
      </div>
      <p className="gd-time">约 2 分钟 · 下载即用</p>

      <h2 className="gd-h2">分享卡片</h2>
      <p>
        尺寸适配社交平台（1200×630）。点击<strong>下载</strong>，然后配上下面任意一段文案和你的推荐链接发布。
        小提示：想发成 PNG 的话，打开文件后导出——或者直接截图。
      </p>
      <p className="gd-note">卡片图片本身目前是英文的。如果你面向中文受众发布，建议配上下面的中文文案，或者自己截图后加上中文标题。</p>

      <div className="gd-kit">
        {CARDS.map((c) => (
          <div key={c.file} className="gd-kit-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG share asset, not an optimizable content image */}
            <img src={`/guides/cards/${c.file}.svg`} alt={c.title} width={1200} height={630} loading="lazy" />
            <div className="gd-kit-meta">
              <b>{c.title}</b>
              <p>{c.blurb}</p>
              <a className="gd-dl" href={`/guides/cards/${c.file}.svg`} download>
                ↓ 下载
              </a>
            </div>
          </div>
        ))}
      </div>

      <h2 className="gd-h2">可直接粘贴的文案</h2>
      <p>把 <code>[你的链接]</code> 换成你的推荐链接（在 设置 → 推荐 中可以找到）：</p>
      {CAPTIONS.map((cap, i) => (
        <div key={i} className="gd-card">
          <p style={{ marginTop: 0 }}>{cap}</p>
        </div>
      ))}

      <h2 className="gd-h2">几条让它持续奏效的原则</h2>
      <ol className="gd-steps">
        <li><b>先讲痛点，别先讲产品</b><span>「我不再自己做账了」比「AgentBook 有 OCR」有效得多。人们买的是结果。</span></li>
        <li><b>永远用展示代替宣称</b><span>一段 10 秒的拍收据录屏，转化率高过任何卡片。卡片的作用是让人停下滑动。</span></li>
        <li><b>说明这是推荐链接</b><span>大多数地方都要求披露，而且这本身也更容易赢得信任。</span></li>
        <li><b>把人引向合适的套餐</b><span>一个人？Pro（19 元/月）。团队或用量大？Business（49 元/月）。还有免费版可以先上手。</span></li>
      </ol>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>发完了？看看<Link href="/guides/zh/sales-rep/earnings">能赚多少</Link>，学学<Link href="/guides/zh/sales-rep/how-it-works">怎么讲清楚</Link>。</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/zh/sales-rep">← 合作伙伴总览</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/how-it-works">运作方式</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/earnings">收入与算法</Link>
      </div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
