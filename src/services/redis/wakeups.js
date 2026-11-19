// Receives the order wake-ups that redis.notifyOrder publishes (design §8.4). One dedicated connection: a subscribed
// connection may only issue subscribe-related commands (RESP2, Redis Pub/Sub docs). A wake-up names the order (and,
// for a new order, its session), never what changed; one lost while disconnected is made up by each stream's timer.
// The listener gets (orderId, sessionId or '').
import { Redis } from 'ioredis';
import { ORDER_CHANNEL } from './index.js';

export function createWakeups({ redis, logger }) {
  const client = new Redis(redis);
  const listeners = new Set();
  client.on('error', (err) => logger.error({ err }, 'wake-up subscriber redis error'));
  // ioredis subscribes again by itself after a reconnect (autoReconnect docs, measured in test/wakeups.test.js).
  client.on('pmessage', (_pattern, channel, message) => {
    const orderId = channel.slice(ORDER_CHANNEL.length);
    for (const listener of listeners) listener(orderId, message);
  });

  return {
    ready: () => client.psubscribe(`${ORDER_CHANNEL}*`),
    // Returns the function that stops the listener.
    onOrder(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => (client.status === 'ready' ? client.quit() : client.disconnect()),
  };
}
