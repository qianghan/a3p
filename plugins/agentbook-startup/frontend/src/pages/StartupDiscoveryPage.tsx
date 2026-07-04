import React, { useEffect, useState } from 'react';
import {
  Rocket, Building2, Users, TrendingUp, Wallet, Search, Loader2,
  Info, ExternalLink, Landmark, Sparkles, CheckCircle2, HelpCircle, XCircle,
} from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';
import { startupApi, formatCents, type ProgramRecommendation, type AddOnPriceTeaser } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  qualified: 'Qualified',
  possibly_qualified: 'Possibly qualified',
  not_qualified: 'Not qualified yet',
};

const STATUS_STYLE: Record<string, string> = {
  qualified: 'bg-green-500/10 text-green-600 border-green-500/20',
  possibly_qualified: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  not_qualified: 'bg-muted text-muted-foreground border-border',
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  qualified: CheckCircle2,
  possibly_qualified: HelpCircle,
  not_qualified: XCircle,
};

function StatusBadge({ status }: { status: string }) {
  const Icon = STATUS_ICON[status] ?? HelpCircle;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border shrink-0 ${STATUS_STYLE[status] ?? STATUS_STYLE.not_qualified}`}>
      <Icon className="w-3.5 h-3.5" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ProgramCard({ program }: { program: ProgramRecommendation }) {
  const range = program.estValueLowCents !== null && program.estValueHighCents !== null
    ? `${formatCents(program.estValueLowCents)} – ${formatCents(program.estValueHighCents)}`
    : null;
  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-3">
      <div className="flex justify-between items-start gap-3 mb-1">
        <h3 className="font-semibold text-foreground">{program.name}</h3>
        <StatusBadge status={program.status} />
      </div>
      <p className="text-sm text-muted-foreground flex items-center gap-1.5 mb-2">
        <Landmark className="w-3.5 h-3.5 shrink-0" />
        {program.authority}
      </p>
      {range && (
        <p className="inline-flex text-sm font-medium text-primary bg-primary/10 rounded-md px-2 py-0.5 mb-2">
          Est. value: {range}
        </p>
      )}
      <p className="text-sm text-foreground/90">{program.reasoning}</p>
      {program.sourceUrl && (
        <a
          href={program.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
        >
          Learn more <ExternalLink className="w-3.5 h-3.5" />
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

  const inputClass = 'w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-sm';

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Rocket className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Startup Tax Benefits</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Answer a few questions about your company to see what government tax-benefit programs you likely qualify for — free, no commitment.
      </p>

      <ChatCTA example="Am I eligible for the R&D tax credit?" />

      <form onSubmit={handleSubmit} className="space-y-4 mb-6">
        <div>
          <label htmlFor="companyType" className="block text-sm font-medium mb-1">Company type</label>
          <div className="relative">
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <select
              id="companyType"
              value={companyType}
              onChange={(e) => setCompanyType(e.target.value)}
              className={`${inputClass} appearance-none`}
            >
              <option value="">Select...</option>
              <option value="c_corp">C-corp</option>
              <option value="llc">LLC</option>
              <option value="ccpc">CCPC (Canada)</option>
              <option value="ltd">Ltd (UK)</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="headcount" className="block text-sm font-medium mb-1">Headcount</label>
          <div className="relative">
            <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="headcount"
              type="number"
              min="0"
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
              className={inputClass}
              placeholder="e.g., 4"
            />
          </div>
        </div>

        <div>
          <label htmlFor="annualRdSpend" className="block text-sm font-medium mb-1">Annual R&D spend ($)</label>
          <div className="relative">
            <TrendingUp className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="annualRdSpend"
              type="number"
              min="0"
              step="any"
              value={annualRdSpend}
              onChange={(e) => setAnnualRdSpend(e.target.value)}
              className={inputClass}
              placeholder="0.00"
            />
          </div>
        </div>

        <div>
          <label htmlFor="equityRaised" className="block text-sm font-medium mb-1">Equity raised ($)</label>
          <div className="relative">
            <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="equityRaised"
              type="number"
              min="0"
              step="any"
              value={equityRaised}
              onChange={(e) => setEquityRaised(e.target.value)}
              className={inputClass}
              placeholder="0.00"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'Checking…' : 'See what I qualify for'}
        </button>
      </form>

      {result?.message && (
        <div className="bg-amber-500/10 text-amber-700 border border-amber-500/20 rounded-lg p-4 mb-3 flex items-start gap-2 text-sm">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          {result.message}
        </div>
      )}
      {result?.programs.map((program) => <ProgramCard key={program.programCode} program={program} />)}

      {teaser?.price && !teaser.active && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mt-6 flex items-start gap-2">
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <p className="text-sm text-muted-foreground">
            Ready to draft an application? Startup Tax Benefits starts at{' '}
            <span className="font-medium text-foreground">{formatCents(teaser.price.priceCents)}/year</span>.
          </p>
        </div>
      )}
    </div>
  );
}
