// Tests for the claim flow's client surface (claim.js). The byte-level claims
// are pinned from the other side too: litesvm-tests/tests/fixtures.rs builds
// the same message and the same Ed25519 instruction with the real SDK types
// and asserts the same hex, and the LiteSVM suite runs the real precompile
// over an instruction laid out exactly this way.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keypairFromSeed, buildTransaction, isFullySigned, attachSignature } from './tx.js';
import { toBase58, fromBase58 } from './events.js';
import { PROGRAM_ID, pdas, decodeCurve } from './program.js';
import {
  claimMessage,
  ed25519VerifyIx,
  initiateClaimIx,
  finalizeClaimIx,
  vetoClaimIx,
  buildInitiateClaimTransaction,
  ED25519_PROGRAM,
  INSTRUCTIONS_SYSVAR,
  CLAIM_MESSAGE_LEN
} from './claim.js';

const seed = (n) => Uint8Array.from({ length: 32 }, () => n);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const KICK_ID = 4242n;
const EXPIRY = 1_700_000_000n;
const NONCE = 3n;
const destination = keypairFromSeed(seed(9));
const oracleA = keypairFromSeed(seed(5));
const oracleB = keypairFromSeed(seed(6));

const fixtureMessage = () =>
  claimMessage({ kickUserId: KICK_ID, destination: destination.publicKey, expiry: EXPIRY, claimNonce: NONCE });

test('the claim message is 88 bytes in the pinned order', () => {
  const m = fixtureMessage();
  assert.equal(m.length, CLAIM_MESSAGE_LEN);
  const view = new DataView(m.buffer, m.byteOffset);
  assert.equal(view.getBigUint64(0, true), KICK_ID);
  assert.equal(toBase58(m.subarray(8, 40)), destination.publicKey);
  assert.equal(view.getBigInt64(40, true), EXPIRY);
  assert.equal(view.getBigUint64(48, true), NONCE);
  assert.equal(toBase58(m.subarray(56, 88)), PROGRAM_ID);
  // Pinned by fixtures.rs `claim_message_bytes_match_the_js_side`, which
  // builds the same bytes with the program's own claim_message.
  assert.equal(
    hex(m),
    '9210000000000000fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61800f1536500000000030000000000000024898889896884b95dec034b882336013e6bb60c7df01b2a5cad39acc0a5cdf2'
  );
});

test('golden bytes: two signers, the layout fixtures.rs and the precompile both accept', () => {
  const message = fixtureMessage();
  const ix = ed25519VerifyIx({
    message,
    signatures: [
      { publicKey: oracleA.publicKey, signature: oracleA.sign(message) },
      { publicKey: oracleB.publicKey, signature: oracleB.sign(message) }
    ]
  });
  assert.equal(
    hex(ix.data),
    '02003e00ffff1e00ffffde005800ffff9e00ffff7e00ffffde005800ffff6e7a1cdd29b0b78fd13af4c5598feff4ef2a97166e3ca6f2e4fbfccd80505bf11f4cb0b5d26763eeda60842030c2a5b54713420d1a6f1d51620251adcbdf2bb7d3ff16dc4cb897a1cdb25ba2b61566d07733da7ac7978d4535480454df9665048a875fff1eb38451577acd5afee405456568dd7c89e090863a0557bc7af49f177bfa2c0428e115a3e33e3278bdf0f78fd3a39f1fe5ea262af97b7a27f18fe0028821318fd827f4e90a949c359d9b8475a6d3389051156ffb1cf8e2cb60a7eb039210000000000000fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61800f1536500000000030000000000000024898889896884b95dec034b882336013e6bb60c7df01b2a5cad39acc0a5cdf2'
  );
});

test('a negative expiry and a nonce past 2^53 encode without loss', () => {
  const m = claimMessage({ kickUserId: 1n, destination: destination.publicKey, expiry: -1n, claimNonce: 2n ** 60n });
  const view = new DataView(m.buffer, m.byteOffset);
  assert.equal(view.getBigInt64(40, true), -1n);
  assert.equal(view.getBigUint64(48, true), 2n ** 60n);
});

