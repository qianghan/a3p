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
 *
 * IMPORTANT (found while wiring up stateful elicitation, Task 8-fix): the
 * `responsePromise` this function returns MUST resolve as soon as headers are
 * written (`writeHead`), with a `Response` whose body is a *live*
 * `ReadableStream` fed incrementally as `write()`/`end()` are called — NOT
 * only once `.end()` fires. `StreamableHTTPServerTransport.handleRequest()`
 * (the MCP SDK's Node wrapper, via `@hono/node-server`) does not resolve
 * until the SSE stream it's writing fully closes. For a long-lived
 * elicitation round-trip, that means: if this adapter only resolved
 * `responsePromise` at `.end()` time, the calling route handler could never
 * hand a `Response` back to the real HTTP client until the *entire*
 * conversation (including the reply it's still waiting on) had already
 * finished — a deadlock, since the client can't send that reply without
 * first seeing the `elicitation/create` event, which it can only do once it
 * has actually received (a prefix of) this response.
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
  // `IncomingMessage.rawHeaders` is a *separate* field from `.headers` — a
  // freshly constructed `IncomingMessage` initializes it to `[]` and nothing
  // derives it from `.headers` automatically. Libraries built on
  // `@hono/node-server`'s `getRequestListener` (which is what
  // `StreamableHTTPServerTransport.handleRequest()` uses internally to
  // bridge back to a Web Standard `Request`) read headers from
  // `incoming.rawHeaders`, not `incoming.headers`. Without this, every
  // header — `Accept`, `Content-Type`, `Mcp-Session-Id`, the bearer token —
  // would silently vanish by the time the MCP SDK's transport sees the
  // request, even though `nodeReq.headers` looks correctly populated.
  nodeReq.rawHeaders = Object.entries(nodeReq.headers).flatMap(([key, value]) =>
    Array.isArray(value) ? value.flatMap((v) => [key, v]) : [key, String(value)],
  );
  process.nextTick(() => {
    nodeReq.push(bodyBuffer);
    nodeReq.push(null);
  });

  const nodeRes = new ServerResponse(nodeReq);
  const originalWrite = nodeRes.write.bind(nodeRes);
  const originalEnd = nodeRes.end.bind(nodeRes);
  const originalWriteHead = nodeRes.writeHead.bind(nodeRes);
  // `write(chunk, encoding?, callback?)` / `end(chunk?, encoding?, callback?)`
  // are overloaded: the arg right after `chunk` is either a `BufferEncoding`
  // string or (if omitted) the callback itself. Only a string in that
  // position is a real encoding.
  const encodingFromRest = (rest: unknown[]): BufferEncoding | undefined =>
    typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : undefined;
  const toBuffer = (chunk: unknown, rest: unknown[]): Buffer =>
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, encodingFromRest(rest));

  // `writeHead(statusCode, headersObject)` — the form `@hono/node-server`'s
  // `getRequestListener` actually calls when bridging a Web `Response` back
  // onto this `ServerResponse` — writes those headers straight onto the wire
  // without also recording them in the `setHeader`-tracked map that
  // `getHeaders()` reads from. Left unhandled, every header set this way
  // (including the MCP SDK's `Mcp-Session-Id`, `Content-Type`, etc.) would
  // silently vanish from the `Response` this function resolves with, even
  // though the underlying bytes were written correctly. So capture whatever
  // is passed to `writeHead` directly, and merge it with `getHeaders()` when
  // building the `Response`'s headers below.
  const capturedWriteHeadHeaders: Record<string, string | string[]> = {};

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveResponse: ((response: Response) => void) | undefined;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  // Builds and resolves the `Response` the first time it's safe to do so
  // (i.e. once `writeHead` has run, so status/headers are final) with a body
  // that streams whatever gets `write()`/`end()`-ed afterwards. Idempotent —
  // only the first call actually resolves anything.
  function startResponse() {
    if (!resolveResponse) return;
    const resolve = resolveResponse;
    resolveResponse = undefined;

    const headers = new Headers();
    const allHeaders = { ...capturedWriteHeadHeaders, ...nodeRes.getHeaders() };
    for (const [key, value] of Object.entries(allHeaders)) {
      if (value === undefined) continue;
      // Headers set multiple times (e.g. `Set-Cookie`) come back as arrays.
      // `Headers.set()` would overwrite prior values (and even joining them
      // into a single call collapses them into one comma-joined string), so
      // each value needs its own `.append()` call to preserve them as
      // distinct header lines, matching Node http semantics where a client
      // sees multiple `Set-Cookie` headers.
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        headers.append(key, String(v));
      }
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        // Client disconnected/gave up reading; nothing more to do on our
        // side beyond letting subsequent enqueue attempts no-op below.
        streamController = undefined;
      },
    });

    resolve(new Response(body, { status: nodeRes.statusCode, headers }));
  }

  const enqueue = (buf: Buffer) => {
    if (buf.length === 0) return;
    try {
      streamController?.enqueue(new Uint8Array(buf));
    } catch {
      // Stream already closed/errored (e.g. client cancelled) — ignore,
      // matching how a real socket write would be a no-op post-disconnect.
    }
  };

  (nodeRes.writeHead as unknown as (...args: unknown[]) => ServerResponse) = (
    statusCode: unknown,
    ...rest: unknown[]
  ) => {
    const headersArg = (typeof rest[0] === 'object' && rest[0] !== null ? rest[0] : rest[1]) as
      | Record<string, string | string[]>
      | Array<string>
      | undefined;
    if (Array.isArray(headersArg)) {
      for (let i = 0; i < headersArg.length; i += 2) {
        capturedWriteHeadHeaders[headersArg[i]] = headersArg[i + 1];
      }
    } else if (headersArg) {
      Object.assign(capturedWriteHeadHeaders, headersArg);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (originalWriteHead as any)(statusCode, ...rest);
    startResponse();
    return result;
  };

  (nodeRes.write as unknown as (...args: unknown[]) => boolean) = (
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    // Defensive: a caller that writes before calling writeHead (unusual, but
    // not disallowed by the Node API) should still get a resolved response
    // rather than hanging forever.
    startResponse();
    if (chunk !== undefined && chunk !== null) {
      enqueue(toBuffer(chunk, rest));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWrite as any)(chunk, ...rest);
  };

  (nodeRes.end as unknown as (...args: unknown[]) => ServerResponse) = (
    chunk?: unknown,
    ...rest: unknown[]
  ) => {
    startResponse();
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      enqueue(toBuffer(chunk, rest));
    }
    try {
      streamController?.close();
    } catch {
      // Already closed/errored — fine.
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEnd as any)(chunk, ...rest);
  };

  return { nodeReq, nodeRes, responsePromise };
}
