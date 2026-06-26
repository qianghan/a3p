import { useEffect, useState } from 'react';
import {
  Send, Key, Loader2, Trash2, RefreshCw,
  CheckCircle, XCircle, AlertCircle, ExternalLink,
} from 'lucide-react';

const API = '/api/v1/agentbook-core';

interface BotStatus {
  configured: boolean;
  enabled?: boolean;
  botUsername?: string;
  chatIds?: string[];
  webhookUrl?: string;
  webhookActive?: boolean | null;
  lastError?: string | null;
}

interface SetupResult {
  botUsername: string;
  botName: string;
  webhookRegistered: boolean;
  webhookUrl: string;
}

export function TelegramCard(): JSX.Element {
  const [status, setStatus]           = useState<BotStatus | null>(null);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [botToken, setBotToken]       = useState('');
  const [error, setError]             = useState<string | null>(null);
  const [success, setSuccess]         = useState<string | null>(null);

  const fetchStatus = async (): Promise<void> => {
    try {
      const res = await fetch(`${API}/telegram/status`);
      const d = await res.json();
      if (d.success) setStatus(d.data);
    } catch {
      setError('Could not load Telegram status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchStatus(); }, []);

  const handleSetup = async (): Promise<void> => {
    if (!botToken.trim() || !botToken.includes(':')) {
      setError('Enter a valid bot token (format: 123456789:ABCdef...)');
      return;
    }
    setSaving(true); setError(null); setSuccess(null);
    try {
      const res = await fetch(`${API}/telegram/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      const d = await res.json();
      if (d.success) {
        const result = d.data as SetupResult;
        setSuccess(`Connected to @${result.botUsername}!${result.webhookRegistered ? ' Webhook registered.' : ' Webhook needs manual setup.'}`);
        setBotToken('');
        await fetchStatus();
      } else {
        setError(d.error || 'Setup failed');
      }
    } catch {
      setError('Connection failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    if (!confirm('Disconnect your Telegram bot? You can reconnect anytime.')) return;
    setDisconnecting(true);
    try {
      await fetch(`${API}/telegram/disconnect`, { method: 'DELETE' });
      setStatus({ configured: false });
      setSuccess('Telegram bot disconnected.');
    } catch {
      setError('Could not disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-lg">✈️</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">Telegram</div>
          <div className="text-xs text-muted-foreground">
            {status?.configured && status.botUsername
              ? `@${status.botUsername}`
              : 'Record expenses and manage finances via chat'}
          </div>
        </div>
        {status?.configured && (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            ● Connected
          </span>
        )}
        {status !== null && !status.configured && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
            Not connected
          </span>
        )}
      </div>

      <div className="px-4 py-4">
        {/* Alerts */}
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {success && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm text-foreground">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            {success}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : status?.configured ? (
          /* Connected state */
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">Webhook</div>
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  status.webhookActive === true ? 'text-primary' :
                  status.webhookActive === false ? 'text-destructive' : 'text-muted-foreground'
                }`}>
                  {status.webhookActive === true ? <CheckCircle className="h-3.5 w-3.5" /> :
                   status.webhookActive === false ? <XCircle className="h-3.5 w-3.5" /> :
                   <AlertCircle className="h-3.5 w-3.5" />}
                  {status.webhookActive === true ? 'Active' :
                   status.webhookActive === false ? 'Error' : 'Unknown'}
                </div>
              </div>
              <div className="rounded-lg bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">Linked chats</div>
                <div className="text-sm font-medium text-foreground">
                  {(status.chatIds as string[])?.length ?? 0}
                </div>
              </div>
            </div>
            {status.lastError && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Last error: {status.lastError}
              </div>
            )}
            <div className="rounded-lg bg-background px-3 py-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Quick start</div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Open{' '}
                {status.botUsername && (
                  <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer"
                    className="text-primary hover:underline">
                    {status.botUsername}
                  </a>
                )}{' '}
                → send <code className="rounded bg-muted px-1 py-0.5">/start</code> → type expenses naturally
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-3">
                {status.botUsername && (
                  <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline">
                    Open in Telegram <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button onClick={() => { void fetchStatus(); setError(null); setSuccess(null); }}
                  className="text-xs text-muted-foreground hover:text-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <button onClick={() => void handleDisconnect()} disabled={disconnecting}
                className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80">
                {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          /* Not connected state */
          <div className="space-y-3">
            <ol className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">1</span>
                Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"
                  className="mx-1 text-primary hover:underline">@BotFather</a> in Telegram
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">2</span>
                Send <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">/newbot</code> and follow prompts
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">3</span>
                Copy the API token and paste below
              </li>
            </ol>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Key className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="password"
                  placeholder="Paste bot token here"
                  value={botToken}
                  onChange={e => { setBotToken(e.target.value); setError(null); }}
                  onKeyDown={e => e.key === 'Enter' && void handleSetup()}
                  className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>
              <button
                onClick={() => void handleSetup()}
                disabled={saving || !botToken.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {saving ? 'Connecting…' : 'Connect Bot'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
