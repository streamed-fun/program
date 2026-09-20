// Cancel a pending claim during its veto window (spec §3.4).
//
// This is the other half of a promise the program already makes. `veto_claim`
// has existed since the claim flow shipped, and until now nothing could send
// it — so the 48-hour window during which a fraudulent claim is "cancellable"
// was cancellable in principle and not in practice. A veto power nobody can
// exercise is worth exactly as much as one nobody watches.
//
//   npm run program:veto -- --list                      # what is inside a window right now
//   npm run program:veto -- --kick-user-id 12345        # inspect, send nothing
//   npm run program:veto -- --kick-user-id 12345 --confirm
//
// ⛔ SENDING IS OPT-IN, WHICH IS THE OPPOSITE OF THE OTHER SCRIPTS HERE. A
// retune moves numbers and can be moved back; a veto cancels a specific
// person's claim on their own money and forces them to start over. So the
// default prints what would happen and stops, and `--confirm` is the only way
// to send. Getting the wrong `kick_user_id` should cost a wasted command, not
// a streamer's afternoon.
//
// A veto is NOT a pause and does not contradict D9. It touches the
// `creator_vault` release path and nothing else: `buy` and `sell` stay
// permissionless and unhaltable on every coin, at every point in the claim
// state machine, including this one.
//
// Reads DEVNET_DEPLOYER_KEYPAIR from `.dev.vars` as a PATH. That key is
// `Global.authority` on devnet; on mainnet the authority is the Squads
// multisig (D10), which means building this transaction for the multisig to
// sign rather than signing it here — hence the refusal below.

import { keypairFromSeed, buildTransaction } from '../js/tx.js';
import { decodeCurve, decodeGlobal, pdas, PROGRAM_ID } from '../js/program.js';
import { vetoClaimIx, CLAIM_PENDING, CLAIM_CLAIMED } from '../js/claim.js';
import { loadDevVars, keypairBytes } from './devvars.mjs';

loadDevVars();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = flag('url', 'https://api.devnet.solana.com');
const confirm = args.includes('--confirm');
const list = args.includes('--list');
const kickUserId = flag('kick-user-id');

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

function die(message) {
  console.error(message);
  process.exit(1);
}

if (url.includes('mainnet')) {
  die(
    'refusing to run against mainnet: Global.authority is the Squads multisig (D10), so a veto\n' +
      'there is a transaction built for the multisig to sign, not one signed by this script.'
  );
}

