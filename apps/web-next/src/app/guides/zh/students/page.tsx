import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '学生生活 — AgentBook 指南',
  description: '用 AgentBook 管理学生的钱、住房和奖学金。',
};

export default function StudentsGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 03</div>
      <h1 className="gd-h1">AgentBook 与学生生活</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>用对的方式管好学生阶段的钱，并在找奖学金、带薪实习和住处时得到帮助。</p>
      </div>
      <p className="gd-time">约 2 分钟</p>

      <h2 className="gd-h2">开启学生模式</h2>
      <ol className="gd-steps">
        <li><b>设置时选择「学生」</b><span>在引导对话中把类型选为学生。（已经注册了？在设置里的业务资料中修改。）</span></li>
        <li><b>获得为学生调校的配置</b><span>你的分类会切换成学生生活——学费、教材、房租、奖学金与助学金收入、助学贷款利息——让记账贴合你真实的花钱方式。</span></li>
      </ol>

      <h2 className="gd-h2">解锁学生助手</h2>
      <p>添加 <strong>Student Success</strong> 增值包（在应用内的市场／账单页，当前价格以那里为准）即可开启三个助手：</p>
      <ol className="gd-steps">
        <li><b>奖学金</b><span>找到并筛选你符合条件的奖学金。在聊天里说：「帮我找安大略省计算机专业大二学生的奖学金。」或者打开<strong>奖学金</strong>标签页。</span></li>
        <li><b>求职与带薪实习</b><span>按专业、学校和工作许可匹配带薪实习与实习岗位。打开<strong>求职与实习</strong>，或者问「找找学校附近的带薪实习岗位」。</span></li>
        <li><b>住房</b><span>室友匹配，以及针对你的预算和入住时间的负担能力核算。打开<strong>住房</strong>，或者问「在学校附近找 900 元以内的室友」。</span></li>
      </ol>

      <div className="gd-done"><span className="gd-check">✓</span><div>把类型设为学生，添加 Student Success，然后直接在聊天里要奖学金、带薪实习或室友——它已经知道你的专业和预算了。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
