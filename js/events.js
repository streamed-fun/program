// The event contract between the on-chain program and the indexer, pinned
// here before the Rust exists — the same move the application's attestation module made for the
// attestation message. The program emits events via Anchor's emit_cpi! (a
// self-CPI carrying the event in instruction data), and the indexer reads them
// from innerInstructions. NOT from log lines: logs can be forged by any
// program that merely references our program id in its transaction, and long
// transactions truncate their logs silently. A self-CPI can do neither — the
// event authority PDA must sign, so an inner instruction of ours that executed
// is authentic by construction.
//
// Discriminators are the real Anchor derivations (sha256 of "event:<Name>",
// first 8 bytes), so a Rust program declaring #[event] TradeEvent emits
// exactly these bytes with no coordination needed:
//   TradeEvent        bddb7fd34ee661ee
//   CoinCreatedEvent  2645d99da6e2dffa
// The instruction data prefix is Anchor's EVENT_IX_TAG (e445a52e51cb9a1d).
//
// Field layouts, borsh (little-endian), after the 8-byte discriminator:
//   TradeEvent: mint 32 ‖ trader 32 ‖ is_buy u8 ‖ sol_amount u64 ‖
//               token_amount u64 ‖ fee u64 ‖ virtual_sol u64 ‖ real_sol u64 ‖
//               token_reserves u64            (113 bytes)
//   CoinCreatedEvent: kick_user_id u64 ‖ mint 32 ‖ decimals u8 ‖
//                     grad_bar_lamports u64 ‖ grad_bar_claimed_lamports u64 ‖
//                     virtual_sol_reserves u64      (65 bytes)
//
// CoinCreatedEvent carries the graduation bars the coin baked in at creation
// (D20 revised), so the indexer knows every coin's finish line without ever
// fetching the account.
//
// Every TradeEvent carries the POST-TRADE reserves, so the indexer never
// fetches accounts and can verify continuity: replaying a trade onto the
// previous state must land exactly on the state the event claims. A mismatch
// is a detected gap, never a silent drift.

export const EVENT_IX_TAG = 'e445a52e51cb9a1d';
export const TRADE_EVENT_DISC = 'bddb7fd34ee661ee';
export const COIN_CREATED_DISC = '2645d99da6e2dffa';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));

export function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out || '1';
}

export function fromBase58(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error('bad base58');
    n = n * 58n + v;
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

// The real program id: the devnet deploy workflow holds
// the matching keypair and the program's declare_id! carries the same address,
// so events decoded here can only come from our deployed code.
export const PROGRAM_ID = '3TdK7cTcmTQwZuZfJyDQqHLe6kyqRXQif2eCF1jDG7k5';

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function writer(size) {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let at = 0;
  return {
    buf,
    bytes(b) {
      buf.set(b, at);
      at += b.length;
    },
    u8(v) {
      buf[at++] = Number(v);
    },
    u64(v) {
      view.setBigUint64(at, BigInt(v), true);
      at += 8;
    },
    done() {
      if (at !== size) throw new Error(`wrote ${at} of ${size}`);
      return buf;
    }
  };
}

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  return {
    bytes(n) {
      const out = bytes.subarray(at, at + n);
      at += n;
      return out;
    },
    u8: () => bytes[at++],
    u64() {
      const v = view.getBigUint64(at, true);
      at += 8;
      return v;
    },
    left: () => bytes.length - at
  };
}

// mint/trader are base58 address strings; amounts are BigInt base units.
export function encodeTradeEvent({ mint, trader, isBuy, solAmount, tokenAmount, fee, virtualSol, realSol, tokenReserves }) {
  const w = writer(8 + 113);
  w.bytes(fromHex(TRADE_EVENT_DISC));
  w.bytes(fromBase58(mint));
  w.bytes(fromBase58(trader));
  w.u8(isBuy ? 1 : 0);
  for (const v of [solAmount, tokenAmount, fee, virtualSol, realSol, tokenReserves]) w.u64(v);
  return w.done();
}

export function encodeCoinCreatedEvent({
  kickUserId,
  mint,
  decimals,
  gradBarLamports,
  gradBarClaimedLamports,
  virtualSolReserves
}) {
  const w = writer(8 + 65);
  w.bytes(fromHex(COIN_CREATED_DISC));
  w.u64(kickUserId);
  w.bytes(fromBase58(mint));
  w.u8(decimals);
  w.u64(gradBarLamports);
  w.u64(gradBarClaimedLamports);
  w.u64(virtualSolReserves);
  return w.done();
}

// Decodes one event payload (discriminator + fields). Unknown discriminators
// return null rather than throwing: the program will grow events this decoder
// version has never heard of, and skipping them must be safe.
export function decodeEvent(bytes) {
  if (bytes.length < 8) return null;
  const disc = toHex(bytes.subarray(0, 8));
  const r = reader(bytes.subarray(8));
  if (disc === TRADE_EVENT_DISC && r.left() === 113) {
    return {
      type: 'trade',
      mint: toBase58(r.bytes(32)),
      trader: toBase58(r.bytes(32)),
      isBuy: r.u8() === 1,
      solAmount: r.u64(),
      tokenAmount: r.u64(),
      fee: r.u64(),
      virtualSol: r.u64(),
      realSol: r.u64(),
      tokenReserves: r.u64()
    };
  }
  if (disc === COIN_CREATED_DISC && r.left() === 65) {
    return {
      type: 'coinCreated',
      kickUserId: r.u64(),
      mint: toBase58(r.bytes(32)),
      decimals: r.u8(),
      gradBarLamports: r.u64(),
      gradBarClaimedLamports: r.u64(),
      virtualSolReserves: r.u64()
    };
  }
  return null;
}

// Pulls every event our program emitted in one transaction, in emission order.
// The walk is over innerInstructions only, and only instructions whose program
// is ours and whose data opens with the EVENT_IX_TAG. eventIndex counts our
// event-CPIs positionally INCLUDING ones with unknown discriminators, so the
// (signature, event_index) identity of a trade never shifts when a future
// decoder learns a new event type.
export function eventsFromTransaction(tx) {
  const msg = tx?.transaction?.message;
  if (!msg || !tx.meta) return [];
  const keys = [...(msg.accountKeys || [])];
  if (tx.meta.loadedAddresses) {
    keys.push(...(tx.meta.loadedAddresses.writable || []), ...(tx.meta.loadedAddresses.readonly || []));
  }
  const out = [];
  let eventIndex = 0;
  for (const group of tx.meta.innerInstructions || []) {
    for (const ix of group.instructions || []) {
      const program = ix.programIdIndex != null ? keys[ix.programIdIndex] : ix.programId;
      if (program !== PROGRAM_ID || typeof ix.data !== 'string') continue;
      let data;
      try {
        data = fromBase58(ix.data);
      } catch {
        continue;
      }
      if (data.length < 8 || toHex(data.subarray(0, 8)) !== EVENT_IX_TAG) continue;
      const event = decodeEvent(data.subarray(8));
      if (event) out.push({ eventIndex, event });
      eventIndex += 1;
    }
  }
  return out;
}
