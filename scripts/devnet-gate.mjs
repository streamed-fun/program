// The devnet gate driver: runs the deployed curve program through its first
// real lifecycle and produces the phase-3 gate measurements. Initializes
// Global if absent, creates a rehearsal coin, runs scripted buys and sells
// from two throwaway wallets, and — the load-bearing part — predicts every
// trade with the executable reference (js/curve.js) first and demands
// the on-chain state land exactly there, with slippage minimums set to the
// exact quote so any rounding drift fails loudly instead of rounding quietly.
// Ends by decoding the TradeEvent bytes off a real transaction with the same
// js/events.js the indexer uses: the full contract, live.
//
// Needs: DEVNET_DEPLOYER_KEYPAIR in `.dev.vars`, as a PATH to the keypair file
// (see the note in devvars.mjs on why never as a value), optional RPC_URL and
// VIRTUAL_SOL (whole SOL, default 30 — the undecided open, spec §9).
// Prints every figure in SOL and lamports; never dollars.
//
//   npm run program:gate

import { randomBytes } from 'node:crypto';
import { loadDevVars, keypairBytes } from './devvars.mjs';
import { keypairFromSeed, buildTransaction, systemTransfer, sha256, findProgramAddress } from '../js/tx.js';
import {
  PROGRAM_ID,
  pdas,
  ata,
  initializeGlobalIx,
  createCoinIx,
  buyIx,
  sellIx,
  decodeGlobal,
  decodeCurve
} from '../js/program.js';
import { eventsFromTransaction, fromBase58 } from '../js/events.js';
import * as curve from '../js/curve.js';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const SOL = 1_000_000_000n;
const SIG_FEE = 5000n;

const fmtSol = (lamports) => `${(Number(lamports) / 1e9).toFixed(9)} SOL (${lamports} lamports)`;

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await res.json();
  if (body.error) {
    const logs = body.error.data?.logs ? `\n${body.error.data.logs.join('\n')}` : '';
    throw new Error(`${method}: ${body.error.message}${logs}`);
  }
  return body.result;
}

const getBalance = async (pubkey) => BigInt((await rpc('getBalance', [pubkey, { commitment: 'confirmed' }])).value);

async function getAccount(pubkey) {
  const res = await rpc('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!res.value) return null;
  return { ...res.value, data: Uint8Array.from(Buffer.from(res.value.data[0], 'base64')) };
}

async function sendTx(instructions, signers, label) {
  const { blockhash } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const tx = buildTransaction({ instructions, recentBlockhash: blockhash, signers });
  const sig = await rpc('sendTransaction', [
    Buffer.from(tx.bytes).toString('base64'),
    { encoding: 'base64', preflightCommitment: 'confirmed' }
  ]);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      return sig;
    }
  }
  throw new Error(`${label}: not confirmed after 60s (${sig})`);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`MISMATCH ${what}: on-chain ${actual} vs reference ${expected}`);
  }
  console.log(`  ok ${what} = ${actual}`);
}

