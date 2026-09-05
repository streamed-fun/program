#!/usr/bin/env node
// Trade the program's devnet coins from a few wallets, so a devnet deployment
// has a steady stream of real transactions to index.
//
//   node scripts/devnet-trades.mjs --wallets ../w1.json,../w2.json --trades 3 --over 6m
//   node scripts/devnet-trades.mjs --wallets ../w1.json --kick-user-id 5508767 --trades 40
//
// Without --kick-user-id every coin on the cluster is discovered from the chain
// at startup and each trade lands on a random one, so a coin created from the
// application is picked up on the next run with nothing to configure. Graduated
// coins are skipped: their curve no longer trades.
//
// --wallets takes paths to solana-keygen JSON files; keys are never passed as
// values. The endpoint's genesis hash is checked before anything is signed and
// mainnet is refused outright.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buyIx,
  sellIx,
  buildTransaction,
  attachSignature,
  webSigner,
  parseSecretKey,
  toBase58,
  pdas,
  ata,
  decodeCurve,
  decodeGlobal,
  curve as curveMath,
  sha256,
  PROGRAM_ID
} from '../js/index.js';

const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/// "2h", "90m", "45s", "0" -> milliseconds.
function duration(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`cannot read a duration from "${text}" (try 90s, 30m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
}

/// Deterministic RNG, so a run can be replayed with the same --seed.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`rpc ${res.status} for ${method}`);
  const reply = await res.json();
  if (reply.error) throw new Error(`rpc ${method}: ${reply.error.message}`);
  return reply.result;
}

/// Scheme and host only, so a keyed endpoint is safe to print.
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(unparseable rpc url)';
  }
}

async function assertDevnet(url) {
  const genesis = await rpc(url, 'getGenesisHash', []);
  if (genesis === GENESIS.mainnet) {
    throw new Error('refusing to run: this endpoint is mainnet. This script exists for devnet only.');
  }
  if (genesis !== GENESIS.devnet) {
    throw new Error(`refusing to run: genesis ${genesis} is neither devnet nor mainnet.`);
  }
}

async function loadWallet(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read wallet at ${path}: ${err.message}`);
  }
  const { publicKeyBytes } = parseSecretKey(text);
  return { path, address: toBase58(publicKeyBytes), signer: await webSigner(text) };
}

async function solOf(url, address) {
  const info = await rpc(url, 'getBalance', [address, { commitment: 'confirmed' }]);
  return BigInt(info?.value ?? 0);
}

async function tokensOf(url, owner, mint) {
  const info = await rpc(url, 'getTokenAccountBalance', [ata(owner, mint), { commitment: 'confirmed' }]).catch(
    () => null
  );
  return BigInt(info?.value?.amount ?? 0);
}

async function readAccount(url, address) {
  const info = await rpc(url, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!info?.value?.data) return null;
  return new Uint8Array(Buffer.from(info.value.data[0], 'base64'));
}

async function readCurve(url, kickUserId) {
  const bytes = await readAccount(url, pdas(kickUserId).curve.address);
  if (!bytes) throw new Error(`no curve for kick_user_id ${kickUserId}; the coin does not exist on this cluster`);
  return decodeCurve(bytes);
}

/// Every coin the program holds on the cluster, selected by the Curve account
/// discriminator.
async function discoverCoins(url) {
  const disc = toBase58(sha256(new TextEncoder().encode('account:Curve')).subarray(0, 8));
  const accounts = await rpc(url, 'getProgramAccounts', [
    PROGRAM_ID,
    { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: disc } }] }
  ]);
  const coins = [];
  for (const { pubkey, account } of accounts) {
    let curve;
    try {
      curve = decodeCurve(new Uint8Array(Buffer.from(account.data[0], 'base64')));
    } catch {
      continue;
    }
    coins.push({ address: pubkey, kickUserId: curve.kickUserId, mint: curve.mint, graduated: curve.venue !== 0 });
  }
  coins.sort((a, b) => (a.kickUserId < b.kickUserId ? -1 : a.kickUserId > b.kickUserId ? 1 : 0));
  return coins;
}

