// Mock provider signer (design §5.2), checked against our real verifier: pure functions, no containers needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookSigner } from '../sims/payment-provider/sign.js';
import { createInboundVerifier, InvalidSignatureError } from '../src/services/connectors/payment-mock.js';

const SECRET = 'test-secret';
const NOW = 1_800_000_000; // fixed clock, unix seconds
const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { title: 'Ragnarök' } }));

const signerAt = (seconds, secret = SECRET) => createWebhookSigner({ secret, now: () => seconds * 1000 });
const verifierAt = (seconds) => createInboundVerifier({ secret: SECRET, now: () => seconds * 1000 });
const headersFor = (value) => ({ 'mock-signature': value });

test('header is t=<unix seconds>,v1=<64 hex chars>; milliseconds are cut off', () => {
  const signer = createWebhookSigner({ secret: SECRET, now: () => NOW * 1000 + 999 });
  assert.match(signer.sign(body), new RegExp(`^t=${NOW},v1=[0-9a-f]{64}$`));
});

test('our verifier accepts the signed body, non-ASCII included', () => {
  const event = verifierAt(NOW).verifyInbound(body, headersFor(signerAt(NOW).sign(body)));
  assert.equal(event.data.title, 'Ragnarök');
});

test('another secret is rejected by our verifier', () => {
  assert.throws(
    () => verifierAt(NOW).verifyInbound(body, headersFor(signerAt(NOW, 'other-secret').sign(body))),
    InvalidSignatureError,
  );
});

test('a retry 301 s later: the old header is rejected, re-signing makes it valid again', () => {
  const old = signerAt(NOW).sign(body);
  const later = NOW + 301;
  assert.throws(() => verifierAt(later).verifyInbound(body, headersFor(old)), InvalidSignatureError);
  assert.equal(verifierAt(later).verifyInbound(body, headersFor(signerAt(later).sign(body))).id, 'evt_1');
});

test('a body that is not a Buffer is refused', () => {
  assert.throws(() => signerAt(NOW).sign(body.toString()), TypeError);
});