test('a destination that is not 32 bytes is refused', () => {
  assert.throws(() => claimMessage({ kickUserId: 1n, destination: new Uint8Array(31), expiry: 1n, claimNonce: 0n }), /32-byte/);
});

test('the Ed25519 instruction lays out count, offsets, keys, signatures, then the message once', () => {
  const message = fixtureMessage();
  const ix = ed25519VerifyIx({
    message,
    signatures: [
      { publicKey: oracleA.publicKey, signature: oracleA.sign(message) },
      { publicKey: oracleB.publicKey, signature: oracleB.sign(message) }
    ]
  });
  assert.equal(ix.programId, ED25519_PROGRAM);
  assert.deepEqual(ix.keys, []);
  const d = ix.data;
  const view = new DataView(d.buffer, d.byteOffset);
  assert.equal(d[0], 2, 'two signatures');
  assert.equal(d[1], 0, 'padding');
  const header = 2 + 14 * 2;
  const msgOff = header + 96 * 2;
  assert.equal(d.length, msgOff + CLAIM_MESSAGE_LEN);
  for (const i of [0, 1]) {
    const rec = 2 + 14 * i;
    const pkOff = header + 96 * i;
    assert.equal(view.getUint16(rec, true), pkOff + 32, 'signature offset');
    assert.equal(view.getUint16(rec + 2, true), 0xffff, 'signature in this instruction');
    assert.equal(view.getUint16(rec + 4, true), pkOff, 'public key offset');
    assert.equal(view.getUint16(rec + 6, true), 0xffff);
    assert.equal(view.getUint16(rec + 8, true), msgOff, 'one shared message');
    assert.equal(view.getUint16(rec + 10, true), CLAIM_MESSAGE_LEN);
    assert.equal(view.getUint16(rec + 12, true), 0xffff);
  }
  assert.equal(toBase58(d.subarray(header, header + 32)), oracleA.publicKey);
  assert.equal(toBase58(d.subarray(header + 96, header + 96 + 32)), oracleB.publicKey);
  assert.equal(hex(d.subarray(msgOff)), hex(message));
});

test('a single signer is byte-identical to the SDK layout the Rust fixture pins', () => {
  const message = fixtureMessage();
  const ix = ed25519VerifyIx({ message, signatures: [{ publicKey: oracleA.publicKey, signature: oracleA.sign(message) }] });
  // new_ed25519_instruction: [1, 0] ‖ offsets(14) ‖ pubkey at 16 ‖ signature at 48 ‖ message at 112.
  const view = new DataView(ix.data.buffer, ix.data.byteOffset);
  assert.equal(view.getUint16(2, true), 48);
  assert.equal(view.getUint16(6, true), 16);
  assert.equal(view.getUint16(10, true), 112);
  assert.equal(ix.data.length, 112 + CLAIM_MESSAGE_LEN);
});

test('initiate_claim names the signer, the sysvar and the event accounts, in the struct order', () => {
  const ix = initiateClaimIx({ kickUserId: KICK_ID, destination: destination.publicKey, expiry: EXPIRY });
  const p = pdas(KICK_ID);
  assert.equal(ix.programId, PROGRAM_ID);
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]),
    [
      [p.global.address, false, true],
      [p.curve.address, false, true],
      [destination.publicKey, true, false],
      [INSTRUCTIONS_SYSVAR, false, false],
      [p.eventAuthority.address, false, false],
      [PROGRAM_ID, false, false]
    ]
  );
  assert.equal(ix.data.length, 8 + 8 + 8, 'discriminator, kick_user_id, expiry');
  const view = new DataView(ix.data.buffer, ix.data.byteOffset);
  assert.equal(view.getBigUint64(8, true), KICK_ID);
  assert.equal(view.getBigInt64(16, true), EXPIRY);
});

