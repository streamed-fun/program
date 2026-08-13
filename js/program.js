// Instruction builders and account decoding for the streamed_coin program —
// the JS mirror of programs/streamed_coin/src/lib.rs. Account
// orderings here must match the Rust Accounts structs field-for-field, and
// the arg encodings are borsh in declaration order; the devnet driver proves
// both against the deployed program, and the golden fixtures in
// litesvm-tests/tests/fixtures.rs pin the PDAs.

import { toBase58, fromBase58 } from './events.js';
import { sha256, findProgramAddress, SYSTEM_PROGRAM, concat } from './tx.js';

export const PROGRAM_ID = '3TdK7cTcmTQwZuZfJyDQqHLe6kyqRXQif2eCF1jDG7k5';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const ixDisc = (name) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);

const kidBytes = (kickUserId) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(kickUserId), true);
  return b;
};

export function pdas(kickUserId) {
  const kid = kidBytes(kickUserId);
  const seed = (s) => new TextEncoder().encode(s);
  return {
    global: findProgramAddress([seed('global')], PROGRAM_ID),
    curve: findProgramAddress([seed('curve'), kid], PROGRAM_ID),
    tokenVault: findProgramAddress([seed('token_vault'), kid], PROGRAM_ID),
    creatorVault: findProgramAddress([seed('creator_vault'), kid], PROGRAM_ID),
    solVault: findProgramAddress([seed('sol_vault'), kid], PROGRAM_ID),
    eventAuthority: findProgramAddress([seed('__event_authority')], PROGRAM_ID)
  };
}

export function ata(owner, mint) {
  return findProgramAddress(
    [fromBase58(owner), fromBase58(TOKEN_PROGRAM), fromBase58(mint)],
    ATA_PROGRAM
  ).address;
}

function writer() {
  const parts = [];
  return {
    bytes: (b) => parts.push(Uint8Array.from(b)),
    u8: (v) => parts.push(Uint8Array.from([Number(v)])),
    u16: (v) => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, Number(v), true);
      parts.push(b);
    },
    u32: (v) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, Number(v), true);
      parts.push(b);
    },
    u64: (v) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
      parts.push(b);
    },
    i64: (v) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
      parts.push(b);
    },
    pubkey: (b58) => parts.push(fromBase58(b58)),
    string: (s) => {
      const utf8 = new TextEncoder().encode(s);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, utf8.length, true);
      parts.push(len, utf8);
    },
    done: () => concat(parts)
  };
}

// Field order mirrors GlobalParams in lib.rs exactly.
export function encodeGlobalParams(p) {
  const w = writer();
  w.pubkey(p.creatorAuthority);
  for (const o of p.oraclePubkeys) w.pubkey(o);
  w.u8(p.oracleThreshold);
  w.pubkey(p.relayerPubkey);
  w.pubkey(p.treasury);
  w.u16(p.feeBps);
  w.u16(p.creatorShareBps);
  w.u64(p.tokenTotalSupply);
  w.u8(p.tokenDecimals);
  w.u64(p.defaultVirtualSolReserves);
  w.i64(p.claimDelaySeconds);
  w.i64(p.claimPeriodSeconds);
  w.u16(p.claimCapPerPeriod);
  w.u64(p.gradBarLamports);
  w.u64(p.gradBarClaimedLamports);
  return w.done();
}

export function initializeGlobalIx({ authority, params }) {
  const { global } = pdas(0);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: global.address, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }
    ],
    data: concat([ixDisc('initialize_global'), encodeGlobalParams(params)])
  };
}

// Bounded tuning only (spec §3.2). Same args as initialize_global, but the
// account list is shorter: no `init`, so no system program, and `authority` is
// checked by has_one rather than becoming one.
export function updateGlobalIx({ authority, params }) {
  const { global } = pdas(0);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: global.address, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }
    ],
    data: concat([ixDisc('update_global'), encodeGlobalParams(params)])
  };
}

