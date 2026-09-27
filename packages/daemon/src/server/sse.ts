import type { ServerResponse } from 'node:http';

/** Opens a server-sent event response. Shared by the interface streams and the consumer feed. */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  // WebKit can hold a tiny chunked response until its network buffer fills. Prime that buffer
  // with one legal SSE comment so a later single event reaches Safari immediately rather than
  // waiting for the 15-second heartbeat (or enough unrelated events to accumulate).
  res.write(`: salidium ${' '.repeat(2048)}\n\n`);
}
