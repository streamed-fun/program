# Security policy

This is the policy the on-chain program points at. `streamed_coin` embeds a
[security.txt](https://github.com/neodyme-labs/solana-security-txt) block in its
binary whose `policy` field is this file, so anyone who finds a bug in the
deployed program can read the address off the chain and land here without
knowing who we are.

## Status: devnet only

**Nothing is deployed to mainnet and no real funds are at risk.** The program
runs on devnet with throwaway keys. Spec decision [D18](SPEC.md) requires a
third-party audit before any mainnet deploy, and that has not happened.

That is not a reason to sit on a finding. A bug reported now costs us a commit;
the same bug reported after launch costs somebody their money.

## Reporting

**Do not open a public issue for a security bug.**

- Preferred: [a private security advisory](https://github.com/streamed-fun/program/security/advisories/new)
- Or email **security@streamed.fun**

What helps, roughly in order of usefulness:

- the program id and cluster you saw it on
- a transaction signature, or a test that reproduces it
- what an attacker gets — funds, someone else's tokens, a coin that should not
  exist, a stuck market

We will confirm receipt, tell you whether we think it is exploitable, and say
what we intend to do. If we disagree with your assessment we will say why rather
than going quiet.

## Scope

This repository is the program and its JavaScript mirror. The application that
consumes it is separate and private; findings there are still wanted, and the
same two contacts reach us.

In scope here, hardest-looking-at first:

- **`programs/streamed_coin`** — the curve program. Anything that pays out more
  than was paid in, mints supply, moves a vault, or bricks a coin's trading.
- **The claim flow** ([SPEC.md §3.4](SPEC.md)). The oracle set is the largest
  realistic loss path in the system and is deliberately bounded four ways; holes
  in those bounds are the highest-value finding here.
- **The first buy** ([SPEC.md §3.6](SPEC.md)) — one transaction creates a coin
  and buys it, and the backend co-signs. Anything that gets `creator_authority`
  to sign a transaction it did not build, or gets a coin created for a streamer
  the backend refused, is exactly the thing that gate exists to stop.
- **The JavaScript mirror** (`js/`). It builds the transactions users sign. A
  mismatch between it and the program that produces a valid-but-different
  transaction is a finding even though the program is unchanged.
- **Key handling** in `scripts/` and `.github/workflows/` — anything that puts a
  signing key somewhere it outlives the command that needed it.

Out of scope:

- **Devnet SOL.** It is free.
- **The application's simulated market data.** Every price the site shows today
  is invented; making it show a wrong number is not a vulnerability.
- Anything requiring the multisig's own keys, or a streamer's Kick credentials.

## Things we already know

Listed so nobody spends time rediscovering them. Each is in [SPEC.md](SPEC.md).

- **The program is upgradeable by the authority** (D9/D10). Deliberate while the
  code is young; the endgame — a timelock, then burning the authority — is an
  open item.
- **The authority can retune fee parameters** within bounds enforced in-program.
  The bounds exist so no value it can set halts trading or confiscates; **a value
  that escapes them is a finding.**
- **On devnet, one key currently holds every role** — authority, creator,
  relayer, oracle and the upgrade authority — which is a rehearsal shortcut and
  not the design. D10 and D13 say what mainnet requires.
- **Holder counts are approximate.** These are ordinary SPL tokens, so
  wallet-to-wallet transfers never touch the program and an indexer watching only
  it cannot see them (D15).
- **`create_coin` does not write metadata yet.** The name, symbol and URI are
  length-checked and discarded, so a freshly created coin has no on-chain
  identity. D21 says what it will do.

## Auditors

None yet. The on-chain security.txt says `auditors: "None"` and will keep saying
so until that is untrue.
