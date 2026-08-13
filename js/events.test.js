// Tests for the pinned event contract (events.js).
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTradeEvent, encodeCoinCreatedEvent, decodeEvent, eventsFromTransaction,
  toBase58, fromBase58, fromHex, PROGRAM_ID, EVENT_IX_TAG, TRADE_EVENT_DISC
} from './events.js';

const MINT = toBase58(new Uint8Array(32).fill(7));
const TRADER = toBase58(new Uint8Array(32).fill(9));

const trade = {
  mint: MINT, trader: TRADER, isBuy: true,
  solAmount: 1_000_000_000n, tokenAmount: 733_000_000_000n, fee: 10_000_000n,
  virtualSol: 10_600_000_000n, realSol: 990_000_000n, tokenReserves: 7_767_000_000_000n
};

// Wraps event payloads the way the program's emit_cpi does: a self-CPI whose
// instruction data is EVENT_IX_TAG + event bytes.
function txWith(instructions, { keys = [PROGRAM_ID], err = null } = {}) {
  return {
    transaction: { message: { accountKeys: keys } },
    meta: {
      err,
      innerInstructions: [{ index: 0, instructions }]
    }
  };
}

const selfCpi = (eventBytes, programIdIndex = 0) => ({
  programIdIndex,
  data: toBase58(new Uint8Array([...fromHex(EVENT_IX_TAG), ...eventBytes]))
});

test('base58 round-trips, including leading zeros', () => {
  for (const bytes of [new Uint8Array(32).fill(7), new Uint8Array([0, 0, 5, 255]), new Uint8Array([0]), new Uint8Array(32)]) {
    assert.deepEqual(fromBase58(toBase58(bytes)), bytes);
  }
  assert.throws(() => fromBase58('0OIl'));
});

test('trade event round-trips exactly', () => {
  const decoded = decodeEvent(encodeTradeEvent(trade));
  assert.deepEqual(decoded, { type: 'trade', ...trade });
});

test('coin created event round-trips exactly', () => {
  const fields = {
    kickUserId: 990002n,
    mint: MINT,
    decimals: 6,
    gradBarLamports: 160_000_000_000n,
    gradBarClaimedLamports: 136_000_000_000n,
    virtualSolReserves: 30_000_000_000n
  };
  assert.deepEqual(decodeEvent(encodeCoinCreatedEvent(fields)), { type: 'coinCreated', ...fields });
});

test('golden bytes: the layout the Rust program must reproduce', () => {
  const bytes = encodeTradeEvent(trade);
  assert.equal(bytes.length, 121);
  // discriminator = sha256("event:TradeEvent")[0..8]
  assert.equal([...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(''), TRADE_EVENT_DISC);
  // mint at 8, trader at 40, is_buy at 72, then six u64 LE
  assert.equal(bytes[72], 1);
  assert.equal(new DataView(bytes.buffer).getBigUint64(73, true), 1_000_000_000n);
  assert.equal(new DataView(bytes.buffer).getBigUint64(113, true), 7_767_000_000_000n);
});

test('events extract from inner instructions in emission order', () => {
  const sell = { ...trade, isBuy: false, solAmount: 5n };
  const tx = txWith([selfCpi(encodeTradeEvent(trade)), selfCpi(encodeTradeEvent(sell))]);
  const events = eventsFromTransaction(tx);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.eventIndex), [0, 1]);
  assert.equal(events[0].event.isBuy, true);
  assert.equal(events[1].event.solAmount, 5n);
});

test('a forged event from a foreign program is ignored', () => {
  const foreign = toBase58(new Uint8Array(32).fill(66));
  const tx = txWith([selfCpi(encodeTradeEvent(trade), 1)], { keys: [PROGRAM_ID, foreign] });
  assert.equal(eventsFromTransaction(tx).length, 0);
});

test('log lines cannot smuggle events: only inner instructions are read', () => {
  const tx = txWith([]);
  tx.meta.logMessages = [
    'Program data: ' + Buffer.from(encodeTradeEvent(trade)).toString('base64'),
    'Log truncated'
  ];
  assert.equal(eventsFromTransaction(tx).length, 0);
});

test('unknown discriminators are skipped but still consume an event index', () => {
  const unknown = new Uint8Array(50).fill(3);
  const tx = txWith([selfCpi(unknown), selfCpi(encodeTradeEvent(trade))]);
  const events = eventsFromTransaction(tx);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventIndex, 1, 'index stable when a future event type is learned');
});

test('v0 transactions resolve program ids through loadedAddresses', () => {
  const tx = txWith([selfCpi(encodeTradeEvent(trade), 2)], { keys: [MINT, TRADER] });
  tx.meta.loadedAddresses = { writable: [PROGRAM_ID], readonly: [] };
  assert.equal(eventsFromTransaction(tx).length, 1);
});

test('malformed data never throws: garbage base58, short data, missing tag', () => {
  const tx = txWith([
    { programIdIndex: 0, data: '!!not-base58!!' },
    { programIdIndex: 0, data: toBase58(new Uint8Array(3)) },
    { programIdIndex: 0, data: toBase58(encodeTradeEvent(trade)) }
  ]);
  assert.equal(eventsFromTransaction(tx).length, 0, 'event bytes without the ix tag are not events');
});
