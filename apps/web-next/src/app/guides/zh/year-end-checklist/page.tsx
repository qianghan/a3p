import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '自雇人士年末检查清单 — AgentBook 指南',
  description: '15 项检查，在 12 月 31 日前结清 2026 年账目：收据、抵扣项、GST/HST、RRSP，以及 2027 年要坚持的三个习惯。',
};

export default function YearEndChecklistGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 08</div>
      <h1 className="gd-h1">自雇人士年末 15 项检查清单</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>在 12 月 31 日前结清 2026 年账目——收据全找到，抵扣项全报上，4 月不再措手不及。</p>
      </div>
      <p className="gd-time">约 15 分钟做完 · 面向加拿大自雇人士</p>

      <p>
        如果你是加拿大的自雇人士，12 月就是今年账目要么做完、要么变贵的时候。
        按顺序做完这 15 项——先收据，再是最容易漏的抵扣项，最后是只有 12 月 31 日前才有效的税务动作。
      </p>

      <h2 className="gd-h2">收据与账本</h2>
      <ol className="gd-steps">
        <li><b>收齐所有 2026 年收据</b><span>邮件确认、纸质小票、应用商店账单——放进一个文件夹，一个不落。</span></li>
        <li><b>核对银行和信用卡账单</b><span>对照你的记录；未分类的支出标出来。</span></li>
        <li><b>公私混用的卡要分清</b><span>这是 CRA 查自雇人士时最常见的审计触发点。</span></li>
        <li><b>现在就记里程</b><span>趁还记得——到 4 月再去回忆是行不通的。</span></li>
      </ol>

      <h2 className="gd-h2">抵扣项——最容易漏的</h2>
      <ol className="gd-steps" start={5}>
        <li><b>家庭办公室</b><span>量好办公面积占比，收集房租／房贷利息、水电、保险、维修费用。</span></li>
        <li><b>电话和网络</b><span>商用比例要留书面记录。</span></li>
        <li><b>专业会费与订阅</b><span>软件、域名、服务器续费。</span></li>
        <li><b>商务餐饮与差旅</b><span>谁、为什么、有收据——三样缺一不可。</span></li>
        <li><b>超过约 $500 的资产采购</b><span>查 CCA 折旧类别，不要直接当费用报掉。</span></li>
      </ol>

      <h2 className="gd-h2">税务动作——12 月 31 日前</h2>
      <ol className="gd-steps" start={10}>
        <li><b>估算 2026 年自雇净收入</b><span>粗算要交多少税——别等 4 月才吓一跳。</span></li>
        <li><b>如果你是 GST/HST 注册人</b><span>确认第四季度申报截止日，现在就把税款留出来。</span></li>
        <li><b>查 RRSP 额度</b><span>供款截止日是 2027 年 3 月 1 日，但决定得在 12 月做。</span></li>
        <li><b>原计划明年初付的业务费用现在就付</b><span>这样才能在 2026 年抵扣。</span></li>
      </ol>

      <h2 className="gd-h2">收尾</h2>
      <ol className="gd-steps" start={14}>
        <li><b>出一份 2026 年损益表——粗略的也行</b><span>没有它，你没法规划 2027 年的税。</span></li>
        <li><b>写下 2027 年每月要坚持的 3 个记账习惯</b><span>这份清单的意义就在这里。</span></li>
      </ol>

      <p className="gd-note">
        仅为一般信息，不是税务建议。具体情况请咨询 CPA。
      </p>

      <div className="gd-say">
        <div className="gd-say-k">做完这 15 项还是头大？</div>
        <p>
          我们在办一个免费的 3 周<b>「Year-End Books Rescue」年末账目急救营</b>，15 个名额：
          把收据发过来，我们在 AgentBook 聊天里帮你理成账。免费，不用银行卡。
          <Link href="/register">免费注册加入</Link>。
        </p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>完成——2026 年账目结清了，抵扣项报上了，2027 年可以干净开局。</div></div>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