/// A countdown a person reads at a glance. The number that matters during an
/// incident is "how long do I have", not a unix timestamp.
function remaining(seconds) {
  if (seconds <= 0) return 'window has closed — finalize can run at any moment';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

const bytesOf = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

console.log(`cluster:  ${url}`);
console.log(`program:  ${PROGRAM_ID}`);

const now = Math.floor(Date.now() / 1000);

// --- --list: every claim currently inside its veto window --------------------
//
// Deliberately answerable from this repository alone. The application has the
// same list and renders it more nicely, but an incident-response tool that
// needs a separate, private system to tell it what to act on is a weak one —
// and the program being independently operable is the entire reason it is
// public.
//
// Every `Curve` is fetched and decoded rather than filtered by a memcmp on the
// claim_state byte. The offset of that byte is a fact about the struct layout,
// and a hardcoded one would keep returning plausible answers after the layout
// moved. Fetching whole accounts cannot go subtly wrong, and this is a tool
// somebody reaches for a handful of times, under pressure.
if (list) {
  const accounts = await rpc('getProgramAccounts', [
    PROGRAM_ID,
    { encoding: 'base64', commitment: 'confirmed' }
  ]);
  const pending = [];
  for (const { pubkey, account } of accounts || []) {
    let curve;
    try {
      curve = decodeCurve(bytesOf(account.data[0]));
    } catch {
      continue; // Global, or an account this decoder does not know.
    }
    // A decoded Curve whose PDA does not re-derive from its own kick_user_id
    // is not one of ours; anyone may create an account of any size.
    if (pdas(curve.kickUserId).curve.address !== pubkey) continue;
    if (curve.claimState === CLAIM_PENDING) pending.push(curve);
  }
  if (!pending.length) {
    console.log('\nno claim is inside its veto window.');
    process.exit(0);
  }
  console.log(`\n${pending.length} claim(s) pending:\n`);
  for (const c of pending) {
    console.log(`  kick_user_id ${c.kickUserId}`);
    console.log(`    paying out to ${c.pendingDestination}`);
    console.log(`    ${remaining(Number(c.pendingUnlockAt) - now)}`);
    console.log(`    veto with: npm run program:veto -- --kick-user-id ${c.kickUserId} --confirm\n`);
  }
  process.exit(0);
}

if (!kickUserId || !/^\d{1,20}$/.test(kickUserId)) {
  die('pass --kick-user-id <id>, or --list to see what is pending');
}

const p = pdas(kickUserId);
const curveAccount = await rpc('getAccountInfo', [p.curve.address, { encoding: 'base64', commitment: 'confirmed' }]);
if (!curveAccount?.value) die(`\nno coin exists for kick_user_id ${kickUserId}`);
const curve = decodeCurve(bytesOf(curveAccount.value.data[0]));

console.log(`\ncoin:     ${curve.mint}`);
console.log(`curve:    ${p.curve.address}`);

// ⛔ The state is read and printed BEFORE anything is signed. The failure this
// prevents is vetoing the wrong coin: the operator sees the destination
// wallet and the time left, and can check both against whatever made them
// reach for this script.
if (curve.claimState === CLAIM_CLAIMED) {
  die('\nthis reserve has already been released. claim_state 2 is terminal and nothing moves it back.');
}
if (curve.claimState !== CLAIM_PENDING) {
  die('\nno claim is pending on this coin, so there is nothing to veto.');
}

const left = Number(curve.pendingUnlockAt) - now;
console.log('\npending claim');
console.log(`  destination  ${curve.pendingDestination}`);
console.log(`  unlocks at   ${new Date(Number(curve.pendingUnlockAt) * 1000).toISOString()}`);
console.log(`  ${remaining(left)}`);
console.log(`  nonce        ${curve.claimNonce} -> ${curve.claimNonce + 1n} after a veto`);
if (left <= 0) {
  console.log(
    '\n⚠️ THE WINDOW HAS CLOSED. finalize_claim is permissionless and anyone can call it, so this\n' +
      '   veto only lands if it gets there first. Send it anyway if the claim is fraudulent — but\n' +
      '   treat the reserve as gone until the chain says otherwise.'
  );
}

const globalAccount = await rpc('getAccountInfo', [p.global.address, { encoding: 'base64', commitment: 'confirmed' }]);
if (!globalAccount?.value) die('\nno Global at this address — the program is not initialized');
const global = decodeGlobal(bytesOf(globalAccount.value.data[0]));

if (!confirm) {
  console.log(
    '\nnothing sent. This is a dry run by default because a veto cancels a specific person\'s\n' +
      'claim and forces them to start over.\n\n' +
      `  npm run program:veto -- --kick-user-id ${kickUserId} --confirm`
  );
  console.log(
    '\nWhat --confirm would do: set claim_state back to 0, clear the pending destination, and\n' +
      'increment claim_nonce — which kills every oracle signature over the current message, so the\n' +
      'attestation behind this claim can never be replayed. A legitimate claimant re-claims and\n' +
      'waits the window again.'
  );
  process.exit(0);
}

let payer;
try {
  payer = keypairFromSeed(keypairBytes('DEVNET_DEPLOYER_KEYPAIR'));
} catch (err) {
  die(`${err.message}\n\nA veto is an authority instruction and needs Global.authority.`);
}
if (global.authority !== payer.publicKey) {
  die(
    `\nthe loaded key ${payer.publicKey} is not Global.authority ${global.authority};\n` +
      'the program would reject this.'
  );
}

const { blockhash } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
const tx = buildTransaction({
  instructions: [vetoClaimIx({ kickUserId, authority: payer.publicKey })],
  recentBlockhash: blockhash,
  signers: [payer]
});

const sig = await rpc('sendTransaction', [
  Buffer.from(tx.bytes).toString('base64'),
  { encoding: 'base64', preflightCommitment: 'confirmed' }
]);
console.log('\nveto_claim sent');
console.log(`signature: ${sig}`);
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
console.log('\nThe claim is cancelled and the nonce has moved. Tell the streamer: their claim was');
console.log('stopped and they need to start it again, which will wait the full window once more.');
