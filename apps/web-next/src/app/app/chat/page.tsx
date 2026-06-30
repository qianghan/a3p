'use client';

import React, { useRef, useState } from 'react';
import { Send } from 'lucide-react';

interface Msg { role: 'user' | 'agent'; text: string }

/** Pull a human-readable reply out of the agent brain result, whatever the field. */
function replyText(data: unknown): string {
  if (!data || typeof data !== 'object') return 'Done.';
  const d = data as Record<string, unknown>;
  for (const k of ['message', 'reply', 'text', 'answer', 'response']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (d.data && typeof d.data === 'object') return replyText(d.data);
  return 'Done.';
}

export default function MobileChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    setMsgs((m) => [...m, { role: 'user', text: t }]);
    setBusy(true);
    try {
      const r = await fetch('/api/v1/agentbook-core/agent/message', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }),
      });
      const j = await r.json();
      setMsgs((m) => [...m, { role: 'agent', text: r.ok ? replyText(j) : (j.error || 'Something went wrong.') }]);
    } catch {
      setMsgs((m) => [...m, { role: 'agent', text: 'Network error.' }]);
    } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 64px)', color: 'var(--foreground,#fff)' }}>
      <div style={{ padding: '16px 16px 8px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 500 }}>Ask AgentBook</h1>
        <p style={{ fontSize: 13, color: 'var(--muted-foreground,#888)' }}>e.g. “how much did I spend on travel?”</p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '82%', padding: '10px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.5,
            background: m.role === 'user' ? '#10b981' : 'var(--card,#1a1a1a)',
            color: m.role === 'user' ? '#04130c' : 'var(--foreground,#fff)',
          }}>
            {m.text}
          </div>
        ))}
        {busy && <div style={{ alignSelf: 'flex-start', color: 'var(--muted-foreground,#888)', fontSize: 13 }}>…thinking</div>}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border,#262626)' }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          placeholder="Type a message…"
          style={{ flex: 1, padding: '12px 14px', borderRadius: 22, border: '1px solid var(--border,#333)', background: 'var(--background,#0a0a0a)', color: 'var(--foreground,#fff)', fontSize: 16 }} />
        <button onClick={() => void send()} disabled={busy || !text.trim()}
          style={{ width: 44, height: 44, borderRadius: 22, border: 'none', background: '#10b981', color: '#04130c', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.5 : 1 }}>
          <Send style={{ width: 18, height: 18 }} />
        </button>
      </div>
    </div>
  );
}
