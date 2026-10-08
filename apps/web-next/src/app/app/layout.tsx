import type { Viewport } from 'next';
import { MobileShell } from './_shell/MobileShell';

/**
 * The /app PWA layout. A SERVER component so it can export `viewport`:
 * `viewportFit: 'cover'` is what makes iOS report non-zero
 * env(safe-area-inset-*) — without it the tab bar sits under the home
 * indicator. Everything interactive lives in the client MobileShell.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function MobileAppLayout({ children }: { children: React.ReactNode }) {
  return <MobileShell>{children}</MobileShell>;
}
