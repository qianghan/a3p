import React from 'react';

const SANS =
  '"SF Pro Display","Helvetica Neue",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';

/**
 * Auth canvas — the brand's first impression. A dark radial canvas with an
 * oversized ghost "a" lettermark behind the form. The `dark` class flips the
 * shared form tokens (bg-background / text-foreground / borders) to their dark
 * values so the form sits correctly on the canvas without per-screen restyling.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{
        background:
          'radial-gradient(120% 130% at 50% 28%, #2a323b 0%, #1b222a 48%, #11161b 100%)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
      >
        <span
          style={{
            fontFamily: SANS,
            fontWeight: 720,
            fontSize: 'min(78vh, 760px)',
            lineHeight: 1,
            letterSpacing: '-0.04em',
            opacity: 0.06,
            transform: 'translateY(-4%)',
            backgroundImage: 'linear-gradient(120deg,#0c6e57,#149578,#62cda2)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          a
        </span>
      </div>
      <div className="relative z-10 w-full flex items-center justify-center">{children}</div>
    </div>
  );
}
