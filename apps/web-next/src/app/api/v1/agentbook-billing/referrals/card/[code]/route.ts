import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { prisma } from '@naap/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEAL = '#149578';
const MINT = '#62cda2';
const INK = '#0a231b';

/**
 * GET /api/v1/agentbook-billing/referrals/card/[code]
 * A branded, shareable PNG for social channels — value-focused (savings /
 * peace of mind / ROI), the referral code front and center. Public (no auth)
 * so it renders correctly when the share link unfurls in chat apps and can be
 * downloaded directly. 404s for an unknown code so cards can't be spoofed for
 * codes that were never issued.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = raw.trim().toUpperCase();
  const owner = await prisma.billReferralCode.findUnique({ where: { code } });
  if (!owner) return new Response('Not found', { status: 404 });

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
          background: `linear-gradient(135deg, ${INK} 0%, #12332a 55%, #0c6e57 100%)`,
          fontFamily: 'sans-serif',
        }}
      >
        {/* Wordmark */}
        <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 40, fontWeight: 700 }}>
          <span style={{ color: '#ffffff' }}>agent</span>
          <span style={{ color: MINT }}>book</span>
        </div>

        {/* Headline + value chips */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 44, fontWeight: 700, color: '#ffffff', lineHeight: 1.15 }}>
              I do my books &amp; taxes with AgentBook.
            </div>
            <div style={{ fontSize: 22, color: 'rgba(255,255,255,0.75)', maxWidth: 780 }}>
              AI bookkeeping that saves freelancers on tax-prep fees and hours of admin.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {['Save on tax-prep fees', 'Peace of mind at tax time', 'Real ROI — hours back'].map((chip) => (
              <div
                key={chip}
                style={{
                  display: 'flex',
                  padding: '10px 18px',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.12)',
                  color: '#ffffff',
                  fontSize: 18,
                }}
              >
                {chip}
              </div>
            ))}
          </div>
        </div>

        {/* Footer: code + CTA */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid rgba(255,255,255,0.18)',
            paddingTop: 28,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 14, letterSpacing: 2, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>
              Use my code
            </div>
            <div
              style={{
                fontSize: 34,
                fontWeight: 700,
                color: '#ffffff',
                background: `linear-gradient(92deg, ${TEAL}, ${MINT})`,
                padding: '6px 20px',
                borderRadius: 10,
              }}
            >
              {code}
            </div>
          </div>
          <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.85)' }}>Sign up → your first paid month, we both save</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
