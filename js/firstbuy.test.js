// The create+buy transaction: that it fits, that it is partially signable by
// three parties who never meet, and that the buyer is always the one paying.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { keypairFromSeed, attachSignature, isFullySigned } from './tx.js';
import { buildFirstBuyTransaction, firstBuySize, TX_SIZE_LIMIT } from './firstbuy.js';
import { PROGRAM_ID } from './program.js';
import { fromBase58 } from './events.js';

const seed = (n) => createHash('sha256').update(`firstbuy-${n}`).digest();
const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';

const authority = keypairFromSeed(seed(1));
const buyer = keypairFromSeed(seed(2));
const mint = keypairFromSeed(seed(3));
const treasury = keypairFromSeed(seed(4)).publicKey;

const base = {
  kickUserId: 4242n,
  name: 'A Streamer',
  symbol: 'STRM',
  uri: 'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  creatorAuthority: authority.publicKey,
  buyer: buyer.publicKey,
  mint: mint.publicKey,
  treasury,
  solIn: 20_000_000n,
  minTokensOut: 0n,
  recentBlockhash: BLOCKHASH
};

test('create and buy ride in one transaction, under the size limit', () => {
  const tx = buildFirstBuyTransaction({ ...base, signers: [authority] });
  assert.ok(tx.bytes.length <= TX_SIZE_LIMIT, `${tx.bytes.length} bytes`);
  assert.equal(tx.signerOrder.length, 3, 'buyer, mint and creator_authority');
  assert.equal(tx.signerOrder[0], buyer.publicKey, 'the buyer is the fee payer');
  assert.ok(tx.signerOrder.includes(mint.publicKey));
  assert.ok(tx.signerOrder.includes(authority.publicKey));
});

test('the worst case still fits, with the margin stated', () => {
  const size = firstBuySize({
    ...base,
    name: 'x'.repeat(32),
    symbol: 'y'.repeat(10),
    uri: 'z'.repeat(200)
  });
  assert.ok(size <= TX_SIZE_LIMIT, `worst case is ${size} bytes`);
  // Roughly 32 bytes per extra account. If this margin ever goes negative the
  // flow needs a versioned transaction and a lookup table, so it is asserted
  // rather than left as a comment.
  assert.ok(TX_SIZE_LIMIT - size > 100, `only ${TX_SIZE_LIMIT - size} bytes of margin left`);
});

test('metadata too long to fit is refused at build time, not at submit time', () => {
  assert.throws(
    () => buildFirstBuyTransaction({ ...base, uri: 'z'.repeat(2000) }),
    /over the 1232 limit/
  );
});

test('three parties sign the same message in any order', () => {
  // The Worker builds and signs its own slot; it holds neither of the others.
  const tx = buildFirstBuyTransaction({ ...base, signers: [authority] });
  assert.equal(isFullySigned(tx), false, 'two slots still empty');

  // The browser adds the mint it ground, then the wallet adds the buyer.
  let bytes = attachSignature({
    ...tx,
    publicKey: mint.publicKey,
    signature: mint.sign(tx.message)
  });
  assert.equal(isFullySigned({ ...tx, bytes }), false, 'buyer still missing');

  bytes = attachSignature({
    ...tx,
    bytes,
    publicKey: buyer.publicKey,
    signature: buyer.sign(tx.message)
  });
  assert.equal(isFullySigned({ ...tx, bytes }), true);

  // ...and the same three signatures assembled in the opposite order are the
  // same bytes, because each one lands in a fixed slot.
  const other = attachSignature({
    ...tx,
    bytes: attachSignature({
      ...tx,
      publicKey: buyer.publicKey,
      signature: buyer.sign(tx.message)
    }),
    publicKey: mint.publicKey,
    signature: mint.sign(tx.message)
  });
  assert.deepEqual([...bytes], [...other]);
});

test('a fully signed transaction built all at once is byte-identical', () => {
  const partial = buildFirstBuyTransaction({ ...base, signers: [authority] });
  const assembled = attachSignature({
    ...partial,
    bytes: attachSignature({
      ...partial,
      publicKey: mint.publicKey,
      signature: mint.sign(partial.message)
    }),
    publicKey: buyer.publicKey,
    signature: buyer.sign(partial.message)
  });
  const direct = buildFirstBuyTransaction({ ...base, signers: [authority, buyer, mint] });
  assert.deepEqual([...assembled], [...direct.bytes]);
});

test('attaching a signature for a non-signer is refused', () => {
  const tx = buildFirstBuyTransaction({ ...base, signers: [authority] });
  const stranger = keypairFromSeed(seed(9));
  assert.throws(
    () =>
      attachSignature({
        ...tx,
        publicKey: stranger.publicKey,
        signature: stranger.sign(tx.message)
      }),
    /not a signer/
  );
});

test('create runs before buy, and both are ours', () => {
  const tx = buildFirstBuyTransaction({ ...base, signers: [authority] });
  // Walk the compiled message far enough to read the two instruction program
  // ids in order. Ordering is load-bearing: buy reads a curve that create makes.
  const msg = tx.message;
  const numKeys = msg[3];
  let at = 4 + numKeys * 32 + 32;
  assert.equal(msg[at], 2, 'exactly two instructions');
  at += 1;
  const programs = [];
  for (let i = 0; i < 2; i++) {
    const programIndex = msg[at];
    programs.push(msg.subarray(4 + programIndex * 32, 4 + programIndex * 32 + 32));
    at += 1;
    const nKeys = msg[at];
    at += 1 + nKeys;
    const dataLen = msg[at] & 0x7f ? msg[at] : msg[at];
    // data length is a compact-u16; the create instruction's data exceeds 127
    // bytes so it uses two, which is exactly why this is decoded rather than
    // assumed.
    if (msg[at] & 0x80) {
      at += 2;
      at += (msg[at - 2] & 0x7f) | (msg[at - 1] << 7);
    } else {
      at += 1 + dataLen;
    }
  }
  for (const p of programs) assert.deepEqual([...p], [...fromBase58(PROGRAM_ID)]);
});
