'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Send } from 'lucide-react';
import type { TFn } from '@/hooks/use-t';

// HTML attribute value, not copy.
const SEND_HINT = 'send';
const iconBtn: React.CSSProperties = {
  width: 44, height: 44, flexShrink: 0, borderRadius: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))',
};
const sheetBtn: React.CSSProperties = {
  minHeight: 44, padding: '0 14px', borderRadius: 12, fontSize: 14,
  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))',
};

export function Composer({ t, value, onChange, onSend, sendDisabled, onPhoto }: {
  t: TFn; value: string; onChange: (v: string) => void; onSend: () => void; sendDisabled: boolean;
  onPhoto: (file: File) => void;
}) {
  const [sheet, setSheet] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 44), 120)}px`;
  }, [value]);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setSheet(false);
    if (f) onPhoto(f);
  };

  return (
    <div data-testid="chat-composer" style={{
      borderTop: '1px solid hsl(var(--border))', background: 'hsl(var(--card))',
      padding: '8px 12px', paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
    }}>
      {sheet && (
        <div data-testid="chat-attach-sheet" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <button type="button" data-testid="chat-attach-camera" onClick={() => cameraRef.current?.click()} style={sheetBtn}>
            {t('mobile.chat.attach_camera')}
          </button>
          <button type="button" data-testid="chat-attach-library" onClick={() => libraryRef.current?.click()} style={sheetBtn}>
            {t('mobile.chat.attach_library')}
          </button>
          <button type="button" data-testid="chat-attach-close" onClick={() => setSheet(false)} style={sheetBtn}>
            {t('mobile.chat.attach_close')}
          </button>
        </div>
      )}
      <input ref={cameraRef} data-testid="chat-file-camera" type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={libraryRef} data-testid="chat-file-library" type="file" accept="image/*" hidden onChange={pick} />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <button type="button" data-testid="chat-attach" aria-label={t('mobile.chat.attach')} aria-expanded={sheet}
          onClick={() => setSheet((s) => !s)} style={iconBtn}>
          <Paperclip aria-hidden style={{ width: 20, height: 20 }} />
        </button>
        <textarea
          ref={taRef}
          data-testid="chat-input"
          rows={1}
          value={value}
          enterKeyHint={SEND_HINT}
          aria-label={t('mobile.chat.placeholder')}
          placeholder={t('mobile.chat.placeholder')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: an IME (zh-CN pinyin) uses Enter to commit a candidate.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!sendDisabled) onSend();
            }
          }}
          style={{
            flex: 1, resize: 'none', minHeight: 44, maxHeight: 120, padding: '11px 14px', borderRadius: 22,
            border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))',
            color: 'hsl(var(--foreground))', fontSize: 16, lineHeight: '20px',
          }}
        />
        <button type="button" data-testid="chat-send" aria-label={t('mobile.chat.send')} disabled={sendDisabled}
          onClick={onSend} style={{ ...iconBtn, opacity: sendDisabled ? 0.5 : 1 }}>
          <Send aria-hidden style={{ width: 20, height: 20 }} />
        </button>
      </div>
    </div>
  );
}
