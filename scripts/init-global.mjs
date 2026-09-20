// Initialize (or retune) the program's Global config account on a cluster.
//
// Split out of scripts/devnet-gate.mjs, where this only ever happened as a side
// effect of a rehearsal run. It is the one setup step between a freshly
// deployed program and a usable one — nothing else can run until Global exists,
// because every instruction reads its economics from it.
//
//   npm run program:init                                   # devnet, initialize if absent
//   npm run program:init -- --update --grad-bar 1 --grad-bar-claimed 0.85
//   npm run program:init -- --update --grad-bar 1 --dry-run
//   npm run program:init -- --update --oracles A,B,C       # rotate the oracle set
//   npm run program:init -- --url https://api.mainnet-beta.solana.com
//
// A retune reads the Global that is there and changes only the flags given.
// update_global takes the whole parameter set, so anything else would have to
// be re-supplied from somewhere, and re-supplying the roles from this script's
// defaults would rotate the creator authority, relayer and treasury to the
// deployer without anyone asking for it.
//
// Reads DEVNET_DEPLOYER_KEYPAIR from `.dev.vars`, as a PATH to the keypair file.
// That key becomes Global.authority, which on
// mainnet is meant to be the Squads multisig (D10) — hence the refusal below.
// A --dry-run needs no key at all: it prints what would be sent and exits.
//
// Global's layout is not migrated by a program upgrade. If you change the
// struct, an existing Global deserializes short and every instruction fails.
// There is no close or realloc path, so on devnet the fix is a fresh program
// id; see program/README.md.

import { keypairFromSeed, buildTransaction } from '../js/tx.js';
import { initializeGlobalIx, updateGlobalIx, decodeGlobal, pdas, PROGRAM_ID } from '../js/program.js';
import { retuneParams, changedFields, rotatesOracles, solToLamports } from '../js/retune.js';
import { loadDevVars, keypairBytes } from './devvars.mjs';

loadDevVars();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = flag('url', 'https://api.devnet.solana.com');
const update = args.includes('--update');
const dryRun = args.includes('--dry-run');

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

if (url.includes('mainnet')) {
  console.error(
    'refusing to run against mainnet: Global.authority must be the Squads multisig (D10),\n' +
      'which means building this transaction for the multisig to sign, not signing it here.'
  );
  process.exit(1);
}

