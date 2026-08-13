// Reference implementation of the bonding curve in onchain-coins-spec.md §3.3.
//
// This is the executable version of the spec's math, written before the Rust
// program exists so the rules are proven in isolation: pure integer arithmetic,
// BigInt throughout to mirror u64/u128 semantics, no blockchain anywhere. When
// the Anchor program is written it must match this module number-for-number
// (differential testing), which is a load-bearing part of the audit posture.
//
// Everything the spec decided lives here:
//   - buys and curve-origin sells are pure constant product (pump.fun-identical)
//   - the curve tracks `outstanding` so it knows curve-origin from vault-origin
//   - vault-origin proceeds are capped at MAX_TAKE_BPS of the payable pool
//   - no change is ever returned: unpayable vault overflow is retired into
//     `surplus`, outside pricing, forever
//   - the whole fee is the treasury's (D6): no split, no reserve top-up, and
//     the ceiling is the promised 1%
//   - k = (Sv + Sr) * T never decreases (ceil rounding on the token side)

export const MAX_FEE_BPS = 100n;
export const MAX_TAKE_BPS = 9_800n;
const BPS = 10_000n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

export class CurveError extends Error {}

function requireCond(cond, msg) {
  if (!cond) throw new CurveError(msg);
}

// virtualSol and supply-side amounts are plain integers (lamports, token base
// units). `float` is the sellable share minted into the curve at creation;
// `outstanding` starts at zero because nobody holds curve-origin tokens yet.
export function createCurve({ virtualSol, float, feeBps = 100n }) {
  requireCond(virtualSol > 0n && float > 0n, 'bad init');
  requireCond(feeBps >= 0n && feeBps <= MAX_FEE_BPS, 'fee out of bounds');
  return {
    Sv: virtualSol,
    Sr: 0n,
    T: float,
    outstanding: 0n,
    surplus: 0n,
    feeBps,
    paidIn: 0n,
    paidOut: 0n
  };
}

export function k(c) {
  return (c.Sv + c.Sr) * c.T;
}

export function price(c) {
  return Number(c.Sv + c.Sr) / Number(c.T);
}

export function buy(c, solIn) {
  requireCond(solIn > 0n, 'zero buy');
  const kk = k(c);
  const fee = (solIn * c.feeBps) / BPS;
  const net = solIn - fee;
  const newEff = c.Sv + c.Sr + net;
  const newT = ceilDiv(kk, newEff);
  const tokensOut = c.T - newT;
  requireCond(tokensOut > 0n && tokensOut <= c.T, 'buy too small');
  c.Sr += net;
  c.T = newT;
  c.outstanding += tokensOut;
  c.paidIn += solIn;
  return { tokensOut, fee };
}

export function sell(c, tokensIn) {
  requireCond(tokensIn > 0n, 'zero sell');
  const kk = k(c);
  const eff = c.Sv + c.Sr;
  const curveOrigin = tokensIn <= c.outstanding ? tokensIn : c.outstanding;
  const vaultPart = tokensIn - curveOrigin;
  // Curve-origin sells price down to Sv at most (conservation already
  // guarantees payability); any vault-origin content raises the floor so a
  // single sell can never take more than MAX_TAKE_BPS of the payable pool.
  const floorEff = vaultPart > 0n ? c.Sv + (c.Sr - (c.Sr * MAX_TAKE_BPS) / BPS) : c.Sv;
  const pricedT = (() => {
    const wanted = c.T + tokensIn;
    if (floorEff <= 0n) return wanted;
    const cap = kk / floorEff;
    return wanted < cap ? wanted : cap;
  })();
  const retired = c.T + tokensIn - pricedT;
  let newEff = ceilDiv(kk, pricedT);
  if (newEff < floorEff) newEff = floorEff;
  const gross = eff - newEff;
  requireCond(gross > 0n, 'nothing to pay');
  const fee = (gross * c.feeBps) / BPS;
  const netOut = gross - fee;
  c.Sr -= netOut + fee;
  requireCond(c.Sr >= 0n, 'insolvent: reserve went negative');
  c.T = pricedT;
  c.outstanding -= curveOrigin;
  c.surplus += retired;
  c.paidOut += netOut;
  return { netOut, fee, retired, curveOrigin, vaultPart };
}

// The invariants every state must satisfy after every operation. The test
// suite calls this relentlessly; the Rust program asserts the same set.
export function checkInvariants(c) {
  requireCond(c.Sr >= 0n, 'negative reserve');
  requireCond(c.T > 0n, 'empty curve side');
  requireCond(c.outstanding >= 0n, 'negative outstanding');
  requireCond(c.surplus >= 0n, 'negative surplus');
  requireCond(c.paidOut <= c.paidIn, 'solvency: paid out more than was ever paid in');
  return true;
}
