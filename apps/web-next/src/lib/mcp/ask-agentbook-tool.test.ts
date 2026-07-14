import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-config', () => ({
  getAppBaseUrl: vi.fn(() => 'https://agentbook.brainliber.com'),
}));

import { callAgentBrain, AgentBrainError } from './ask-agentbook-tool';

const originalFetch = global.fetch;

describe('callAgentBrain', () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  it('posts to agent-brain with channel "mcp" and the resolved tenant header', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { message: 'You spent $42 this week.' } }),
    });

    const result = await callAgentBrain({ text: 'top spending?', tenantId: 'user-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/agentbook-core/agent/message'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-tenant-id': 'user-1' }),
      }),
    );
    const [, options] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({ text: 'top spending?', tenantId: 'user-1', channel: 'mcp' });
    expect(result.data.message).toBe('You spent $42 this week.');
  });

  it('surfaces a real plan.requiresConfirmation shape, not an invented field', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        data: { message: 'Record $42 to Uber as Travel?', plan: { steps: [{ id: '1' }], requiresConfirmation: true } },
      }),
    });
    const result = await callAgentBrain({ text: 'log $42 uber ride', tenantId: 'user-1' });
    expect(result.data.plan?.requiresConfirmation).toBe(true);
  });

  it('throws a safe AgentBrainError with a correlation id on network failure, no raw error leaked', async () => {
    (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:4150 — internal detail'));
    await expect(callAgentBrain({ text: 'hi', tenantId: 'user-1' })).rejects.toBeInstanceOf(AgentBrainError);
    await expect(callAgentBrain({ text: 'hi', tenantId: 'user-1' })).rejects.toMatchObject({
      name: 'AgentBrainError',
      message: expect.not.stringContaining('10.0.0.5'),
      correlationId: expect.any(String),
    });
  });

  it('resolves its target host via getAppBaseUrl(), not a raw localhost fallback', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { message: 'ok' } }),
    });

    await callAgentBrain({ text: 'hi', tenantId: 'user-1' });

    const [url] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://agentbook.brainliber.com/api/v1/agentbook-core/agent/message');
  });
});
