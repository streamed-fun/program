// The public surface of @streamed-fun/program: everything a client needs to
// talk to the deployed curve program, and nothing that needs a Worker.
//
// This half of the repo is the JavaScript mirror of the Rust program, and it
// lives here rather than in the app for one reason: three contracts hold the
// two implementations together, and all three are checked by tests that have to
// run in the same job.
//
//   - the curve math, via tests/vectors.json — 1,527 recorded steps of the
//     reference below that curve.rs must reproduce exactly
//   - the transaction bytes, via litesvm-tests/tests/fixtures.rs, which builds
//     the same transactions with the real Solana SDK and asserts identical hex
//   - the event layouts, whose discriminators and byte sizes are pinned on both
//     sides
//
// Split those across two repositories and nothing can check them in one run,
// which is exactly the drift the fixtures exist to prevent.

export { PROGRAM_ID, TOKEN_PROGRAM, ATA_PROGRAM } from './program.js';
export {
  pdas,
  ata,
  encodeGlobalParams,
  initializeGlobalIx,
  updateGlobalIx,
  createCoinIx,
  buyIx,
  sellIx,
  decodeGlobal,
  decodeCurve
} from './program.js';
export {
  EVENT_IX_TAG,
  TRADE_EVENT_DISC,
  COIN_CREATED_DISC,
  toBase58,
  fromBase58,
  fromHex,
  encodeTradeEvent,
  encodeCoinCreatedEvent,
  decodeEvent,
  eventsFromTransaction
} from './events.js';
export {
  buildTransaction,
  attachSignature,
  isFullySigned,
  findProgramAddress,
  isOnCurve,
  compactU16,
  concat,
  systemTransfer,
  keypairFromSeed,
  sha256,
  SYSTEM_PROGRAM
} from './tx.js';
export { buildFirstBuyTransaction, firstBuySize, TX_SIZE_LIMIT } from './firstbuy.js';
export { webSigner, parseSecretKey } from './websigner.js';

// The executable spec for the curve. Exported because the app's simulation and
// its tests check themselves against it, and because reading it is the fastest
// way to understand what the program does.
export * as curve from './curve.js';
