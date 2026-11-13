// verifyInbound (design §5.2 steps 1-2): pure function, no containers needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createInboundVerifier,
  InvalidSignatureError,
  InvalidPayloadError,
} from '../src/services/connectors/payment-mock.js';

const SECRET = 'test-secret';
const NOW = 1_800_000_000; // fixed clock, unix seconds
const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { title: 'Ragnarök' } }));

const sign = (t, raw, secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
const headersFor = (value) => ({ 'mock-signature': value });
const verifier = createInboundVerifier({ secret: SECRET, now: () => NOW * 1000 });
const rejects = (raw, headers, ErrorClass = InvalidSignatureError) =>
  assert.throws(() => verifier.verifyInbound(raw, headers), ErrorClass);

test('valid signature returns the parsed event, non-ASCII body included', () => {
  const event = verifier.verifyInbound(body, headersFor(`t=${NOW},v1=${sign(NOW, body)}`));
  assert.equal(event.id, 'evt_1');
  assert.equal(event.data.title, 'Ragnarök');
});

test('a changed body byte is rejected', () => {
  const tampered = Buffer.from(body);
  tampered[tampered.length - 2] ^= 1;
  rejects(tampered, headersFor(`t=${NOW},v1=${sign(NOW, body)}`));
});

test('a signature made with another secret is rejected', () => {
  rejects(body, headersFor(`t=${NOW},v1=${sign(NOW, body, 'other-secret')}`));
});

test('timestamp tolerance: 300 s old accepted, 301 s old rejected', () => {
  const t300 = NOW - 300;
  assert.equal(verifier.verifyInbound(body, headersFor(`t=${t300},v1=${sign(t300, body)}`)).id, 'evt_1');
  const t301 = NOW - 301;
  rejects(body, headersFor(`t=${t301},v1=${sign(t301, body)}`));
});

test('malformed headers are rejected', () => {
  const v1 = sign(NOW, body);
  rejects(body, {}); // missing header
  rejects(body, headersFor(`v1=${v1}`)); // no t
  rejects(body, headersFor(`t=${NOW},t=${NOW},v1=${v1}`)); // two t
  rejects(body, headersFor(`t=${NOW}`)); // no v1
  rejects(body, headersFor(`t=abc,v1=${v1}`)); // t not digits
  rejects(body, headersFor(`t=${NOW},v0=${v1}`)); // only another scheme
});

test('v1 that is not exactly 64 hex chars is rejected', () => {
  const v1 = sign(NOW, body);
  rejects(body, headersFor(`t=${NOW},v1=${v1.slice(0, 62)}`)); // too short
  rejects(body, headersFor(`t=${NOW},v1=${v1}zz`)); // junk after 64 hex chars
});

test('two v1 values, one valid, is accepted (secret rotation, as Stripe)', () => {
  const bad = sign(NOW, body, 'old-secret');
  assert.equal(verifier.verifyInbound(body, headersFor(`t=${NOW},v1=${bad},v1=${sign(NOW, body)}`)).id, 'evt_1');
});

test('valid signature on a body that is not JSON gives InvalidPayloadError', () => {
  const raw = Buffer.from('not json');
  rejects(raw, headersFor(`t=${NOW},v1=${sign(NOW, raw)}`), InvalidPayloadError);
});
