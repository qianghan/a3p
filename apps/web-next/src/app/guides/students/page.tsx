import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Student life — AgentBook Guides',
  description: 'Use AgentBook for student money, housing, and scholarships.',
};

export default function StudentsGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 03</div>
      <h1 className="gd-h1">AgentBook for student life</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Track student money the right way, and get help finding scholarships, co-ops, and a place to live.</p>
      </div>
      <p className="gd-time">~2 min</p>

      <h2 className="gd-h2">Turn on student mode</h2>
      <ol className="gd-steps">
        <li><b>Pick “Student” when you set up</b><span>In the onboarding chat, choose Student as your type. (Already signed up? Change it in Business Profile under Settings.)</span></li>
        <li><b>Get a student-tuned setup</b><span>Your categories switch to student life — tuition, textbooks, rent, scholarship &amp; grant income, student-loan interest — so bookkeeping fits how you actually spend.</span></li>
      </ol>

      <h2 className="gd-h2">Unlock the student copilots</h2>
      <p>Add the <strong>Student Success</strong> add-on (from the in-app marketplace / billing — see current pricing there) to switch on three helpers:</p>
      <ol className="gd-steps">
        <li><b>Scholarships</b><span>Find and shortlist scholarships you qualify for. In chat: “find scholarships for a second-year CS student in Ontario.” Or open the <strong>Scholarships</strong> tab.</span></li>
        <li><b>Jobs &amp; Co-op</b><span>Match to co-ops and internships by program, school, and work authorization. Open <strong>Jobs &amp; Co-op</strong>, or ask “find co-op roles near campus.”</span></li>
        <li><b>Housing</b><span>Roommate matches and an affordability check for your budget and move-in date. Open <strong>Housing</strong>, or ask “find roommates near campus under $900.”</span></li>
      </ol>

      <div className="gd-done"><span className="gd-check">✓</span><div>Set your type to Student, add Student Success, then just ask the chat for scholarships, co-ops, or roommates — it already knows your program and budget.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
