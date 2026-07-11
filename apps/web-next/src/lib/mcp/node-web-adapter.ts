import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { NextRequest } from 'next/server';

/**
 * Bridges a Next.js App Router `NextRequest` (Web Fetch API) to genuine Node
 * `IncomingMessage`/`ServerResponse` objects, so Koa-based libraries (like
 * `oidc-provider`) that expect a real Node `(req, res)` handler can be mounted
 * inside a Next.js route handler.
 *
 * Reused as-is by the MCP Streamable HTTP route (Task 7), which needs this to
 * support long-lived/streaming responses — not just one-shot JSON — so header
 * casing and multi-value header handling matter beyond this task's immediate use.
 */
export async function nodeRequestResponseFromWeb(request: NextRequest): Promise<{
  nodeReq: IncomingMessage;
  nodeRes: ServerResponse;
  responsePromise: Promise<Response>;
}> {
  const url = new URL(request.url);
  const bodyBuffer =
    request.method !== 'GET' && request.method !== 'HEAD'
      ? Buffer.from(await request.arrayBuffer())
      : Buffer.alloc(0);

  const socket = new Socket();
  const nodeReq = new IncomingMessage(socket);
  nodeReq.method = request.method;
  nodeReq.url = url.pathname + url.search;
  // Web `Headers` iterates entries with already-lower-cased names, matching
  // Node's `IncomingMessage.headers` semantics.
  nodeReq.headers = Object.fromEntries(request.headers.entries());
  process.nextTick(() => {
    nodeReq.push(bodyBuffer);
    nodeReq.push(null);
  });

  const nodeRes = new ServerResponse(nodeReq);
  const chunks: Buffer[] = [];
  const originalWrite = nodeRes.write.bind(nodeRes);
  const originalEnd = nodeRes.end.bind(nodeRes);
  (nodeRes.write as unknown as (...args: unknown[]) => boolean) = (
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWrite as any)(chunk, ...rest);
  };

  const responsePromise = new Promise<Response>((resolve) => {
    (nodeRes.end as unknown as (...args: unknown[]) => ServerResponse) = (
      chunk?: unknown,
      ...rest: unknown[]
    ) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(nodeRes.getHeaders())) {
        if (value === undefined) continue;
        // `getHeaders()` returns arrays for headers set multiple times (e.g.
        // `Set-Cookie`). `Headers.set()` would overwrite prior values (and
        // even joining them into a single call collapses them into one
        // comma-joined string), so each value needs its own `.append()` call
        // to preserve them as distinct header lines, matching Node http
        // semantics where a client sees multiple `Set-Cookie` headers.
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          headers.append(key, String(v));
        }
      }
      resolve(new Response(Buffer.concat(chunks), { status: nodeRes.statusCode, headers }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalEnd as any)(chunk, ...rest);
    };
  });

  return { nodeReq, nodeRes, responsePromise };
}
