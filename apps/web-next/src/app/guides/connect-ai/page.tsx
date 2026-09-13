import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Connect your AI assistant — AgentBook Guides',
  description: 'Use AgentBook from Claude, Codex, ChatGPT or Gemini. One URL, one Allow, no API keys.',
};

const URL = 'https://agentbook.brainliber.com/api/v1/mcp';

export default function ConnectAiGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 06</div>
      <h1 className="gd-h1">Connect your AI assistant</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Ask Claude, Codex, ChatGPT or Gemini about your own books &mdash; and have it answer with your real numbers.</p>
      </div>
      <p className="gd-time">~3 min · one URL, one Allow, no API key to copy</p>

      <div className="gd-card">
        <b>The only address you need</b>
        <p><code>{URL}</code></p>
      </div>

      <p>
        Every assistant below connects the same way: you paste that URL, it sends you to a normal
        AgentBook sign-in page, you press <b>Allow</b>, and it can read your books. Nothing is
        saved to your books without a second confirmation, every time.
      </p>
      <p className="gd-note">
        Your workspace admin has to switch the connector on once before any of this works &mdash;
        that is <Link href="/guides/mcp-admin">Guide 07</Link>. If sign-in never appears, ask them
        first.
      </p>

      <h2 className="gd-h2">Claude</h2>
      <ol className="gd-steps">
        <li><b>Desktop or claude.ai</b><span>Settings &rarr; Connectors &rarr; add a custom connector, paste the URL, save.</span></li>
        <li><b>Claude Code</b><span>Run <code>claude mcp add --transport http agentbook {URL}</code>, then type <code>/mcp</code> to sign in.</span></li>
      </ol>

      <h2 className="gd-h2">Codex</h2>
      <ol className="gd-steps">
        <li><b>Add it</b><span><code>codex mcp add agentbook --url {URL}</code></span></li>
        <li><b>Sign in</b><span><code>codex mcp login agentbook</code> opens your browser for the Allow screen.</span></li>
      </ol>

      <h2 className="gd-h2">ChatGPT</h2>
      <ol className="gd-steps">
        <li><b>Turn on developer mode</b><span>Settings &rarr; Connectors. Custom connectors are a paid-plan feature, and on Business or Enterprise an admin may have to permit them first &mdash; that is the usual reason the option is missing.</span></li>
        <li><b>Create the connector</b><span>Give it a name, paste the URL, choose OAuth when asked how it authenticates. Do not paste a token: AgentBook does not issue any.</span></li>
      </ol>

      <h2 className="gd-h2">Gemini</h2>
      <ol className="gd-steps">
        <li><b>Add it</b><span><code>gemini mcp add -t http agentbook {URL}</code></span></li>
        <li><b>Start Gemini</b><span>It signs you in the first time it reaches AgentBook. <code>gemini mcp list</code> shows whether it connected.</span></li>
      </ol>

      <h2 className="gd-h2">Check it actually works</h2>
      <p>
        Do not ask &ldquo;are you connected?&rdquo; &mdash; an assistant with no connection will
        cheerfully say yes and then invent numbers. Plant something only your account could know,
        and go looking for it.
      </p>
      <ol className="gd-steps">
        <li><b>In AgentBook, add one odd expense</b><span>Vendor <code>Connector Check</code>, amount <b>$7.77</b>, today&rsquo;s date. An amount you would never really spend, so there is no chance of a coincidence.</span></li>
        <li><b>Ask your assistant</b><span>&ldquo;Using AgentBook, list my expenses for this month from the vendor Connector Check.&rdquo;</span></li>
        <li><b>Read the answer, not the confidence</b><span>A working connection returns <b>$7.77</b> and today&rsquo;s date. Anything else &mdash; a different figure, a polite &ldquo;I don&rsquo;t have access&rdquo;, an offer to help you add it &mdash; means it is not connected, whatever it says about itself.</span></li>
        <li><b>Delete the test expense</b><span>It is a real expense until you do, and it will show up in your totals and your tax figures.</span></li>
      </ol>
      <div className="gd-say">
        <div className="gd-say-k">Then try the real thing</div>
        <p>
          &ldquo;What&rsquo;s my cash position?&rdquo; &middot; &ldquo;Break my expenses down by
          category this year.&rdquo; &middot; &ldquo;Which invoices are overdue, and by how
          much?&rdquo; &middot; &ldquo;Record a $30 client lunch.&rdquo;
        </p>
      </div>

      <h2 className="gd-h2">If something goes wrong</h2>
      <table className="gd-table">
        <thead><tr><th>What you see</th><th>What to do</th></tr></thead>
        <tbody>
          <tr><td><strong>&ldquo;Isn&rsquo;t turned on for this account yet&rdquo;</strong></td><td>The connector is switched off. Send your admin to <Link href="/guides/mcp-admin">Guide 07</Link>.</td></tr>
          <tr><td><strong>No sign-in page ever opens</strong></td><td>Remove the connector and add it again. If your assistant offered an API-key or header field, leave it empty &mdash; filling it in stops the sign-in that would have worked.</td></tr>
          <tr><td><strong>It worked, then stopped</strong></td><td>Sign in again from the assistant. If it keeps happening every hour or so, tell your admin &mdash; it is a server setting, not you.</td></tr>
          <tr><td><strong>It answers questions but refuses to record anything</strong></td><td>That assistant cannot show you a confirmation step, so AgentBook will not let it write. Use Claude Desktop or Claude Code for changes.</td></tr>
          <tr><td><strong>Wrong country&rsquo;s tax figures</strong></td><td>Set your country and region in Business Profile. The connector reads the same profile the app does.</td></tr>
        </tbody>
      </table>

      <h2 className="gd-h2">Taking access away</h2>
      <p>
        Settings &rarr; Connected Apps lists everything you have approved, with a <b>Revoke</b>
        button each. Revoking cuts it off immediately. Deleting the connector inside the assistant
        does not do that on its own &mdash; if the point is to withdraw access, revoke here too.
      </p>

      <div className="gd-done"><span className="gd-check">✓</span><div>Your assistant can now read your books, and can only change them with your say-so &mdash; one confirmation per change, asked every time.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
