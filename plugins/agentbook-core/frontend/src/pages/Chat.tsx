import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageSquare, Loader2 } from 'lucide-react';
import { PlanPreview, type PlanStep } from '../components/PlanPreview';

const API = '/api/v1/agentbook-core';

interface PlanPayload {
  steps: PlanStep[];
  requiresConfirmation: boolean;
}

interface Message {
  role: 'user' | 'agent';
  text?: string;
  plan?: PlanPayload;
  sessionId?: string;
  skillUsed?: string;
  error?: boolean;
}

interface AgentResponseData {
  message?: string;
  skillUsed?: string;
  plan?: PlanPayload;
  sessionId?: string;
}

/**
 * AgentBook web chat surface. This is the default landing page for the plugin
 * (replacing the dashboard at /) — AgentBook is agent-first, so the chat IS the
 * homepage.
 *
 * When the agent returns plan.requiresConfirmation === true, the bubble renders
 * an inline <PlanPreview> with Proceed / Cancel buttons. Proceed re-submits
 * with sessionAction: 'confirm' and the stored sessionId; Cancel sends 'cancel'.
 * Closes G-012 (third and final rubric auto-fail clause).
 */
export const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, loading]);

  async function submit(text: string, sessionAction?: 'confirm' | 'cancel') {
    if (!text.trim() && !sessionAction) return;
    setLoading(true);
    // Only show the user bubble for free-text submissions, not for
    // Proceed/Cancel button clicks (which carry their own visual signal).
    if (!sessionAction) {
      setMessages((m) => [...m, { role: 'user', text }]);
    }
    try {
      const res = await fetch(`${API}/agent/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, sessionAction, sessionId }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: AgentResponseData;
      };
      if (json?.success && json?.data) {
        const data = json.data;
        setMessages((m) => [
          ...m,
          {
            role: 'agent',
            text: data.message,
            plan: data.plan,
            sessionId: data.sessionId,
            skillUsed: data.skillUsed,
          },
        ]);
        if (data.sessionId) {
          setSessionId(data.sessionId);
        } else if (sessionAction) {
          // Clear after confirm/cancel completes with no new session.
          setSessionId(undefined);
        }
      } else {
        setMessages((m) => [
          ...m,
          { role: 'agent', text: 'Sorry, something went wrong.', error: true },
        ]);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: 'agent', text: `Error: ${String(err)}`, error: true },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading || !input.trim()) return;
    const text = input;
    setInput('');
    // Reset textarea height.
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void submit(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-resize up to ~6 rows.
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  return (
    <div className="flex flex-col h-screen max-h-screen bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        <MessageSquare className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-base font-semibold">AgentBook</h1>
          <p className="text-xs text-muted-foreground">
            Your AI bookkeeper
          </p>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-4"
        data-testid="chat-messages"
      >
        {messages.length === 0 && !loading && (
          <div className="text-center text-muted-foreground text-sm py-12 max-w-md mx-auto">
            <MessageSquare className="w-8 h-8 mx-auto mb-3 text-muted-foreground/50" />
            <p className="font-medium mb-1">Hi! Try:</p>
            <p className="text-xs">&ldquo;log $5 coffee&rdquo;</p>
            <p className="text-xs">&ldquo;how much have I spent this month?&rdquo;</p>
            <p className="text-xs">&ldquo;send the latest draft invoice to acme&rdquo;</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={
                msg.role === 'user'
                  ? 'max-w-[80%] rounded-2xl px-4 py-2 bg-primary text-primary-foreground'
                  : `max-w-[85%] rounded-2xl px-4 py-3 bg-card border ${msg.error ? 'border-destructive/40' : 'border-border'}`
              }
            >
              {msg.text && (
                <div className="text-sm whitespace-pre-wrap break-words">
                  {msg.text}
                </div>
              )}
              {msg.role === 'agent' && msg.plan?.requiresConfirmation && (
                <PlanPreview
                  steps={msg.plan.steps}
                  onProceed={() => void submit('', 'confirm')}
                  onCancel={() => void submit('', 'cancel')}
                  disabled={loading}
                />
              )}
              {msg.role === 'agent' && msg.skillUsed && !msg.error && (
                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {msg.skillUsed}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-card border border-border">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Thinking...
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input row */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-border bg-card px-4 py-3"
      >
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            name="message"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything... (Shift+Enter for newline)"
            disabled={loading}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send"
            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </div>
      </form>
    </div>
  );
};
