import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '聊天与 Claude 连接器 — AgentBook 指南',
  description: '用最快的方式与 AgentBook 对话：在应用里、Telegram 上，或直接从 Claude。',
};

export default function ChatbotMcpGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 01</div>
      <h1 className="gd-h1">聊天与 Claude 连接器</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>只靠说话就能获得答案、记录事项——在应用里、Telegram 上，或者直接从 Claude。</p>
      </div>
      <p className="gd-time">约 2 分钟 · 支持美国、加拿大和澳大利亚</p>

      <h2 className="gd-h2">最快：在应用里聊天</h2>
      <ol className="gd-steps">
        <li><b>打开应用，点击「询问 AgentBook」</b><span>就是聊天页面。也可以在手机上访问 <code>/app/chat</code>。</span></li>
        <li><b>像给记账员发消息那样写</b><span>「记录 14 元停车费，归到差旅」「这个月我在软件上花了多少？」「给 Acme 起草一张 4,840 元的发票」。</span></li>
        <li><b>它询问时确认一下</b><span>任何会改动账目的操作（发送发票、记录收款）都会先请你确认。</span></li>
      </ol>

      <h2 className="gd-h2">随时随地：Telegram</h2>
      <ol className="gd-steps">
        <li><b>创建你自己的机器人</b><span>在 Telegram 中给 <code>@BotFather</code> 发消息，发送 <code>/newbot</code>，复制它给你的令牌。</span></li>
        <li><b>把令牌粘贴到设置里</b><span>打开 <Link href="/login" className="gd-kbd">设置</Link> → 聊天机器人 → Telegram，粘贴令牌并保存。剩下的 AgentBook 会自动接好。</span></li>
        <li><b>给你的机器人发消息</b><span>现在就能在 Telegram 里记录支出、提问了——同一个助理，装在口袋里。</span></li>
      </ol>

      <h2 className="gd-h2">进阶玩法：连接 Claude（MCP）</h2>
      <p>把 AgentBook 当作 Claude Desktop 或 Claude Code 里的一个工具——不用离开 Claude 就能查询财务或执行操作。</p>
      <ol className="gd-steps">
        <li><b>添加自定义连接器</b><span>在 Claude 中添加一个远程 MCP 连接器，使用下面这个网址：</span></li>
        <li><b>Claude 打开浏览器时登录</b><span>就是普通的 AgentBook 登录——不需要复制任何 API 密钥或令牌。Claude 会自动完成注册。</span></li>
        <li><b>尽管问</b><span>「问问 AgentBook 我这个季度在差旅上花了多少」或者「记录一笔 30 元的客户午餐」。</span></li>
      </ol>
      <div className="gd-card">
        <b>连接器网址</b>
        <p><code>https://agentbook.brainliber.com/api/v1/mcp</code></p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>现在你有三种方式找到 AgentBook。大多数人从应用开始，加上 Telegram 随手记，用顺手之后再连接 Claude。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
