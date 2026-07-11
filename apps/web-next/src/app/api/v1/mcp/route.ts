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
    async ({ message, conversationId }, extra) => {
      try {
        const result = await callAgentBrain({ text: message, tenantId: auth.tenantId, conversationId });

        if (result.data.plan?.requiresConfirmation) {
          // Real capability check: whether *this* server instance recorded an
          // `elicitation` capability from the client's `initialize` handshake.
          // NOTE — see Task 8 report: under this route's current stateless
          // transport (`sessionIdGenerator: undefined`, a fresh McpServer per
          // HTTP request), `getClientCapabilities()` is verified to always
          // return undefined here, because the `initialize` request is
          // handled by a *different*, already-discarded server instance. This
          // check is still the objectively correct one (`extra.sendRequest`
          // is a non-optional field, always present regardless of client
          // capability, so `Boolean(extra.sendRequest)` can never be false
          // and would be dead code) — it just can't succeed until the
          // transport is made session-aware. Once that lands, this check
          // starts working correctly with no further change needed here.
          const supportsElicitation = Boolean(server.server.getClientCapabilities()?.elicitation);
          if (!supportsElicitation) {
            return {
              content: [{
                type: 'text',
                text: 'This connection doesn\'t support secure confirmation for actions that write ' +
                  'data, so I can\'t proceed with that. Read-only questions still work — or reconnect ' +
                  'using a client with elicitation support (e.g. Claude Desktop/Code).',
              }],
              isError: true,
            };
          }

          const elicited = await extra.sendRequest(
            {
              method: 'elicitation/create',
              params: {
                message: result.data.message,
                requestedSchema: {
                  type: 'object',
                  properties: { confirm: { type: 'boolean', title: 'Proceed with this action?' } },
                  required: ['confirm'],
                },
              },
            },
            z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.object({ confirm: z.boolean() }).optional() }),
          );

          if (elicited.action !== 'accept' || !elicited.content?.confirm) {
            return { content: [{ type: 'text', text: 'Action cancelled — nothing was recorded.' }] };
          }

          const confirmed = await callAgentBrain({
            text: message,
            tenantId: auth.tenantId,
            conversationId,
            sessionAction: 'confirm',
          });
          return { content: [{ type: 'text', text: confirmed.data.message }] };
        }

        return { content: [{ type: 'text', text: result.data.message }] };
      } catch (err) {
        // AgentBrainError's message is already safe to surface (no stack
        // traces/internal URLs); the correlationId is logged server-side
        // (Task 7's callAgentBrain), not sent to the client.
        const errMessage = err instanceof Error ? err.message : 'AgentBook is temporarily unavailable.';
        return { content: [{ type: 'text', text: errMessage }], isError: true };
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
