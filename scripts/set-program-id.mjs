// Point the whole checkout at the program keypair in `.dev.vars`.
//
//   npm run program:id            # adopt DEVNET_PROGRAM_KEYPAIR's pubkey
//   npm run program:id -- --check # verify without writing (what CI wants)
//
// The id lives in five places and every PDA in the system derives from it, so
// swapping by hand is nine edits and the fixtures are the ones you forget. It
// has been done by hand twice; this is that, reliably.
//
// Why the id has to be baked in at all, rather than discovered at deploy time:
// Anchor compiles `declare_id!` into the binary and its generated entrypoint
// rejects EVERY instruction when the address it is deployed at differs
// (`DeclaredProgramIdMismatch`, anchor-syn codegen/program/entry.rs). On top of
// that the Worker, the indexer and the LiteSVM fixtures all derive addresses
// from the same constant. A mismatch is not "slightly off" — it is a program
// that answers nothing, discovered after ~3 SOL of deploy.

import { readFileSync, writeFileSync } from 'node:fs';
import { toBase58 } from '../js/events.js';
import { findProgramAddress } from '../js/tx.js';
import { loadDevVars, keypairBytes } from './devvars.mjs';

loadDevVars();

function die(message) {
  console.error(message);
  process.exit(1);
}
const check = process.argv.includes('--check');

let programId;
try {
  programId = toBase58(keypairBytes('DEVNET_PROGRAM_KEYPAIR').subarray(32, 64));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// The current id, read from the JS mirror rather than imported, so this script
// can rewrite the file it just read without module caching getting involved.
const FILES = [
  'programs/streamed_coin/src/lib.rs',
  'programs/streamed_coin/Cargo.toml',
  'Anchor.toml',
  'README.md',
  'js/events.js',
  'js/program.js'
];
const FIXTURES = 'litesvm-tests/tests/fixtures.rs';

// Each file is asked what id IT holds, rather than trusting one file to speak
// for all of them. A run that dies partway leaves the set disagreeing, and a
// check keyed on any single file then skips the ones still holding the old id —
// which is exactly what happened, twice, and left Anchor.toml stale.
const ANCHORS = [
  ['programs/streamed_coin/src/lib.rs', /declare_id!\("([^"]+)"\)/],
  ['Anchor.toml', /streamed_coin = "([^"]+)"/],
  ['js/events.js', /PROGRAM_ID = '([^']+)'/],
  ['js/program.js', /PROGRAM_ID = '([^']+)'/],
  ['README.md', /explorer\.solana\.com\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/]
];

const held = new Map();
for (const [file, pattern] of ANCHORS) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const found = text.match(pattern)?.[1];
  if (found) held.set(file, found);
}
const distinct = [...new Set(held.values())];
console.log(`current: ${distinct.join(', ') || '(none found)'}`);
console.log(`keypair: ${programId}`);

const fixturesText = readFileSync(FIXTURES, 'utf8');
const expectedGlobal = findProgramAddress([new TextEncoder().encode('global')], programId).address;
const inSync = distinct.every((id) => id === programId) && fixturesText.includes(expectedGlobal);

if (inSync) {
  console.log('\nalready in sync.');
  process.exit(0);
}
if (check) {
  console.error('\nout of sync — run `npm run program:id` to adopt the keypair.');
  process.exit(1);
}

// Replace whatever each file holds, everywhere it appears in that file.
let touched = 0;
for (const [file, old] of held) {
  if (old === programId) continue;
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.split(old).join(programId));
  console.log(`  rewrote ${file}`);
  touched++;
}
// Files with no anchored pattern of their own still carry the id in prose.
for (const file of FILES) {
  if (held.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const before = text;
  for (const old of distinct) if (old !== programId) text = text.split(old).join(programId);
  if (text !== before) {
    writeFileSync(file, text);
    console.log(`  rewrote ${file}`);
    touched++;
  }
}

// The pinned PDAs are derived values, not occurrences of the id, so they are
// recomputed rather than substituted. The bump moves with them.
const seed = (s) => new TextEncoder().encode(s);
const kid = new Uint8Array(8);
new DataView(kid.buffer).setBigUint64(0, 4242n, true);
const derived = {
  global: findProgramAddress([seed('global')], programId),
  curve: findProgramAddress([seed('curve'), kid], programId),
  solVault: findProgramAddress([seed('sol_vault'), kid], programId),
  eventAuthority: findProgramAddress([seed('__event_authority')], programId)
};
let fx = fixturesText;
for (const [lhs, want] of [
  ['global.to_string()', derived.global.address],
  ['curve.to_string()', derived.curve.address],
  ['sol_vault.to_string()', derived.solVault.address],
  ['event_authority.to_string()', derived.eventAuthority.address]
]) {
  const re = new RegExp(`(assert_eq!\\(${lhs.replace(/[.()]/g, '\\$&')}, ")[^"]+(")`);
  if (!re.test(fx)) die(`could not find the pinned assertion for ${lhs} in ${FIXTURES}`);
  fx = fx.replace(re, `$1${want}$2`);
}
fx = fx.replace(/(assert_eq!\(curve_bump, )\d+(\))/, `$1${derived.curve.bump}$2`);
if (fx !== fixturesText) {
  writeFileSync(FIXTURES, fx);
  console.log(`  rewrote ${FIXTURES} (curve bump is now ${derived.curve.bump})`);
  touched++;
}

console.log(`\n${touched} files updated. New PDAs:`);
for (const [name, { address }] of Object.entries(derived)) {
  console.log(`  ${name.padEnd(15)} ${address}`);
}
console.log('\nnext: npm run program:test, npm run program:deploy, then npm run program:idl');
console.log('(idl.json still names the old id until program:idl regenerates it)');
