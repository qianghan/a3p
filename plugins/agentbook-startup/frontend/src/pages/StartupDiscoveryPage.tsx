import React, { useEffect, useState } from 'react';
import { startupApi, formatCents, type ProgramRecommendation, type AddOnPriceTeaser } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  qualified: 'Qualified',
  possibly_qualified: 'Possibly qualified',
  not_qualified: 'Not qualified yet',
};

function ProgramCard({ program }: { program: ProgramRecommendation }) {
  const range = program.estValueLowCents !== null && program.estValueHighCents !== null
    ? `${formatCents(program.estValueLowCents)} – ${formatCents(program.estValueHighCents)}`
    : null;
  return (
    <div className="glass-card p-4 mb-3 border">
      <div className="flex justify-between items-baseline">
        <h3 className="font-semibold">{program.name}</h3>
        <span className="text-sm">{STATUS_LABEL[program.status] ?? program.status}</span>
      </div>
      <p className="text-sm text-gray-600">{program.authority}</p>
      {range && <p className="text-sm font-medium">{range}</p>}
      <p className="text-sm mt-1">{program.reasoning}</p>
      {program.sourceUrl && (
        <a href={program.sourceUrl} target="_blank" rel="noreferrer" className="text-sm underline">
          Learn more
        </a>
      )}
    </div>
  );
}

export function StartupDiscoveryPage() {
  const [companyType, setCompanyType] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [annualRdSpend, setAnnualRdSpend] = useState('');
  const [equityRaised, setEquityRaised] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ programs: ProgramRecommendation[]; message?: string } | null>(null);
  const [teaser, setTeaser] = useState<AddOnPriceTeaser | null>(null);

  useEffect(() => {
    startupApi.getProfile().then((profile) => {
      if (!profile) return;
      setCompanyType(profile.companyType ?? '');
      setHeadcount(profile.headcount != null ? String(profile.headcount) : '');
      setAnnualRdSpend(profile.annualRdSpendCents != null ? String(profile.annualRdSpendCents / 100) : '');
      setEquityRaised(profile.equityRaisedCents != null ? String(profile.equityRaisedCents / 100) : '');
    });
    startupApi.getAddOnTeaser().then(setTeaser).catch(() => setTeaser(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await startupApi.saveProfile({
        companyType: companyType || undefined,
        headcount: headcount ? Number(headcount) : undefined,
        annualRdSpendCents: annualRdSpend ? Math.round(Number(annualRdSpend) * 100) : undefined,
        equityRaisedCents: equityRaised ? Math.round(Number(equityRaised) * 100) : undefined,
      });
      const recs = await startupApi.getRecommendations();
      setResult(recs);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Startup Tax Benefits</h1>
      <p className="text-sm text-gray-600 mb-4">
        Answer a few questions about your company to see what government tax-benefit programs you likely qualify for — free, no commitment.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 mb-6">
        <div>
          <label htmlFor="companyType">Company type</label>
          <select id="companyType" value={companyType} onChange={(e) => setCompanyType(e.target.value)}>
            <option value="">Select...</option>
            <option value="c_corp">C-corp</option>
            <option value="llc">LLC</option>
            <option value="ccpc">CCPC (Canada)</option>
            <option value="ltd">Ltd (UK)</option>
          </select>
        </div>
        <div>
          <label htmlFor="headcount">Headcount</label>
          <input id="headcount" type="number" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
        </div>
        <div>
          <label htmlFor="annualRdSpend">Annual R&D spend ($)</label>
          <input id="annualRdSpend" type="number" value={annualRdSpend} onChange={(e) => setAnnualRdSpend(e.target.value)} />
        </div>
        <div>
          <label htmlFor="equityRaised">Equity raised ($)</label>
          <input id="equityRaised" type="number" value={equityRaised} onChange={(e) => setEquityRaised(e.target.value)} />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? 'Checking…' : 'See what I qualify for'}
        </button>
      </form>

      {result?.message && <p className="text-sm text-amber-700">{result.message}</p>}
      {result?.programs.map((program) => <ProgramCard key={program.programCode} program={program} />)}

      {teaser?.price && !teaser.active && (
        <p className="text-sm text-gray-500 mt-6 border-t pt-4">
          Ready to draft an application? Startup Tax Benefits starts at {formatCents(teaser.price.priceCents)}/year.
        </p>
      )}
    </div>
  );
}
