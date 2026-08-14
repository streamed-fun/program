// Shared config loading for the program scripts.
//
// Reads `.dev.vars`, the gitignored local-secrets file wrangler dev already
// uses, so the program scripts do not demand the same values be re-typed on
// every command line.
//
// KEYPAIRS ARE REFERENCED BY PATH, NEVER BY VALUE, AND THAT IS DELIBERATE.
//
// The obvious convenience — accept the JSON byte array itself, so a value can
// be pasted wherever it is wanted — puts a signing key in at least three places
// it should never be:
//
//   - shell history, for anything like KEY="$(cat k.json)" npm run ...
//   - `.dev.vars` in plaintext, which wrangler dev then injects into the local
//     Worker's env, so the key is now readable by application code that has no
//     business holding it
//   - a second copy on disk, if a script has to materialize a temp file for a
//     tool that wants a real path (`solana program deploy` does)
//
// A path leaks none of that. If `.dev.vars` is read by the wrong person they
// learn where a key is, not what it is, and the file's own permissions still
// stand between them and it.
//
// The GitHub workflow does write secrets to /tmp, because GitHub secrets are
// values and there is no alternative there. Locally there is one, so take it.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/// Parse `.dev.vars` into process.env, without clobbering anything already
/// set: an explicit `FOO=bar npm run ...` should always win over the file.
export function loadDevVars(path = '.dev.vars') {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env) && value) process.env[key] = value;
  }
  return true;
}

// One example per variable. A single hardcoded filename was suggesting
// devnet-program-id.json for the deployer key, which is a confusing thing to be
// told when you are already lost.
const EXAMPLE_FILE = {
  DEVNET_PROGRAM_KEYPAIR: 'devnet-program-id.json',
  DEVNET_DEPLOYER_KEYPAIR: 'devnet-deployer.json'
};

/// The path to a keypair file, validated. Throws with something actionable.
export function keypairPath(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set.\n` +
        `Set it in .dev.vars (see .dev.vars.example) to the PATH of the keypair file:\n` +
        `  ${name}=~/keys/${EXAMPLE_FILE[name] ?? 'keypair.json'}`
    );
  }
  if (value.startsWith('[')) {
    throw new Error(
      `${name} looks like a keypair's contents rather than a path to one.\n` +
        `Point it at the file instead. A key pasted as a value ends up in shell\n` +
        `history and, from .dev.vars, in the local Worker's environment.`
    );
  }
  const expanded = value.startsWith('~/') ? value.replace(/^~/, process.env.HOME ?? '~') : value;
  // Absolute, always. Some of the tools these paths are handed to change
  // directory before opening them — solana-verify builds inside a temp clone —
  // and a relative path then resolves somewhere else entirely. That surfaces as
  // a bare "No such file or directory" after several minutes of Docker build,
  // which is a long way from the cause.
  const path = resolve(expanded);
  if (!existsSync(path)) throw new Error(`${name}=${expanded}\n  no such file.`);

  // Not enforced, just said: a keypair readable by the whole machine is a
  // different risk from one that is not, and it is invisible until stated.
  const mode = statSync(path).mode & 0o077;
  if (mode) console.warn(`  ⚠️ ${path} is readable beyond your user (chmod 600 it)`);
  return path;
}

/// The keypair's bytes, for scripts that sign in-process.
export function keypairBytes(name) {
  const path = keypairPath(name);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path}\n  is not the JSON byte array solana-keygen writes.`);
  }
  const bytes = Uint8Array.from(parsed);
  if (bytes.length !== 64) {
    throw new Error(`${path}\n  expected the 64-byte solana-keygen form, got ${bytes.length}.`);
  }
  return bytes;
}
