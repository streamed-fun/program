// The claim flow's client surface (spec §3.4): the message the oracle set
// signs, the Ed25519 program instruction that carries their signatures, and
// the three claim instructions. The JS mirror of `initiate_claim`,
// `finalize_claim`, `veto_claim` and `claim_message` in lib.rs.
//
// Two byte layouts here are contracts with the program and are pinned on both
// sides by litesvm-tests/tests/fixtures.rs:
//
//   - the 88-byte attestation message, which the program rebuilds from its own
//     state and compares against what was signed, so one wrong byte is a
//     rejected claim rather than a subtle one
//   - the Ed25519 program's instruction data, which the program reads back
//     through the instructions sysvar to learn who signed what
//
// Nothing here signs anything. An oracle signs `claimMessage(...)` with
// whatever Ed25519 it has (node:crypto, WebCrypto, a hardware key); the
// destination wallet signs the transaction; the fee payer signs the
// transaction. This module only lays the bytes out.

import { buildTransaction } from './tx.js';
import { SYSTEM_PROGRAM } from './tx.js';
import { fromBase58 } from './events.js';
import { PROGRAM_ID, TOKEN_PROGRAM, ATA_PROGRAM, pdas, ata, ixDisc, writer } from './program.js';

export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';
export const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';

export const CLAIM_MESSAGE_LEN = 88;

/// `Curve.claim_state`. 2 is terminal.
export const CLAIM_UNCLAIMED = 0;
export const CLAIM_PENDING = 1;
export const CLAIM_CLAIMED = 2;

const asKey = (k) => (typeof k === 'string' ? fromBase58(k) : Uint8Array.from(k));

/// The bytes the oracle set signs:
/// `kick_user_id u64 ‖ destination 32 ‖ expiry i64 ‖ claim_nonce u64 ‖ program_id 32`,
/// integers little-endian. `claimNonce` is the CURRENT `Curve.claim_nonce`: a
/// veto increments it, which is what stops a vetoed attestation being replayed.
export function claimMessage({ kickUserId, destination, expiry, claimNonce }) {
  const dest = asKey(destination);
  if (dest.length !== 32) throw new Error('destination must be a 32-byte public key');
  const w = writer();
  w.u64(kickUserId);
  w.bytes(dest);
  w.i64(expiry);
  w.u64(claimNonce);
  w.pubkey(PROGRAM_ID);
  const m = w.done();
  if (m.length !== CLAIM_MESSAGE_LEN) throw new Error(`claim message is ${m.length} bytes, not ${CLAIM_MESSAGE_LEN}`);
  return m;
}

/// One Ed25519 program instruction carrying every oracle signature over one
/// message. Layout, which is what the program parses:
///
///   [count u8][0 u8]
///   count × { signature_offset u16, signature_instruction_index u16,
///             public_key_offset u16, public_key_instruction_index u16,
///             message_data_offset u16, message_data_size u16,
///             message_instruction_index u16 }
///   count × { public key 32 ‖ signature 64 }
///   message
///
/// Every instruction index is u16::MAX, "this instruction"; the program refuses
/// any other value. For a single signer this is byte-identical to what the Rust
/// SDK's `new_ed25519_instruction` produces, which the fixtures assert.
///
/// The precompile verifies every signature or fails the transaction, so the
/// program never checks signatures itself — only what was signed and by whom.
export function ed25519VerifyIx({ message, signatures }) {
  const n = signatures.length;
  if (n < 1 || n > 255) throw new Error(`between 1 and 255 signatures, got ${n}`);
  const header = 2 + 14 * n;
  const msgOff = header + 96 * n;
  const data = new Uint8Array(msgOff + message.length);
  const view = new DataView(data.buffer);
  data[0] = n;
  data[1] = 0;
  signatures.forEach(({ publicKey, signature }, i) => {
    const pk = asKey(publicKey);
    const sig = Uint8Array.from(signature);
    if (pk.length !== 32) throw new Error(`signature ${i}: public key must be 32 bytes`);
    if (sig.length !== 64) throw new Error(`signature ${i}: signature must be 64 bytes`);
    const pkOff = header + 96 * i;
    const sigOff = pkOff + 32;
    const rec = 2 + 14 * i;
    view.setUint16(rec, sigOff, true);
    view.setUint16(rec + 2, 0xffff, true);
    view.setUint16(rec + 4, pkOff, true);
    view.setUint16(rec + 6, 0xffff, true);
    view.setUint16(rec + 8, msgOff, true);
    view.setUint16(rec + 10, message.length, true);
    view.setUint16(rec + 12, 0xffff, true);
    data.set(pk, pkOff);
    data.set(sig, sigOff);
  });
  data.set(message, msgOff);
  return { programId: ED25519_PROGRAM, keys: [], data };
}

/// `initiate_claim(kick_user_id, expiry)`. Must be placed IMMEDIATELY after the
/// `ed25519VerifyIx` in the same transaction; the program reads the previous
/// instruction and nothing else. `destination` signs; the fee payer is
/// whoever the transaction names.
export function initiateClaimIx({ kickUserId, destination, expiry }) {
  const p = pdas(kickUserId);
  const w = writer();
  w.u64(kickUserId);
  w.i64(expiry);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p.global.address, isSigner: false, isWritable: true },
      { pubkey: p.curve.address, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: true, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: p.eventAuthority.address, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: concatBytes(ixDisc('initiate_claim'), w.done())
  };
}

/// `finalize_claim(kick_user_id)`. Permissionless; `payer` covers the fee and
/// the destination's token account if it does not exist yet. `destination`
/// must be the wallet the pending claim named — read it off the Curve.
export function finalizeClaimIx({ kickUserId, mint, destination, payer }) {
  const p = pdas(kickUserId);
  const w = writer();
  w.u64(kickUserId);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p.global.address, isSigner: false, isWritable: false },
      { pubkey: p.curve.address, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: p.creatorVault.address, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: false },
      { pubkey: ata(destination, mint), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: p.eventAuthority.address, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: concatBytes(ixDisc('finalize_claim'), w.done())
  };
}

/// `veto_claim(kick_user_id)`. `authority` is `Global.authority`.
export function vetoClaimIx({ kickUserId, authority }) {
  const p = pdas(kickUserId);
  const w = writer();
  w.u64(kickUserId);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p.global.address, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: p.curve.address, isSigner: false, isWritable: true },
      { pubkey: p.eventAuthority.address, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: concatBytes(ixDisc('veto_claim'), w.done())
  };
}

/// The initiate transaction: the attestation's Ed25519 instruction followed by
/// `initiate_claim`. Two signers, and the caller usually holds one of them: the
/// fee payer (the relayer, in the Worker) and the destination wallet (in the
/// browser). Built partially signed, the other slot filled by
/// `attachSignature` — the same shape as the first buy.
///
/// `attestation` is what the oracle service issued: the expiry and nonce it
/// signed over, and one `{ publicKey, signature }` per oracle.
export function buildInitiateClaimTransaction({
  kickUserId,
  destination,
  attestation,
  feePayer,
  recentBlockhash,
  signers = []
}) {
  const { expiry, claimNonce, signatures } = attestation;
  const message = claimMessage({ kickUserId, destination, expiry, claimNonce });
  return buildTransaction({
    instructions: [
      ed25519VerifyIx({ message, signatures }),
      initiateClaimIx({ kickUserId, destination, expiry })
    ],
    recentBlockhash,
    signers,
    feePayer,
    allowPartial: true
  });
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
