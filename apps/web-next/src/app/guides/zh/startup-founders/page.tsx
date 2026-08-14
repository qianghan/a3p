import Link from 'next/link';
import type { Metadata } from 'next';
import { Flow } from '../../_components/Flow';

export const metadata: Metadata = {
  title: 'AgentBook 写给创业者',
  description:
    '用一个下午把创业公司的财务理顺——从第一天就把账做干净，随时看清现金消耗与可用月数、开票收款，以及带创业优惠的税务。',
};

export default function StartupFoundersGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">创始人指南</div>
      <h1 className="gd-h1">AgentBook 写给创业者</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>
          从<strong>第一天</strong>就把账做干净——让现金消耗、可用月数和税务随时都答得上来，
          融资或年终结账也不会变成一场大扫除。
        </p>
      </div>
      <p className="gd-time">约 6 分钟 · 今天下午就能做完</p>

      <p>
        早期财务通常死于两种方式：一鞋盒没人对账的收据，或者一位你还请不起的记账员。
        AgentBook 是第三个选项——一个用聊天框就能替你记账、跟踪现金消耗、随时提示税务的 AI。
        下面是创始人的配置方法。
      </p>

      <h2 className="gd-h2">1 · 把公司建起来（10 分钟）</h2>
      <ol className="gd-steps">
        <li><b>创建工作区</b><span>注册并走一遍引导流程：国家／司法辖区、币种、会计年度。</span></li>
        <li><b>把业务类型设为「创业公司」</b><span>在 <code>设置 → 业务资料</code> 中设置。这会定制你的分类和税务指引，并解锁<strong>创业税务优惠</strong>相关工具。</span></li>
        <li><b>初始化会计科目表</b><span>设置时已替你完成——收入、创业公司真正会用到的支出分类、现金和权益。</span></li>
      </ol>

      <h2 className="gd-h2">2 · 自动跟踪现金消耗与可用月数</h2>
      <Flow
        caption="账户只需连接一次；支出会自己入账、自己对账。"
        steps={[
          { label: '连接\n银行/卡', sub: 'Plaid（美国/加拿大）' },
          { label: '支出\n自动导入', sub: '自动分类' },
          { label: '消耗与\n可用月数', sub: '始终最新' },
          { label: '现金预警', sub: '在见底之前' },
        ]}
      />
      <p>
        连上公司银行账户或信用卡，每一笔交易都会自动流入并完成分类。你的月度消耗和现金状况保持实时更新——
        当缓冲变薄时，助理会主动提醒你，而不是等到月底才发现。偶尔的现金或纸质收据，在 Telegram 里拍一张，
        入账方式完全一样。
      </p>

      <h2 className="gd-h2">3 · 向客户开票、收到钱</h2>
      <p>
        发送带品牌样式的发票，附上「立即付款」的刷卡按钮——款项直接结算到你的账户，发票自动完成对账。
        为预付金或订阅设置周期性发票，收入就能自动开票。第一笔收入是个里程碑；别让收款这件事还得手工做。
      </p>

      <h2 className="gd-h2">4 · 税务——带创业优惠</h2>
      <Flow
        caption="全年保持实时估算；创业专属的优惠会主动呈现给你。"
        steps={[
          { label: '实时税务\n估算', sub: '该预留多少' },
          { label: '创业优惠', sub: '抵免与选择' },
          { label: '年终\n资料包', sub: '可直接申报' },
          { label: '会计师\n复核', sub: '分享链接' },
        ]}
      />
      <p>
        AgentBook 会保持一份实时的税务估算，并针对创业公司主动呈现那些值得去问会计师的优惠与税务选择——
        不让该拿的好处白白错过。到了年终，生成申报资料包，并把只读复核链接分享给你的会计师。
        它负责把来龙去脉整理清楚；由你的会计师签字确认。
      </p>
      <div className="gd-card">
        <b>不构成税务或法律建议</b>
        <p>AgentBook 负责呈现和整理——它不能取代你的会计师或律师。在依赖这些内容之前，请就适用于你具体实体的抵免、税务选择和申报事项咨询专业人士。</p>
      </div>

      <h2 className="gd-h2">5 · 当你融资或招人时</h2>
      <ol className="gd-steps">
        <li><b>升级到 Business 套餐</b><span>每月 49 元，解锁不限量额度和团队席位——当需要用的不只是你一个人时。</span></li>
        <li><b>给你的会计师一个席位</b><span>邀请会计师／记账员来复核——不用再靠邮件来回发表格。</span></li>
        <li><b>账干净 = 尽调更快</b><span>当投资人要数字时，它们早就存在而且对得上。这正是从第一天就开始的意义。</span></li>
      </ol>

      <h2 className="gd-h2">费用是多少</h2>
      <table className="gd-table">
        <thead><tr><th>套餐</th><th>价格</th><th>适合谁</th></tr></thead>
        <tbody>
          <tr><td><strong>免费版</strong></td><td>0 元</td><td>还没有收入——先试试，把最初几笔支出记上。</td></tr>
          <tr><td><strong>Pro</strong></td><td>19 元/月</td><td>单打独斗的创始人：聊天机器人、税务导出、真实额度。</td></tr>
          <tr><td><strong>Business</strong></td><td>49 元/月</td><td>一个团队：一切不限量，为联合创始人／会计师提供席位。</td></tr>
        </tbody>
      </table>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>把业务类型设为<strong>创业公司</strong>，连接银行，发出第一张发票。从此你的账目、消耗和税务都会自己维持下去。</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/zh">← 返回全部指南</Link>
        <Link className="gd-chip" href="/guides/zh/workflows">日常工作流</Link>
        <Link className="gd-chip" href="/guides/zh/chatbot-mcp">聊天与 Claude</Link>
      </div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
