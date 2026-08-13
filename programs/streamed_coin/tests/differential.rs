//! The differential half of the audit posture: replays every vector the
//! JavaScript reference (js/curve.js) recorded and demands the Rust
//! port lands on the identical outcome and identical state, step by step.
//! Then native fuzz storms re-assert the solvency properties independently,
//! and the event contract pinned by js/events.js is checked against
//! what the Anchor macros actually derive.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use streamed_coin::curve::{self, CurveState};

#[derive(Deserialize)]
struct VectorFile {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    init: Init,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Init {
    virtual_sol: String,
    float: String,
    fee_bps: u16,
}

#[derive(Deserialize)]
struct Step {
    op: String,
    amount: String,
    #[serde(default)]
    err: Option<String>,
    #[serde(default)]
    out: Option<serde_json::Map<String, serde_json::Value>>,
    state: Snap,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snap {
    sv: String,
    sr: String,
    t: String,
    outstanding: String,
    surplus: String,
    paid_in: String,
    paid_out: String,
}

fn u64s(s: &str) -> u64 {
    s.parse().unwrap()
}

fn assert_state(c: &CurveState, snap: &Snap, at: &str) {
    assert_eq!(c.sv, u64s(&snap.sv), "{at}: sv");
    assert_eq!(c.sr, u64s(&snap.sr), "{at}: sr");
    assert_eq!(c.t, u64s(&snap.t), "{at}: t");
    assert_eq!(c.outstanding, u64s(&snap.outstanding), "{at}: outstanding");
    assert_eq!(c.surplus, u64s(&snap.surplus), "{at}: surplus");
    assert_eq!(c.paid_in, snap.paid_in.parse::<u128>().unwrap(), "{at}: paid_in");
    assert_eq!(c.paid_out, snap.paid_out.parse::<u128>().unwrap(), "{at}: paid_out");
}

fn out_field(out: &serde_json::Map<String, serde_json::Value>, key: &str) -> u64 {
    u64s(out.get(key).and_then(|v| v.as_str()).unwrap())
}

#[test]
fn replays_the_reference_vectors_exactly() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json")).unwrap();
    let file: VectorFile = serde_json::from_str(&raw).unwrap();
    assert!(!file.scenarios.is_empty());
    let mut steps_run = 0usize;
    for sc in &file.scenarios {
        let mut c = curve::create(
            u64s(&sc.init.virtual_sol),
            u64s(&sc.init.float),
            sc.init.fee_bps,
        )
        .unwrap();
        for (i, step) in sc.steps.iter().enumerate() {
            let at = format!("{} step {}", sc.name, i);
            let amount = u64s(&step.amount);
            match step.op.as_str() {
                "buy" => match curve::buy(&mut c, amount) {
                    Ok(out) => {
                        let want = step.out.as_ref().unwrap_or_else(|| panic!("{at}: reference errored ({:?}), rust succeeded", step.err));
                        assert_eq!(out.tokens_out, out_field(want, "tokensOut"), "{at}: tokensOut");
                        assert_eq!(out.fee, out_field(want, "fee"), "{at}: fee");
                    }
                    Err(e) => assert_eq!(Some(e.msg()), step.err.as_deref(), "{at}: error"),
                },
                "sell" => match curve::sell(&mut c, amount) {
                    Ok(out) => {
                        let want = step.out.as_ref().unwrap_or_else(|| panic!("{at}: reference errored ({:?}), rust succeeded", step.err));
                        assert_eq!(out.net_out, out_field(want, "netOut"), "{at}: netOut");
                        assert_eq!(out.fee, out_field(want, "fee"), "{at}: fee");
                        assert_eq!(out.retired, out_field(want, "retired"), "{at}: retired");
                        assert_eq!(out.curve_origin, out_field(want, "curveOrigin"), "{at}: curveOrigin");
                        assert_eq!(out.vault_part, out_field(want, "vaultPart"), "{at}: vaultPart");
                    }
                    Err(e) => assert_eq!(Some(e.msg()), step.err.as_deref(), "{at}: error"),
                },
                other => panic!("unknown op {other}"),
            }
            assert_state(&c, &step.state, &at);
            curve::check_invariants(&c).unwrap();
            steps_run += 1;
        }
    }
    assert!(steps_run > 1000, "vector file suspiciously small: {steps_run} steps");
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo)
    }
}

const SUPPLY: u64 = 10_000_000 * 1_000_000;
const VAULT: u64 = SUPPLY * 1500 / 10_000;
const FLOAT: u64 = SUPPLY - VAULT;
const SOL: u64 = 1_000_000_000;

fn k_of(c: &CurveState) -> u128 {
    (c.sv as u128 + c.sr as u128) * c.t as u128
}