test('finalize_claim and veto_claim carry only the kick user id', () => {
  const mint = toBase58(seed(42));
  const payer = keypairFromSeed(seed(2)).publicKey;
  const fin = finalizeClaimIx({ kickUserId: KICK_ID, mint, destination: destination.publicKey, payer });
  assert.equal(fin.keys.length, 12);
  assert.equal(fin.keys[6].pubkey, payer);
  assert.ok(fin.keys[6].isSigner && fin.keys[6].isWritable, 'payer signs and pays');
  assert.equal(fin.data.length, 16);
  const veto = vetoClaimIx({ kickUserId: KICK_ID, authority: payer });
  assert.equal(veto.keys.length, 5);
  assert.ok(veto.keys[1].isSigner);
  assert.equal(veto.data.length, 16);
});

test('the initiate transaction is signed by the relayer and the wallet, in either order', () => {
  const relayer = keypairFromSeed(seed(1));
  const message = fixtureMessage();
  const attestation = {
    expiry: EXPIRY,
    claimNonce: NONCE,
    signatures: [
      { publicKey: oracleA.publicKey, signature: oracleA.sign(message) },
      { publicKey: oracleB.publicKey, signature: oracleB.sign(message) }
    ]
  };
  const blockhash = toBase58(seed(3));
  const args = { kickUserId: KICK_ID, destination: destination.publicKey, attestation, feePayer: relayer.publicKey, recentBlockhash: blockhash };

  // The Worker signs its slot; the browser attaches the wallet's.
  const partial = buildInitiateClaimTransaction({ ...args, signers: [relayer] });
  assert.deepEqual(partial.signerOrder, [relayer.publicKey, destination.publicKey]);
  assert.ok(!isFullySigned(partial));
  const signed = attachSignature({
    ...partial,
    publicKey: destination.publicKey,
    signature: destination.sign(partial.message)
  });
  assert.ok(isFullySigned({ ...partial, bytes: signed }));

  // Built all at once it is byte-identical, so the two halves agree on the message.
  const whole = buildInitiateClaimTransaction({ ...args, signers: [relayer, destination] });
  assert.equal(hex(whole.bytes), hex(signed));

  // The Ed25519 instruction immediately precedes initiate_claim, which is the
  // only place the program looks. Walk the compiled message: header (3),
  // compact key count, keys, blockhash, compact instruction count, then each
  // instruction as program index, compact account count, accounts, compact
  // data length, data. Every count here is under 128, so compact-u16 is one byte.
  const msg = whole.message;
  const keyCount = msg[3];
  const keyAt = (i) => toBase58(msg.subarray(4 + i * 32, 4 + (i + 1) * 32));
  let at = 4 + keyCount * 32 + 32;
  const ixCount = msg[at++];
  assert.equal(ixCount, 2);
  const programIds = [];
  for (let i = 0; i < ixCount; i++) {
    programIds.push(keyAt(msg[at++]));
    const nAccounts = msg[at++];
    at += nAccounts;
    let dataLen = msg[at++];
    if (dataLen & 0x80) dataLen = (dataLen & 0x7f) | (msg[at++] << 7);
    at += dataLen;
  }
  assert.equal(at, msg.length, 'walked the whole message');
  assert.deepEqual(programIds, [ED25519_PROGRAM, PROGRAM_ID]);
});

test('a curve that is pending decodes the claim fields the UI reads', () => {
  const bytes = new Uint8Array(8 + 8 + 32 * 4 + 8 * 5 + 1 + 32 + 8 + 8 + 8 + 8 + 1 + 32 + 8 + 1 + 1);
  const view = new DataView(bytes.buffer);
  let at = 8;
  view.setBigUint64(at, KICK_ID, true);
  at += 8 + 32 * 4 + 8 * 5;
  bytes[at++] = 1;
  bytes.set(fromBase58(destination.publicKey), at);
  at += 32;
  view.setBigInt64(at, 1_700_172_800n, true);
  at += 8;
  at += 8;
  view.setBigUint64(at, 7n, true);
  const c = decodeCurve(bytes);
  assert.equal(c.claimState, 1);
  assert.equal(c.pendingDestination, destination.publicKey);
  assert.equal(c.pendingUnlockAt, 1_700_172_800n);
  assert.equal(c.claimNonce, 7n);
});
