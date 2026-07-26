import React from 'react';

/**
 * Theme-aware horizontal workflow diagram used across the guides. Renders 2–4
 * steps as rounded nodes joined by arrows. Colours come from the `.gd-diagram`
 * CSS classes (defined in guides/layout.tsx) so it adapts to light/dark.
 * Labels may contain "\n" for a second line; `sub` is an optional caption.
 */
export function Flow({
  steps,
  caption,
  highlightLast = true,
}: {
  steps: { label: string; sub?: string }[];
  caption?: string;
  highlightLast?: boolean;
}) {
  const W = 600;
  const H = 116;
  const gap = 34;
  const pad = 6;
  const n = steps.length;
  const nodeW = (W - pad * 2 - gap * (n - 1)) / n;
  const nodeH = 66;
  const y = 22;

  return (
    <figure className="gd-fig">
      <svg className="gd-diagram" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption || 'workflow diagram'}>
        <defs>
          <marker id="gd-ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path className="head" d="M0,0 L6,3 L0,6 Z" />
          </marker>
        </defs>
        {steps.map((s, i) => {
          const x = pad + i * (nodeW + gap);
          const cx = x + nodeW / 2;
          const isLast = i === n - 1;
          const lines = s.label.split('\n');
          const labelY = y + nodeH / 2 - (s.sub ? 8 : (lines.length - 1) * 8) + 4;
          return (
            <g key={i}>
              <rect
                className={isLast && highlightLast ? 'node' : 'node-plain'}
                x={x}
                y={y}
                width={nodeW}
                height={nodeH}
                rx={11}
              />
              {lines.map((ln, li) => (
                <text key={li} className="lbl" x={cx} y={labelY + li * 15} textAnchor="middle">
                  {ln}
                </text>
              ))}
              {s.sub && (
                <text className="sub" x={cx} y={y + nodeH - 12} textAnchor="middle">
                  {s.sub}
                </text>
              )}
              {i < n - 1 && (
                <line
                  className="flow"
                  x1={x + nodeW + 4}
                  y1={y + nodeH / 2}
                  x2={x + nodeW + gap - 4}
                  y2={y + nodeH / 2}
                  markerEnd="url(#gd-ah)"
                />
              )}
            </g>
          );
        })}
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
