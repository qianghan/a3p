import 'server-only';
import crypto from 'crypto';
import { PLUGIN_PORTS, DEFAULT_PORT } from '@/lib/plugin-ports';

const CORE_URL = process.env.AGENTBOOK_CORE_URL || `http://localhost:${PLUGIN_PORTS['agentbook-core'] || DEFAULT_PORT}`;

export interface AgentResponse {
  success: boolean;
  data: {
    message: string;
    skillUsed?: string;
    confidence?: number;
    sessionId?: string;
    plan?: { steps: unknown[]; requiresConfirmation: boolean };
  };
}

export class AgentBrainError extends Error {
  correlationId: string;
  constructor(message: string, correlationId: string) {
    super(message);
    this.name = 'AgentBrainError';
    this.correlationId = correlationId;
  }
}

export async function callAgentBrain(params: {
  text: string;
  tenantId: string;
  conversationId?: string;
  sessionAction?: 'confirm' | 'cancel';
}): Promise<AgentResponse> {
  const correlationId = crypto.randomUUID();
  try {
    const response = await fetch(`${CORE_URL}/api/v1/agentbook-core/agent/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': params.tenantId },
      body: JSON.stringify({
        text: params.text,
        tenantId: params.tenantId,
        channel: 'mcp',
        chatId: params.conversationId,
        sessionAction: params.sessionAction,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[mcp:${correlationId}] agent-brain returned ${response.status}`, body);
      throw new AgentBrainError('AgentBook is temporarily unavailable — try again shortly.', correlationId);
    }
    return JSON.parse(body) as AgentResponse;
  } catch (err) {
    if (err instanceof AgentBrainError) throw err;
    console.error(`[mcp:${correlationId}] agent-brain call failed`, err);
    throw new AgentBrainError('AgentBook is temporarily unavailable — try again shortly.', correlationId);
  }
}
