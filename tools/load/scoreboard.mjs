// Prints the first proof scoreboard the reconciler publishes after this script starts (read from the public SSE stream).
// Run after a k6 run: node tools/load/scoreboard.mjs [baseUrl]
const base = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';
const startedAt = Date.now();

const { sessionId } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 60_000);
const response = await fetch(`${base}/api/stream?session=${sessionId}`, { signal: abort.signal });

let buffer = '';
try {
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const messages = buffer.split('\n\n');
    buffer = messages.pop();
    for (const message of messages) {
      if (!message.startsWith('event: scoreboard')) continue;
      const board = JSON.parse(message.split('\ndata: ')[1]);
      if (Date.parse(board.checkedAt) > startedAt) {
        console.log(JSON.stringify(board, null, 2));
        process.exit(0);
      }
    }
  }
} catch (err) {
  if (err.name !== 'AbortError') throw err;
}
console.error('no fresh scoreboard within 60 s');
process.exit(1);
