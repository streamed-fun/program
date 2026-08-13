// Reproducible builds, and checking the deployed program against one.
// <https://github.com/solana-foundation/solana-verifiable-build>
//
//   npm run program:verify            # compare the local artifact to the chain
//   npm run program:verify -- --build # rebuild reproducibly in Docker first
//   npm run program:verify -- --repo  # submit a verification from the repo
//
// The problem this solves: `npm run program:build` produces a binary that
// depends on the machine that built it — toolchain version, paths, whatever the
// linker felt like. Two people building the same commit get two different
// hashes, so "is the deployed program the code in main?" has no answer.
// `solana-verify build` runs the build inside a pinned Docker image, so the
// same commit gives the same bytes anywhere, and the hash can be compared
// against what is actually deployed.
//
// Two different things live in here and it is worth not confusing them. The
// default path is a LOCAL check: does the chain hold the bytes this source
// builds? That catches a deploy from an uncommitted working tree and is
// answerable on your own machine. `--repo` is the PUBLIC one: it submits to the
// registry explorers read, which is the only way anybody else learns that this
// program matches this repository.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROGRAM_ID } from '../js/program.js';
import { loadDevVars } from './devvars.mjs';

loadDevVars();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = flag('url', 'https://api.devnet.solana.com');
const doBuild = args.includes('--build');
const fromRepo = args.includes('--repo');

const LIBRARY_NAME = 'streamed_coin';
const ARTIFACT = 'target/deploy/streamed_coin.so';
const REPO = 'https://github.com/streamed-fun/program';

function die(message) {
  console.error(message);
  process.exit(1);
}

const capture = (cmd, cmdArgs, opts = {}) => {
  const out = execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  return typeof out === 'string' ? out.trim() : '';
};

function have(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!have('solana-verify')) {
  die(
    'solana-verify is not installed.\n' +
      '  cargo install solana-verify\n' +
      'See https://github.com/solana-foundation/solana-verifiable-build'
  );
}

// Every mode below shells into Docker. Checking once, here, beats three
// different daemon-not-running errors from three different tools.
if (doBuild || fromRepo) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    die('Docker is not running — a reproducible build happens inside a container.');
  }
}

console.log(`cluster:  ${url}`);
console.log(`program:  ${PROGRAM_ID}`);

if (doBuild) {
  console.log('\nbuilding reproducibly (this is slow the first time — it pulls an image)...');
  execFileSync('solana-verify', ['build', '--library-name', LIBRARY_NAME], {
    cwd: 'program',
    stdio: 'inherit'
  });
}

