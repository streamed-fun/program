// The Worker signing path, checked against the node:crypto one that already
// has golden fixtures against the Rust SDK. Node 24's WebCrypto implements
// Ed25519, so this exercises the real code rather than a mock — what it cannot
// prove is which algorithm name Cloudflare's runtime accepts, which is why
// websigner.js tries both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';

import { keypairFromSeed } from './tx.js';
import { webSigner, parseSecretKey } from './websigner.js';
import { toBase58 } from './events.js';

const seed = (n) => createHash('sha256').update(`websigner-${n}`).digest();

// The solana-keygen JSON form: 32-byte seed followed by the 32-byte pubkey.
function keygenJson(n) {
  const kp = keypairFromSeed(seed(n));
  return JSON.stringify([...seed(n), ...kp.publicKeyBytes]);
}

test('the Worker signer produces the same bytes as the node signer', async () => {
  const kp = keypairFromSeed(seed(1));
  const signer = await webSigner(keygenJson(1), webcrypto.subtle);

  assert.equal(toBase58(signer.publicKeyBytes), kp.publicKey);
  for (const text of ['', 'a', 'the quick brown fox', 'x'.repeat(1200)]) {
    const message = new TextEncoder().encode(text);
    assert.deepEqual(
      [...(await signer.sign(message))],
      [...kp.sign(message)],
      `signature over ${text.length} bytes`
    );
  }
});

test('a signature verifies against the public key it claims', async () => {
  const signer = await webSigner(keygenJson(2), webcrypto.subtle);
  const message = new TextEncoder().encode('a transaction message');
  const sig = await signer.sign(message);

  const pub = await webcrypto.subtle.importKey(
    'raw',
    signer.publicKeyBytes,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  assert.equal(await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, sig, message), true);

  message[0] ^= 1;
  assert.equal(await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, sig, message), false);
});

test('a 32-byte seed is refused rather than signing for an unknown address', async () => {
  const bare = JSON.stringify([...seed(3)]);
  assert.throws(() => parseSecretKey(bare), /64-byte solana-keygen form/);
  await assert.rejects(() => webSigner(bare, webcrypto.subtle), /64-byte solana-keygen form/);
});

test('a malformed key fails at load, not at signing time', async () => {
  await assert.rejects(() => webSigner('not json', webcrypto.subtle), /JSON array of bytes/);
});

test('a runtime with no Ed25519 at all says so', async () => {
  const subtle = { importKey: async () => { throw new Error('unsupported algorithm'); } };
  await assert.rejects(
    () => webSigner(keygenJson(4), subtle),
    /no Ed25519 implementation this runtime accepts/
  );
});
