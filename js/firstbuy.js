// The first buy (spec §3.6): a fan presses buy on a streamer who has no coin,
// and one transaction creates the coin and executes their purchase.
//
// Three keys sign it and no single party holds all three:
//
//   creator_authority  the Worker      — the blocklist gate, enforced on chain
//   mint               the browser     — ground for its vanity suffix (D19),
//                                        never held server-side
//   buyer              the wallet      — pays the buy AND every deposit
//
// So the Worker builds the message and signs its own slot, and the browser
// fills the other two. The buyer is the fee payer throughout: we front nothing.
//
// Worst-case size is ~1063 bytes against the 1232 limit (15 unique accounts,
// three signatures, name/symbol/uri at their 32/10/200 maxima), so this fits a
// legacy transaction with no address lookup table. `firstBuySize` exists to
// keep that true rather than assumed — the margin is 169 bytes and every
// account added to either instruction eats about 32 of it.

import { buildTransaction } from './tx.js';
import { createCoinIx, buyIx } from './program.js';

export const TX_SIZE_LIMIT = 1232;

/// Build the create+buy transaction, signed by whichever of the three keys the
/// caller actually holds. The Worker calls this with only `creatorAuthority`.
///
/// `mint` is an address, not a keypair: the browser ground it and keeps the
/// secret. Passing the pubkey is the whole security property.
export function buildFirstBuyTransaction({
  kickUserId,
  name,
  symbol,
  uri,
  creatorAuthority,
  buyer,
  mint,
  treasury,
  solIn,
  minTokensOut,
  recentBlockhash,
  signers = []
}) {
  const instructions = [
    createCoinIx({
      kickUserId,
      name,
      symbol,
      uri,
      creatorAuthority,
      // The buyer pays for the mint, the curve and both vaults. This single
      // argument is the entire "we front nothing" claim.
      payer: buyer,
      mint
    }),
    buyIx({ kickUserId, trader: buyer, mint, treasury, amount: solIn, minOut: minTokensOut })
  ];

  const tx = buildTransaction({
    instructions,
    recentBlockhash,
    signers,
    feePayer: buyer,
    allowPartial: true
  });

  if (tx.bytes.length > TX_SIZE_LIMIT) {
    throw new Error(
      `first-buy transaction is ${tx.bytes.length} bytes, over the ${TX_SIZE_LIMIT} limit — ` +
        'shorten the metadata uri or move to a versioned transaction with a lookup table'
    );
  }
  return tx;
}

/// The size this transaction would serialize to, without needing a blockhash or
/// any signer. Used by the tests to hold the margin, and worth calling before
/// adding an account to either instruction.
export function firstBuySize(args) {
  const tx = buildFirstBuyTransaction({
    ...args,
    recentBlockhash: args.recentBlockhash ?? '11111111111111111111111111111111',
    signers: []
  });
  return tx.bytes.length;
}
