import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Chat & Claude connector — AgentBook Guides',
  description: 'Talk to AgentBook the fastest way: in the app, on Telegram, or from Claude.',
};

export default function ChatbotMcpGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 01</div>
      <h1 className="gd-h1">Chat &amp; the Claude connector</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Get answers and log things by just talking &mdash; in the app, on Telegram, or straight from Claude.</p>
      </div>
      <p className="gd-time">~2 min · supports US, Canada &amp; Australia</p>

      <h2 className="gd-h2">Fastest: chat in the app</h2>
      <ol className="gd-steps">
        <li><b>Open the app and tap “Ask AgentBook”</b><span>The chat screen. Or go to <code>/app/chat</code> on your phone.</span></li>
        <li><b>Type it like you’d text a bookkeeper</b><span>“Log $14 parking under travel”, “what did I spend on software this month?”, “draft an invoice for Acme, $4,840”.</span></li>
        <li><b>Confirm when it asks</b><span>Anything that changes your books (send an invoice, record a payment) asks you to confirm first.</span></li>
      </ol>

      <h2 className="gd-h2">On the go: Telegram</h2>
      <ol className="gd-steps">
        <li><b>Create your own bot</b><span>In Telegram, message <code>@BotFather</code>, send <code>/newbot</code>, and copy the token it gives you.</span></li>
        <li><b>Paste the token in Settings</b><span>Open <Link href="/login" className="gd-kbd">Settings</Link> → Chatbots → Telegram, paste the token, save. AgentBook wires up the rest.</span></li>
        <li><b>Text your bot</b><span>Now log expenses and ask questions from Telegram — same assistant, in your pocket.</span></li>
      </ol>

      <h2 className="gd-h2">Power move: connect Claude (MCP)</h2>
      <p>Use AgentBook as a tool inside Claude Desktop or Claude Code — ask about your finances or take actions without leaving Claude.</p>
      <ol className="gd-steps">
        <li><b>Add a custom connector</b><span>In Claude, add a remote MCP connector with this URL:</span></li>
        <li><b>Sign in when Claude opens the browser</b><span>It’s a normal AgentBook login — no API key or token to copy. Claude registers itself automatically.</span></li>
        <li><b>Ask away</b><span>“Ask AgentBook what I spent on travel this quarter” or “record a $30 client lunch”.</span></li>
      </ol>
      <div className="gd-card">
        <b>Connector URL</b>
        <p><code>https://agentbook.brainliber.com/api/v1/mcp</code></p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>You can now reach AgentBook three ways. Most people start in the app, add Telegram for on-the-go, and connect Claude once they’re hooked.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
