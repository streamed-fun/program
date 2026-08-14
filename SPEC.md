# The streamed.fun curve program — protocol spec

What the on-chain program does, account by account and instruction by
instruction, and the constraints it is built to hold. This is the document to
read alongside `programs/streamed_coin/src/` — an auditor should need nothing
else, and if something here disagrees with the code, the code is the truth about
what runs and the disagreement is a bug in one of them.

**This is the protocol half only.** Every streamer on [Kick](https://kick.com)
can have a coin; the rules deciding *which* streamers, what a coin is worth on
day one, and where the money goes are product decisions kept with the
application, and they reach the program only as values in the `Global` config
account. Nothing below depends on knowing them. Where a number is referred to as
coming from "the project's economics notes", that is a private document and the
program's behaviour does not turn on its contents — only on the bounds this spec
states, which are enforced in-program.

## Decisions this program implements

Numbered, because the code comments and the tests refer to them by number.
Decisions about distribution and economics are omitted; the numbering is shared
with the application's spec, so the gaps are deliberate rather than missing.

| # | Decision |
|---|---|
| D1 | One Anchor program. A `Global` config PDA plus one `Curve` PDA per streamer, keyed by **Kick user ID, never by username** — usernames change, and a coin that could be inherited by whoever claims an abandoned name is not a coin for that person. |
| D2 | Plain SPL Token plus Metaplex Token Metadata, not Token-2022. Chosen for wallet and explorer compatibility. Being re-priced: a metadata extension inside the mint is measurably cheaper per coin. |
| D4 | Fixed supply per coin, 6 decimals. A fixed share is reserved for the streamer in a claim vault; the rest is the curve's sellable float. Both the supply and the share are `Global` parameters. |
| D5 | Mint authority is set to `None` and freeze authority is never set, in the same transaction that creates the coin. Permanent and irreversible: no future minting, no freezing, ever, by anyone. |
| D6 | Trades take a fee in basis points, read from `Global`, and the whole fee is the treasury's: no split, no reserve top-up. The in-program ceiling equals the promised rate (1%), so the cap is the promise. |
| D7 | **Coin creation is gated, not permissionless.** Only the `creator_authority` key may call `create_coin`, which is what makes an off-chain refusal possible at all — after a mint exists, D5 and D9 mean the token and its name are permanent. |
| D8 | Coins open at identical constants: every coin shares one opening reserve and one token float. There is no follower-based band (D20). |
| D9 | No per-wallet buy cap, no anti-snipe mechanism, no pause instruction. **Stated precisely, because the stronger claim is false:** within the deployed program's rules nobody — including the authority — can halt a coin's trading, drain its reserves, mint more supply, or freeze a holder. Two things remain true and must not be claimed away: trades read fee parameters from `Global` live, so the authority can move them, which is why §3.2 bounds them in-program to values that cannot halt or confiscate; and the program is upgradeable by the authority, so the rules themselves can be replaced. |
| D10 | `Global`'s authority, the treasury and the program's upgrade authority are all held by a multisig, not a single key. |
| D11 | Streamer identity is bound by a trusted off-chain oracle: a real Kick OAuth login is verified off chain, then an ed25519 attestation over `(kick_user_id, destination_wallet, expiry)` is signed. The claim instruction verifies that signature on chain via the native Ed25519 program before releasing the vault. |
| D12 | The claim transaction is fee-sponsored by a relayer key, so a streamer holding no SOL can still claim. The destination wallet still signs, proving live key possession. |
| D13 | Oracle keys and the relayer key are separate. Oracle compromise can misdirect a claim; relayer compromise can only waste SOL on fees. **The oracle set is the largest realistic loss path in the system**, and §3.4 bounds it four ways: 2-of-3 signing keys held separately, a timelock the multisig can veto inside, an on-chain per-period cap on initiations, and a public event for every attempt. |
| D15 | Chain data is indexed by a self-built service. Holder enumeration is a special case: these are ordinary SPL tokens, so wallet-to-wallet transfers never touch this program, and a holder list built from program events alone drifts permanently wrong. |
| D16 | SOL/USD is never touched on chain. Prices are quoted in SOL and lamports throughout; any fiat conversion is a display concern for the application. |
| D17 | Any future consumer of a coin's price resolves it from the `Curve` account alone — including after graduation, where the account records the venue it moved to. |
| D18 | Real funds do not touch mainnet without a third-party audit. Devnet and the LiteSVM suite precede it. |
| D19 | **Vanity mint addresses.** Every coin's address ends in `kick`. The mint is a supplied keypair rather than a PDA, because a PDA is derived deterministically and cannot be ground for a suffix. **The grinding happens in the buyer's browser and no mint secret key is ever held server-side** — the key signs once and `create_coin` sets its authority to `None` in the same transaction, so it is spent on use. |
| D20 | **Every coin opens at the same price and graduates at the same bars.** There is no follower-based pricing band: it would have priced concentration up without preventing it, and it would have made the backend an unverifiable oracle for follower counts. `create_coin` takes no price argument of any kind, so it cannot open a coin anywhere else. Graduation is a flat pair of collected-SOL bars in `Global`, baked into each `Curve` at creation, so retuning touches future coins only and no live coin's finish line ever moves. SOL-denominated on purpose, pump.fun style: a dollar-anchored bar breaks whenever SOL moves, so dollars are a display concern (D16). |
| D21 | Coin metadata is immutable (`is_mutable: false`) and its URI is an IPFS CID served through an HTTPS gateway. Nothing about a coin's identity is editable after creation, including by us. |

## Verification

Three contracts hold the Rust and the JavaScript mirror in this repo together,
and all three are checked by `cargo test --workspace` plus `npm test`:

| Contract | Rust | JavaScript | Checked by |
|---|---|---|---|
| Curve math | `programs/streamed_coin/src/curve.rs` | [`js/curve.js`](js/curve.js) | `tests/vectors.json` — 1,527 recorded steps the port must reproduce exactly, regenerated in CI so the reference cannot drift ahead |
| Transaction bytes | `litesvm-tests/tests/fixtures.rs` | [`js/tx.js`](js/tx.js) | both build the same transactions and assert identical hex, one with the real Solana SDK |
| Event layouts | `#[event]` structs | [`js/events.js`](js/events.js) | discriminators and byte sizes pinned on both sides |

The program is also reproducibly buildable — see the README — so the deployed
binary can be checked against this source rather than trusted.

---

## 3. On-chain program

Anchor workspace at the root of this repository, workspace member `programs/streamed_coin`.

### 3.1 Accounts

**`Global`** — singleton, seeds `["global"]`

```rust
#[account]
pub struct Global {
    pub authority: Pubkey,          // Squads multisig (D10)
    pub creator_authority: Pubkey,  // backend key allowed to call create_coin (D7)
    pub oracle_pubkeys: [Pubkey; 3],// claim attestation signers (D11, D13)
    pub oracle_threshold: u8,       // M of the 3 above must sign; 2 for v1 (D13)
    pub relayer_pubkey: Pubkey,     // sponsors claim tx fees (D12)
    pub treasury: Pubkey,           // fee destination
    pub fee_bps: u16,               // 100 = 1% (D6). The whole fee is the treasury's.
    pub creator_share_bps: u16,     // 1500 = 15% (D4)
    pub token_total_supply: u64,    // working number, a Global parameter
    pub token_decimals: u8,         // 6
    pub default_virtual_sol_reserves: u64, // the one opening reserve every coin shares (D8, D20).
                                           // SOL value set at devnet config time; see Open items.
    // Graduation bars (§3.5, D20 revised), in collected SOL, identical for every coin. These are
    // the defaults new coins bake in at creation; retuning them never touches an existing coin.
    pub grad_bar_lamports: u64,         // working number 160 SOL
    pub grad_bar_claimed_lamports: u64, // working number 136 SOL; must not exceed the bar above
    // Claim blast-radius controls (D13, §3.4)
    pub claim_delay_seconds: i64,   // timelock between initiate and finalize; 172_800 (48h) for v1
    pub claim_period_seconds: i64,  // rate-limit window; 86_400 (24h) for v1
    pub claim_cap_per_period: u16,  // max initiations per window; value TBD
    pub claims_this_period: u16,    // rolling counter, reset when the window rolls over
    pub claim_period_start: i64,    // unix ts the current window opened
    pub oracle_epoch: u64,          // +1 on any oracle rotation; cancels in-flight claims (§3.4)
    pub bump: u8,
}
```

**Hard bounds, enforced in-program as constants, not by convention.** `update_global` rejects any
value outside these. They exist so the honest version of D9 stays true: the multisig can tune the
economics but cannot use `Global` to halt trading or confiscate.

```rust
pub const MAX_FEE_BPS: u16 = 200;                  // 2%. At 10_000, every buy fails its
                                                   // tokens_out > 0 check and every sell pays 0:
                                                   // an unbounded fee is a pause-and-seize switch.
pub const MAX_TREASURY_FEE_SHARE_BPS: u16 = 10_000;// above this the fee split underflows and
                                                   // checked math reverts every trade
pub const MIN_CLAIM_DELAY_SECONDS: i64 = 86_400;   // the veto window is a public promise; the
                                                   // multisig must not be able to shrink it to 0
pub const MIN_CLAIM_CAP_PER_PERIOD: u16 = 1;       // a cap of 0 would halt all claims
```

**`Curve`** — one per streamer, seeds `["curve", kick_user_id.to_le_bytes()]`

```rust
#[account]
pub struct Curve {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    pub token_vault: Pubkey,     // token account at PDA ["token_vault", kick_user_id], authority = this Curve PDA — sellable float (D4).
                                 // Not an ATA: an ATA address is unique per (owner, mint), and this vault and creator_vault
                                 // share both, so they are seeded program accounts instead.
    pub sol_vault: Pubkey,       // system account owned by this Curve PDA — real SOL backing
    pub creator_vault: Pubkey,   // token account at PDA ["creator_vault", kick_user_id], authority = this Curve PDA — streamer's unclaimed 15% (D4)
    pub virtual_sol_reserves: u64, // constant pricing offset, copied from Global at creation,
                                   // never changes (D8, D20).
    pub grad_bar_lamports: u64,         // this coin's finish line (§3.5), baked from Global at
    pub grad_bar_claimed_lamports: u64, // creation. A retune of the defaults never reaches back
                                        // here, so the bar a buyer bought into holds forever.
    pub real_sol_reserves: u64,    // mirrors sol_vault's lamports (minus rent-exempt minimum)
    pub token_reserves: u64,       // <= token_vault.amount (see the invariant below); the AMM other side
    // Claim state machine (D11/D12/D13, §3.4)
    pub claim_state: u8,           // 0 = unclaimed, 1 = pending, 2 = claimed. Terminal at 2.
    pub pending_destination: Pubkey, // set on initiate, meaningless unless claim_state == 1
    pub pending_unlock_at: i64,    // earliest ts finalize_claim may run
    pub outstanding: u64,          // tokens sold to buyers minus curve-origin tokens sold back;
                                   // the boundary between pump.fun-pure sells and vault-origin
                                   // sells (see 3.3)
    pub claim_nonce: u64,          // starts 0, +1 on every veto. Signed into the attestation so a
                                   // vetoed attestation cannot be replayed. See §3.4.
    pub pending_oracle_epoch: u64, // Global.oracle_epoch at initiate; finalize requires it still
                                   // matches, so rotating the oracle set cancels every in-flight
                                   // claim at once. See §3.4.
    // Graduation (§3.5). These are the forward-compat surface D17 depends on: any future program
    // resolves the current price source from this account alone.
    pub venue: u8,                 // 0 = this curve, 1 = migrated. Terminal at 1.
    pub venue_pool: Pubkey,        // destination pool address; default until venue == 1
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}
```

**Invariant — read this before writing any assertion about vault balances.**

```
token_reserves  <=  token_vault.amount
real_sol_reserves  <=  sol_vault.lamports - rent_exempt_minimum
```

**These are inequalities, deliberately, and no instruction may assert equality.**

Anyone can transfer lamports into any system account and tokens into any token account, with no
signature from us and no instruction of ours involved. A stranger sending **one lamport** to a
curve's `sol_vault` makes an equality false permanently — nothing in the instruction set moves
value out of a vault except trades priced off the mirrors. Any instruction asserting equality would
let anyone brick any coin's trading forever for the cost of one lamport, per coin.

So: **the mirrored fields are authoritative for pricing.** Vault balances may exceed them. Excess
is ignored by the curve maths entirely. Every instruction still updates the mirrors in the same
transaction as the transfers it makes, so the mirrors never *exceed* the vaults — which is the
direction that matters, because that is the one that would make the program insolvent.

Optionally a permissionless `sweep_excess` crank may move the surplus to `treasury`, turning
griefing dust into revenue. Not required for correctness; it only prevents dust accumulating
untracked.

Pricing invariant: `k = (virtual_sol_reserves + real_sol_reserves) * token_reserves` is
non-decreasing across trades (ceil rounding on the token side never lets it fall).

### 3.2 Instructions

| Instruction | Signer(s) | Notes |
|---|---|---|
| `initialize_global` | `authority` (multisig) | One-time. Sets all `Global` fields including the shared `default_virtual_sol_reserves`. |
| `update_global` | `authority` (multisig) | Rotate `oracle_pubkeys` / `oracle_threshold` / `relayer_pubkey` / `creator_authority` / `treasury` / fee params. **Every value is bounded by the constants in §3.1 and the instruction rejects anything outside them** — this is what keeps D9's claim true. Any change to `oracle_pubkeys` or `oracle_threshold` **must** increment `oracle_epoch`, which cancels all in-flight claims (§3.4). Cannot touch any already-created `Curve`'s reserves or claim state. |
| `create_coin(kick_user_id, name, symbol, uri)` | `creator_authority` + the buyer as `payer` | **Blocklist gate (off-chain, mandatory): the backend checks the blocklist before submitting, with no exceptions — not for Index additions, not for fan-triggered first buys, not for streamer claims. After a mint exists there is no remedy but delisting from our own site; D5 and D9 mean the token, its name and its image are permanent and keep trading on a venue we built. Pre-mint is the only point where "no" is possible.** Enforces `name <= 32 bytes` and `symbol <= 10 bytes` (Metaplex limits, counted in **bytes not characters** — a short Kick display name with emoji can exceed both and would fail the CPI mid-create); sanitize off-chain and reject in-program. Creates the mint (6 decimals), mints `token_total_supply`, splits into `creator_vault` (15%) and `token_vault` (85%), creates Metaplex metadata via CPI, sets mint authority to `None`, never sets freeze authority (D5), initializes `Curve` with `real_sol_reserves = 0` and `token_reserves = 85% of supply`. **Metadata is immutable (`is_mutable: false`) and its `uri` is an IPFS CID served through a gateway (D21)** — nothing about a coin's identity is editable after this returns, including by us. **There is no price argument of any kind (D20 revised):** every coin opens at `Global.default_virtual_sol_reserves` and bakes `Global`'s graduation bars into its `Curve`, so this instruction cannot be used to open a coin anywhere else, and the baked bars are echoed in `CoinCreatedEvent`. **Called only ever bundled with a `buy` in the same transaction (§3.6); no coin is created without a first buyer paying for it.** |
| `buy(sol_in, min_tokens_out)` | trader (permissionless) | See §3.3. Creates the trader's ATA if needed, payer = trader. |
| `sell(tokens_in, min_sol_out)` | trader (permissionless) | See §3.3. |
| `initiate_claim(kick_user_id, destination, expiry)` | destination wallet (+ any fee payer) | **Not implemented.** Starts the claim. Full detail in §3.4. |
| `finalize_claim(kick_user_id)` | anyone (permissionless; `relayer` pays) | **Not implemented.** Completes it after the timelock. §3.4. |
| `veto_claim(kick_user_id)` | `authority` (multisig) | **Not implemented.** Cancels a pending claim during the timelock. §3.4. |
| `migrate(kick_user_id)` | anyone (permissionless) | **Not implemented.** Graduates the coin to its destination venue once the threshold is met. §3.5. |

The deployed program has five instructions: `initialize_global`, `update_global`, `create_coin`,
`buy` and `sell`. The four marked above are specified here so the account layouts carry their shape
now, and are added in a later phase. `idl.json` is the authority on what exists today.

No `pause` instruction, no per-wallet cap parameter anywhere (D9). No `admin_withdraw` from a curve's
vaults — treasury only ever receives the fee share, streamed out during `buy`/`sell`, never a lump
withdrawal from a curve's backing reserves.

**`veto_claim` is not a pause and does not conflict with D9.** It touches only the `creator_vault`
release path. `buy` and `sell` remain permissionless and unhaltable on every coin, by anyone,
including us, at every point in the claim state machine.

### 3.3 Bonding curve math

**The sell side carries a solvency floor** (working rule, revisit at the
mainnet gate).** Unfloored constant-product sells are insolvent against vault dumps: freely-minted
vault tokens sold into a shallow pool get quoted against virtual plus real reserves, and the
virtual part is not money (worked example and analysis in
the project's economics notes). The floor is not synthetic
pricing; it is ordinary constant product plus the physical constraint that only SOL that exists
can leave. The design principle: **byte-for-byte pump.fun behavior for
everyone, with the special handling attached only to the one thing pump.fun does not have, the
freely minted vault.** Curve-origin tokens (anything up to the tracked `outstanding` count) sell
at pure constant product with no caps, exactly as on pump.fun, where conservation already
guarantees payability. Vault-origin tokens are the only exception: their extraction is capped at
`MAX_TAKE_BPS` of the payable pool, and **no change is ever returned**: every token sent is
absorbed, and the unpayable overflow is retired from circulation (held as untracked surplus,
never priced, so the opening-price floor holds). A whole-bag dump gets nearly everything real,
leaves a sliver that is exit liquidity for buyers alone, and leaves the dumper holding nothing,
restoring the pump.fun property that the pool only reaches empty when nobody holds tokens.
Cumulative sell proceeds can never exceed what buyers paid in; the front end must quote the
exact payout and warn whenever a sell is till-capped rather than curve-priced. Whole-bag vault
sells clear at full curve pricing once buyers hold more tokens than the
vault itself, which is `(float/(float-vault))^2` times the opening market cap: 1.47x at 85/15.

Reserves before a trade: `Sv = virtual_sol_reserves` (constant), `Sr = real_sol_reserves`, `T = token_reserves`.
`k = (Sv + Sr) * T`.

**Buy(sol_in):**
```
fee            = sol_in * fee_bps / 10_000     // the whole fee is the treasury's (D6)
net_sol        = sol_in - fee

eff_before     = Sv + Sr
new_eff        = eff_before + net_sol
new_T          = ceil_div(k, new_eff)          // k computed from state *before* this trade
tokens_out     = T - new_T
require tokens_out > 0 and tokens_out <= T
require tokens_out >= min_tokens_out           // slippage protection

Sr            += net_sol
T              = new_T
// transfer sol_in (lamports) from trader into sol_vault
// transfer fee lamports from sol_vault to treasury
// transfer tokens_out from token_vault to trader's ATA
```

**Sell(tokens_in):**
```
MAX_TAKE_BPS   = 9_800                         // applies ONLY to vault-origin tokens; program constant

// The Curve tracks `outstanding`: += tokens_out on every buy, -= the curve-origin portion of
// every sell. Tokens up to `outstanding` are curve-origin: buyers selling back what buyers
// bought. Conservation makes those always payable, so they trade PURE constant product with the
// effective reserve floored at Sv — byte-for-byte pump.fun behavior, no caps, in every normal
// state. Any portion of a sell beyond `outstanding` is vault-origin (the streamer's freely
// minted bag): that portion is priced only as far as the pool can pay, additionally capped at
// MAX_TAKE_BPS of the payable pool so a dump always leaves the buyers a sliver.
//
// No change is ever returned: every token sent is absorbed. Vault-origin
// tokens beyond what the pool could pay for are RETIRED — held by the curve as untracked
// surplus, never counted in T, never sold, permanently out of circulation. The seller was paid
// the maximum the till allowed and walks away holding nothing, so no dust position exists to
// re-sell in shrinking crumbs. This also restores pump.fun's symmetry: after a whole-bag dump
// the dumper holds zero, the remaining sliver is exit liquidity for buyers alone, and the pool
// reaches empty exactly when nobody holds tokens. The front end MUST quote the exact payout and
// warn before a sell whose proceeds are till-capped rather than curve-priced.

eff_before     = Sv + Sr
floor_eff      = Sv + (vault-origin portion in this sell ? Sr - (Sr * MAX_TAKE_BPS) / 10_000 : 0)
priced_T       = min(T + tokens_in, k / floor_eff)   // tokens the pool can afford to price
retired        = (T + tokens_in) - priced_T          // vault-origin overflow, absorbed and retired
new_eff        = max(ceil_div(k, priced_T), floor_eff)
gross_sol_out  = eff_before - new_eff
require gross_sol_out > 0                      // symmetry with buy's tokens_out > 0; without it a
                                               // dust sell donates tokens for zero SOL

fee            = gross_sol_out * fee_bps / 10_000  // the whole fee is the treasury's (D6)
net_sol_out    = gross_sol_out - fee

require net_sol_out >= min_sol_out             // slippage protection

Sr            -= (net_sol_out + fee)           // Sr drops by exactly what left the vault
T              = priced_T                      // retired overflow sits in token_vault as surplus, outside T forever
// transfer ALL tokens_in from trader's ATA to token_vault
// transfer net_sol_out lamports from sol_vault to trader
// transfer fee lamports from sol_vault to treasury
```

All arithmetic in `u128` intermediates with `checked_*` operations; reject the instruction on any
overflow, underflow, or division producing zero where a nonzero result is required. `ceil_div`
rounds in the program's favor (against the trader) on both sides, standard practice for AMMs.

**This section has an executable reference implementation: [`js/curve.js`](js/curve.js),
with the property suite in `js/curve.test.js` (`npm test`).** BigInt arithmetic mirroring the
u64/u128 semantics above, plus fuzz storms asserting k-monotonicity and `paid_out <= paid_in` across
thousands of random operation orderings. The Rust program must match it number-for-number
(differential testing).

**Events.** `buy` and `sell` each end with Anchor `emit_cpi!(TradeEvent {...})`, and `create_coin`
with `emit_cpi!(CoinCreatedEvent {...})` — self-CPI delivery, **never plain log emission**: log
lines can be forged by any program whose transaction merely references this program id, and long
transactions truncate logs silently, while an executed self-CPI requires the event authority PDA's
signature and survives any log length. Field layouts and the Anchor-derived discriminators
(`sha256("event:<Name>")[0..8]`: TradeEvent `bddb7fd34ee661ee`, CoinCreatedEvent `2645d99da6e2dffa`)
are pinned byte-for-byte by the reference implementation in
[`js/events.js`](js/events.js), which the indexer and its fixtures already consume:

```
TradeEvent:       mint: Pubkey, trader: Pubkey, is_buy: u8, sol_amount: u64,
                  token_amount: u64, fee: u64, virtual_sol: u64, real_sol: u64,
                  token_reserves: u64        // POST-trade reserves, all three
CoinCreatedEvent: kick_user_id: u64, mint: Pubkey, decimals: u8, grad_bar_lamports: u64,
                  grad_bar_claimed_lamports: u64, virtual_sol_reserves: u64
```

Carrying the post-trade reserves in every event is load-bearing: the indexer maintains per-mint
state without ever fetching accounts, and it can verify continuity (applying a trade to the
previous state must land exactly on the state the event claims), which turns any missed
transaction into a detected, alarmed gap instead of silent drift.

### 3.4 The claim flow

**Not implemented.** Specified here so the account layouts carry its shape; no instruction below exists in the deployed program.

**Everything below assumes the coin already exists on chain, and under D7 most will
not when the streamer arrives.** A claim on an unminted coin is free and off-chain by decision, and
it does not trigger creation. That path has no mechanism yet: see the open items below and the
write-up in
the project's economics notes.

Three instructions. The split exists because the
oracle keys are the largest realistic loss path in this system: whoever holds them can attest any
`(kick_user_id, destination)` pair. The program cannot prevent that — it can only make it slow,
bounded, and visible.

Note the destination-wallet signature is **not** a defence against oracle compromise: an attacker
attests to a wallet they control and signs with it. It defends against typos and against an
attestation being used by someone other than its intended recipient. Nothing more.

**`initiate_claim(kick_user_id, destination, expiry)`**

Signers: `destination` (proves live key possession) + `relayer` (fee payer, D12).

Requires a preceding `Ed25519Program` instruction in the same transaction carrying **at least
`Global.oracle_threshold` signatures over the identical message**:

```
kick_user_id ‖ destination ‖ expiry ‖ curve.claim_nonce ‖ program_id
```

Byte encoding, pinned by the reference implementation
(mirrored by the application's attestation module): `kick_user_id` u64 LE, `destination` 32 raw
bytes, `expiry` i64 LE (unix seconds), `claim_nonce` u64 LE, `program_id` 32 raw bytes — 88 bytes
total. The program's sysvar introspection must reconstruct these exact bytes.

**This flow has an executable reference implementation and a live rehearsal.**
The application's claim state machine is the state machine below check-for-check, with
the application's claim property suite, and its `/api/claim/*` routes
(the application's claim rehearsal) runs the whole flow against D1 with deterministic
pretend oracle keys — attest, initiate, timelock, veto, replay-rejection, rotation, finalize — so
everything except the on-chain instruction is debugged before devnet keys exist. The rehearsal
timelock is `CLAIM_DELAY_SECONDS` (300 in the beta); the program ships 172_800 with the 86_400
floor from §3.1.

Checks, all of which must pass:

1. Sysvar introspection of the `Ed25519Program` instruction: correct program ID, and every verified
   signature's message matches the bytes above exactly.
2. At least `oracle_threshold` of those signatures are from **distinct** members of
   `Global.oracle_pubkeys`. Reject duplicates — the same key signing twice is one signature.
3. `Clock::get()?.unix_timestamp < expiry`.
4. `curve.claim_state == 0`.
5. Rate limit: if `now - global.claim_period_start >= global.claim_period_seconds`, roll the window
   (`claim_period_start = now`, `claims_this_period = 0`). Then require
   `claims_this_period < claim_cap_per_period` and increment it.

Effects: `claim_state = 1`, `pending_destination = destination`,
`pending_unlock_at = now + global.claim_delay_seconds`, `pending_oracle_epoch = global.oracle_epoch`.
Emits `ClaimInitiated` with every field. **No tokens move.**

Any account may be fee payer — the `relayer` normally is (D12), but requiring it as a signer would
mean claims stop entirely whenever our backend is down. A streamer holding SOL should always be able
to self-serve.

`claim_nonce` in the signed message is what stops a vetoed attestation being replayed — a veto
increments the nonce, so the old signatures no longer match any message the program will accept.

**`finalize_claim(kick_user_id)`**

Permissionless — anyone may call it, `relayer` normally pays. It carries no authority, so there is
nothing to steal by front-running it.

Checks `claim_state == 1`, `now >= pending_unlock_at`, **and
`curve.pending_oracle_epoch == global.oracle_epoch`**. Transfers the whole `creator_vault`
balance to `pending_destination`'s ATA (created if absent, payer = fee payer), sets `claim_state = 2`.
Emits `ClaimFinalized`.

`claim_state == 2` is terminal. No instruction moves it back.

**Rotating the oracle set cancels every in-flight claim.**

Without the epoch check, rotation would be useless as an incident response: `finalize_claim` looks
only at state and the clock, so a fraudulent claim initiated *before* rotation completes 48 hours
later under keys that no longer exist. The alternative would be vetoing every pending claim
individually — up to `claim_cap_per_period` per elapsed day, each a full multisig ceremony, and
missing one loses that streamer's allocation.

With it, `update_global` bumping `oracle_epoch` invalidates all pending claims at once. Legitimate
claimants simply re-initiate with a fresh attestation. `veto_claim` remains for the targeted case
where the key set is fine and one specific claim is wrong.

**`veto_claim(kick_user_id)`**

Signer: `authority` (the Squads multisig, D10).

Checks `claim_state == 1`. Sets `claim_state = 0`, clears `pending_destination` and
`pending_unlock_at`, and **increments `claim_nonce`**. Emits `ClaimVetoed`.

The window between `ClaimInitiated` and `pending_unlock_at` is the entire point: a theft attempt is
public for `claim_delay_seconds` before any tokens move, and cancellable throughout. A streamer who
sees a claim they did not start has that long to tell us.

**Operational obligation this creates:** somebody has to watch `ClaimInitiated` events and be able
to convene the multisig within the delay. A veto power nobody monitors is worth nothing. This is a
staffing commitment, not just code — see the application's rollout plan.

**Trade-off, stated plainly:** every legitimate streamer now waits `claim_delay_seconds` between
logging in and holding their tokens. For a once-per-streamer action on a coin they did not know
existed, 48 hours is a reasonable price for making theft cancellable. If that lands badly in
testing, the value is a `Global` field and can be lowered by the multisig without a program upgrade.

### 3.5 Graduation

**Not implemented.** Specified here so the account layouts carry its shape; `migrate` does not exist in the deployed program and no coin can reach a graduated state.

`migrate(kick_user_id)` — permissionless, callable by anyone once the threshold is met. It carries
no authority and no discretion, so there is nothing to gain by front-running it and nothing for us
to withhold.

**The threshold depends on whether the streamer has claimed:**

```
required = if curve.claim_state == 2 { curve.grad_bar_claimed_lamports }
           else                      { curve.grad_bar_lamports }
require curve.real_sol_reserves >= required
require curve.venue == 0
```

**Claiming is a force multiplier, not a gate.** An unclaimed coin still graduates; it just has
further to climb. A streamer showing up brings the finish line closer, which gives holders a reason
to want them there and gives the streamer a reason to turn up, without ever letting us — or their
absence — block a market that has earned its way there.

Effects: create the destination pool, deposit `token_reserves` and `real_sol_reserves` as its
opening liquidity, permanently lock the LP position, set `venue = 1` and `venue_pool` to the pool
address, zero the reserves. Emits `Graduated`.

**`creator_vault` is not touched by migration, ever.** The `Curve` account survives graduation as
the holder of the streamer's allocation and as the venue pointer. `initiate_claim` and
`finalize_claim` work identically before and after — they read `creator_vault` and the claim state
machine, neither of which depends on the curve still trading. This is what lets claiming be an
accelerator rather than a precondition: there is no second release path to build, because the
original one never goes away.

**Consequences of not gating, recorded so they are chosen rather than inherited:**

- **A coin can reach a public venue without its streamer ever having agreed.** Gating would have
  prevented that. Accepted deliberately: the alternative lets one person's silence freeze a market
  other people have put real money into, and the coin is already public on our site regardless.
  The blocklist (§3.2) remains the place where "this person should not have a coin" is enforced,
  and it runs before the mint, which is the only point where it can.
- **The 48-hour claim timelock means a claim is a public two-day signal.** If the claimed threshold
  is materially lower, `ClaimInitiated` on a coin near that lower bar telegraphs an imminent
  graduation. See the discussion in
  the project's venue notes; the
  gap between the two thresholds is the dial that controls how strong that signal is.

### 3.6 The first buy — creation and purchase in one transaction

The centerpiece of the product model, and the thing that makes on-demand creation (the D7 revision)
affordable at any number of streamers. A fan presses buy on a streamer who has no coin; one
transaction creates the coin and executes their purchase; **the buyer's money carries every storage
deposit.** We front nothing, for anybody. Same shape as pump.fun, whose creation was never free
either — the cost just rides in the first buy.

**Three keys sign it, and no single party holds all three.**

| Slot | Held by | Why it has to be there |
|---|---|---|
| `creator_authority` | the Worker | `has_one` on `Global`. This signature **is** the blocklist gate |
| the mint | the buyer's browser | ground for its `kick` suffix (D19); we never see the secret |
| the buyer | their wallet | pays `sol_in` *and* every deposit, and is the fee payer |

So the Worker builds the message and signs its own slot; the browser fills the other two and
submits. Building it in the Worker rather than the page is deliberate: the alternative has the
backend co-signing a message somebody else composed, which means parsing an arbitrary transaction
and proving it is exactly what we would have built — a validation surface that has to stay correct
forever, guarding a signature that authorizes coin creation.

**It fits a legacy transaction, measured rather than assumed.** 15 unique accounts, 3 signatures, 2
instructions: **904 bytes** for realistic metadata and **1052** with `name`/`symbol`/`uri` at their
32/10/200 maxima, against the 1232 limit — 180 bytes of margin, roughly five more accounts. No
address lookup table, no versioned transaction. `js/firstbuy.js` asserts this on every test
run, because the margin is the kind of thing that silently disappears.

**Ordering is load-bearing.** `create_coin` runs first and `buy` reads the curve it creates. The
buyer's associated token account is `init_if_needed` against a mint that does not exist at build
time, which is fine — the address is deterministic, so the client derives it up front.

**Losing the creation race is a clean revert.** Two fans buying the same uncreated coin at once:
the second transaction fails on the `curve` PDA `init`, and the *whole* transaction reverts,
including the buy. The loser is charged nothing beyond the fee, and the client retries as a plain
`buy` against the now-live curve. This is asserted in the LiteSVM suite rather than reasoned about,
because "the buy half applied" would be a very expensive thing to be wrong about.

**A minimum first buy, equal to the creation cost.** Being first is strictly worse than being
second — the second buyer walks into a coin that already exists and pays only for their own
purchase. With no founder incentive in v1, nothing offsets that, so the floor bounds it: at the
minimum you put as much into the coin as you spent creating it, rather than watching most of a small
buy disappear into rent. Denominated in SOL, which also keeps this flow off D16's critical path.
Arithmetic in
the project's economics notes.

**The blocklist is checked before a signature exists**, and it is the last moment "no" is possible
for that streamer, ever (§3.2). Note it is a pre-mint veto and not a trading ban: once a coin
exists there is nothing left to veto, and refusing trades would only strand the people holding it.



## 7. Security

- Every account-modifying instruction validates signer, PDA seeds/bump, and account ownership via
  Anchor constraints — no manual discriminator checks.
- All reserve/lamport arithmetic uses checked `u128` intermediates (§3.3); no instruction can leave
  `token_reserves`/`real_sol_reserves` negative or `token_vault`/`sol_vault` balances short of the
  mirrored fields.
- `initiate_claim`'s ed25519 verification checks the exact program ID, public keys, and message
  bytes of the companion `Ed25519Program` instruction via sysvar introspection — not just "an
  ed25519 ix exists somewhere in this transaction."
- **The offset trap, which is the actual finding class here.** The Ed25519 program's instruction
  data is a table of offsets, and each signature's `public_key_offset`, `message_data_offset` and
  `signature_offset` carry their own **instruction index** — they may point into a *different*
  instruction's data. A checker that parses "the ed25519 instruction verified our message" without
  the following can be satisfied by a transaction that verified entirely different bytes from the
  ones the claim consumes. All three are required:
  1. **Every offset's instruction index must reference the ed25519 instruction itself.** No
     cross-instruction references.
  2. **Every offset plus its length must be in-bounds** of that instruction's data.
  3. **The message length must equal exactly** the expected message size — not "at least", which
     lets a valid prefix carry attacker-chosen suffix bytes.
  A forged-offset case belongs in the adversarial Surfpool tests alongside the ones below.
- Vault balances are compared with `<=`, never `==` (§3.1). Asserting equality would let anyone
  brick a coin with a one-lamport donation. A property test must cover it: donate to both vaults,
  then buy and sell, and neither may revert nor move the price.
- `update_global` clamps every parameter to the §3.1 constants. A test must assert that
  `fee_bps = 10_000`, `grad_bar_claimed_lamports > grad_bar_lamports` and `claim_delay_seconds = 0` are all
  rejected — each of those is a halt or seize switch if it lands.
- `initialize_global`/`update_global`/`create_coin` are the only privileged instructions; each checks
  its signer against the specific `Global` field authorizing it.
- Testing: LiteSVM unit tests for the curve math (property tests — `k` never decreases, no negative
  balances, slippage checks correctly reject, dust sells reject rather than donating), Surfpool
  integration tests for full instruction flows including the ed25519 claim path, the donation-grief
  case, forged ed25519 offsets, and oracle rotation cancelling an in-flight claim.
- Third-party audit (D18) required before any mainnet deploy — see rollout plan.
- **Gap: the oracle key has no blast-radius limit.** Every bullet above hardens the *program*.
  The largest realistic loss path is not a program bug — it is compromise of the off-chain oracle
  key, which can attest any `(kick_user_id, wallet)` pair and drain every unclaimed `creator_vault`.
  An audit does not address this, and pump.fun's May 2024 loss (~12,300 SOL) was this shape of
  failure — privileged access, not curve arithmetic. Mitigations are listed under D13 and are not
  yet specified here. **Specify them before mainnet**; the custody note in the application's backend currently understates
  this as a v1 risk to revisit.

## Open items

Program-side only; the economics and rollout questions live with the
application.

- **`default_virtual_sol_reserves` has no chosen value.** It is set at devnet
  config time and revisited before mainnet, and it is coupled to the creator
  share: `virtual_sol_reserves = opening_market_cap_in_SOL × (1 −
  creator_share)`.
- **The graduation bars are working numbers.** 160 SOL and 136 claimed keep the
  floor coin's climb where the docs put it; the honest tuning direction if
  graduations feel rare is down toward pump.fun's proven 85, never up, and only
  for new coins.
- **`claim_cap_per_period` and `claim_delay_seconds` are guesses.** Too low and a
  launch-day rush of legitimate streamers hits the ceiling; too high and the cap
  bounds nothing. A compromised oracle set can also spend the cap to grief
  legitimate claims, which argues for a value generous enough that doing so is
  noticeable rather than routine.
- **Where the three oracle keys live.** 2-of-3 only helps if the keys have
  genuinely separate compromise paths; all three in one process is 1-of-1 with
  extra steps. At minimum one signer should sit behind a different trust
  boundary. Decide before `initialize_global` runs on mainnet.
- **Per-coin account count is a cost decision, and two of the six accounts may be
  removable.** `creator_vault` could become a `u64` on the `Curve`, and
  `sol_vault` could be the `Curve` PDA holding lamports directly above its own
  rent-exempt minimum. Together roughly 20% of the per-coin deposit.
- **Metadata is the single largest per-coin line.** Token-2022's metadata
  extension stores it inside the mint and would likely cost less than a separate
  Metaplex account, but D2 chose plain SPL deliberately for compatibility. Worth
  pricing rather than leaving unexamined.
- **Claiming a coin that does not exist yet has no on-chain design**, and under
  on-demand creation it is the common case rather than an edge case. Every
  instruction in §3.4 reads fields off a `Curve`, and most streamers have none
  until a first buy. The settled part is that a pre-claim is free, off-chain, and
  mints nothing; the open part is when the timelock starts running.
- **The upgrade-authority endgame.** D9 concedes the multisig can replace the
  program. That is right while the code is young. What changes it later — a
  timelock on upgrades, then burning the authority once the program has been
  stable and audited for some period — should be written down so "we can change
  the rules" has a published expiry rather than being permanent by default.
