# streamed.fun — the curve program

[![tests](https://img.shields.io/github/actions/workflow/status/streamed-fun/program/program.yml?branch=main&label=tests)](https://github.com/streamed-fun/program/actions/workflows/program.yml)
[![verified](https://img.shields.io/github/actions/workflow/status/streamed-fun/program/program-verify.yml?branch=main&label=verified)](https://github.com/streamed-fun/program/actions/workflows/program-verify.yml)
[![build](https://img.shields.io/badge/build-reproducible-brightgreen)](#verifying-what-is-deployed)
[![security.txt](https://img.shields.io/badge/security.txt-on--chain-blue)](SECURITY.md)
[![mainnet](https://img.shields.io/badge/mainnet-not%20deployed-lightgrey)](#status)

Every streamer on [Kick](https://kick.com) can have a coin. This repository is
the part that holds the money: a Solana program implementing a constant-product
bonding curve with virtual reserves, a sell-side solvency floor, and a claim flow
that hands a streamer their share once they prove they own the channel.

**[SPEC.md](SPEC.md) is the document to read** — accounts, instructions, the
maths, and the decisions the code is built to hold. The application that consumes
this program is a separate, private repository; nothing here depends on it.

## Why the JavaScript is in here too

`js/` is a mirror of the program: the same curve maths, the same instruction
encodings, the same event layouts, written independently in JavaScript. It is not
a convenience wrapper. Three contracts hold the two implementations together, and
splitting them across repositories would mean nothing could check them in one
run:

| Contract | Rust | JavaScript | Checked by |
|---|---|---|---|
| Curve maths | `programs/streamed_coin/src/curve.rs` | `js/curve.js` | `tests/vectors.json` — 1,527 recorded steps of the reference that the port must reproduce exactly, error for error |
| Transaction bytes | `litesvm-tests/tests/fixtures.rs` | `js/tx.js` | both build the same transactions and assert identical hex, one of them with the real Solana SDK |
| Event layouts | `#[event]` structs | `js/events.js` | discriminators and byte sizes pinned on both sides |

CI regenerates `vectors.json` and fails if the committed copy is stale, so the
reference cannot drift ahead of the port silently. **If you change `js/curve.js`,
regenerate the vectors and expect to change `curve.rs` to match.**

## Layout

- `programs/streamed_coin/src/curve.rs` — the curve maths. Pure functions, no
  accounts, no CPIs.
- `programs/streamed_coin/src/lib.rs` — the Anchor program: account validation,
  token and lamport movement, and `emit_cpi!` events. Events ride inner
  instructions rather than log lines, because logs can be forged by any program
  that merely mentions ours and long transactions truncate them silently.
- `litesvm-tests/` — tests against the compiled artifact: the full lifecycle, a
  first buy that creates and buys in one transaction, slippage rejecting rather
  than rounding, and a one-lamport donation that must neither revert nor move
  the price.
- `js/` — the mirror, and the client surface. `js/index.js` is the entry point.

## Running the tests

```
npm test                    # the JavaScript mirror
cargo test -p streamed-coin # differential replay, property tests, event contract
npm run program:build       # cargo build-sbf (needs the Solana toolchain)
npm run program:test        # everything, including LiteSVM against the artifact
```

The host half needs only Rust. The LiteSVM half needs `cargo build-sbf` to have
produced `target/deploy/streamed_coin.so` first.

## Deploying

`.dev.vars` holds two keypair **paths** — never the keypairs themselves; see the
note at the top of `scripts/devvars.mjs` for why.

```
npm run program:id                        # point the checkout at DEVNET_PROGRAM_KEYPAIR
npm run program:deploy -- --dry-run       # preflight and build, spend nothing
npm run program:deploy -- --verifiable    # build in Docker, then deploy that
npm run program:init                      # initialize_global; nothing works until it exists
npm run program:idl                       # publish the IDL so explorers can decode transactions
npm run program:verify                    # confirm the chain has what this source builds
npm run program:gate                      # drive create/buy/sell against the deployed program
```

⚠️ **`--verifiable` decides something permanent.** A deployment is checkable or
it is not, and that is settled by which artifact was uploaded — not by anything
you can do afterwards. `cargo build-sbf` produces bytes that depend on the
machine, so deploying without `--verifiable` means `program:verify` will report
a mismatch forever, correctly, and the only fix is another deploy. The plain
path warns when you use it; it is fine for a throwaway devnet iteration and
wrong for anything you intend to point at.

`program:id` rewrites `declare_id!`, the JS mirror, `Anchor.toml` and the pinned
PDA fixtures together — the id lives in several places and every PDA derives from
it, so changing it by hand is nine edits and the fixtures are the ones you
forget.

⚠️ **A deploy upgrades code and never migrates account data.** Any change to the
`Global` or `Curve` struct breaks an existing deployment: the new code
deserializes the old bytes, runs short, and every instruction fails. There is no
`realloc` and no `close` path for either account, so it cannot be repaired in
place. On devnet the answer is a fresh program id. It is not an answer on
mainnet, which is a reason to be sure of these layouts before the first real
deploy rather than after.

## Verifying what is deployed

`npm run program:build` produces a binary that depends on the machine that built
it, so "is the deployed program the code in `main`?" has no answer.
[solana-verify](https://github.com/solana-foundation/solana-verifiable-build)
builds inside a pinned Docker image instead, so the same commit gives the same
bytes anywhere.

```
npm run program:verify              # compare the local artifact to the chain
npm run program:verify -- --build   # rebuild reproducibly in Docker first
npm run program:verify -- --repo    # publish the verification so explorers show it
```

**The first two are a private check and the third is a public claim.** Comparing
hashes locally proves to *you* that the chain holds what this source builds —
useful, and what the weekly workflow runs. It registers nothing anywhere.
`--repo` writes the program's own on-chain claim about which repository and
commit it came from, signed by the upgrade authority because nobody else may
make that claim, and then asks a hosted worker to check it.

⚠️ **The hosted verification service only builds mainnet programs**, so no
explorer will show a devnet program as verified however reproducible it is. On
devnet `--repo` writes the PDA and stops, which is not nothing: the claim is on
chain, the build is reproducible, and anyone can check it themselves — a fresh
clone rebuilt in the container gives the same hash as the deployment. What is
missing is a third party having done it. That becomes available at the same
moment the program reaches mainnet.

## The IDL

`idl.json` is the machine-readable description of the program's instructions,
accounts, events and errors — names, argument types, and the eight-byte
discriminators that identify each one on the wire.

Without it, an explorer showing one of our transactions can only render raw
bytes: "Unknown instruction", a base58 blob, an account list with no labels.
With it, the same transaction reads as `buy(kick_user_id, sol_in,
min_tokens_out)` against named accounts, and anyone can decode our events
without our code.

```
npm run program:idl              # build it and publish it on chain
npm run program:idl -- --build   # build only, upload nothing
```

Published through the program-metadata program into a canonical PDA derived from
the program id and the seed `idl`, which is where explorers look. Writing it
needs the upgrade authority — only whoever controls a program may say what its
interface is.

⚠️ **The IDL describes the interface, not the deployment.** Publishing one says
nothing about whether the deployed bytes match this source; that is what
`program:verify` does, and the two are independent. A program can have a
perfectly accurate IDL and be running something else entirely.

The program also embeds a
[security.txt](https://github.com/neodyme-labs/solana-security-txt), so anyone
who finds a hole can get from a program id to a contact without knowing who we
are. Read it off any build with
`strings target/deploy/streamed_coin.so | grep -A16 BEGIN`. Reporting policy is
in [SECURITY.md](SECURITY.md).

## Status

Devnet only. No mainnet deployment, no real funds. A third-party audit is a
precondition for mainnet (D18) and has not happened — `auditors` in the
security.txt says `None` and changes when that is untrue.

The devnet deployment, as of the last verified deploy:

| | |
|---|---|
| Program | [`3TdK7cTcmTQwZuZfJyDQqHLe6kyqRXQif2eCF1jDG7k5`](https://explorer.solana.com/address/3TdK7cTcmTQwZuZfJyDQqHLe6kyqRXQif2eCF1jDG7k5?cluster=devnet) |
| Executable hash | `725ddb09dec75fe4525edbe1c3ec3eeffef9fad9a4a9b49a0cab87d6c7e768b6` |
| `Global` | `F8ASxDoxa3bhuxVo2mYFeiofMgKF1gmVHgqGHPNYHKBY` |
| Reproducible | yes — built in the pinned container, and `program:verify` reports the deployed hash equal to the local one |
| security.txt | present in the deployed binary, not only in this source |
| IDL | published, so explorers decode instructions by name |
| Verified on a registry | **no, and not possible on devnet.** The hosted service only builds mainnet programs, so no explorer shows a badge. Anyone can reproduce the build themselves; nothing third-party asserts it. |

"Reproducible" means the artifact that was deployed came out of the container,
which is what makes checking it possible at all. It does not mean somebody else
has checked it — those are different claims, and only the first is made here.
