// Property tests for the reference curve (curve.js), the executable spec.
// Run with: npm test  (node --test js/)
//
// The killer cases from the adversarial review and the economics pass are all
// here: the vault dump, solvency under any ordering, the k invariant, the
// retire rule, and the worked example from the project's economics notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCurve, buy, sell, k, checkInvariants, CurveError, MAX_TAKE_BPS } from './curve.js';

const SOL = 1_000_000_000n;
// The working numbers: 10M supply at 6 decimals, 85% float, and a virtual
// reserve of 10.6 SOL (the $2,500-equivalent open used in the docs example).
const FLOAT = 8_500_000n * 1_000_000n;
const VAULT = 1_500_000n * 1_000_000n;
const SV = 10_600_000_000n;

const fresh = () => createCurve({ virtualSol: SV, float: FLOAT });

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return s;
  };
}

test('worked example: two 1 SOL buys then the whole-bag dump', () => {
  const c = fresh();
  const a = buy(c, SOL);
  const b = buy(c, SOL);
  // Doc quotes ~733k/~616k ignoring the 1% fee; with the fee both land ~1% lower.
  assert.ok(a.tokensOut > 715_000n * 1_000_000n && a.tokensOut < 740_000n * 1_000_000n);
  assert.ok(b.tokensOut > 600_000n * 1_000_000n && b.tokensOut < 625_000n * 1_000_000n);
  const poolBefore = c.Sr;

  const dump = sell(c, VAULT);
  checkInvariants(c);
  // Paid at most 98% of the pool, absorbed everything, retired the overflow.
  assert.ok(dump.netOut <= (poolBefore * MAX_TAKE_BPS) / 10_000n);
  assert.ok(dump.netOut > (poolBefore * 90n) / 100n);
  assert.ok(dump.retired > 0n);
  assert.equal(c.surplus, dump.retired);
  // The sliver left belongs to the buyers: both can still sell for something.
  const exitA = sell(c, a.tokensOut);
  assert.ok(exitA.netOut > 0n);
  checkInvariants(c);
});

test('pump.fun symmetry: curve-origin sells are never capped and never retire', () => {
  const c = fresh();
  const bought = [];
  for (let i = 0; i < 5; i++) bought.push(buy(c, SOL * BigInt(i + 1)).tokensOut);
  for (const t of bought.reverse()) {
    const r = sell(c, t);
    assert.equal(r.retired, 0n);
    assert.equal(r.vaultPart, 0n);
    checkInvariants(c);
  }
  // Full unwind: everyone out, pool owes nobody, and it never paid more than it took.
  assert.equal(c.outstanding, 0n);
  assert.ok(c.paidOut <= c.paidIn);
});

test('vault dump clears fully once buyers hold more than the vault', () => {
  const c = fresh();
  while (c.outstanding < VAULT) buy(c, SOL * 3n);
  const r = sell(c, VAULT);
  assert.equal(r.retired, 0n, 'no retire once outstanding >= vault');
  checkInvariants(c);
});

test('surplus never re-enters pricing', () => {
  const c = fresh();
  buy(c, SOL);
  sell(c, VAULT);
  const surplusBefore = c.surplus;
  buy(c, SOL * 5n);
  sell(c, c.outstanding);
  assert.equal(c.surplus, surplusBefore);
  checkInvariants(c);
});

test('k never decreases across random operation storms', () => {
  for (const seed of [1, 7, 42]) {
    const r = rng(seed);
    const c = fresh();
    let vaultLeft = VAULT;
    let held = 0n;
    let kPrev = k(c);
    for (let i = 0; i < 2_000; i++) {
      const roll = r() % 100n;
      try {
        if (roll < 45n) {
          const amt = (r() % (5n * SOL)) + 1_000_000n;
          held += buy(c, amt).tokensOut;
        } else if (roll < 80n && held > 0n) {
          const amt = (r() % held) + 1n;
          sell(c, amt);
          held -= amt;
        } else if (vaultLeft > 0n) {
          const amt = (r() % vaultLeft) + 1n;
          sell(c, amt);
          vaultLeft -= amt;
        }
      } catch (e) {
        if (!(e instanceof CurveError)) throw e;
      }
      const kNow = k(c);
      assert.ok(kNow >= kPrev, `k shrank at step ${i} (seed ${seed})`);
      kPrev = kNow;
      checkInvariants(c);
    }
  }
});

test('solvency: no ordering of buys and dumps ever pays out more than was paid in', () => {
  for (const seed of [3, 99, 1234]) {
    const r = rng(seed);
    const c = fresh();
    let vaultLeft = VAULT;
    let held = 0n;
    for (let i = 0; i < 3_000; i++) {
      const roll = r() % 3n;
      try {
        if (roll === 0n) held += buy(c, (r() % (2n * SOL)) + 1n).tokensOut;
        else if (roll === 1n && held > 0n) { const amt = (r() % held) + 1n; sell(c, amt); held -= amt; }
        else if (vaultLeft > 0n) { const amt = (r() % vaultLeft) + 1n; sell(c, amt); vaultLeft -= amt; }
      } catch (e) {
        if (!(e instanceof CurveError)) throw e;
      }
    }
    assert.ok(c.paidOut <= c.paidIn, `solvency broke (seed ${seed})`);
    assert.ok(c.Sr >= 0n);
  }
});

test('fee bounds are enforced at construction', () => {
  assert.throws(() => createCurve({ virtualSol: SV, float: FLOAT, feeBps: 101n }), CurveError);
});

test('empty pool rejects cleanly instead of paying pretend money', () => {
  const c = fresh();
  assert.throws(() => sell(c, VAULT), CurveError);
});
