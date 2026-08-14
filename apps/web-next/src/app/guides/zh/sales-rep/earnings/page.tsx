import Link from 'next/link';
import type { Metadata } from 'next';
import { EarningsCalculator } from '../../../_components/EarningsCalculator';

export const metadata: Metadata = {
  title: '成为 AgentBook 合作伙伴能赚多少',
  description:
    'AgentBook 20% 持续分成背后的真实数字——被动收入如何累积，并附带一个实时计算器。',
};

export default function EarningsGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">合作伙伴手册</div>
      <h1 className="gd-h1">你实际能赚到多少</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>
          理解为什么推荐 AgentBook 是<strong>持续收入</strong>，而不是一次性赏金——
          并用下面的计算器算算你自己的数字。
        </p>
      </div>
      <p className="gd-time">约 4 分钟 · 真实数字，不吹牛</p>

      <h2 className="gd-h2">一句话说清模式</h2>
      <p>
        你能拿到<strong>每位推荐客户所付金额的 20%</strong>——每个账单周期都有，
        只要他们还在订阅就一直有。因为是持续的，推荐会不断累积：上个季度带来的客户还在为你产生收入，
        同时你又在增加新的。
      </p>

      <h2 className="gd-h2">你分成所依据的真实价格</h2>
      <table className="gd-table">
        <thead>
          <tr><th>套餐</th><th>客户支付</th><th>你获得（20%）</th><th>每年</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Pro</strong></td><td>$19 / 月</td><td>$3.80 / 月</td><td><strong>$45.60</strong></td></tr>
          <tr><td><strong>Business</strong></td><td>$49 / 月</td><td>$9.80 / 月</td><td><strong>$117.60</strong></td></tr>
        </tbody>
      </table>
      <p className="gd-note">免费版用户不付费，所以在他们升级之前不会产生分成——你的任务是帮到那些真正能获得价值的人，他们自然会愿意付费。</p>

      <h2 className="gd-h2">算算你的数字</h2>
      <p>拖动滑块。计算使用 AgentBook 真实的套餐价格和 20% 的费率：</p>
      <EarningsCalculator locale="zh" />

      <h2 className="gd-h2">为什么会累积</h2>
      <ol className="gd-steps">
        <li><b>是持续的，不是一锤子买卖</b><span>你在第一季度推荐的客户，到第四季度仍然在为你带来收入——明年也一样。新的推荐还会叠加在上面。</span></li>
        <li><b>把自己的订阅赚回来</b><span>如果你在最初 90 个有效日内的分成足以覆盖年费，该费用将退还给你（仅限一次）。这个工具实际上就自己付了钱。</span></li>
        <li><b>按季度直接打到你账上</b><span>分成每季度打入你连接的 Stripe 账户——不用向我们开票，也不用催款。</span></li>
        <li><b>你推荐的是自己本来就在用的东西</b><span>可信度是免费的。你不是在陌生推销；你只是把那个替你省下大把时间的工具展示给别人。</span></li>
      </ol>

      <div className="gd-card">
        <b>务实，不是一夜暴富</b>
        <p>
          以上是扣除你自身税负之前的分成总额，并且假设客户会持续订阅（有些不会）。
          请把它当作一份随人脉增长而增长的稳定副业收入——而不是一张彩票。
        </p>
      </div>

      <h2 className="gd-h2">怎么拿到钱</h2>
      <ol className="gd-steps">
        <li><b>持有有效的年度套餐</b><span>这是入场券——你是在为一个自己真正付费并使用的产品背书。</span></li>
        <li><b>申请并签署</b><span><code>/sales-rep/apply</code> 的 5 步申请同时也是你的合作伙伴协议，你的具体费率和条款在其中确定。</span></li>
        <li><b>连接收款</b><span>有引导的 Stripe 流程会收集你的税务表格（美国 1099-NEC、加拿大 T4A）和银行信息。</span></li>
        <li><b>分享并赚取</b><span>用你的专属链接。每一家留下来的企业，都会季度复季度地给你 20%。</span></li>
      </ol>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>准备好了？在<Link href="/guides/zh/sales-rep/how-it-works">运作方式</Link>里学会话术，领取<Link href="/guides/zh/sales-rep/materials">分享素材</Link>，然后到 <code>/sales-rep/apply</code> 申请。</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/zh/sales-rep">← 合作伙伴总览</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/how-it-works">运作方式</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/materials">推广素材包</Link>
      </div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
