// Initialize (or retune) the program's Global config account on a cluster.
//
// Split out of scripts/devnet-gate.mjs, where this only ever happened as a side
// effect of a rehearsal run. It is the one setup step between a freshly
// deployed program and a usable one — nothing else can run until Global exists,
// because every instruction reads its economics from it.
//
//   npm run program:init                 # devnet, initialize if absent
//   npm run program:init -- --update     # retune an existing Global
//   npm run program:init -- --url https://api.mainnet-beta.solana.com
//
// Reads DEVNET_DEPLOYER_KEYPAIR from `.dev.vars`, as a PATH to the keypair file.
// That key becomes Global.authority, which on
// mainnet is meant to be the Squads multisig (D10) — hence the refusal below.
//
// Global's layout is not migrated by a program upgrade. If you change the
// struct, an existing Global deserializes short and every instruction fails.
// There is no close or realloc path, so on devnet the fix is a fresh program
// id; see program/README.md.

import { keypairFromSeed, buildTransaction } from '../js/tx.js';
import { initializeGlobalIx, updateGlobalIx, decodeGlobal, pdas, PROGRAM_ID } from '../js/program.js';
import { loadDevVars, keypairBytes } from './devvars.mjs';

loadDevVars();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = flag('url', 'https://api.devnet.solana.com');
const update = args.includes('--update');

const SOL = 1_000_000_000n;
const fmtSol = (n) => `${(Number(n) / 1e9).toFixed(4)} SOL`;

async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let deployerBytes;
try {
  deployerBytes = keypairBytes('DEVNET_DEPLOYER_KEYPAIR');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (url.includes('mainnet')) {
  console.error(
    'refusing to run against mainnet: Global.authority must be the Squads multisig (D10),\n' +
      'which means building this transaction for the multisig to sign, not signing it here.'
  );
  process.exit(1);
}

const payer = keypairFromSeed(deployerBytes);
const p = pdas(0);

console.log(`cluster:  ${url}`);
console.log(`program:  ${PROGRAM_ID}`);
console.log(`authority:${payer.publicKey}`);
console.log(`global:   ${p.global.address}`);

const program = await rpc('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
if (!program?.value) {
  console.error('\nprogram is not deployed at this address — run `npm run program:deploy` first');
  process.exit(1);
}

const existing = await rpc('getAccountInfo', [p.global.address, { encoding: 'base64' }]);
if (existing?.value && !update) {
  const bytes = Buffer.from(existing.value.data[0], 'base64');
  console.log(`\nglobal already exists (${bytes.length} bytes)`);
  try {
    const g = decodeGlobal(new Uint8Array(bytes));
    console.log(`  fee ${g.feeBps}bps, creator share ${g.creatorShareBps}bps`);
    console.log(`  opening reserve ${fmtSol(g.defaultVirtualSolReserves)}`);
    console.log(`  graduation ${fmtSol(g.gradBarLamports)} collected, ${fmtSol(g.gradBarClaimedLamports)} claimed`);
  } catch {
    console.error(
      '  ⚠️ could not decode it with the current layout.\n' +
        '  That means the deployed struct and this checkout disagree — a program upgrade does\n' +
        '  not migrate account data. On devnet, generate a fresh program id.'
    );
    process.exit(1);
  }
  console.log('\nnothing to do. Pass --update to retune it.');
  process.exit(0);
}

// The one opening reserve every coin shares. 30 SOL is pump.fun's number,
// carried here so devnet has something to run; the mainnet value gets picked
// at the gate. SOL-denominated on purpose: no dollar figure anywhere.
const virtualSol = 30n * SOL;

// Every role defaults to the deployer, which is a rehearsal shortcut and not
// the design: the deployer is also Global.authority AND the program's upgrade
// authority, so handing it to the Worker as creator_authority would put the key
// that can replace the program inside a web service. Set these to separate
// keys — the addresses are public, so they belong in the environment rather
// than in a keypair file.
const addr = (name) => process.env[name] || payer.publicKey;
const oracles = (process.env.ORACLE_ADDRESSES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const params = {
  creatorAuthority: addr('CREATOR_ADDRESS'),
  oraclePubkeys: [0, 1, 2].map((i) => oracles[i] || oracles[0] || payer.publicKey),
  oracleThreshold: 2,
  relayerPubkey: addr('RELAYER_ADDRESS'),
  treasury: addr('TREASURY_ADDRESS'),
  feeBps: 100,
  creatorShareBps: 1_500,
  tokenTotalSupply: 10_000_000n * 1_000_000n,
  tokenDecimals: 6,
  defaultVirtualSolReserves: virtualSol,
  claimDelaySeconds: 172_800n,
  claimPeriodSeconds: 86_400n,
  claimCapPerPeriod: 10,
  // The flat graduation bars (D20 revised), in collected SOL: 160, 136 once
  // claimed. Baked into each coin at creation; retunes touch new coins only.
  gradBarLamports: 160n * SOL,
  gradBarClaimedLamports: 136n * SOL
};

const { blockhash } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
const build = update ? updateGlobalIx : initializeGlobalIx;
const tx = buildTransaction({
  instructions: [build({ authority: payer.publicKey, params })],
  recentBlockhash: blockhash,
  signers: [payer]
});

console.log(`\n${update ? 'update_global' : 'initialize_global'}: floor reserve ${fmtSol(virtualSol)}`);
for (const [role, value] of [
  ['creator_authority', params.creatorAuthority],
  ['relayer', params.relayerPubkey],
  ['treasury', params.treasury],
  ['oracle[0]', params.oraclePubkeys[0]]
]) {
  const same = value === payer.publicKey ? '  ⚠️ same as the deployer' : '';
  console.log(`  ${role.padEnd(18)} ${value}${same}`);
}
const sig = await rpc('sendTransaction', [
  Buffer.from(tx.bytes).toString('base64'),
  { encoding: 'base64', preflightCommitment: 'confirmed' }
]);
console.log(`signature: ${sig}`);
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
