// GET /api/stream?session=<id>: the live SSE stream (design §8.1). The session id is a query parameter because
// EventSource cannot set headers (MDN), so this route sits before the X-Session-Id check.
import express from 'express';
import { sendError } from './errors.js';

export function createStreamRouter({ orders, stream, config, logger }) {
  const router = express.Router();
  const counts = new Map(); // session id -> open streams
  const responses = new Set();

  router.get('/stream', async (req, res) => {
    const sessionId = String(req.query.session ?? '').toLowerCase();
    const known = await orders.sessionExists(sessionId);
    if (res.destroyed) return; // the client left during the lookup: its 'close' event has already fired
    if (!known) return sendError(res, 401, 'session_required', 'missing or unknown session; create a session first');
    if ((counts.get(sessionId) ?? 0) >= config.maxPerSession) {
      res.set('Retry-After', '5');
      return sendError(res, 429, 'rate_limited', 'too many open streams for this session');
    }

    // text/event-stream is required; X-Accel-Buffering stops nginx-style proxies from buffering the stream.
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: ${config.retryMs}\n\n`);

    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    responses.add(res);
    const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const close = stream.open(sessionId, writeEvent);
    // A comment line keeps an idle connection from timing out (MDN).
    const ping = setInterval(() => res.write(': ping\n\n'), config.pingMs);

    // 'close': the connection finished or dropped (Node http docs).
    res.on('close', () => {
      clearInterval(ping);
      close();
      responses.delete(res);
      if (counts.get(sessionId) === 1) counts.delete(sessionId);
      else counts.set(sessionId, counts.get(sessionId) - 1);
    });
    res.on('error', (err) => logger.warn({ err }, 'stream connection error'));
  });

  // At shutdown: server.close() waits for open connections, and a stream never ends by itself.
  router.endAll = () => {
    for (const res of responses) res.end();
  };
  return router;
}
