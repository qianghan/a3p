import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '连接你的 AI 助理 — AgentBook 指南',
  description: '在 Claude、Codex、ChatGPT 或 Gemini 里使用 AgentBook。一个网址，点一次「允许」，不需要 API 密钥。',
};

const URL = 'https://agentbook.brainliber.com/api/v1/mcp';

export default function ConnectAiGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 06</div>
      <h1 className="gd-h1">连接你的 AI 助理</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>让 Claude、Codex、ChatGPT 或 Gemini 直接回答关于你自己账目的问题——用你真实的数字。</p>
      </div>
      <p className="gd-time">约 3 分钟 · 一个网址，点一次「允许」，不用复制任何密钥</p>

      <div className="gd-card">
        <b>你只需要这一个地址</b>
        <p><code>{URL}</code></p>
      </div>

      <p>
        下面每个助理的接法都一样：粘贴这个网址，它会把你带到普通的 AgentBook 登录页，
        你点一下<b>允许</b>，它就能读取你的账目。任何会写入账目的操作，每一次都会再问你一遍。
      </p>
      <p className="gd-note">
        管理员需要先把连接器打开一次，上面这些才会生效——见
        <Link href="/guides/zh/mcp-admin">指南 07</Link>。如果始终没有出现登录页面，先去找管理员。
      </p>

      <h2 className="gd-h2">Claude</h2>
      <ol className="gd-steps">
        <li><b>桌面版或 claude.ai</b><span>设置 → 连接器 → 添加自定义连接器，粘贴网址，保存。</span></li>
        <li><b>Claude Code</b><span>运行 <code>claude mcp add --transport http agentbook {URL}</code>，然后输入 <code>/mcp</code> 登录。</span></li>
      </ol>

      <h2 className="gd-h2">Codex</h2>
      <ol className="gd-steps">
        <li><b>添加</b><span><code>codex mcp add agentbook --url {URL}</code></span></li>
        <li><b>登录</b><span><code>codex mcp login agentbook</code> 会打开浏览器显示「允许」页面。</span></li>
      </ol>

      <h2 className="gd-h2">ChatGPT</h2>
      <ol className="gd-steps">
        <li><b>打开开发者模式</b><span>设置 → 连接器。自定义连接器属于付费功能；在商业版或企业版里，可能还需要管理员先放行——这通常就是找不到这个选项的原因。</span></li>
        <li><b>创建连接器</b><span>起个名字，粘贴网址，认证方式选 OAuth。不要粘贴令牌：AgentBook 不签发任何令牌。</span></li>
      </ol>

      <h2 className="gd-h2">Gemini</h2>
      <ol className="gd-steps">
        <li><b>添加</b><span><code>gemini mcp add -t http agentbook {URL}</code></span></li>
        <li><b>启动 Gemini</b><span>第一次访问 AgentBook 时它会引导你登录。用 <code>gemini mcp list</code> 可以看到是否连上了。</span></li>
      </ol>

      <h2 className="gd-h2">验证它真的连上了</h2>
      <p>
        别问「你连上了吗」——没连上的助理照样会爽快地说连上了，然后编造数字。
        放一个只有你的账户才会知道的东西，再去找它。
      </p>
      <ol className="gd-steps">
        <li><b>在 AgentBook 里添加一笔奇怪的支出</b><span>商家填 <code>Connector Check</code>，金额 <b>7.77</b>，日期今天。用一个你现实中绝不会花的数，就不会碰巧撞上。</span></li>
        <li><b>去问你的助理</b><span>「用 AgentBook 查一下，这个月商家是 Connector Check 的支出有哪些。」</span></li>
        <li><b>看答案，别看语气</b><span>连上了就会返回 <b>7.77</b> 和今天的日期。其他任何结果——数字对不上、客气地说「我没有权限」、或者主动提出帮你添加——都说明没连上，不管它嘴上怎么说。</span></li>
        <li><b>删掉这笔测试支出</b><span>在你删掉之前，它就是一笔真实支出，会进入你的合计和税务数字。</span></li>
      </ol>
      <div className="gd-say">
        <div className="gd-say-k">然后试试真正要问的</div>
        <p>
          「我现在手上有多少现金？」·「把我今年的支出按类别拆开。」·
          「哪些发票逾期了，逾期多少？」·「记一笔 30 元的客户午餐。」
        </p>
      </div>

      <h2 className="gd-h2">如果出了问题</h2>
      <table className="gd-table">
        <thead><tr><th>你看到的</th><th>怎么办</th></tr></thead>
        <tbody>
          <tr><td><strong>「尚未为此账户开启」</strong></td><td>连接器没打开。把<Link href="/guides/zh/mcp-admin">指南 07</Link> 发给管理员。</td></tr>
          <tr><td><strong>始终不出现登录页</strong></td><td>删掉连接器重新添加一次。如果助理提供了 API 密钥或请求头的输入框，请留空——填了反而会挡住本来能成功的登录流程。</td></tr>
          <tr><td><strong>本来能用，后来不行了</strong></td><td>在助理里重新登录一次。如果每隔一小时左右就发生，告诉管理员——那是服务端设置，不是你的问题。</td></tr>
          <tr><td><strong>能回答问题，但拒绝记录任何东西</strong></td><td>那个助理没法向你展示确认步骤，所以 AgentBook 不允许它写入。需要改动账目时用 Claude Desktop 或 Claude Code。</td></tr>
          <tr><td><strong>税务数字用错了国家</strong></td><td>在「业务资料」里设置国家和地区。连接器读的和应用是同一份资料。</td></tr>
        </tbody>
      </table>

      <h2 className="gd-h2">收回授权</h2>
      <p>
        设置 → 已连接应用，会列出你批准过的全部应用，每个后面都有<b>撤销</b>。
        撤销会立即断开。只在助理那边删掉连接器并不等于撤销——真要收回访问权，这里也要撤销。
      </p>

      <div className="gd-done"><span className="gd-check">✓</span><div>现在助理能读取你的账目了，而要改动账目必须经你同意——每改一次，都会问一次。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 全部指南</Link>
    </main>
  );
}