if (fromRepo) {
  // ⛔ THIS is the step that makes anything visible to an explorer. Everything
  // else in this file is a local check: it proves to YOU that the deployed bytes
  // match your source, and registers nothing anywhere. Solscan and friends read
  // the OtterSec registry, and only --remote submits to it.
  //
  // It needs the upgrade authority to sign, because the association between a
  // program and a repository is written on chain rather than merely asserted to
  // an API.
  const { keypairPath } = await import('./devvars.mjs');
  let authority;
  try {
    authority = keypairPath('DEVNET_DEPLOYER_KEYPAIR');
  } catch (err) {
    die(`${err.message}\n\n--repo needs the upgrade authority to sign the on-chain association.`);
  }
  // A verification says "this commit builds these bytes". If the tree is dirty
  // the deployed bytes correspond to no commit at all, so there is nothing
  // truthful to submit.
  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty) {
    die(
      'the working tree has uncommitted changes.\n' +
        'A verification names a commit, so commit them first — and redeploy too if any of\n' +
        'them touch the program, since the worker rebuilds that commit and compares.'
    );
  }
  const commit = capture('git', ['rev-parse', 'HEAD']);
  // The verifier clones from GitHub, so a commit that exists only here is a
  // commit it cannot check out. Local-and-committed is not enough.
  try {
    execFileSync('git', ['branch', '-r', '--contains', commit], { stdio: 'ignore' });
    if (!capture('git', ['branch', '-r', '--contains', commit])) throw new Error('unpushed');
  } catch {
    die(`${commit}\n  is not on any remote branch — push it, or the verifier cannot clone it.`);
  }
  console.log(`commit:   ${commit}`);

  // Two steps since solana-verify 0.5.1, where --remote was deprecated. They do
  // different things and both are needed:
  //
  //   1. write the verify PDA on chain — the program's own record of which
  //      repository and commit it claims to come from. Signed by the upgrade
  //      authority, because nobody else may make that claim about this program.
  //   2. ask the hosted worker to rebuild that commit and compare. The PDA is
  //      an assertion; this is what turns it into a checked one, and it is what
  //      explorers read.
  const uploader = capture('solana-keygen', ['pubkey', authority]);

  // solana-verify loads the Solana CLI's config file even when --keypair is
  // given, and a machine that has never run `solana config set` does not have
  // one. The failure is a bare "No such file or directory" arriving after the
  // Docker build, naming nothing. Writing a throwaway config sidesteps it
  // without touching the user's global CLI setup.
  const dir = mkdtempSync(join(tmpdir(), 'sv-'));
  const cliConfig = join(dir, 'config.yml');
  writeFileSync(
    cliConfig,
    `---\njson_rpc_url: ${url}\nwebsocket_url: ''\nkeypair_path: ${authority}\ncommitment: confirmed\n`
  );
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

  console.log('\n1/2 writing the verify PDA...');
  execFileSync(
    'solana-verify',
    [
      // ⚠️ --url and -c are GLOBAL options and are rejected after the subcommand.
      '--url', url,
      '-c', cliConfig,
      'verify-from-repo',
      '--skip-prompt',
      '--program-id', PROGRAM_ID,
      '--library-name', LIBRARY_NAME,
      '--commit-hash', commit,
      '--keypair', authority,
      REPO
    ],
    { stdio: 'inherit' }
  );

  // ⛔ The hosted verification service only builds mainnet programs. On any
  // other cluster the PDA above is the whole story: the program's own on-chain
  // claim about which repository and commit it came from, which anybody can
  // read and check themselves. What is missing is a third party having checked
  // it, and no explorer will show a verified badge without that.
  if (!url.includes('mainnet')) {
    console.log(
      '\n2/2 skipped: the remote verification service only supports mainnet.\n' +
        '   The PDA is written and the build is reproducible, so anyone can verify this\n' +
        '   themselves. No explorer will show it as verified until the program is on mainnet.'
    );
    process.exit(0);
  }

  console.log('\n2/2 queueing the remote build...');
  execFileSync(
    'solana-verify',
    ['--url', url, '-c', cliConfig, 'remote', 'submit-job', '--program-id', PROGRAM_ID, '--uploader', uploader],
    { stdio: 'inherit' }
  );
  console.log(`\ncheck it landed: https://verify.osec.io/status/${PROGRAM_ID}`);
  process.exit(0);
}

if (!existsSync(ARTIFACT)) {
  die(`no artifact at ${ARTIFACT} — run \`npm run program:verify -- --build\` first`);
}

// ⛔ An artifact older than the source it claims to be is the one way this
// check can lie, and it lies in the worst direction: it reports a match against
// the chain while comparing a build from before the source changed. Caught in
// practice — a merged PR changed the program, the stale .so still matched the
// deployment, and verify said ✅.
const artifactAt = statSync(ARTIFACT).mtimeMs;
// Walked in Node rather than shelled out: `stat -f %m` is macOS and means
// "filesystem info" on Linux, so the shell version passed locally and failed in
// CI with an error about block sizes.
const newestSource = (function newest(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target') continue;
      max = Math.max(max, newest(full));
    } else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') {
      max = Math.max(max, statSync(full).mtimeMs);
    }
  }
  return max;
})('programs');
if (newestSource > artifactAt) {
  die(
    `${ARTIFACT} is older than the program source.\n` +
      '  Comparing it would report on a build that no longer exists. Rebuild first:\n' +
      '    npm run program:verify -- --build'
  );
}

const local = capture('solana-verify', ['get-executable-hash', ARTIFACT]);
console.log(`\nlocal artifact:   ${local}`);

let onChain;
try {
  onChain = capture('solana-verify', ['get-program-hash', '--url', url, PROGRAM_ID]);
} catch {
  die('could not read the deployed program — is it deployed on this cluster?');
}
console.log(`deployed program: ${onChain}`);

if (local === onChain) {
  console.log('\n✅ match: the deployed program is this artifact.');
  process.exit(0);
}

console.error(
  '\n❌ MISMATCH: the deployed program is not this artifact.\n' +
    '  Expected, if the local build was not the reproducible one — run with --build.\n' +
    '  Otherwise the deployed binary is not this source, and the difference is what matters.'
);
process.exit(1);
