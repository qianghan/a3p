import 'server-only';
import { prisma } from '@naap/database';

export const MCP_FLAG_KEY = 'agentbook.mcp.enabled';

export async function isMcpEnabled(): Promise<boolean> {
  const row = await prisma.featureFlag.findUnique({ where: { key: MCP_FLAG_KEY } });
  return row?.enabled ?? false;
}
