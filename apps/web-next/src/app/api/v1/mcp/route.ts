import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticateMcpRequest } from '@/lib/mcp/authenticate-mcp-request';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';
import { callAgentBrain } from '@/lib/mcp/ask-agentbook-tool';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';

async function handle(request: NextRequest): Promise<Response> {
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: 'MCP is not enabled for this deployment' }, { status: 503 });
  }

  const auth = await authenticateMcpRequest(request);
  if ('error' in auth) return auth.error;

  const server = new McpServer({ name: 'agentbook', version: '1.0.0' });

  server.registerTool(
    'ask_agentbook',
    {
      description:
        'Ask AgentBook anything about your finances, or ask it to record an expense, ' +
        'create an invoice, or take another action. Destructive actions require ' +
        'explicit human confirmation before anything is written.',
      inputSchema: { message: z.string(), conversationId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ message, conversationId }) => {
      try {
        const result = await callAgentBrain({ text: message, tenantId: auth.tenantId, conversationId });
        return { content: [{ type: 'text', text: result.data.message }] };
      } catch (err) {
        // AgentBrainError's message is already safe to surface (no stack
        // traces/internal URLs); the correlationId is logged server-side
        // (Task 7's callAgentBrain), not sent to the client.
        const message = err instanceof Error ? err.message : 'AgentBook is temporarily unavailable.';
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );

  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
