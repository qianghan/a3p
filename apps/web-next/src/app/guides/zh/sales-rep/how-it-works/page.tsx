import Link from 'next/link';
import type { Metadata } from 'next';
import { Flow } from '../../../_components/Flow';

export const metadata: Metadata = {
  title: 'AgentBook 是怎么运作的——合作伙伴实战手册',
  description:
    '真正打动人的四个价值场景——支出、开票、税务，以及会主动开口的助理——配有示意图和该怎么说。',
};

export default function HowItWorksGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">合作伙伴手册</div>
      <h1 className="gd-h1">AgentBook 是怎么运作的——以及怎么讲清楚</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>
          能在 60 秒内把 AgentBook 讲明白。四个场景就完成了 90% 的说服工作——
          记住示意图，以及每个场景里最打动人的那句话。
        </p>
      </div>
      <p className="gd-time">约 5 分钟 · 你的话术速查表</p>

      <p>
        AgentBook 不是「财务软件」。它是一个用聊天框替人打理账目的财务助理。
        真正的卖点不是功能，而是<strong>每周把好几个小时还给你</strong>，以及<strong>再也不会被税单吓一跳</strong>。
        下面这四个瞬间，会让人说出「等等，它真的直接就做了？」
      </p>

      <h2 className="gd-h2">1 · 拍张收据，账就记好了</h2>
      <Flow
        caption="拍照 → AI 识别 → 自动分类 → 入账。不用填表。"
        steps={[
          { label: '拍照或\n转发', sub: '照片 / PDF' },
          { label: 'AI 识别', sub: '金额 · 商家 · 日期' },
          { label: '自动\n分类', sub: '正确的科目' },
          { label: '记入\n账簿', sub: '生成分录' },
        ]}
      />
      <p>
        你的客户在 Telegram（或应用）里给收据拍张照。AgentBook 的视觉模型会提取金额、商家和日期，
        归到正确的分类，并写好记账分录——只需几秒。不用表格，不用录入，四月也不再有一鞋盒收据。
      </p>
      <div className="gd-say">
        <div className="gd-say-k">可以这么说</div>
        <p>「你那一堆收据？拍张照。手机还没放下，账就记好了。」</p>
      </div>

      <h2 className="gd-h2">2 · 发出发票，刷卡就能收款</h2>
      <Flow
        caption="创建 → 发送 → 客户点击付款 → 现金和账目自动更新。"
        steps={[
          { label: '创建\n发票', sub: '也可周期性' },
          { label: '发送', sub: '邮件 + 链接' },
          { label: '客户\n刷卡付款', sub: '直接到账' },
          { label: '标记已付', sub: '账目已更新' },
        ]}
      />
      <p>
        发票带有「立即付款」按钮。客户刷卡支付，款项直接进入<strong>你客户自己的</strong>账户（不是我们的），
        发票自动标记为已付，现金分录也自动记好。长期合作的客户还可以自动周期性开票。
      </p>
      <div className="gd-say">
        <div className="gd-say-k">可以这么说</div>
        <p>「客户点一下卡就能付，你收钱更快——而且你一条记账分录都不用碰。」</p>
      </div>

      <h2 className="gd-h2">3 · 税务不再有意外</h2>
      <Flow
        caption="每一笔交易都汇入实时估算；年终只需导出一次。"
        steps={[
          { label: '每笔交易', sub: '收入 + 支出' },
          { label: '实时税务\n估算', sub: '该预留多少' },
          { label: '年终\n资料包', sub: 'Schedule C / T2125' },
          { label: '会计师\n复核', sub: '分享链接' },
        ]}
      />
      <p>
        AgentBook 全年保持一份滚动的税务估算——内置美国、加拿大和澳大利亚的规则——
        让你的客户随时知道该预留多少。年终会生成申报资料包（Schedule C、T2125 等），
        并给他们的会计师一个只读复核链接。不用再手忙脚乱。
      </p>
      <div className="gd-say">
        <div className="gd-say-k">可以这么说</div>
        <p>「它今天就告诉你该为税预留多少——所以四月只是普通的一个月，不是一场心脏病。」</p>
      </div>

      <h2 className="gd-h2">4 · 会主动开口的财务助理</h2>
      <Flow
        highlightLast
        caption="它盯着钱的动向，在变成问题之前就提醒你。"
        steps={[
          { label: '助理\n盯着', sub: '现金 · 税 · 支出' },
          { label: '发现\n风险', sub: '断崖 / 异常 / 缺口' },
          { label: '主动\n提醒你', sub: '不用你先问' },
        ]}
      />
      <p>
        这是竞品没有的部分。AgentBook 会主动提示现金缓冲变薄、税单正在累积、支出异常升高、
        收据缺失，或者发票迟迟没收款——直接在聊天里，早于你想到要去看的时候。
        这就是账本和顾问之间的区别。
      </p>
      <div className="gd-say">
        <div className="gd-say-k">可以这么说</div>
        <p>「QuickBooks 等着你登录。AgentBook 会在有事需要处理时主动发消息给你。」</p>
      </div>

      <h2 className="gd-h2">一句话版本</h2>
      <p>
        「AgentBook 是一个你可以对话的 AI 记账员。拍收据、发发票，它在后台把账目和税务都做好——
        然后在钱出问题之前先提醒你。」
      </p>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>
          接下来：领取现成的<Link href="/guides/zh/sales-rep/materials">分享素材</Link>，然后看看
          <Link href="/guides/zh/sales-rep/earnings">你能赚多少</Link>。
        </div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/zh/sales-rep">← 合作伙伴总览</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/materials">推广素材包</Link>
        <Link className="gd-chip" href="/guides/zh/sales-rep/earnings">收入与算法</Link>
      </div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
