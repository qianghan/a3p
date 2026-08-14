import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '日常工作流 — AgentBook 指南',
  description: '你最常用的三件事：记账、报税和个人理财。',
};

export default function WorkflowsGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 02</div>
      <h1 className="gd-h1">你的日常工作流</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>把账记干净、清楚知道要交多少税、随时了解钱的状况——而且不用再碰表格。</p>
      </div>
      <p className="gd-time">约 3 分钟</p>

      <h2 className="gd-h2">1 · 记账（每天都做）</h2>
      <ol className="gd-steps">
        <li><b>把支出录进来</b><span>在 <code>/agentbook/receipts</code> 拍张收据，或者直接告诉聊天窗口「42 元加油，公司支出」。AgentBook 会自动分类。</span></li>
        <li><b>让银行替你打字</b><span>在 <code>/agentbook/bank</code> 关联账户，交易就会自动导入。（银行同步属于付费套餐。）</span></li>
        <li><b>清空待复核队列</b><span>时不时看一眼 <code>/agentbook/expenses</code>——确认被标记的条目，把个人和公司支出分开。</span></li>
      </ol>

      <h2 className="gd-h2">2 · 报税（不再有意外）</h2>
      <ol className="gd-steps">
        <li><b>盯住你的估算</b><span>打开 <code>/agentbook/tax</code> 的税务仪表盘，实时查看你要交多少以及每季度的金额。</span></li>
        <li><b>生成税务资料包</b><span>在 <code>/agentbook/tax-package</code> 生成可用于申报的 PDF 和 CSV（损益表、抵扣项、里程）。</span></li>
        <li><b>去申报</b><span>AgentBook 负责<strong>准备</strong>好一切；由你（或你的会计师）向 IRS／CRA／ATO 申报。它不会自动报送。</span></li>
      </ol>

      <h2 className="gd-h2">3 · 个人理财（看清全貌）</h2>
      <ol className="gd-steps">
        <li><b>打开你的财务视图</b><span>访问 <code>/personal</code> 查看净资产、储蓄率和趋势。</span></li>
        <li><b>关联个人账户</b><span>连上银行，余额和支出就会自动更新。</span></li>
        <li><b>让它给你解读</b><span>在聊天里问：「我的储蓄率怎么样？」或者「这个月我进度还行吗？」</span></li>
      </ol>

      <div className="gd-done"><span className="gd-check">✓</span><div>随手拍收据，每周瞄一眼税务估算，每月看一次 <code>/personal</code>。整个节奏就这么简单。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
