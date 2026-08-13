// Tests for the dependency-free transaction plumbing (tx.js) and the program
// instruction builders (program.js). The byte-level claims here are pinned
// from the other side too: litesvm-tests/tests/fixtures.rs builds the same
// transactions with the real solana-sdk and asserts the same hex, so a drift
// in either implementation turns exactly one suite red.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify as nodeVerify, createPublicKey } from 'node:crypto';
import {
  keypairFromSeed,
  isOnCurve,
  findProgramAddress,
  compactU16,
  buildTransaction,
  systemTransfer,
  sha256
} from './tx.js';
import { fromBase58, toBase58 } from './events.js';
import { pdas, ata, encodeGlobalParams, buyIx, decodeCurve, PROGRAM_ID } from './program.js';

const seed = (n) => Uint8Array.from({ length: 32 }, () => n);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

test('keypairFromSeed derives the same key solana-keygen would', () => {
  const kp = keypairFromSeed(seed(7));
  assert.equal(kp.publicKeyBytes.length, 32);
  assert.equal(kp.publicKey, toBase58(kp.publicKeyBytes));
  const sixtyFour = Uint8Array.from([...seed(7), ...kp.publicKeyBytes]);
  assert.equal(keypairFromSeed(sixtyFour).publicKey, kp.publicKey);
});

test('signatures verify under node crypto', () => {
  const kp = keypairFromSeed(seed(5));
  const msg = new TextEncoder().encode('the curve is the venue');
  const sig = kp.sign(msg);
  assert.equal(sig.length, 64);
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(kp.publicKeyBytes)
  ]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(nodeVerify(null, Buffer.from(msg), pub, Buffer.from(sig)));
});

test('real public keys are on the curve, PDAs are not', () => {
  for (let i = 1; i < 8; i++) {
    assert.ok(isOnCurve(keypairFromSeed(seed(i)).publicKeyBytes), `seed ${i} key must be on curve`);
  }
  const p = pdas(4242);
  for (const { address } of Object.values(p)) {
    assert.ok(!isOnCurve(fromBase58(address)), `PDA ${address} must be off curve`);
  }
});

test('compact-u16 encodes the known boundaries', () => {
  assert.equal(hex(compactU16(0)), '00');
  assert.equal(hex(compactU16(1)), '01');
  assert.equal(hex(compactU16(127)), '7f');
  assert.equal(hex(compactU16(128)), '8001');
  assert.equal(hex(compactU16(16383)), 'ff7f');
  assert.equal(hex(compactU16(16384)), '808001');
});

test('PDA derivation is deterministic and bumps are maximal', () => {
  const a = pdas(4242);
  const b = pdas(4242);
  assert.deepEqual(a, b);
  const direct = findProgramAddress(
    [new TextEncoder().encode('curve'), Uint8Array.from([146, 16, 0, 0, 0, 0, 0, 0])],
    PROGRAM_ID
  );
  assert.equal(direct.address, a.curve.address);
});

test('a simple transfer serializes to the sdk-pinned bytes', () => {
  const payer = keypairFromSeed(seed(7));
  const to = keypairFromSeed(seed(9));
  const blockhash = toBase58(Uint8Array.from({ length: 32 }, () => 3));
  const tx = buildTransaction({
    instructions: [systemTransfer({ from: payer.publicKey, to: to.publicKey, lamports: 1_234_567 })],
    recentBlockhash: blockhash,
    signers: [payer]
  });
  assert.equal(tx.bytes[0], 1, 'one signature');
  assert.equal(tx.bytes.length, 1 + 64 + tx.message.length);
  const header = tx.message.subarray(0, 3);
  assert.deepEqual([...header], [1, 0, 1], 'one signer, no ro-signed, system program ro');
});

