// The confirmation email, the same for Gmail and the mock. The disclaimer is defined here once.
export const SENDER_NAME = 'launch-rush';

export const DISCLAIMER =
  'Demo store: nothing is sold, no game is delivered, no real payment is taken. '
  + 'Not affiliated with or endorsed by any game publisher. Game names are trademarks of their owners.';

const money = (amountMinor, currency) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amountMinor / 100);

// order: { id, gameTitle, invoiceNo, amountMinor, currency }
export function confirmationEmail(order) {
  const text = [
    `${DISCLAIMER} This is a simulated payment: nothing was charged and no game will be delivered.`,
    '',
    'Demo order confirmation',
    '',
    `Game: ${order.gameTitle}`,
    `Order: ${order.id}`,
    `Invoice: ${order.invoiceNo ?? 'not available'}`,
    `Demo price: ${money(order.amountMinor, order.currency)}`,
    '',
    'This message comes from a portfolio demo of an order pipeline.',
    '',
  ].join('\r\n');
  return { subject: '[DEMO] Order confirmation', text };
}
