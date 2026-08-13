// Dependency-free Solana transaction plumbing: ed25519 keys from seeds, PDA
// derivation, and legacy transaction serialization. Exists so the devnet
// driver (scripts/devnet-gate.mjs) and later the Worker's coin creator (spec
// D7) can talk to the chain with the same zero-dependency discipline as the
// rest of the repo — the whole SDK surface we actually use is a few hundred
// lines. Golden-pinned against the real Rust SDK: litesvm-tests/tests/
// fixtures.rs serializes identical transactions with solana-sdk and both
// suites assert the same bytes.
//
// Node-only for now (node:crypto for ed25519). The Worker adaptation swaps
// sign/keyFromSeed to WebCrypto; everything else is pure bytes.

import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { toBase58, fromBase58 } from './events.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export const sha256 = (...chunks) => {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return new Uint8Array(h.digest());
};

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

// Accepts a 32-byte seed or a solana-keygen 64-byte JSON array (seed ‖ pubkey).
export function keypairFromSeed(seedOrSixtyFour) {
  const bytes = Uint8Array.from(seedOrSixtyFour);
  const seed = bytes.length === 64 ? bytes.subarray(0, 32) : bytes;
  if (seed.length !== 32) throw new Error('seed must be 32 or 64 bytes');
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    publicKey: toBase58(pub),
    publicKeyBytes: pub,
    sign: (message) => new Uint8Array(nodeSign(null, Buffer.from(message), key))
  };
}

// ed25519 point decompression, existence only. A PDA is valid exactly when
// its 32 bytes are NOT a curve point, which is the entire find loop below.
const P = 2n ** 255n - 19n;
const D = mod(-121665n * modInverse(121666n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function modInverse(a) {
  return modPow(a, P - 2n);
}

export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const candidate = mod(mod(u * modPow(v, 3n)) * modPow(mod(u * modPow(v, 7n)), (P - 5n) / 8n));
  const check = mod(v * mod(candidate * candidate));
  if (check === u) return true;
  if (check === mod(-u)) return mod(candidate * SQRT_M1) !== 0n || u === 0n;
  return false;
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

export function findProgramAddress(seeds, programId) {
  const programBytes = fromBase58(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds, Uint8Array.from([bump]), programBytes, PDA_MARKER);
    if (!isOnCurve(hash)) return { address: toBase58(hash), bump };
  }
  throw new Error('no viable bump');
}

export function compactU16(n) {
  const out = [];
  let rem = n;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte | 0x80);
  }
}

