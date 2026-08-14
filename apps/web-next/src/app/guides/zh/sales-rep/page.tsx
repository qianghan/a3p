import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '成为合作伙伴 — AgentBook 指南',
  description: '推荐 AgentBook，赚取 20% 分成——把你喜欢的工具变成持续收入。',
};

export default function SalesRepGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 04</div>
      <h1 className="gd-h1">成为 AgentBook 合作伙伴</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>把你本来就在付费使用的工具变成持续收入——你推荐的每一家企业，只要还在订阅，你就能拿到 <strong>20%</strong>。</p>
      </div>
      <p className="gd-time">约 3 分钟</p>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/zh/sales-rep/how-it-works">AgentBook 是怎么运作的 →</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/materials">推广素材包 →</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/earnings">收入与算法 →</Link>
      </div>

      <h2 className="gd-h2">谁可以加入</h2>
      <p>任何持有<strong>有效付费年度套餐</strong>的会员都可以申请。（你是在为自己真正在用的产品背书——所以年度套餐就是入场券。）</p>

      <h2 className="gd-h2">如何成为合作伙伴</h2>
      <ol className="gd-steps">
        <li><b>打开申请表</b><span>从你的仪表盘进入 <code>/sales-rep/apply</code>。</span></li>
        <li><b>完成 5 步注册</b><span>匹配度 → 你所在的国家 → 权益与责任 → 税务提示 → 审阅并签署。这同时也是你的合作伙伴协议。</span></li>
        <li><b>等待审核通过</b><span>我们的团队会审核并通过邮件通知你。（如果暂时不合适，90 天后可以重新申请。）</span></li>
        <li><b>设置收款</b><span>连接一个 Stripe 账户（有引导的托管流程），我们就能直接付款给你。税务表格——美国的 1099-NEC、加拿大的 T4A——也在这一步收集。</span></li>
      </ol>

      <h2 className="gd-h2">你能赚到什么</h2>
      <ol className="gd-steps">
        <li><b>20% 分成，持续发放</b><span>你推荐的每位客户所支付金额的 20% 归你——按季度发放，只要他们的订阅还有效就一直有。</span></li>
        <li><b>把自己的订阅赚回来</b><span>赚回你的年费：如果你在最初 90 个有效日内的分成足以覆盖年费，年费将退还给你（仅限一次）。</span></li>
        <li><b>按季度打到你的账户</b><span>分成会按季度打入你连接的 Stripe 账户。</span></li>
      </ol>

      <h2 className="gd-h2">你推荐的人能得到什么</h2>
      <p>一个用聊天框就能打理账目、税务和现金流的工具——正是当初打动你的那个。你不是在卖折扣给他们；你是把每周好几个小时还给他们。</p>

      <div className="gd-card">
        <b>只想推荐给朋友，不想当合作伙伴？</b>
        <p>用设置里的推荐链接即可——每有一位付费的朋友，你就<strong>免费获得一个月</strong>，每年最多 12 个月。无需申请。</p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>在 <code>/sales-rep/apply</code> 申请、签署、连接收款，然后把 AgentBook 分享出去。每一家留下来的企业，都会季度复季度地为你带来 20%。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