/// The state shape curve.buy / curve.sell operate on. Both mutate what they are
/// given, so every quote starts from a fresh object.
function mathState(c, feeBps) {
  return {
    Sv: c.virtualSolReserves,
    Sr: c.realSolReserves,
    T: c.tokenReserves,
    outstanding: c.outstanding,
    surplus: 0n,
    feeBps: BigInt(feeBps),
    paidIn: 0n,
    paidOut: 0n
  };
}

async function submit(url, { instruction, wallet, blockhash }) {
  const tx = buildTransaction({
    instructions: [instruction],
    recentBlockhash: blockhash,
    signers: [],
    feePayer: wallet.address,
    allowPartial: true
  });
  // The signature is over tx.message, not tx.bytes.
  const bytes = attachSignature({
    ...tx,
    publicKey: wallet.address,
    signature: await wallet.signer.sign(tx.message)
  });
  return rpc(url, 'sendTransaction', [
    Buffer.from(bytes).toString('base64'),
    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }
  ]);
}

async function confirm(url, signature, lastValidBlockHeight) {
  for (;;) {
    const status = await rpc(url, 'getSignatureStatuses', [[signature]]).catch(() => null);
    const value = status?.value?.[0];
    if (value?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(value.err)}`);
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') return;
    const height = await rpc(url, 'getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => 0);
    if (height > lastValidBlockHeight) throw new Error('blockhash expired before the trade landed');
    await sleep(1200);
  }
}

/// minOut with a tolerance applied, in whatever unit the quote returned.
function withSlippage(amount, pct) {
  const n = BigInt(amount ?? 0);
  if (n <= 0n) return 0n;
  return (n * BigInt(Math.round((100 - pct) * 100))) / 10_000n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.wallets) {
    console.log(
      [
        'Usage:',
        '  node scripts/devnet-trades.mjs --wallets a.json,b.json [--kick-user-id N] [options]',
        '',
        'Options:',
        '  --kick-user-id N  trade this one coin; without it, every coin on the cluster',
        '  --trades N        how many trades to attempt (default 20)',
        '  --over DURATION   spread them over this long, e.g. 90m (default 30m; 0 = as fast as possible)',
        '  --min-sol X       smallest buy (default 0.02)',
        '  --max-sol X       largest buy (default 0.25)',
        '  --sell-bias X     0..1, how often a wallet holding tokens sells instead of buying (default 0.4)',
        '  --slippage-pct X  tolerance used for minOut (default 5)',
        '  --seed N          deterministic run (default 1)',
        '  --rpc URL         endpoint (default https://api.devnet.solana.com)',
        '  --dry-run         plan and print, sign nothing',
        '',
        'Wallets are paths to solana-keygen JSON files with devnet SOL in them.'
      ].join('\n')
    );
    process.exit(args.help ? 0 : 1);
  }

  const url = args.rpc || process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
  const total = Number(args.trades ?? 20);
  const overMs = duration(args.over ?? '30m');
  const minSol = Number(args['min-sol'] ?? 0.02);
  const maxSol = Number(args['max-sol'] ?? 0.25);
  const sellBias = Number(args['sell-bias'] ?? 0.4);
  const slippagePct = Number(args['slippage-pct'] ?? 5);
  const dryRun = Boolean(args['dry-run']);
  const random = rng(Number(args.seed ?? 1));

  console.log(`endpoint  ${safeUrl(url)}`);
  await assertDevnet(url);
  console.log('cluster   devnet (genesis verified)');

  let coins;
  if (args['kick-user-id']) {
    const kickUserId = BigInt(args['kick-user-id']);
    const curve = await readCurve(url, kickUserId);
    coins = [{ kickUserId, mint: curve.mint, graduated: curve.venue !== 0 }];
  } else {
    coins = await discoverCoins(url);
  }
  for (const coin of coins) {
    console.log(`coin      kick ${coin.kickUserId}  ${coin.mint}${coin.graduated ? '  (graduated, skipped)' : ''}`);
  }
  coins = coins.filter((c) => !c.graduated);
  if (!coins.length) throw new Error('no tradable coin on this cluster');

  const globalBytes = await readAccount(url, pdas(0).global.address);
  if (!globalBytes) throw new Error('the program has no Global account on this cluster');
  const global = decodeGlobal(globalBytes);
  const treasury = global.treasury;
  console.log(`treasury  ${treasury}  (fee ${global.feeBps}bps)`);

  const wallets = [];
  for (const path of String(args.wallets).split(',').map((s) => s.trim()).filter(Boolean)) {
    const w = await loadWallet(path);
    w.sol = await solOf(url, w.address);
    wallets.push(w);
    console.log(`wallet    ${w.address}  ${(Number(w.sol) / 1e9).toFixed(4)} SOL`);
  }

  const broke = wallets.filter((w) => w.sol < 20_000_000n);
  if (broke.length) {
    const note = `these wallets need devnet SOL (under 0.02):\n` + broke.map((w) => `  ${w.address}`).join('\n');
    if (!dryRun) throw new Error(note);
    console.log(`\n${note}`);
  }

  const gap = total > 1 ? Math.floor(overMs / (total - 1)) : 0;
  console.log(
    `plan      ${total} trades over ${(overMs / 60000).toFixed(1)} min ` +
      `(one every ${(gap / 1000).toFixed(1)}s) across ${coins.length} coin${coins.length === 1 ? '' : 's'}, ` +
      `sell bias ${sellBias}, seed ${args.seed ?? 1}`
  );
  if (dryRun) {
    console.log('\n--dry-run: nothing signed, nothing sent.');
    return;
  }

  let done = 0;
  let failed = 0;
  for (let i = 0; i < total; i++) {
    const wallet = wallets[Math.floor(random() * wallets.length)];
    const coin = coins[Math.floor(random() * coins.length)];
    const { kickUserId, mint } = coin;
    wallet.tokens = await tokensOf(url, wallet.address, mint);
    wallet.sol = await solOf(url, wallet.address);

    const canSell = wallet.tokens > 0n;
    const selling = canSell && random() < sellBias;
    const live = await readCurve(url, kickUserId);
    if (live.venue !== 0) {
      coins.splice(coins.indexOf(coin), 1);
      console.log(`  [${i + 1}/${total}] kick ${kickUserId} graduated mid-run, dropped from the rotation`);
      if (!coins.length) break;
      continue;
    }

    let instruction;
    let describe;
    try {
      if (selling) {
        // A fraction of the holding, never all of it, so positions persist.
        const fraction = 0.15 + random() * 0.5;
        const amount = BigInt(Math.floor(Number(wallet.tokens) * fraction));
        if (amount <= 0n) continue;
        const { netOut } = curveMath.sell(mathState(live, global.feeBps), amount);
        instruction = sellIx({
          kickUserId,
          trader: wallet.address,
          mint,
          treasury,
          amount,
          minOut: withSlippage(netOut, slippagePct)
        });
        describe = `sell ${(Number(amount) / 1e6).toLocaleString()} tokens`;
      } else {
        const sol = minSol + random() * (maxSol - minSol);
        let amount = BigInt(Math.floor(sol * 1e9));
        // Keep a fee reserve in the wallet.
        const spendable = wallet.sol - 10_000_000n;
        if (spendable <= 0n) continue;
        if (amount > spendable) amount = spendable;
        const { tokensOut } = curveMath.buy(mathState(live, global.feeBps), amount);
        instruction = buyIx({
          kickUserId,
          trader: wallet.address,
          mint,
          treasury,
          amount,
          minOut: withSlippage(tokensOut, slippagePct)
        });
        describe = `buy  ${(Number(amount) / 1e9).toFixed(4)} SOL`;
      }
    } catch (err) {
      console.log(`  [${i + 1}/${total}] kick ${kickUserId}  skipped, quote failed: ${err.message}`);
      continue;
    }

    try {
      const { blockhash, lastValidBlockHeight } = (
        await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }])
      ).value;
      const signature = await submit(url, { instruction, wallet, blockhash });
      await confirm(url, signature, lastValidBlockHeight);
      done += 1;
      console.log(`  [${i + 1}/${total}] kick ${kickUserId}  ${describe}  ${wallet.address.slice(0, 6)}  ${signature.slice(0, 12)}…`);
    } catch (err) {
      failed += 1;
      console.log(`  [${i + 1}/${total}] kick ${kickUserId}  ${describe}  FAILED: ${err.message}`);
    }

    if (gap > 0 && i < total - 1) await sleep(gap);
  }

  console.log(`\n${done} landed, ${failed} failed.`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