loadDevVars();
let payer;
try {
  payer = keypairFromSeed(keypairBytes('DEVNET_DEPLOYER_KEYPAIR'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`rpc:      ${RPC_URL}`);
console.log(`program:  ${PROGRAM_ID}`);
console.log(`deployer: ${payer.publicKey}`);

const programAccount = await getAccount(PROGRAM_ID);
if (!programAccount?.executable) {
  console.error('program is not deployed at this address — run the devnet deploy workflow first');
  process.exit(1);
}
const startBalance = await getBalance(payer.publicKey);
console.log(`balance:  ${fmtSol(startBalance)}\n`);

const p = pdas(0);
let globalAccount = await getAccount(p.global.address);
if (!globalAccount) {
  const virtualSol = BigInt(process.env.VIRTUAL_SOL || 30) * SOL;
  const derivedPub = (label) => keypairFromSeed(sha256(new TextEncoder().encode(label), fromBase58(payer.publicKey))).publicKey;
  const params = {
    creatorAuthority: payer.publicKey,
    oraclePubkeys: [derivedPub('oracle-0'), derivedPub('oracle-1'), derivedPub('oracle-2')],
    oracleThreshold: 2,
    relayerPubkey: payer.publicKey,
    treasury: derivedPub('treasury'),
    feeBps: 100,
    creatorShareBps: 1500,
    tokenTotalSupply: 10_000_000n * 1_000_000n,
    tokenDecimals: 6,
    defaultVirtualSolReserves: virtualSol,
    claimDelaySeconds: 172_800n,
    claimPeriodSeconds: 86_400n,
    claimCapPerPeriod: 10,
    // The flat graduation bars (D20 revised), in collected SOL: one finish
    // line for every coin, baked in at creation.
    gradBarLamports: 160n * SOL,
    gradBarClaimedLamports: 136n * SOL,
  };
  console.log(`initialize_global: virtual reserve ${fmtSol(virtualSol)} (the undecided open, spec §9)`);
  await sendTx([initializeGlobalIx({ authority: payer.publicKey, params })], [payer], 'initialize_global');
  globalAccount = await getAccount(p.global.address);
}
const global = decodeGlobal(globalAccount.data);
console.log(`global:   fee ${global.feeBps}bps (all of it to the treasury), creator ${global.creatorShareBps}bps`);

const treasuryBefore = await getBalance(global.treasury);
if (treasuryBefore === 0n) {
  await sendTx([systemTransfer({ from: payer.publicKey, to: global.treasury, lamports: 2_000_000n })], [payer], 'fund treasury');
}
const treasuryStart = await getBalance(global.treasury);

const kickUserId = BigInt(Date.now());
const mint = keypairFromSeed(randomBytes(32));
console.log(`\ncreate_coin: kick_user_id ${kickUserId}, mint ${mint.publicKey}`);
const beforeCreate = await getBalance(payer.publicKey);
await sendTx(
  [createCoinIx({
    kickUserId,
    name: 'Gate Rehearsal',
    symbol: 'GATE',
    // ⛔ NEVER THE REAL DOMAIN. The program only length-checks name/symbol/uri
    // and discards them today, but they still sit in the instruction data of a
    // public transaction forever. A devnet rehearsal put streamed.fun on chain
    // while the site was still a gated private beta. .invalid is a reserved TLD
    // that can never resolve, so it leaks nothing and cannot be mistaken for a
    // live endpoint.
    uri: 'https://example.invalid/gate.json',
    creatorAuthority: payer.publicKey,
    payer: payer.publicKey,
    // The address, not the keypair: every account in an instruction is a base58
    // string. The keypair itself belongs in the signers array below.
    mint: mint.publicKey
  })],
  [payer, mint],
  'create_coin'
);
const afterCreate = await getBalance(payer.publicKey);
const createCost = beforeCreate - afterCreate - SIG_FEE * 2n;
console.log(`per-coin creation cost (rent, excluding tx fee): ${fmtSol(createCost)}`);

const cp = pdas(kickUserId);
const onchain = decodeCurve((await getAccount(cp.curve.address)).data);
const ref = curve.createCurve({
  virtualSol: onchain.virtualSolReserves,
  float: onchain.tokenReserves,
  feeBps: BigInt(global.feeBps)
});

// ⚠️ SIZED TO WHAT THE DEPLOY PAYER ACTUALLY HOLDS, NOT TO WHAT LOOKS REALISTIC.
// The idle 5 SOL lives in the relayer, whose key is a Worker secret, while this
// runs in GitHub Actions holding only the deployer key — no runner can move
// funds between the two, so the gate has to fit inside the payer.
//
// ⭐ THIS COSTS THE RUN NOTHING. Every assertion below is exact equality against
// the reference curve, and the fee take is checked as a lamport delta against
// paidIn - paidOut - reserve. Both hold at any trade size. Only the absolute
// numbers look smaller; the arithmetic they prove is identical.
// ⛔ DERIVED, NOT RANDOM, AND THAT IS A FUNDING FIX RATHER THAN A STYLE CHOICE.
// These were `keypairFromSeed(randomBytes(32))`, and the sweep that returns
// their balance to the payer only runs at the very end. Any failure before it
// stranded the funding in two wallets whose keys existed for one process and
// then ceased to exist. One aborted run cost 0.65 SOL permanently, which on a
// devnet with no reachable faucet is most of a day's budget.
//
// Seeded off the payer's own key, so a re-run lands on the same two addresses
// and whatever they still hold is spendable again.
const traderSeed = (label) => sha256(fromBase58(payer.publicKey), new TextEncoder().encode(label));
const t1 = keypairFromSeed(traderSeed('gate-trader-1'));
const t2 = keypairFromSeed(traderSeed('gate-trader-2'));

// Top up to the target rather than transferring blindly: on a re-run the
// traders usually already hold most of it.
const T1_TARGET = 200_000_000n;
const T2_TARGET = 100_000_000n;
const topUps = [];
for (const [t, target] of [[t1, T1_TARGET], [t2, T2_TARGET]]) {
  const have = await getBalance(t.publicKey);
  console.log(`trader ${t.publicKey}: holds ${fmtSol(have)}, target ${fmtSol(target)}`);
  if (have < target) {
    topUps.push(systemTransfer({ from: payer.publicKey, to: t.publicKey, lamports: target - have }));
  }
}
if (topUps.length) await sendTx(topUps, [payer], 'fund traders');
else console.log('traders already funded, nothing to transfer');

async function trade(kind, trader, amount, label) {
  const quote = kind === 'buy' ? curve.buy(ref, amount) : curve.sell(ref, amount);
  const minOut = kind === 'buy' ? quote.tokensOut : quote.netOut;
  const build = kind === 'buy' ? buyIx : sellIx;
  const sig = await sendTx(
    [build({ kickUserId, trader: trader.publicKey, mint: mint.publicKey, treasury: global.treasury, amount, minOut })],
    [trader],
    label
  );
  const c = decodeCurve((await getAccount(cp.curve.address)).data);
  console.log(`${label} (${fmtSol(kind === 'buy' ? amount : quote.netOut)}${kind === 'sell' ? ' out' : ''})`);
  assertEq(c.realSolReserves, ref.Sr, `${label} real reserve`);
  assertEq(c.tokenReserves, ref.T, `${label} token reserve`);
  assertEq(c.outstanding, ref.outstanding, `${label} outstanding`);
  return { sig, quote };
}

console.log('\nscripted trades, each min-out pinned to the exact reference quote:');
// Named so the event assertion below cannot drift from it. It was a literal
// 1n * SOL in both places, and scaling the trade in one left the other behind.
const BUY_1 = 100_000_000n;
const b1 = await trade('buy', t1, BUY_1, 'buy 1');
await trade('buy', t1, 40_000_000n, 'buy 2');
await trade('buy', t2, 50_000_000n, 'buy 3');
const t1Tokens = (await getAccount(ata(t1.publicKey, mint.publicKey)))?.data;
const t1Amount = new DataView(t1Tokens.buffer, t1Tokens.byteOffset).getBigUint64(64, true);
await trade('sell', t1, t1Amount / 3n, 'sell 1');
const t2Tokens = (await getAccount(ata(t2.publicKey, mint.publicKey)))?.data;
const t2Amount = new DataView(t2Tokens.buffer, t2Tokens.byteOffset).getBigUint64(64, true);
await trade('sell', t2, t2Amount, 'sell 2 (whole bag)');

const treasuryEnd = await getBalance(global.treasury);
const expectedTake = ref.paidIn - ref.paidOut - ref.Sr;
console.log('\nfee take:');
assertEq(treasuryEnd - treasuryStart, expectedTake, 'treasury delta vs reference');

console.log('\nevent contract, decoded off the live transaction:');
const tx = await rpc('getTransaction', [b1.sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
const events = eventsFromTransaction(tx);
if (events.length !== 1) throw new Error(`expected 1 event on buy 1, got ${events.length}`);
const ev = events[0].event;
assertEq(ev.type, 'trade', 'event type');
assertEq(ev.mint, mint.publicKey, 'event mint');
assertEq(ev.solAmount, BUY_1, 'event sol amount');
assertEq(ev.tokenAmount, b1.quote.tokensOut, 'event token amount');

for (const t of [t1, t2]) {
  const bal = await getBalance(t.publicKey);
  if (bal > SIG_FEE) {
    await sendTx([systemTransfer({ from: t.publicKey, to: payer.publicKey, lamports: bal - SIG_FEE })], [t], 'sweep');
  }
}
const endBalance = await getBalance(payer.publicKey);

console.log('\n=== gate numbers ===');
console.log(`per-coin creation cost:   ${fmtSol(createCost)}`);
console.log(`net fee take (5 trades):  ${fmtSol(treasuryEnd - treasuryStart)}`);
console.log(`total run cost to payer:  ${fmtSol(startBalance - endBalance)}`);
console.log(`payer balance remaining:  ${fmtSol(endBalance)}`);
console.log('\nall on-chain states matched the reference exactly; slippage minimums were exact quotes.');
