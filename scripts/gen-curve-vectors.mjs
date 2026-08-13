// Generates the differential test vectors for the Rust curve port. Drives the
// reference implementation (js/curve.js, the executable spec) through
// scripted edge cases plus seeded fuzz storms, recording every outcome and
// every post-operation state. programs/streamed_coin/tests/
// differential.rs replays the file and demands bit-identical results, which is
// what "the Rust program must match the reference number-for-number" means in
// practice.
//
// Deterministic on purpose: same seeds, same file. Regenerate only when the
// reference itself changes, and commit the result.
//
//   node scripts/gen-curve-vectors.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCurve, buy, sell, checkInvariants, k, CurveError } from '../js/curve.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'programs', 'streamed_coin', 'tests', 'vectors.json');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bigIn = (rand, lo, hi) => lo + BigInt(Math.floor(rand() * Number(hi - lo)));

const snap = (c) => ({
  sv: String(c.Sv),
  sr: String(c.Sr),
  t: String(c.T),
  outstanding: String(c.outstanding),
  surplus: String(c.surplus),
  paidIn: String(c.paidIn),
  paidOut: String(c.paidOut)
});

function apply(c, op, amount) {
  const kBefore = k(c);
  try {
    const out = op === 'buy' ? buy(c, amount) : sell(c, amount);
    checkInvariants(c);
    if (k(c) < kBefore) throw new Error('k decreased');
    const serial = {};
    for (const [key, v] of Object.entries(out)) serial[key] = String(v);
    return { op, amount: String(amount), out: serial, state: snap(c) };
  } catch (e) {
    if (!(e instanceof CurveError)) throw e;
    return { op, amount: String(amount), err: e.message, state: snap(c) };
  }
}

function scenario(name, init, run) {
  const c = createCurve(init);
  const steps = [];
  run(c, (op, amount) => {
    const s = apply(c, op, amount);
    steps.push(s);
    return s;
  });
  return {
    name,
    init: {
      virtualSol: String(init.virtualSol),
      float: String(init.float),
      feeBps: Number(init.feeBps ?? 100n)
    },
    steps
  };
}

// The working numbers: 10M supply at 6 decimals, 15% creator share, so the
// float is 8.5e12 base units. 30 SOL of virtual reserve stands in for the
// undecided open (§9); the math is invariant to the choice.
const SUPPLY = 10_000_000n * 1_000_000n;
const FLOAT = SUPPLY - (SUPPLY * 1500n) / 10_000n;
const VAULT = SUPPLY - FLOAT;
const SOL = 1_000_000_000n;

const scenarios = [];

scenarios.push(
  scenario('scripted edges on the working curve', { virtualSol: 30n * SOL, float: FLOAT }, (c, step) => {
    step('sell', 1_000_000n);
    step('buy', 1n);
    step('buy', 10_000n);
    step('buy', SOL / 2n);
    step('buy', 10n * SOL);
    step('sell', c.outstanding / 3n);
    step('sell', c.outstanding);
    step('buy', 100n * SOL);
    step('sell', c.outstanding + VAULT);
    step('buy', 5n * SOL);
    step('sell', c.outstanding + 1n);
    step('sell', VAULT);
    step('buy', 3n * SOL);
    step('sell', c.outstanding / 2n + VAULT / 2n);
  })
);

scenarios.push(
  scenario('coarse curve exercises rounding and error paths', { virtualSol: 1_000_000n * SOL, float: 1_000n, feeBps: 100n }, (c, step) => {
    step('buy', 1_000n);
    step('buy', 999_000_000n);
    step('buy', 600_000_000_000n);
    step('sell', 1n);
    step('buy', 40_000_000_000_000n);
    step('sell', c.outstanding);
    step('sell', 500n);
    step('buy', 2_000_000_000_000n);
    step('sell', c.outstanding + 200n);
  })
);

scenarios.push(
  scenario('zero fee curve', { virtualSol: 5n * SOL, float: FLOAT, feeBps: 0n }, (c, step) => {
    step('buy', SOL);
    step('sell', c.outstanding / 2n);
    step('sell', c.outstanding + VAULT / 4n);
    step('buy', 2n * SOL);
    step('sell', c.outstanding + VAULT);
  })
);

for (const seed of [1, 2, 3]) {
  const rand = mulberry32(seed * 0x9e3779b9);
  scenarios.push(
    scenario(`fuzz storm seed ${seed}`, { virtualSol: 30n * SOL, float: FLOAT }, (c, step) => {
      let held = 0n;
      let vaultLeft = VAULT;
      for (let i = 0; i < 500; i++) {
        const r = rand();
        if (r < 0.02) {
          step(rand() < 0.5 ? 'buy' : 'sell', 0n);
        } else if (r < 0.55 || held + vaultLeft === 0n) {
          const before = c.outstanding;
          const res = step('buy', bigIn(rand, 1n, 2n * SOL));
          if (!res?.err) held += c.outstanding - before;
        } else {
          const wantVault = rand() < 0.25 && vaultLeft > 0n;
          const fromHeld = held > 0n ? bigIn(rand, 1n, held + 1n) : 0n;
          const fromVault = wantVault ? bigIn(rand, 1n, vaultLeft + 1n) : 0n;
          const amount = fromHeld + fromVault;
          if (amount === 0n) continue;
          const res = step('sell', amount);
          if (!res?.err) {
            held -= fromHeld;
            vaultLeft -= fromVault;
          }
        }
      }
    })
  );
}

let total = 0;
for (const s of scenarios) total += s.steps.length;
writeFileSync(OUT, JSON.stringify({ scenarios }, null, 1));
console.log(`wrote ${scenarios.length} scenarios, ${total} steps -> ${OUT}`);