let payer;
if (!dryRun) {
  try {
    payer = keypairFromSeed(keypairBytes('DEVNET_DEPLOYER_KEYPAIR'));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const p = pdas(0);

console.log(`cluster:  ${url}`);
console.log(`program:  ${PROGRAM_ID}`);
console.log(`authority:${payer ? payer.publicKey : '(dry run, no key loaded)'}`);
console.log(`global:   ${p.global.address}`);

const program = await rpc('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
if (!program?.value) {
  console.error('\nprogram is not deployed at this address — run `npm run program:deploy` first');
  process.exit(1);
}

const readGlobal = async () => {
  const account = await rpc('getAccountInfo', [p.global.address, { encoding: 'base64' }]);
  if (!account?.value) return null;
  const bytes = Buffer.from(account.value.data[0], 'base64');
  try {
    return decodeGlobal(new Uint8Array(bytes));
  } catch {
    console.error(
      `\nglobal exists (${bytes.length} bytes) but could not be decoded with the current layout.\n` +
        '  That means the deployed struct and this checkout disagree — a program upgrade does\n' +
        '  not migrate account data. On devnet, generate a fresh program id.'
    );
    process.exit(1);
  }
};

const describe = (g) => {
  console.log(`  fee ${g.feeBps}bps, creator share ${g.creatorShareBps}bps`);
  console.log(`  opening reserve ${fmtSol(g.defaultVirtualSolReserves)}`);
  console.log(`  graduation ${fmtSol(g.gradBarLamports)} collected, ${fmtSol(g.gradBarClaimedLamports)} claimed`);
  const distinct = new Set(g.oraclePubkeys).size;
  console.log(`  oracles ${distinct}-of-${g.oraclePubkeys.length} distinct, threshold ${g.oracleThreshold}`);
  for (const [i, key] of g.oraclePubkeys.entries()) console.log(`    [${i}] ${key}`);
  if (distinct < g.oracleThreshold) {
    console.log('    ⚠️ fewer distinct keys than the threshold: no claim can be attested against this');
  }
};

const existing = await readGlobal();

if (existing && !update) {
  console.log('\nglobal already exists');
  describe(existing);
  console.log('\nnothing to do. Pass --update to retune it.');
  process.exit(0);
}
if (!existing && update) {
  console.error('\nnothing to update: no Global at this address yet. Run without --update to initialize it.');
  process.exit(1);
}

let params;
if (update) {
  const overrides = {};
  if (flag('grad-bar')) overrides.gradBarLamports = solToLamports(flag('grad-bar'));
  if (flag('grad-bar-claimed')) overrides.gradBarClaimedLamports = solToLamports(flag('grad-bar-claimed'));
  // Three addresses, comma separated, in slot order. The public halves only —
  // this script never sees an oracle's signing key, and never needs to.
  if (flag('oracles')) {
    const keys = flag('oracles').split(',').map((s) => s.trim()).filter(Boolean);
    if (keys.length !== 3) {
      console.error(`\n--oracles takes exactly three addresses, got ${keys.length}`);
      process.exit(1);
    }
    overrides.oraclePubkeys = keys;
  }
  if (flag('oracle-threshold')) overrides.oracleThreshold = Number(flag('oracle-threshold'));
  console.log('\ncurrent');
  describe(existing);
  try {
    params = retuneParams(existing, overrides);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  // Compared against the decoded Global directly rather than against
  // `retuneParams(existing)`: the point of a retune may be to fix a Global
  // that retuneParams would refuse to produce, and the baseline must not
  // throw on the very state being repaired.
  const changed = changedFields(existing, params);
  if (!changed.length) {
    console.log('\nno flags given, so nothing would change. Nothing sent.');
    process.exit(0);
  }
  console.log('\nafter');
  describe(params);
  console.log(`\nchanging: ${changed.join(', ')}. Every other value is carried forward as is.`);
  // Not a side note. The program increments `oracle_epoch` on any oracle
  // change, and `finalize_claim` refuses a claim whose epoch no longer
  // matches — so this cancels every claim that is mid-timelock. That is the
  // designed incident response (§3.4) and it is also what a routine rotation
  // does, which is why it is printed rather than assumed understood.
  if (rotatesOracles(existing, params)) {
    console.log(
      `\n⚠️ this rotates the oracle set, so oracle_epoch goes ${existing.oracleEpoch} -> ${existing.oracleEpoch + 1n}` +
        ' and EVERY pending claim is cancelled. Claimants re-initiate with a fresh attestation.'
    );
  }
  if (payer && existing.authority !== payer.publicKey) {
    console.error(`\nthe loaded key ${payer.publicKey} is not Global.authority ${existing.authority}; the program would reject this.`);
    process.exit(1);
  }
} else {
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
  const self = payer ? payer.publicKey : '(deployer)';
  const addr = (name) => process.env[name] || self;
  const oracles = (process.env.ORACLE_ADDRESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  params = {
    creatorAuthority: addr('CREATOR_ADDRESS'),
    oraclePubkeys: [0, 1, 2].map((i) => oracles[i] || oracles[0] || self),
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

  console.log(`\ninitialize_global: floor reserve ${fmtSol(virtualSol)}`);
  for (const [role, value] of [
    ['creator_authority', params.creatorAuthority],
    ['relayer', params.relayerPubkey],
    ['treasury', params.treasury],
    ['oracle[0]', params.oraclePubkeys[0]]
  ]) {
    const same = value === self ? '  ⚠️ same as the deployer' : '';
    console.log(`  ${role.padEnd(18)} ${value}${same}`);
  }
}

if (dryRun) {
  console.log('\ndry run: nothing sent.');
  process.exit(0);
}

const { blockhash } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
const build = update ? updateGlobalIx : initializeGlobalIx;
const tx = buildTransaction({
  instructions: [build({ authority: payer.publicKey, params })],
  recentBlockhash: blockhash,
  signers: [payer]
});

const sig = await rpc('sendTransaction', [
  Buffer.from(tx.bytes).toString('base64'),
  { encoding: 'base64', preflightCommitment: 'confirmed' }
]);
console.log(`\n${update ? 'update_global' : 'initialize_global'} sent`);
console.log(`signature: ${sig}`);
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

// Confirm, then read the account back rather than trusting the send: a
// transaction the RPC accepted can still fail on chain.
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const statuses = await rpc('getSignatureStatuses', [[sig]]);
  const status = statuses?.value?.[0];
  if (!status) continue;
  if (status.err) {
    console.error(`\ntransaction failed on chain: ${JSON.stringify(status.err)}`);
    process.exit(1);
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') break;
}
const after = await readGlobal();
if (!after) {
  console.error('\nconfirmed, but Global could not be read back');
  process.exit(1);
}
console.log('\nGlobal now reads');
describe(after);
if (update) {
  for (const key of ['gradBarLamports', 'gradBarClaimedLamports']) {
    if (after[key] !== params[key]) {
      console.error(`\n${key} on chain is ${after[key]}, expected ${params[key]}`);
      process.exit(1);
    }
  }
}
