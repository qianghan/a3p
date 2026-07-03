import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { prisma } from '@naap/database';
import { enforceRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEAL = '#149578';
const MINT = '#62cda2';
const INK = '#0a231b';

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://agentbook.brainliber.com').replace(/\/$/, '');
}

/**
 * GET /api/v1/agentbook-billing/referrals/qr-card/[code]
 * A branded, portrait "scan to join" card — same referral code as the
 * existing social-share card (card/[code]), but built for in-app display and
 * screen-scanning rather than social unfurling: the QR code is the focal
 * point, sized and contrasted for a phone camera to pick up reliably at a
 * glance. Used identically for a sales rep's referral link and an ordinary
 * user's peer-referral link — same BillReferralCode row either way, no
 * separate code path. Public (no auth), 404s for an unknown code, rate
 * limited (non-trivial image + QR render cost per request).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const limited = enforceRateLimit(request, { keyPrefix: 'referral-qr-card', maxRequests: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { code: raw } = await params;
  const code = raw.trim().toUpperCase();
  const owner = await prisma.billReferralCode.findUnique({ where: { code } });
  if (!owner) return new Response('Not found', { status: 404 });

  const shareUrl = `${appBaseUrl()}/register?ref=${encodeURIComponent(code)}`;
  const qrSvg = await QRCode.toString(shareUrl, {
    type: 'svg',
    margin: 0,
    color: { dark: INK, light: '#ffffff' },
  });
  const qrDataUri = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '56px 48px',
          background: `linear-gradient(160deg, ${INK} 0%, #12332a 55%, #0c6e57 100%)`,
          fontFamily: 'sans-serif',
        }}
      >
        {/* Wordmark */}
        <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 34, fontWeight: 700 }}>
          <span style={{ color: '#ffffff' }}>agent</span>
          <span style={{ color: MINT }}>book</span>
        </div>

        {/* Scan panel */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            background: '#ffffff',
            borderRadius: 28,
            padding: '40px 40px 32px',
            marginTop: 40,
            boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUri} width={360} height={360} alt="" />
          <div
            style={{
              display: 'flex',
              marginTop: 24,
              fontSize: 26,
              fontWeight: 700,
              color: '#ffffff',
              background: `linear-gradient(92deg, ${TEAL}, ${MINT})`,
              padding: '8px 24px',
              borderRadius: 10,
            }}
          >
            {code}
          </div>
        </div>

        {/* CTA */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 40, gap: 8 }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: '#ffffff', textAlign: 'center' }}>
            Scan to join AgentBook
          </div>
          <div style={{ fontSize: 18, color: 'rgba(255,255,255,0.7)', textAlign: 'center', maxWidth: 420 }}>
            AI bookkeeping for freelancers — snap a receipt, get real answers, save hours every month.
          </div>
        </div>
      </div>
    ),
    { width: 800, height: 1000 },
  );
}
