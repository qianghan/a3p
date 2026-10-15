import type { ChatPlanStep, ChatReply, ChatTurn } from '@/app/app/_lib/api';
import type { FromReceiptResult } from '@/lib/mobile/types';

/** AbAgentSession.expiresAt = creation + 24h (agent-planner.ts createSession). */
export const PENDING_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
/** agent/message falls back to 60 s when the limiter supplies no retryAfterMs. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;

export type FailureKind = 'offline' | 'server' | 'rate_limited';
export type PlanState = 'open' | 'proceeding' | 'cancelling' | 'done';

export interface UserItem {
  id: string;
  kind: 'user';
  text: string;
  status: 'sending' | 'sent' | 'failed';
  failure?: FailureKind;
}
export interface BotItem {
  id: string;
  kind: 'bot';
  text: string;
  plan: { steps: ChatPlanStep[] } | null;
  pendingFromHistory: boolean;
  planState: PlanState | null;
  suggestions: string[];
  undoAvailable: boolean;
  errorKey: 'action_failed' | null;
}
export interface ReceiptItem {
  id: string;
  kind: 'receipt';
  status: 'uploading' | 'done' | 'failed';
  idempotencyKey: string;
  result: FromReceiptResult | null;
}
export type ChatItem = UserItem | BotItem | ReceiptItem;

export interface ChatState {
  history: 'loading' | 'ready' | 'error';
  items: ChatItem[];
  busy: boolean;
  rateLimitedUntil: number | null;
  rateLimitMessage: string | null;
}

export const initialChatState: ChatState = {
  history: 'loading',
  items: [],
  busy: false,
  rateLimitedUntil: null,
  rateLimitMessage: null,
};

export type ChatAction =
  | { type: 'history_loading' }
  | { type: 'history_loaded'; turns: ChatTurn[]; now: number }
  | { type: 'history_failed' }
  | { type: 'send_started'; id: string; text: string }
  | { type: 'retry_started'; id: string }
  | { type: 'send_failed'; id: string; failure: FailureKind }
  | { type: 'reply'; userId: string | null; replyId: string; reply: ChatReply }
  | { type: 'action_started'; botId: string; action: 'confirm' | 'cancel' }
  | { type: 'undo_started'; botId: string }
  | { type: 'action_failed'; botId: string; errorId: string; restoreUndo: boolean }
  | { type: 'rate_limited'; until: number; message: string | null }
  | { type: 'rate_limit_cleared' }
  | { type: 'receipt_started'; id: string; idempotencyKey: string }
  | { type: 'receipt_done'; id: string; result: FromReceiptResult }
  | { type: 'receipt_failed'; id: string };

function bot(id: string, text: string): BotItem {
  return {
    id, kind: 'bot', text, plan: null, pendingFromHistory: false, planState: null,
    suggestions: [], undoAvailable: false, errorKey: null,
  };
}

function botFromReply(id: string, reply: ChatReply): BotItem {
  const confirm = reply.plan?.requiresConfirmation === true;
  return {
    ...bot(id, typeof reply.message === 'string' ? reply.message : ''),
    plan: confirm ? { steps: Array.isArray(reply.plan?.steps) ? reply.plan!.steps : [] } : null,
    planState: confirm ? 'open' : null,
    suggestions: Array.isArray(reply.suggestions)
      ? reply.suggestions.filter((s) => typeof s === 'string' && s.trim() !== '').slice(0, 4)
      : [],
    undoAvailable: reply.undoAvailable === true,
  };
}

export function historyToItems(turns: ChatTurn[], now: number): ChatItem[] {
  const items: ChatItem[] = turns.map((turn, i) =>
    turn.role === 'user'
      ? ({ id: `h-${i}`, kind: 'user', text: turn.text, status: 'sent' } as UserItem)
      : bot(`h-${i}`, turn.text),
  );
  const last = turns[turns.length - 1] as (ChatTurn & { intent?: string }) | undefined;
  if (last && last.role === 'bot' && last.intent === 'planner') {
    const age = now - Date.parse(last.at);
    if (Number.isFinite(age) && age >= 0 && age < PENDING_PLAN_TTL_MS) {
      const idx = items.length - 1;
      items[idx] = { ...(items[idx] as BotItem), pendingFromHistory: true, planState: 'open' };
    }
  }
  return items;
}

const mapBot = (items: ChatItem[], id: string, f: (b: BotItem) => BotItem): ChatItem[] =>
  items.map((it) => (it.kind === 'bot' && it.id === id ? f(it) : it));
const mapUser = (items: ChatItem[], id: string, f: (u: UserItem) => UserItem): ChatItem[] =>
  items.map((it) => (it.kind === 'user' && it.id === id ? f(it) : it));
const mapReceipt = (items: ChatItem[], id: string, f: (r: ReceiptItem) => ReceiptItem): ChatItem[] =>
  items.map((it) => (it.kind === 'receipt' && it.id === id ? f(it) : it));

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history_loading':
      return { ...state, history: 'loading' };
    case 'history_loaded':
      return { ...state, history: 'ready', items: [...historyToItems(action.turns, action.now), ...state.items] };
    case 'history_failed':
      return { ...state, history: 'error' };
    case 'send_started':
      return {
        ...state,
        busy: true,
        items: [...state.items, { id: action.id, kind: 'user', text: action.text, status: 'sending' }],
      };
    case 'retry_started':
      return { ...state, busy: true, items: mapUser(state.items, action.id, (u) => ({ ...u, status: 'sending', failure: undefined })) };
    case 'send_failed':
      return { ...state, busy: false, items: mapUser(state.items, action.id, (u) => ({ ...u, status: 'failed', failure: action.failure })) };
    case 'reply': {
      const next = botFromReply(action.replyId, action.reply);
      const items = state.items.map((it): ChatItem => {
        if (it.kind === 'user' && action.userId && it.id === action.userId) {
          return { ...it, status: 'sent', failure: undefined };
        }
        if (it.kind !== 'bot') return it;
        let b = it;
        if (b.planState === 'proceeding' || b.planState === 'cancelling') b = { ...b, planState: 'done' };
        if (next.planState === 'open' && b.planState === 'open') b = { ...b, planState: 'done' };
        if (b.undoAvailable) b = { ...b, undoAvailable: false };
        return b;
      });
      return { ...state, busy: false, items: [...items, next] };
    }
    case 'action_started':
      return {
        ...state,
        busy: true,
        items: mapBot(state.items, action.botId, (b) => ({
          ...b, planState: action.action === 'confirm' ? 'proceeding' : 'cancelling',
        })),
      };
    case 'undo_started':
      return { ...state, busy: true, items: mapBot(state.items, action.botId, (b) => ({ ...b, undoAvailable: false })) };
    case 'action_failed': {
      const items = mapBot(state.items, action.botId, (b) => ({
        ...b,
        planState: b.planState === 'proceeding' || b.planState === 'cancelling' ? 'open' : b.planState,
        undoAvailable: action.restoreUndo ? true : b.undoAvailable,
      }));
      return { ...state, busy: false, items: [...items, { ...bot(action.errorId, ''), errorKey: 'action_failed' }] };
    }
    case 'rate_limited':
      return { ...state, rateLimitedUntil: action.until, rateLimitMessage: action.message };
    case 'rate_limit_cleared':
      return { ...state, rateLimitedUntil: null, rateLimitMessage: null };
    case 'receipt_started': {
      const exists = state.items.some((it) => it.kind === 'receipt' && it.id === action.id);
      return exists
        ? { ...state, items: mapReceipt(state.items, action.id, (r) => ({ ...r, status: 'uploading' })) }
        : {
            ...state,
            items: [...state.items, { id: action.id, kind: 'receipt', status: 'uploading', idempotencyKey: action.idempotencyKey, result: null }],
          };
    }
    case 'receipt_done':
      return { ...state, items: mapReceipt(state.items, action.id, (r) => ({ ...r, status: 'done', result: action.result })) };
    case 'receipt_failed':
      return { ...state, items: mapReceipt(state.items, action.id, (r) => ({ ...r, status: 'failed' })) };
    default:
      return state;
  }
}

type ErrLike = { status?: number; code?: string; retryAfterMs?: number; message?: string } | null | undefined;

export function classifyFailure(err: unknown, online: boolean): FailureKind {
  const e = (typeof err === 'object' ? err : null) as ErrLike;
  if (e?.status === 429) return 'rate_limited';
  if (!online || err instanceof TypeError || e?.status === 0 || e?.code === 'offline') return 'offline';
  return 'server';
}

export function retryAfterFrom(err: unknown): number {
  const ms = (typeof err === 'object' && err ? (err as ErrLike)?.retryAfterMs : undefined);
  return typeof ms === 'number' && ms > 0 ? ms : DEFAULT_RETRY_AFTER_MS;
}

/** The server's localized 429 `message`, when api.ts surfaced it (not a machine code). */
export function serverMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.trim();
  if (!m || m === 'rate_limited' || /^[a-z_]+$/.test(m)) return null;
  return m;
}
