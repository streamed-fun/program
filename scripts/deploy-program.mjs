// Deploy the curve program from a laptop, with the same preflight the GitHub
// workflow does. The workflow (.github/workflows/devnet-deploy.yml) stays the
// canonical path — it runs on a clean checkout with the repo's keys — and this
// exists so the loop between changing the program and seeing it run does not
// have to go through Actions.
//
//   npm run program:deploy
//
// Reads DEVNET_PROGRAM_KEYPAIR and DEVNET_DEPLOYER_KEYPAIR from `.dev.vars`, as
// PATHS to the keypair files. Never as values — see the note in devvars.mjs.
//
// A deploy upgrades code, never account data. If Global's or Curve's layout
// changed since the last deploy, existing accounts deserialize short and every
// instruction fails — there is no realloc or close path. On devnet the fix is a
// fresh program id; see program/README.md.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { PROGRAM_ID } from '../js/program.js';
import { loadDevVars, keypairPath } from './devvars.mjs';

loadDevVars();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = flag('url', 'https://api.devnet.solana.com');
// Everything except the one command that costs money. The success path of this
// script is otherwise only reachable by spending SOL, so it goes untested.
const dryRun = args.includes('--dry-run');
// Build the artifact reproducibly (Docker) rather than with whatever this
// machine's toolchain produces. It matters more than it sounds: a deployment is
// verifiable or not verifiable *permanently*, decided here, and a plain
// cargo build-sbf produces bytes nobody else can reproduce.
const verifiable = args.includes('--verifiable');

// `stdio: 'inherit'` streams straight to the terminal and returns null rather
// than a captured string, so the callers that want output and the callers that
// want to watch a build cannot share a `.trim()`.
const run = (cmd, cmdArgs, opts = {}) => {
  const out = execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  return typeof out === 'string' ? out.trim() : '';
};

function die(message) {
  console.error(message);
  process.exit(1);
}

let programKey;
let deployerKey;
try {
  // Straight through to `solana program deploy`, which wants real files. No
  // copy is made, so there is nothing to clean up and nothing to leak.
  programKey = keypairPath('DEVNET_PROGRAM_KEYPAIR');
  deployerKey = keypairPath('DEVNET_DEPLOYER_KEYPAIR');
} catch (err) {
  die(err.message);
}

if (url.includes('mainnet')) {
  die('refusing to deploy to mainnet from a laptop: D10 puts the upgrade authority on the multisig.');
}

const programId = run('solana-keygen', ['pubkey', programKey]);
const deployer = run('solana-keygen', ['pubkey', deployerKey]);
console.log(`cluster:  ${url}`);
console.log(`program:  ${programId}`);
console.log(`deployer: ${deployer}`);

// The same check the workflow makes, and the reason it exists: deploying under
// a keypair that does not match declare_id! produces a program at an address
// nothing in this repo will ever talk to, and it costs a few SOL to find out.
if (programId !== PROGRAM_ID) {
  die(
    `\nkeypair pubkey does not match the program id this checkout expects:\n` +
      `  keypair:  ${programId}\n` +
      `  expected: ${PROGRAM_ID}  (declare_id! and js/program.js)\n` +
      `Fix one of them before spending anything.`
  );
}

const balance = Number(run('solana', ['balance', deployer, '--url', url]).split(' ')[0]);
console.log(`balance:  ${balance} SOL`);
if (balance < 3.5) {
  die(`\ndeployer needs at least 3.5 SOL — fund ${deployer} at faucet.solana.com`);
}

if (verifiable) {
  try {
    execFileSync('which', ['solana-verify'], { stdio: 'ignore' });
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    die(
      '--verifiable needs solana-verify (cargo install solana-verify) and a running Docker daemon.'
    );
  }
  // Deploying a reproducible build from a dirty tree produces bytes no commit
  // reproduces, which makes the reproducibility worthless the moment anyone
  // tries to check it.
  if (run('git', ['status', '--porcelain'])) {
    die('the working tree has uncommitted changes — commit them, or the deployed bytes match no commit.');
  }
  console.log(`commit:   ${run('git', ['rev-parse', '--short', 'HEAD'])}`);
  console.log('\nbuilding reproducibly (slow the first time — it pulls an image)...');
  run('solana-verify', ['build', '--library-name', 'streamed_coin'], { stdio: 'inherit' });
} else {
  console.log('\nbuilding...');
  run('cargo', ['build-sbf'], { cwd: 'programs/streamed_coin', stdio: 'inherit' });
  console.warn(
    '\n⚠️  This artifact is not reproducible, so the deployment it produces cannot be\n' +
      '   verified against this source — `npm run program:verify` will report a mismatch,\n' +
      '   correctly. Deploy with --verifiable when the deployment is meant to be checkable.'
  );
}

const artifact = 'target/deploy/streamed_coin.so';
if (!existsSync(artifact)) die(`build produced no artifact at ${artifact}`);
console.log(`artifact: ${statSync(artifact).size} bytes`);

if (dryRun) {
  console.log('\n--dry-run: everything up to the deploy passed. Nothing was spent.');
  process.exit(0);
}

console.log('\ndeploying...');
run(
  'solana',
  [
    'program',
    'deploy',
    artifact,
    '--program-id',
    programKey,
    '--keypair',
    deployerKey,
    '--url',
    url,
    '--commitment',
    'confirmed'
  ],
  { stdio: 'inherit' }
);

const after = Number(run('solana', ['balance', deployer, '--url', url]).split(' ')[0]);
console.log(`\ndeploy cost: ${(balance - after).toFixed(6)} SOL`);

// Recorded at deploy time because it is the only moment both halves are known
// for certain, and it is what program:verify compares against later.
if (verifiable) {
  try {
    console.log(`executable hash: ${run('solana-verify', ['get-executable-hash', artifact])}`);
  } catch {
    /* the deploy succeeded; failing to print a hash must not look like failure */
  }
}
console.log('next: npm run program:init, then npm run program:verify');
