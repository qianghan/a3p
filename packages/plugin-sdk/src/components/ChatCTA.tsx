/**
 * ChatCTA — a small banner that points users from a form page at the chat
 * (PR 41 / Tier 1 #1).
 *
 * The rubric calls for agent-first surfaces: any page where the primary
 * task can be expressed as a chat message should offer the chat path
 * prominently. Drop this at the top of a form page with a sample prompt
 * and it gives the user a one-click escape hatch into the agent.
 *
 * Stateless, props-only. No data fetching. The href defaults to
 * `/agentbook` (the agentbook-core mount point) but is overridable for
 * non-default mount paths.
 */

import React from 'react';

export interface ChatCTAProps {
  /**
   * Example utterance the user could type. Rendered after a short label so
   * the banner reads naturally: "Try the agent instead — 'I spent $42 at
   * Starbucks today'".
   */
  example: string;
  /** Optional override of the chat link. Defaults to '/agentbook'. */
  href?: string;
  /** Optional override of the label preceding the example. */
  label?: string;
  /** Optional className override appended to the banner container. */
  className?: string;
}

export const ChatCTA: React.FC<ChatCTAProps> = ({
  example,
  href = '/agentbook',
  label = 'Try the agent instead',
  className = '',
}) => {
  return (
    <a
      href={href}
      className={`group inline-flex items-center gap-3 mb-6 px-4 py-2.5 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors text-sm w-full sm:max-w-xl ${className}`}
      data-testid="chat-cta"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 flex-shrink-0 text-primary"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span className="flex-1 truncate">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground"> — &ldquo;{example}&rdquo;</span>
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 flex-shrink-0 opacity-40 group-hover:opacity-80 transition-opacity"
      >
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </a>
  );
};