// instructions: [{ programId, keys: [{ pubkey, isSigner, isWritable }], data }]
// signers: keypairs from keypairFromSeed, fee payer first.
//
// `feePayer` and `allowPartial` exist for the first-buy flow (§3.6), where
// three keys sign one transaction and no single party holds all three: the
// buyer's wallet, the mint keypair the browser ground, and `creator_authority`
// in the Worker. The Worker builds the message and signs its own slot; the
// other two are filled in client-side by `attachSignature`. Passing `feePayer`
// separately is the whole point — the buyer pays, and we never hold their key.
export function buildTransaction({
  instructions,
  recentBlockhash,
  signers,
  feePayer,
  allowPartial = false
}) {
  const payer = feePayer ?? signers[0].publicKey;
  const priv = new Map();
  const upsert = (pubkey, isSigner, isWritable) => {
    const cur = priv.get(pubkey) || { isSigner: false, isWritable: false };
    priv.set(pubkey, { isSigner: cur.isSigner || isSigner, isWritable: cur.isWritable || isWritable });
  };
  upsert(payer, true, true);
  for (const ix of instructions) {
    upsert(ix.programId, false, false);
    for (const k of ix.keys) upsert(k.pubkey, k.isSigner, k.isWritable);
  }
  const rest = [...priv.keys()].filter((k) => k !== payer);
  const rank = (k) => {
    const { isSigner, isWritable } = priv.get(k);
    if (isSigner && isWritable) return 0;
    if (isSigner) return 1;
    if (isWritable) return 2;
    return 3;
  };
  // Within a privilege class the SDK's CompiledKeys is a BTreeMap, so keys
  // come out in raw byte order — base58 string order is close but not
  // identical, and identical bytes are the whole point here.
  const byteCompare = (a, b) => {
    const ab = fromBase58(a);
    const bb = fromBase58(b);
    for (let i = 0; i < 32; i++) {
      if (ab[i] !== bb[i]) return ab[i] - bb[i];
    }
    return 0;
  };
  rest.sort((a, b) => rank(a) - rank(b) || byteCompare(a, b));
  const keys = [payer, ...rest];
  const numSigners = keys.filter((k) => priv.get(k).isSigner).length;
  const numReadonlySigned = keys.filter((k) => priv.get(k).isSigner && !priv.get(k).isWritable).length;
  const numReadonlyUnsigned = keys.filter((k) => !priv.get(k).isSigner && !priv.get(k).isWritable).length;
  const index = new Map(keys.map((k, i) => [k, i]));

  // Every account is a base58 string. Passing a keypair object instead is the
  // easy mistake, because the signers array beside it genuinely wants keypairs,
  // and without this it surfaces four frames away as "s is not iterable" from
  // inside base58 decoding. Cost one devnet gate run to diagnose.
  for (const k of keys) {
    if (typeof k !== 'string') {
      throw new TypeError(
        `account key must be a base58 address, got ${typeof k}` +
          (k && typeof k === 'object' && 'publicKey' in k ? ' — pass its .publicKey' : '')
      );
    }
  }

  const parts = [
    Uint8Array.from([numSigners, numReadonlySigned, numReadonlyUnsigned]),
    compactU16(keys.length),
    ...keys.map((k) => fromBase58(k)),
    fromBase58(recentBlockhash),
    compactU16(instructions.length)
  ];
  for (const ix of instructions) {
    parts.push(Uint8Array.from([index.get(ix.programId)]));
    parts.push(compactU16(ix.keys.length));
    parts.push(Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))));
    parts.push(compactU16(ix.data.length));
    parts.push(Uint8Array.from(ix.data));
  }
  const message = concat(parts);

  const byPubkey = new Map(signers.map((s) => [s.publicKey, s]));
  const signerOrder = keys.slice(0, numSigners);
  const sigs = [];
  for (const k of signerOrder) {
    const signer = byPubkey.get(k);
    if (!signer) {
      // A zero-filled slot is what "not signed yet" looks like on the wire, and
      // it is what every Solana SDK produces for a partially signed
      // transaction. Without allowPartial this stays an error, because a
      // silently unsigned transaction fails far from where it was built.
      if (!allowPartial) throw new Error(`missing signer for ${k}`);
      sigs.push(new Uint8Array(64));
      continue;
    }
    sigs.push(signer.sign(message));
  }
  const wire = concat([compactU16(sigs.length), ...sigs, message]);
  return {
    bytes: wire,
    signature: toBase58(sigs[0]),
    message,
    signerOrder,
    sigOffset: compactU16(sigs.length).length
  };
}

/// Fill one signature slot in an already-built wire transaction, in place.
///
/// The alternative — rebuilding the transaction once per signer — means the
/// message bytes have to be reproduced identically by three parties, and any
/// disagreement about account ordering surfaces as an opaque signature
/// failure. Signing the message once and posting signatures into fixed slots
/// removes that whole class of bug.
export function attachSignature({ bytes, signerOrder, sigOffset = 1, publicKey, signature }) {
  const index = signerOrder.indexOf(publicKey);
  if (index < 0) throw new Error(`${publicKey} is not a signer of this transaction`);
  if (signature.length !== 64) throw new Error('an ed25519 signature is 64 bytes');
  const out = Uint8Array.from(bytes);
  out.set(signature, sigOffset + index * 64);
  return out;
}

/// True when every signature slot is filled. Submitting a transaction with a
/// zeroed slot wastes a round trip and returns an error that names none of it.
export function isFullySigned({ bytes, signerOrder, sigOffset = 1 }) {
  for (let i = 0; i < signerOrder.length; i++) {
    const at = sigOffset + i * 64;
    if (bytes.subarray(at, at + 64).some((b) => b !== 0)) continue;
    return false;
  }
  return true;
}

export function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

export function systemTransfer({ from, to, lamports }) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true }
    ],
    data
  };
}