// `payer` is the buyer, not us: the first buy carries every storage deposit
// (§3.6). There is deliberately no price argument of any kind (D20 revised):
// every coin opens at the same reserve and bakes the same bars, so this
// instruction cannot be used to price a coin arbitrarily.
export function createCoinIx({
  kickUserId,
  name,
  symbol,
  uri,
  creatorAuthority,
  payer,
  mint
}) {
  const p = pdas(kickUserId);
  const w = writer();
  w.u64(kickUserId);
  w.string(name);
  w.string(symbol);
  w.string(uri);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p.global.address, isSigner: false, isWritable: false },
      { pubkey: creatorAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: p.curve.address, isSigner: false, isWritable: true },
      { pubkey: p.tokenVault.address, isSigner: false, isWritable: true },
      { pubkey: p.creatorVault.address, isSigner: false, isWritable: true },
      { pubkey: p.solVault.address, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: p.eventAuthority.address, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: concat([ixDisc('create_coin'), w.done()])
  };
}

function tradeIx(name, { kickUserId, trader, mint, treasury, amount, minOut }) {
  const p = pdas(kickUserId);
  const w = writer();
  w.u64(kickUserId);
  w.u64(amount);
  w.u64(minOut);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p.global.address, isSigner: false, isWritable: false },
      { pubkey: p.curve.address, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: p.tokenVault.address, isSigner: false, isWritable: true },
      { pubkey: p.solVault.address, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: trader, isSigner: true, isWritable: true },
      { pubkey: ata(trader, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: p.eventAuthority.address, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: concat([ixDisc(name), w.done()])
  };
}

export const buyIx = (args) => tradeIx('buy', args);
export const sellIx = (args) => tradeIx('sell', args);

// Mirrors the Global account struct; input includes the 8-byte discriminator.
export function decodeGlobal(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  const pubkey = () => {
    const out = toBase58(bytes.subarray(at, at + 32));
    at += 32;
    return out;
  };
  const u64 = () => {
    const v = view.getBigUint64(at, true);
    at += 8;
    return v;
  };
  const i64 = () => {
    const v = view.getBigInt64(at, true);
    at += 8;
    return v;
  };
  const u16 = () => {
    const v = view.getUint16(at, true);
    at += 2;
    return v;
  };
  const u8 = () => bytes[at++];
  return {
    authority: pubkey(),
    creatorAuthority: pubkey(),
    oraclePubkeys: [pubkey(), pubkey(), pubkey()],
    oracleThreshold: u8(),
    relayerPubkey: pubkey(),
    treasury: pubkey(),
    feeBps: u16(),
    creatorShareBps: u16(),
    tokenTotalSupply: u64(),
    tokenDecimals: u8(),
    defaultVirtualSolReserves: u64(),
    claimDelaySeconds: i64(),
    claimPeriodSeconds: i64(),
    claimCapPerPeriod: u16(),
    claimsThisPeriod: u16(),
    claimPeriodStart: i64(),
    oracleEpoch: u64(),
    gradBarLamports: u64(),
    gradBarClaimedLamports: u64(),
    bump: u8()
  };
}

// Mirrors the Curve account struct; input is the raw account data including
// the 8-byte discriminator.
export function decodeCurve(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  const pubkey = () => {
    const out = toBase58(bytes.subarray(at, at + 32));
    at += 32;
    return out;
  };
  const u64 = () => {
    const v = view.getBigUint64(at, true);
    at += 8;
    return v;
  };
  const i64 = () => {
    const v = view.getBigInt64(at, true);
    at += 8;
    return v;
  };
  const u8 = () => bytes[at++];
  return {
    kickUserId: u64(),
    mint: pubkey(),
    tokenVault: pubkey(),
    solVault: pubkey(),
    creatorVault: pubkey(),
    virtualSolReserves: u64(),
    gradBarLamports: u64(),
    gradBarClaimedLamports: u64(),
    realSolReserves: u64(),
    tokenReserves: u64(),
    claimState: u8(),
    pendingDestination: pubkey(),
    pendingUnlockAt: i64(),
    outstanding: u64(),
    claimNonce: u64(),
    pendingOracleEpoch: u64(),
    venue: u8(),
    venuePool: pubkey(),
    createdAt: i64(),
    bump: u8(),
    vaultBump: u8()
  };
}
