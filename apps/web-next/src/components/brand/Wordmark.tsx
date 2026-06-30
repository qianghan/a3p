/**
 * AgentBook wordmark — the logo is the word itself: lowercase "agent" in the
 * surrounding ink color + "book" in the brand teal→mint gradient. Self-contained
 * (inline styles) so it renders identically without depending on Tailwind tokens.
 * "agent" inherits the current text color, so it adapts to light/dark grounds.
 */

import React from 'react';

const SANS =
  '"SF Pro Display","Helvetica Neue",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';

export function Wordmark({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      aria-label="AgentBook"
      style={{
        fontFamily: SANS,
        fontWeight: 680,
        letterSpacing: '-0.045em',
        fontSize: size,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      <span>agent</span>
      <span
        style={{
          backgroundImage: 'linear-gradient(92deg,#149578,#62cda2)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        book
      </span>
    </span>
  );
}

/** The lowercase "a" lettermark, for favicons / square icons. */
export function LetterMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-label="AgentBook"
      style={{
        display: 'inline-grid',
        placeContent: 'center',
        width: size,
        height: size,
        borderRadius: '24%',
        background: 'radial-gradient(120% 120% at 50% 35%,#283038,#161c22)',
      }}
    >
      <span
        style={{
          fontFamily: SANS,
          fontWeight: 720,
          fontSize: size * 0.62,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          marginTop: -size * 0.04,
          backgroundImage: 'linear-gradient(120deg,#0c6e57,#149578,#62cda2)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        a
      </span>
    </span>
  );
}
