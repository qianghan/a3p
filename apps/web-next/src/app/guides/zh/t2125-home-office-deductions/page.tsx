import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'T2125 家庭办公室费用 2026 — 加拿大自由职业者最容易漏的抵扣 — AgentBook 指南',
  description: '详细法与简易法怎么选、哪些费用能算、最容易引起 CRA 注意的 3 个错误，以及一份 12 月行动清单。',
};

export default function T2125HomeOfficeGuideZh() {
  return (
    <main>
      <div className="gd-eyebrow">指南 10</div>
      <h1 className="gd-h1">T2125 家庭办公室费用 2026——加拿大自由职业者最容易漏的抵扣</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">你的目标</div>
        <p>把应得的家庭办公室抵扣一分不少地拿回来——不多拿一分不该拿的。</p>
      </div>
      <p className="gd-time">约 10 分钟读完 · 面向报 T2125 的加拿大自雇人士</p>

      <p>
        如果你作为加拿大自雇人士报 T2125（企业或专业活动报表），家庭办公室这一行就是
        漏报最多钱的地方——也是 CRA 看得最紧的地方。以下是 2026 年的正确做法。
      </p>

      <h2 className="gd-h2">两种方法（以及选哪一种）</h2>
      <div className="gd-card">
        <b>详细法</b>
        <p>按商用比例申报<i>所有</i>符合条件的家庭费用。手续多，抵扣多。如果你大多数日子都在家工作，值得用它。</p>
      </div>
      <div className="gd-card">
        <b>简易法</b>
        <p>按工作日给固定费率（CRA 在疫情期间设过临时固定费率；2026 年详细法是标准做法——是否有固定费率可选，请查 CRA 最新指引）。</p>
      </div>
      <p>
        经验法则：如果你的家庭办公室超过 50% 用于工作、每周在家工作 4 天以上，
        就按详细法算一遍。它通常能多出 2–4 倍。
      </p>

      <h2 className="gd-h2">哪些费用能算（详细法）</h2>
      <ol className="gd-steps">
        <li><b>房租，或房贷利息（不是本金）、房产税、房屋保险</b><span>几项大头固定费用，按商用比例分摊。</span></li>
        <li><b>水电暖：取暖、电、水</b><span>同样按比例分摊——账单留好。</span></li>
        <li><b>维修和小的修缮</b><span>办公室角落那个修好的漏水水龙头——按比例算。</span></li>
        <li><b>网络和电话</b><span>按商用比例。</span></li>
      </ol>

      <h2 className="gd-h2">最容易引起 CRA 注意的 3 个错误</h2>
      <ol className="gd-steps">
        <li><b>报 100% 的住房费用</b><span>商用比例必须实测（办公室面积 ÷ 住房面积），且合理。10–20% 是常见值。</span></li>
        <li><b>没有书面记录</b><span>平面图计算方法和账单要保存 6 年。</span></li>
        <li><b>用家庭办公室费用制造亏损来退税</b><span>家庭办公室费用不能制造或增加 T2125 上的业务亏损（上限是业务收入，超出的部分结转以后年度）。</span></li>
      </ol>

      <h2 className="gd-h2">12 月行动清单</h2>
      <p>
        这周就量好你的办公区域（拿卷尺拍照——未来的你会感谢现在的你）。
        拉出 12 个月的水电／房租／房贷利息数字。在年底前决定用详细法还是简易法，
        因为这会改变你需要留哪些收据。
      </p>

      <div className="gd-say">
        <div className="gd-say-k">一整年的账要手算？</div>
        <p>
          免费的 3 周 <b>Year-End Books Rescue</b>（15 个名额）包含帮你算好的家庭办公室费用。
          <Link href="/register">免费注册加入</Link>。
        </p>
      </div>

      <p className="gd-note">
        仅为一般信息，不是税务建议。
      </p>

      <Link href="/guides/zh" className="gd-back">&larr; 返回全部指南</Link>
    </main>
  );
}