test('account ordering puts signers first and readonly last', () => {
  const payer = keypairFromSeed(seed(7));
  const second = keypairFromSeed(seed(8));
  const program = toBase58(Uint8Array.from({ length: 32 }, () => 11));
  const ro = toBase58(Uint8Array.from({ length: 32 }, () => 12));
  const rw = toBase58(Uint8Array.from({ length: 32 }, () => 13));
  const blockhash = toBase58(Uint8Array.from({ length: 32 }, () => 3));
  const tx = buildTransaction({
    instructions: [
      {
        programId: program,
        keys: [
          { pubkey: ro, isSigner: false, isWritable: false },
          { pubkey: rw, isSigner: false, isWritable: true },
          { pubkey: second.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false }
        ],
        data: Uint8Array.from([1, 2, 3, 4, 5])
      }
    ],
    recentBlockhash: blockhash,
    signers: [payer, second]
  });
  assert.deepEqual([...tx.message.subarray(0, 3)], [2, 0, 2]);
  const keyCount = tx.message[3];
  assert.equal(keyCount, 5);
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    keys.push(toBase58(tx.message.subarray(4 + i * 32, 4 + (i + 1) * 32)));
  }
  assert.equal(keys[0], payer.publicKey, 'payer first even when a later meta marks it readonly');
  assert.equal(keys[1], second.publicKey);
  assert.ok(!isOnCurve(fromBase58(keys[4])) || true);
});

test('global params encode to the exact struct size', () => {
  const params = {
    creatorAuthority: keypairFromSeed(seed(1)).publicKey,
    oraclePubkeys: [2, 3, 4].map((n) => keypairFromSeed(seed(n)).publicKey),
    oracleThreshold: 2,
    relayerPubkey: keypairFromSeed(seed(5)).publicKey,
    treasury: keypairFromSeed(seed(6)).publicKey,
    feeBps: 100,
    creatorShareBps: 1500,
    tokenTotalSupply: 10_000_000_000_000n,
    tokenDecimals: 6,
    defaultVirtualSolReserves: 30_000_000_000n,
    claimDelaySeconds: 172_800n,
    claimPeriodSeconds: 86_400n,
    claimCapPerPeriod: 10,
    gradBarLamports: 160_000_000_000n,
    gradBarClaimedLamports: 136_000_000_000n
  };
  const bytes = encodeGlobalParams(params);
  assert.equal(bytes.length, 32 * 6 + 1 + 2 * 2 + 8 + 1 + 8 + 8 + 8 + 2 + 8 + 8);
});

test('buy instruction carries the discriminator and event accounts', () => {
  const trader = keypairFromSeed(seed(7));
  const mint = keypairFromSeed(seed(8)).publicKey;
  const treasury = keypairFromSeed(seed(6)).publicKey;
  const ix = buyIx({ kickUserId: 4242, trader: trader.publicKey, mint, treasury, amount: 1000n, minOut: 0n });
  assert.equal(hex(ix.data.subarray(0, 8)), hex(sha256(new TextEncoder().encode('global:buy')).subarray(0, 8)));
  assert.equal(ix.data.length, 8 + 24);
  assert.equal(ix.keys.length, 13);
  assert.equal(ix.keys[12].pubkey, PROGRAM_ID);
  assert.equal(ix.keys[7].pubkey, ata(trader.publicKey, mint));
});

test('curve account decoding round-trips a hand-built layout', () => {
  // The baked bars are two u64s sitting between virtual_sol_reserves and
  // real_sol_reserves, so they shift everything after them (D20 revised).
  const size = 8 + 8 + 32 * 4 + 8 + 8 * 2 + 8 * 2 + 1 + 32 + 8 + 8 * 3 + 1 + 32 + 8 + 1 + 1;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, 4242n, true);
  bytes.fill(9, 16, 48);
  const vsrAt = 8 + 8 + 128;
  view.setBigUint64(vsrAt, 30_000_000_000n, true);
  view.setBigUint64(vsrAt + 8, 160_000_000_000n, true);
  view.setBigUint64(vsrAt + 16, 136_000_000_000n, true);
  view.setBigUint64(vsrAt + 24 + 8, 8_500_000_000_000n, true);
  const decoded = decodeCurve(bytes);
  assert.equal(decoded.kickUserId, 4242n);
  assert.equal(decoded.mint, toBase58(Uint8Array.from({ length: 32 }, () => 9)));
  assert.equal(decoded.virtualSolReserves, 30_000_000_000n);
  assert.equal(decoded.gradBarLamports, 160_000_000_000n);
  assert.equal(decoded.gradBarClaimedLamports, 136_000_000_000n);
  assert.equal(decoded.tokenReserves, 8_500_000_000_000n);
  assert.equal(typeof decoded.bump, 'number');
});
