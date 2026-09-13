import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Switch on the AI connector (admin) — AgentBook Guides',
  description: 'Two one-time settings that let everyone in the workspace connect Claude, Codex, ChatGPT or Gemini.',
};

export default function McpAdminGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 07</div>
      <h1 className="gd-h1">Switch on the AI connector</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Two one-time settings, done once for the whole workspace, that let everyone in it connect their AI assistant.</p>
      </div>
      <p className="gd-time">~10 min · needs admin access and a deploy · you only do this once</p>

      <p>
        Nobody can connect anything until these are done &mdash; every part of the connector
        answers &ldquo;not turned on&rdquo; until step 1. Once they are done, each person follows{' '}
        <Link href="/guides/connect-ai">Guide 06</Link> on their own.
      </p>

      <h2 className="gd-h2">1 · Turn the connector on</h2>
      <ol className="gd-steps">
        <li><b>Open Admin &rarr; Config &rarr; Feature Flags</b><span>Find <code>agentbook.mcp.enabled</code> and enable it.</span></li>
        <li><b>That is the whole step</b><span>It is a database setting, read fresh on every request. No deploy, no restart &mdash; it takes effect immediately.</span></li>
      </ol>
      <div className="gd-say">
        <div className="gd-say-k">Prove it, from any machine</div>
        <p>
          Open <code>/.well-known/oauth-protected-resource</code> on your site. While the connector
          is off it returns an error; once it is on it returns a small block of JSON. That page
          needs no login, so it is the quickest way to check from anywhere.
        </p>
      </div>

      <h2 className="gd-h2">2 · Give it a signing key</h2>
      <p>
        Set an environment variable named <code>AGENTBOOK_MCP_JWKS</code> in your hosting
        dashboard, for Production, then redeploy.
      </p>
      <p>
        This one is security, not convenience. With it unset, the OAuth library signs with a
        sample key that ships inside its own package &mdash; the same key in every installation of
        it anywhere, published openly. Nothing looks broken; that is the problem.
      </p>
      <ol className="gd-steps">
        <li><b>Generate a key on your own machine</b><span>Run this. It copies the key to your clipboard and prints nothing, so it never lands in your terminal history or scrollback.</span></li>
        <li><b>Paste it into the hosting dashboard</b><span>Name it <code>AGENTBOOK_MCP_JWKS</code>, scope Production. Paste the whole line exactly as generated &mdash; it starts with <code>{'{"keys":['}</code> and ends with <code>{']}'}</code>.</span></li>
        <li><b>Redeploy</b><span>The running app reads it at startup, so it will not see the value until a new deployment goes out.</span></li>
      </ol>
      <div className="gd-card">
        <b>Generate the key</b>
        <p><code>node -e &apos;const{'{'}generateKeyPairSync{'}'}=require(&quot;crypto&quot;);const{'{'}privateKey{'}'}=generateKeyPairSync(&quot;rsa&quot;,{'{'}modulusLength:2048{'}'});console.log(JSON.stringify({'{'}keys:[{'{'}...privateKey.export({'{'}format:&quot;jwk&quot;{'}'}),use:&quot;sig&quot;,alg:&quot;RS256&quot;{'}'}]{'}'}))&apos; | pbcopy</code></p>
      </div>
      <div className="gd-say">
        <div className="gd-say-k">Treat it like a password</div>
        <p>
          Anyone holding this key can forge what your server signs. Keep it to the hosting
          dashboard: not in the repository, not in a chat message, not in a ticket. If it does get
          out, generate a new one and redeploy &mdash; that is all it takes to retire the old one.
        </p>
      </div>

      <h2 className="gd-h2">3 · Check it end to end</h2>
      <p>
        Connect one assistant yourself using <Link href="/guides/connect-ai">Guide 06</Link> and run
        the $7.77 test there. A green tick on the two settings above only means they are set; the
        test is the part that proves somebody can actually reach their own books.
      </p>

      <h2 className="gd-h2">What people will ask you</h2>
      <table className="gd-table">
        <thead><tr><th>They report</th><th>Cause</th></tr></thead>
        <tbody>
          <tr><td><strong>&ldquo;It says the connector isn&rsquo;t turned on&rdquo;</strong></td><td>Step 1 is not done, or the flag was switched back off.</td></tr>
          <tr><td><strong>&ldquo;It logs me out every hour&rdquo;</strong></td><td>The deployment is behind. Refreshing access without a new sign-in needs the current release.</td></tr>
          <tr><td><strong>&ldquo;It won&rsquo;t connect at all, in any assistant&rdquo;</strong></td><td>Same answer &mdash; deploy the current release, then have them try again.</td></tr>
          <tr><td><strong>&ldquo;Everything is slow, or it says too many requests&rdquo;</strong></td><td>Sixty calls a minute per person is the ceiling. It resets on its own.</td></tr>
        </tbody>
      </table>

      <div className="gd-done"><span className="gd-check">✓</span><div>Done once, for everyone. From here it is self-service: each person connects their own assistant and approves it with their own login, and can revoke it themselves.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
