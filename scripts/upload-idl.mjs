// Generate the program's IDL and publish it on chain.
//
//   npm run program:idl              # build the IDL and upload it
//   npm run program:idl -- --build   # build only, write idl.json, upload nothing
//
// An IDL is the machine-readable description of this program's instructions,
// accounts, events and errors — names, argument types, and the eight-byte
// discriminators that identify each one on the wire. Without it an explorer
// showing one of our transactions can only render the raw bytes: "Unknown
// instruction", a base58 blob, and an account list with no labels. With it, the
// same transaction reads as `buy(kick_user_id, sol_in, min_tokens_out)` against
// named accounts, and anyone can decode our events without our code.
//
// It is published through the program-metadata program, which stores it in a
// canonical PDA derived from the program id and the seed "idl". That is the
// place explorers look, and writing it requires the program's upgrade
// authority — the point being that only whoever controls the program may say
// what its interface is.
//
// The IDL describes the interface, not the deployment. Uploading one says
// nothing about whether the deployed bytes match this source; that is what
// `program:verify` is for, and the two are independent.

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
const buildOnly = args.includes('--build');
const IDL = 'idl.json';

function die(message) {
  console.error(message);
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) => {
  const out = execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  return typeof out === 'string' ? out.trim() : '';
};

console.log(`program:  ${PROGRAM_ID}`);
console.log('\nbuilding the IDL (compiles the crate with the idl-build feature)...');
run('anchor', ['idl', 'build', '-o', IDL], { stdio: 'inherit' });
if (!existsSync(IDL)) die(`anchor produced no ${IDL}`);

// The address inside the IDL is baked from declare_id!. If it disagrees with
// what this checkout targets, something is out of sync and uploading it would
// publish an interface under the wrong program.
const idl = JSON.parse(run('cat', [IDL]));
if (idl.address !== PROGRAM_ID) {
  die(`the IDL names ${idl.address} but this checkout targets ${PROGRAM_ID} — run \`npm run program:id\``);
}
console.log(`  ${statSync(IDL).size} bytes, ${idl.instructions.length} instructions, ${(idl.events || []).length} events`);

if (buildOnly) {
  console.log(`\n--build: wrote ${IDL}, uploaded nothing.`);
  process.exit(0);
}

let authority;
try {
  authority = keypairPath('DEVNET_DEPLOYER_KEYPAIR');
} catch (err) {
  die(`${err.message}\n\nPublishing an IDL needs the program's upgrade authority.`);
}

console.log('\nuploading...');
run(
  'npx',
  [
    '--yes',
    '@solana-program/program-metadata@latest',
    'write',
    'idl',
    PROGRAM_ID,
    `./${IDL}`,
    '--keypair',
    authority,
    '--rpc',
    url
  ],
  { stdio: 'inherit' }
);
console.log(`\nread it back: npx @solana-program/program-metadata fetch idl ${PROGRAM_ID} --rpc ${url}`);