// The vault-dump property from the board card: free-mint tokens, sell
// everything from every wallet in every order, and payouts must never exceed
// the real SOL paid in. Runs storms of random buys and sells (including
// vault-origin dumps) and then liquidates completely.
#[test]
fn fuzz_storms_never_pay_out_more_than_was_paid_in() {
    for seed in 0..8u64 {
        let mut rng = Lcg(0x5eed + seed);
        let mut c = curve::create(30 * SOL, FLOAT, 100).unwrap();
        let mut held = 0u64;
        let mut vault_left = VAULT;
        for _ in 0..2_000 {
            let k_before = k_of(&c);
            if rng.next() % 100 < 55 || held + vault_left == 0 {
                let before = c.outstanding;
                if curve::buy(&mut c, rng.range(1, 2 * SOL)).is_ok() {
                    held += c.outstanding - before;
                }
            } else {
                let from_held = if held > 0 { rng.range(1, held + 1) } else { 0 };
                let from_vault = if vault_left > 0 && rng.next() % 4 == 0 {
                    rng.range(1, vault_left + 1)
                } else {
                    0
                };
                let amount = from_held + from_vault;
                if amount > 0 && curve::sell(&mut c, amount).is_ok() {
                    held -= from_held;
                    vault_left -= from_vault;
                }
            }
            assert!(k_of(&c) >= k_before, "k decreased (seed {seed})");
            curve::check_invariants(&c).unwrap();
        }
        while held + vault_left > 0 {
            let amount = (held + vault_left).min(rng.range(1, FLOAT));
            let take_vault = amount.saturating_sub(held).min(vault_left);
            let take_held = amount - take_vault;
            if curve::sell(&mut c, amount).is_err() {
                break;
            }
            held -= take_held;
            vault_left -= take_vault;
        }
        curve::check_invariants(&c).unwrap();
        assert!(c.paid_out <= c.paid_in, "seed {seed}: paid out more than paid in");
    }
}

// A whole-bag dump into a shallow pool: the seller is absorbed entirely, paid
// at most what the pool held, a sliver always remains, and buyers arriving
// afterwards can still trade.
#[test]
fn whole_bag_vault_dump_leaves_a_living_curve() {
    let mut c = curve::create(30 * SOL, FLOAT, 100).unwrap();
    curve::buy(&mut c, 2 * SOL).unwrap();
    let bought = c.outstanding;
    let sr_before = c.sr;
    let out = curve::sell(&mut c, bought + VAULT).unwrap();
    assert!(out.retired > 0, "a shallow-pool dump must retire overflow");
    assert!(out.net_out + out.fee <= sr_before, "dump took more than the pool held");
    assert!(c.sr > 0, "the dust reserve must survive a whole-bag dump");
    assert_eq!(c.outstanding, 0);
    curve::buy(&mut c, SOL).unwrap();
    let sellable = c.outstanding;
    assert!(curve::sell(&mut c, sellable).is_ok(), "post-dump buyers must be able to exit");
    curve::check_invariants(&c).unwrap();
}

// The event contract in js/events.js pins these discriminators as the
// real Anchor derivations. If the derive macros ever produce different bytes,
// the indexer would go silently deaf; this makes that loudly impossible.
#[test]
fn event_discriminators_match_the_pinned_contract() {
    use anchor_lang::Discriminator;
    let derive = |name: &str| {
        let hash = Sha256::digest(format!("event:{name}").as_bytes());
        hash[..8].to_vec()
    };
    assert_eq!(streamed_coin::TradeEvent::DISCRIMINATOR, &derive("TradeEvent")[..]);
    assert_eq!(streamed_coin::CoinCreatedEvent::DISCRIMINATOR, &derive("CoinCreatedEvent")[..]);
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    assert_eq!(hex(streamed_coin::TradeEvent::DISCRIMINATOR), "bddb7fd34ee661ee");
    assert_eq!(hex(streamed_coin::CoinCreatedEvent::DISCRIMINATOR), "2645d99da6e2dffa");
}

// Byte-for-byte serialization check against the layout events.js documents:
// TradeEvent is 113 bytes after the discriminator, CoinCreatedEvent is 41,
// little-endian u64s, is_buy as one byte.
#[test]
fn event_layouts_match_the_pinned_contract() {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::AnchorSerialize;
    let ev = streamed_coin::TradeEvent {
        mint: Pubkey::new_from_array([1; 32]),
        trader: Pubkey::new_from_array([2; 32]),
        is_buy: true,
        sol_amount: 3,
        token_amount: 4,
        fee: 5,
        virtual_sol: 6,
        real_sol: 7,
        token_reserves: 8,
    };
    let mut buf = vec![];
    ev.serialize(&mut buf).unwrap();
    assert_eq!(buf.len(), 113);
    let mut want = vec![];
    want.extend([1u8; 32]);
    want.extend([2u8; 32]);
    want.push(1);
    for v in [3u64, 4, 5, 6, 7, 8] {
        want.extend(v.to_le_bytes());
    }
    assert_eq!(buf, want);

    // The baked bars ride in this event (D20 revised): the indexer learns every
    // coin's finish line at creation and never fetches the account for it.
    let ev = streamed_coin::CoinCreatedEvent {
        kick_user_id: 9,
        mint: Pubkey::new_from_array([3; 32]),
        decimals: 6,
        grad_bar_lamports: 160_000_000_000,
        grad_bar_claimed_lamports: 136_000_000_000,
        virtual_sol_reserves: 30_000_000_000,
    };
    let mut buf = vec![];
    ev.serialize(&mut buf).unwrap();
    assert_eq!(buf.len(), 65);
    let mut want = 9u64.to_le_bytes().to_vec();
    want.extend([3u8; 32]);
    want.push(6);
    want.extend(160_000_000_000u64.to_le_bytes());
    want.extend(136_000_000_000u64.to_le_bytes());
    want.extend(30_000_000_000u64.to_le_bytes());
    assert_eq!(buf, want);
}
