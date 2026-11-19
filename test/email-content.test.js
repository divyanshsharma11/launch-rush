import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCLAIMER, SENDER_NAME, confirmationEmail } from '../src/business/email-content.js';

const order = { id: 'o-1', gameTitle: 'Ragnarök', invoiceNo: 'SINV-0001', amountMinor: 580000, currency: 'INR' };

test('subject starts with [DEMO] and the first line is the disclaimer plus the simulated-payment line', () => {
  const { subject, text } = confirmationEmail(order);
  assert.ok(subject.startsWith('[DEMO]'));
  const [first] = text.split('\r\n');
  assert.ok(first.startsWith(DISCLAIMER));
  assert.match(first, /simulated payment: nothing was charged and no game will be delivered/);
});

test('the body names the game, order, invoice and demo price, and contains no link', () => {
  const { text } = confirmationEmail(order);
  for (const part of ['Ragnarök', 'Order: o-1', 'Invoice: SINV-0001', 'Demo price:', '5,800.00']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /https?:|www\./);
});

test('an order without an invoice number says so; the sender is the project name', () => {
  assert.match(confirmationEmail({ ...order, invoiceNo: null }).text, /Invoice: not available/);
  assert.equal(SENDER_NAME, 'launch-rush');
});
