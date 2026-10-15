'use client';

import React from 'react';
import { formatMessage, type Inline } from '@/app/app/_lib/format-message';

function inline(parts: Inline[], key: string): React.ReactNode[] {
  return parts.map((p, i) =>
    p.kind === 'bold' ? (
      <strong key={`${key}-${i}`}>{p.text}</strong>
    ) : (
      <React.Fragment key={`${key}-${i}`}>{p.text}</React.Fragment>
    ),
  );
}

/** Renders formatMessage() blocks as React nodes. Never parses HTML. */
export function MessageBody({ text }: { text: string }) {
  const blocks = formatMessage(text);
  return (
    <div data-testid="chat-message-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {blocks.map((b, bi) => {
        if (b.kind === 'bullets') {
          return (
            <ul key={bi} style={{ margin: 0, paddingLeft: 20 }}>
              {b.items.map((it, ii) => <li key={ii}>{inline(it, `${bi}-${ii}`)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'numbered') {
          return (
            <ol key={bi} start={b.start} style={{ margin: 0, paddingLeft: 22 }}>
              {b.items.map((it, ii) => <li key={ii}>{inline(it, `${bi}-${ii}`)}</li>)}
            </ol>
          );
        }
        return (
          <p key={bi} style={{ margin: 0 }}>
            {b.lines.map((line, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {inline(line, `${bi}-${li}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
