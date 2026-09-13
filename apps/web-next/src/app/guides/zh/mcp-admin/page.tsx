import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '开启 AI 连接器（管理员） — AgentBook 指南',
  description: '两项一次性设置，让工作区里的每个人都能连上 Claude、Codex、ChatGPT 或 Gemini。',
};

export default function McpAdminGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 07</div>
      <h1 className="gd-h1">开启 AI 连接器</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>两项一次性设置，为整个工作区做一次，之后每个人都能连上自己的 AI 助理。</p>
      </div>
      <p className="gd-time">约 10 分钟 · 需要管理员权限和一次部署 · 只做这一次</p>

      <p>
        在这两步完成之前，谁也连不上——连接器的每个入口都会回答「尚未开启」。
        完成之后，每个人各自照着<Link href="/guides/zh/connect-ai">指南 06</Link> 操作即可。
      </p>

      <h2 className="gd-h2">1 · 打开连接器</h2>
      <ol className="gd-steps">
        <li><b>进入 管理 → 配置 → 功能开关</b><span>找到 <code>agentbook.mcp.enabled</code>，把它打开。</span></li>
        <li><b>这一步就完了</b><span>它是一条数据库设置，每次请求都会重新读取。不用部署、不用重启，立即生效。</span></li>
      </ol>
      <div className="gd-say">
        <div className="gd-say-k">在任意一台机器上验证</div>
        <p>
          打开站点上的 <code>/.well-known/oauth-protected-resource</code>。
          连接器关着时它返回错误，打开后返回一小段 JSON。这个页面不需要登录，
          所以它是随时随地最快的检查方式。
        </p>
      </div>

      <h2 className="gd-h2">2 · 给它一把签名密钥</h2>
      <p>
        在托管平台的控制台里，为 Production 环境设置一个名为 <code>AGENTBOOK_MCP_JWKS</code> 的
        环境变量，然后重新部署。
      </p>
      <p>
        这一步关乎安全，不是图方便。不设置它，OAuth 库就会使用自己软件包里自带的示例密钥——
        全世界每一份安装里都是同一把，而且公开可得。表面上一切正常，问题正在于此。
      </p>
      <ol className="gd-steps">
        <li><b>在你自己的机器上生成密钥</b><span>运行下面这条命令。它会把密钥复制到剪贴板，并且不打印任何内容，所以不会留在终端历史或回滚记录里。</span></li>
        <li><b>粘贴到托管平台控制台</b><span>变量名 <code>AGENTBOOK_MCP_JWKS</code>，范围选 Production。原样粘贴整行——它以 <code>{'{"keys":['}</code> 开头，以 <code>{']}'}</code> 结尾。</span></li>
        <li><b>重新部署</b><span>应用在启动时读取它，所以要等到新的部署上线才会生效。</span></li>
      </ol>
      <div className="gd-card">
        <b>生成密钥</b>
        <p><code>node -e &apos;const{'{'}generateKeyPairSync{'}'}=require(&quot;crypto&quot;);const{'{'}privateKey{'}'}=generateKeyPairSync(&quot;rsa&quot;,{'{'}modulusLength:2048{'}'});console.log(JSON.stringify({'{'}keys:[{'{'}...privateKey.export({'{'}format:&quot;jwk&quot;{'}'}),use:&quot;sig&quot;,alg:&quot;RS256&quot;{'}'}]{'}'}))&apos; | pbcopy</code></p>
      </div>
      <div className="gd-say">
        <div className="gd-say-k">把它当密码看待</div>
        <p>
          拿到这把密钥的人，就能伪造你服务器签发的东西。只让它出现在托管平台控制台里：
          不要进代码仓库，不要发在聊天里，不要贴进工单。万一泄露，重新生成一把并部署即可——
          让旧的作废只需要这一步。
        </p>
      </div>

      <h2 className="gd-h2">3 · 端到端验证一次</h2>
      <p>
        自己照着<Link href="/guides/zh/connect-ai">指南 06</Link> 连一个助理，把那个 7.77 的测试跑一遍。
        上面两项设置打上勾只说明它们设好了；真正证明有人能读到自己账目的，是那个测试。
      </p>

      <h2 className="gd-h2">大家会来问你什么</h2>
      <table className="gd-table">
        <thead><tr><th>他们反馈</th><th>原因</th></tr></thead>
        <tbody>
          <tr><td><strong>「提示连接器没开启」</strong></td><td>第 1 步没做，或者开关又被关上了。</td></tr>
          <tr><td><strong>「每小时就要重新登录」</strong></td><td>部署版本落后了。免登录续期需要当前版本。</td></tr>
          <tr><td><strong>「所有助理都连不上」</strong></td><td>同一个原因——部署当前版本，然后让他们再试。</td></tr>
          <tr><td><strong>「很慢，或者提示请求过多」</strong></td><td>每人每分钟六十次是上限，会自动恢复。</td></tr>
        </tbody>
      </table>

      <div className="gd-done"><span className="gd-check">✓</span><div>做一次，惠及所有人。之后就是自助：每个人用自己的账号连接并授权，也可以自己撤销。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 全部指南</Link>
    </main>
  );
}
