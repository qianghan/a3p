import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '加拿大自雇人士：如何在 12 月 31 日前补完一整年的账 — AgentBook 指南',
  description: '2026 年的账还在鞋盒里？3 小时补账方法、加拿大人最容易漏的 5 项抵扣，以及 12 月 31 日前要做的事。',
};

export default function YearEndBookkeepingCatchupGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 09</div>
      <h1 className="gd-h1">加拿大自雇人士：如何在 12 月 31 日前补完一整年的账</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>把一整年没整理的收据变成分类好的账目和一份税款估算——一个 12 月的下午就能完成。</p>
      </div>
      <p className="gd-time">约 3 小时 · 面向加拿大自雇人士</p>

      <p>
        如果你是加拿大的自雇人士，而你 2026 年的账现在还装在鞋盒里、某个 3 月之后就没打开过的
        电子表格页，或者「等 4 月再说」——这篇指南就是写给 12 月的你的。
      </p>

      <h2 className="gd-h2">为什么是 12 月，不是 4 月</h2>
      <p>
        两个原因。第一，对你重要的 CRA 截止日比你想象的来得早：GST/HST 分期、RRSP
        供款决定（截止日是 2027 年 3 月 1 日，但钱必须在 12 月就存在）、以及任何想在 2026 年
        抵扣的费用都必须在 <i>2026 年内付掉</i>。第二，4 月再去重建 12 个月的收据，
        抵扣项就是这么漏掉的。去年有个自由职业者这么做之后，发现漏报了 $2,300
        的家庭办公室和软件抵扣——是实实在在留在桌上的钱。
      </p>

      <h2 className="gd-h2">3 小时补账方法</h2>
      <ol className="gd-steps">
        <li><b>第 1 小时——收集</b><span>所有收据放进一个文件夹：邮件确认（搜「receipt」「invoice」「payment confirmed」）、纸质小票（拍照）、应用订阅（查银行账单里那些小额定期扣款——它们是最容易被忘掉的抵扣项）。</span></li>
        <li><b>第 2 小时——分类</b><span>CRA 的 T2125 要求费用按类别填写：广告、餐饮娱乐（只算 50%）、办公、用品、专业费用、车辆、家庭办公室。按这些类别分一次，报税就完成了一半。公私混用的支出要过「商用比例」这一关——比例现在就写下来，别等 4 月。</span></li>
        <li><b>第 3 小时——估算</b><span>粗略损益表：总收入减去分类后的费用。再粗算一下要交多少税。目标不是精确——是消除 4 月的惊吓。</span></li>
      </ol>

      <h2 className="gd-h2">加拿大人最容易漏的 5 项抵扣</h2>
      <ol className="gd-steps">
        <li><b>家庭办公室</b><span>不只是房租占比：水电、保险、维修、房贷利息（不是本金）。</span></li>
        <li><b>电话／网络商用比例</b><span>有记录、前后一致。</span></li>
        <li><b>软件与订阅</b><span>每月 $12 的工具加起来就是实实在在的抵扣。</span></li>
        <li><b>职业发展</b><span>与工作相关的课程、书籍、会议。</span></li>
        <li><b>车辆</b><span>里程记录胜过加油收据；现在就开始记。</span></li>
      </ol>

      <div className="gd-say">
        <div className="gd-say-k">想有人陪你一起做？</div>
        <p>
          我们在办一个免费的 3 周 <b>Year-End Books Rescue</b>，面向 15 位加拿大自雇人士：
          把 2026 年收据发过来，通过 AI 记账聊天拿到每周损益快照、年末税款估算和漏报抵扣报告。
          免费，不用银行卡。<Link href="/register">免费注册加入</Link>。
        </p>
      </div>

      <p className="gd-note">
        仅为一般信息，不是税务建议。复杂情况请咨询 CPA。
      </p>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
