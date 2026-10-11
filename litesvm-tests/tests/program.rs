//! Program-level tests against the real compiled artifact in LiteSVM: the
//! full create/buy/sell lifecycle predicted by the same math module the
//! program links, slippage rejecting rather than rounding, the one-lamport
//! donation that must neither revert nor move the price, and the emit_cpi
//! events carrying the exact pinned bytes.
//!
//! Needs `cargo build-sbf` to have produced target/deploy/streamed_coin.so
//! first; the CI workflow runs the two in that order.

use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, Space};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};
use std::str::FromStr;
use streamed_coin::curve::{self, CurveState};
use streamed_coin::{CurveError, GlobalParams};

mod common;

const SOL: u64 = 1_000_000_000;
const SUPPLY: u64 = 10_000_000 * 1_000_000;
/// The one opening reserve every coin shares (D20 revised).
const VIRTUAL_SOL: u64 = 30 * SOL;
const KICK_ID: u64 = 4242;
const CREATOR_SHARE_BPS: u16 = 1_500;

/// The flat graduation bars, in collected SOL, the working numbers from the
/// economics docs: 160 SOL, 136 once claimed.
const GRAD_BAR: u64 = 160 * SOL;
const GRAD_BAR_CLAIMED: u64 = 136 * SOL;

fn float_of(supply: u64) -> u64 {
    supply - (supply as u128 * CREATOR_SHARE_BPS as u128 / 10_000) as u64
}

fn token_program() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

fn ata_program() -> Pubkey {
    Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}

fn ix_disc(name: &str) -> Vec<u8> {
    Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &streamed_coin::ID).0
}

fn ata_of(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}

struct World {
    svm: LiteSVM,
    authority: Keypair,
    treasury: Pubkey,
    mint_kp: Keypair,
    mint: Pubkey,
    global: Pubkey,
    curve: Pubkey,
    token_vault: Pubkey,
    sol_vault: Pubkey,
    event_authority: Pubkey,
    /// The oracle set `Global` was initialized with, so tests can attest.
    oracles: Vec<Keypair>,
}

const CLAIM_DELAY: i64 = 172_800;
const CLAIM_PERIOD: i64 = 86_400;

fn global_params(
    authority: &Pubkey,
    treasury: &Pubkey,
    oracles: [Pubkey; 3],
    claim_cap_per_period: u16,
) -> GlobalParams {
    GlobalParams {
        creator_authority: *authority,
        oracle_pubkeys: oracles,
        oracle_threshold: 2,
        relayer_pubkey: *authority,
        treasury: *treasury,
        fee_bps: 100,
        creator_share_bps: 1_500,
        token_total_supply: SUPPLY,
        token_decimals: 6,
        default_virtual_sol_reserves: VIRTUAL_SOL,
        claim_delay_seconds: CLAIM_DELAY,
        claim_period_seconds: CLAIM_PERIOD,
        claim_cap_per_period,
        grad_bar_lamports: GRAD_BAR,
        grad_bar_claimed_lamports: GRAD_BAR_CLAIMED,
    }
}

fn oracle_keys(w: &World) -> [Pubkey; 3] {
    [w.oracles[0].pubkey(), w.oracles[1].pubkey(), w.oracles[2].pubkey()]
}

/// `create_coin` for an arbitrary payer. Split out of `setup` because the
/// first-buy flow (§3.6) needs to build it without sending it, so it can ride
/// in the same transaction as the buy.
fn create_coin_ix(w: &World, payer: &Pubkey) -> Instruction {
    let kid = KICK_ID.to_le_bytes();
    let creator_vault = pda(&[b"creator_vault", &kid]);
    let mut data = ix_disc("create_coin");
    KICK_ID.serialize(&mut data).unwrap();
    "Test Streamer".to_string().serialize(&mut data).unwrap();
    "TEST".to_string().serialize(&mut data).unwrap();
    "https://example.invalid/meta.json".to_string().serialize(&mut data).unwrap();
    Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new_readonly(w.global, false),
            AccountMeta::new_readonly(w.authority.pubkey(), true),
            AccountMeta::new(*payer, true),
            AccountMeta::new(w.mint, true),
            AccountMeta::new(w.curve, false),
            AccountMeta::new(w.token_vault, false),
            AccountMeta::new(creator_vault, false),
            AccountMeta::new(w.sol_vault, false),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(w.event_authority, false),
            AccountMeta::new_readonly(streamed_coin::ID, false),
        ],
        data,
    }
}

/// The world with `Global` initialized and the mint keypair generated, but no
/// coin on chain. This is the state every streamer is in until somebody buys.
fn setup_bare() -> World {
    setup_bare_with(None, 10)
}

/// `setup_bare` with the oracle slots and the per-period claim cap chosen by
/// the test. Three oracle keypairs are always generated; `oracle_override`
/// decides what `Global` actually records in its slots, which is how the
/// "same key in every slot" configuration gets exercised.
fn setup_bare_with(oracle_override: Option<[Pubkey; 3]>, claim_cap_per_period: u16) -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(
        streamed_coin::ID,
        concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/streamed_coin.so"),
    )
    .expect("run `cargo build-sbf` before these tests");

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 1_000 * SOL).unwrap();
    let treasury = Pubkey::new_unique();
    svm.airdrop(&treasury, SOL).unwrap();

    let global = pda(&[b"global"]);
    let kid = KICK_ID.to_le_bytes();
    let curve = pda(&[b"curve", &kid]);
    let token_vault = pda(&[b"token_vault", &kid]);
    let creator_vault = pda(&[b"creator_vault", &kid]);
    let sol_vault = pda(&[b"sol_vault", &kid]);
    let event_authority = pda(&[b"__event_authority"]);

    let oracles: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    let slots = oracle_override
        .unwrap_or([oracles[0].pubkey(), oracles[1].pubkey(), oracles[2].pubkey()]);
    let mut data = ix_disc("initialize_global");
    global_params(&authority.pubkey(), &treasury, slots, claim_cap_per_period)
        .serialize(&mut data)
        .unwrap();
    let init = Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new(global, false),
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data,
    };
    send(&mut svm, &[init], &authority, &[]).expect("initialize_global failed");
    let _ = creator_vault;

    let mint_kp = Keypair::new();
    World {
        svm,
        authority,
        treasury,
        mint: mint_kp.pubkey(),
        mint_kp,
        global,
        curve,
        token_vault,
        sol_vault,
        event_authority,
        oracles,
    }
}

/// The world with a floor-tier coin already created and paid for by the
/// authority. Everything that is not about creation itself starts here.
fn setup() -> World {
    let mut w = setup_bare();
    let payer = w.authority.pubkey();
    let create = create_coin_ix(&w, &payer);
    send(&mut w.svm, &[create], &w.authority, &[&w.mint_kp]).expect("create_coin failed");
    w
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<litesvm::types::TransactionMetadata, Box<litesvm::types::FailedTransactionMetadata>> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        &signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).map_err(Box::new)
}

fn trade_ix(w: &World, trader: &Pubkey, name: &str, amount: u64, min_out: u64) -> Instruction {
    let mut data = ix_disc(name);
    KICK_ID.serialize(&mut data).unwrap();
    amount.serialize(&mut data).unwrap();
    min_out.serialize(&mut data).unwrap();
    Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new_readonly(w.global, false),
            AccountMeta::new(w.curve, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new(w.token_vault, false),
            AccountMeta::new(w.sol_vault, false),
            AccountMeta::new(w.treasury, false),
            AccountMeta::new(*trader, true),
            AccountMeta::new(ata_of(trader, &w.mint), false),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(ata_program(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(w.event_authority, false),
            AccountMeta::new_readonly(streamed_coin::ID, false),
        ],
        data,
    }
}

fn curve_account(w: &World) -> streamed_coin::Curve {
    let data = w.svm.get_account(&w.curve).unwrap().data;
    streamed_coin::Curve::deserialize(&mut &data[8..]).unwrap()
}

fn token_amount(w: &World, account: &Pubkey) -> u64 {
    let data = w.svm.get_account(account).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn math_of(w: &World) -> CurveState {
    let c = curve_account(w);
    CurveState {
        sv: c.virtual_sol_reserves,
        sr: c.real_sol_reserves,
        t: c.token_reserves,
        outstanding: c.outstanding,
        surplus: 0,
        fee_bps: 100,
        paid_in: 0,
        paid_out: 0,
    }
}

/// The centerpiece of the product model (§3.6): a fan presses buy on a streamer
/// who has no coin, and one transaction creates the coin and executes their
/// purchase. Nothing exists on chain beforehand, and the buyer's own lamports
/// pay every storage deposit — we front nothing for any indexed streamer.
#[test]
fn a_first_buy_creates_the_coin_and_buys_it_in_one_transaction() {
    let mut w = setup_bare();
    let buyer = Keypair::new();
    w.svm.airdrop(&buyer.pubkey(), 50 * SOL).unwrap();

    assert!(w.svm.get_account(&w.curve).map_or(true, |a| a.data.is_empty()));
    assert!(w.svm.get_account(&w.mint).map_or(true, |a| a.data.is_empty()));

    // Predicted against a curve that does not exist yet — the same reference
    // math the program links, seeded from the shared opening reserve.
    let mut predicted = CurveState {
        sv: VIRTUAL_SOL,
        sr: 0,
        t: float_of(SUPPLY),
        outstanding: 0,
        surplus: 0,
        fee_bps: 100,
        paid_in: 0,
        paid_out: 0,
    };
    let quote = curve::buy(&mut predicted, 2 * SOL).unwrap();

    let create = create_coin_ix(&w, &buyer.pubkey());
    let buy = trade_ix(&w, &buyer.pubkey(), "buy", 2 * SOL, quote.tokens_out);
    let before = w.svm.get_account(&buyer.pubkey()).unwrap().lamports;
    send(&mut w.svm, &[create, buy], &buyer, &[&w.authority, &w.mint_kp])
        .expect("create+buy in one transaction failed");
    let after = w.svm.get_account(&buyer.pubkey()).unwrap().lamports;

    let c = curve_account(&w);
    assert_eq!(c.kick_user_id, KICK_ID, "the coin exists now");
    assert_eq!(c.virtual_sol_reserves, VIRTUAL_SOL);
    assert_eq!(c.grad_bar_lamports, GRAD_BAR, "the bar bakes in at creation");
    assert_eq!(c.real_sol_reserves, predicted.sr, "sr after the first buy");
    assert_eq!(c.token_reserves, predicted.t, "t after the first buy");
    assert_eq!(
        token_amount(&w, &ata_of(&buyer.pubkey(), &w.mint)),
        quote.tokens_out,
        "the buyer holds the tokens their money bought"
    );

    // The whole economic claim in one assertion: the buyer paid their 2 SOL
    // *and* the deposits on top. Being first costs more than being second, and
    // the minimum first buy exists to bound exactly this gap.
    let spent = before - after;
    let deposits = spent - 2 * SOL;
    assert!(
        deposits > 10_000_000 && deposits < 25_000_000,
        "buyer should carry ~0.0166 SOL of deposits and fees, carried {deposits} lamports"
    );
}

/// Two fans press buy on the same uncreated coin at once. The loser's whole
/// transaction reverts — including their buy — rather than half-applying, so
/// the client can safely retry it as a plain buy against the live curve.
#[test]
fn losing_the_creation_race_reverts_the_whole_transaction() {
    let mut w = setup_bare();
    let first = Keypair::new();
    let second = Keypair::new();
    w.svm.airdrop(&first.pubkey(), 50 * SOL).unwrap();
    w.svm.airdrop(&second.pubkey(), 50 * SOL).unwrap();

    let create = create_coin_ix(&w, &first.pubkey());
    let buy = trade_ix(&w, &first.pubkey(), "buy", 2 * SOL, 0);
    send(&mut w.svm, &[create, buy], &first, &[&w.authority, &w.mint_kp]).expect("first buy failed");

    let reserves_after_first = curve_account(&w).real_sol_reserves;
    let before = w.svm.get_account(&second.pubkey()).unwrap().lamports;

    let create = create_coin_ix(&w, &second.pubkey());
    let buy = trade_ix(&w, &second.pubkey(), "buy", 2 * SOL, 0);
    assert!(
        send(&mut w.svm, &[create, buy], &second, &[&w.authority, &w.mint_kp]).is_err(),
        "creating an existing coin must fail"
    );

    assert_eq!(
        curve_account(&w).real_sol_reserves,
        reserves_after_first,
        "the loser's buy must not have applied"
    );
    let after = w.svm.get_account(&second.pubkey()).unwrap().lamports;
    assert!(before - after < SOL / 100, "the loser must not be charged for a coin they did not create");

    // ...and the retry, which is what the client actually does next.
    let buy = trade_ix(&w, &second.pubkey(), "buy", 2 * SOL, 0);
    send(&mut w.svm, &[buy], &second, &[]).expect("retry as a plain buy must succeed");
    assert!(curve_account(&w).real_sol_reserves > reserves_after_first);
}

/// D20 revised: every coin opens at the same reserve and bakes the same bars,
/// and there is no price argument of any kind to pass. Retuning `Global`
/// afterward must never reach back into a coin that already exists.
#[test]
fn the_bars_bake_in_at_creation_and_a_retune_never_reaches_back() {
    let mut w = setup();
    let c = curve_account(&w);
    assert_eq!(c.virtual_sol_reserves, VIRTUAL_SOL, "one open for every coin");
    assert_eq!(c.grad_bar_lamports, GRAD_BAR);
    assert_eq!(c.grad_bar_claimed_lamports, GRAD_BAR_CLAIMED);

    // Claiming accelerates and never gates, so a claimed bar above the
    // unclaimed one must be rejected at the door.
    let mut bad = global_params(&w.authority.pubkey(), &w.treasury, oracle_keys(&w), 10);
    bad.grad_bar_claimed_lamports = bad.grad_bar_lamports + 1;
    let mut data = ix_disc("update_global");
    bad.serialize(&mut data).unwrap();
    let update = Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new(w.global, false),
            AccountMeta::new_readonly(w.authority.pubkey(), true),
        ],
        data,
    };
    assert!(
        send(&mut w.svm, &[update], &w.authority, &[]).is_err(),
        "a claimed bar above the unclaimed one must be rejected"
    );

    // A legitimate retune lands on Global and does not touch the live coin.
    let mut tuned = global_params(&w.authority.pubkey(), &w.treasury, oracle_keys(&w), 10);
    tuned.grad_bar_lamports = 200 * SOL;
    tuned.grad_bar_claimed_lamports = 170 * SOL;
    let mut data = ix_disc("update_global");
    tuned.serialize(&mut data).unwrap();
    let update = Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new(w.global, false),
            AccountMeta::new_readonly(w.authority.pubkey(), true),
        ],
        data,
    };
    send(&mut w.svm, &[update], &w.authority, &[]).expect("retune failed");

    let g: streamed_coin::Global = {
        let data = w.svm.get_account(&w.global).unwrap().data;
        streamed_coin::Global::deserialize(&mut &data[8..]).unwrap()
    };
    assert_eq!(g.grad_bar_lamports, 200 * SOL, "the default moved");
    let c = curve_account(&w);
    assert_eq!(c.grad_bar_lamports, GRAD_BAR, "the live coin's finish line did not");
    assert_eq!(c.grad_bar_claimed_lamports, GRAD_BAR_CLAIMED);
}

/// The per-coin deposit total is a published number that budgets get built
/// against (the project's cost breakdown), and it is arithmetic over these
/// account sizes. Pinning them here means a struct change fails a test rather
/// than silently invalidating a doc.
#[test]
fn the_account_sizes_the_cost_estimate_is_built_on() {
    let w = setup();
    let kid = KICK_ID.to_le_bytes();
    let sizes = [
        (w.curve, 8 + streamed_coin::Curve::INIT_SPACE, "Curve"),
        (w.mint, 82, "mint"),
        (w.token_vault, 165, "token_vault"),
        (pda(&[b"creator_vault", &kid]), 165, "creator_vault"),
        (w.sol_vault, 0, "sol_vault"),
    ];
    for (key, expected, what) in sizes {
        assert_eq!(
            w.svm.get_account(&key).unwrap().data.len(),
            expected,
            "{what} account size"
        );
    }
    // Rent-exempt minimum is (128 + bytes) * 6960 lamports. Metadata is not in
    // this list because the Metaplex CPI is not written yet — when it lands,
    // its 679-byte account joins the total.
    let rent = |bytes: usize| (128 + bytes as u64) * 6_960;
    let deposits: u64 = sizes.iter().map(|(_, b, _)| rent(*b)).sum();
    assert_eq!(deposits, 9_354_240, "per-coin deposits before metadata, in lamports");
    // With the Metaplex account the total is 0.0149710 SOL. The baked bars
    // put 15 net bytes on every `Curve` (two u64 bars in, the tier byte out),
    // 292 bytes now, measured here rather than counted by hand.
    assert_eq!(deposits + rent(679), 14_970_960, "per-coin deposits with metadata");
}

#[test]
fn create_coin_mints_the_split_and_burns_the_authority() {
    let w = setup();
    let kid = KICK_ID.to_le_bytes();
    let creator_vault = pda(&[b"creator_vault", &kid]);
    let vault_cut = (SUPPLY as u128 * 1_500 / 10_000) as u64;
    assert_eq!(token_amount(&w, &creator_vault), vault_cut);
    assert_eq!(token_amount(&w, &w.token_vault), SUPPLY - vault_cut);

    let mint_data = w.svm.get_account(&w.mint).unwrap().data;
    assert_eq!(&mint_data[0..4], &[0, 0, 0, 0], "mint authority must be None");
    let supply = u64::from_le_bytes(mint_data[36..44].try_into().unwrap());
    assert_eq!(supply, SUPPLY);

    let c = curve_account(&w);
    assert_eq!(c.kick_user_id, KICK_ID);
    assert_eq!(c.virtual_sol_reserves, VIRTUAL_SOL);
    assert_eq!(c.real_sol_reserves, 0);
    assert_eq!(c.token_reserves, SUPPLY - vault_cut);
    assert_eq!(c.outstanding, 0);
    assert_eq!(c.venue, 0);
}

#[test]
fn buys_and_sells_match_the_reference_math_exactly() {
    let mut w = setup();
    let trader = Keypair::new();
    w.svm.airdrop(&trader.pubkey(), 50 * SOL).unwrap();

    let mut predicted = math_of(&w);
    let buy1 = curve::buy(&mut predicted, 2 * SOL).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "buy", 2 * SOL, buy1.tokens_out);
    send(&mut w.svm, &[ix], &trader, &[]).expect("buy failed");

    let c = curve_account(&w);
    assert_eq!(c.real_sol_reserves, predicted.sr, "sr after buy");
    assert_eq!(c.token_reserves, predicted.t, "t after buy");
    assert_eq!(c.outstanding, predicted.outstanding, "outstanding after buy");
    assert_eq!(token_amount(&w, &ata_of(&trader.pubkey(), &w.mint)), buy1.tokens_out);

    let rent_floor = w.svm.get_account(&w.sol_vault).unwrap().lamports - c.real_sol_reserves;
    assert!(rent_floor > 0, "sol vault must keep its rent floor");

    let sell_amount = buy1.tokens_out / 3;
    let sell1 = curve::sell(&mut predicted, sell_amount).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "sell", sell_amount, sell1.net_out);
    send(&mut w.svm, &[ix], &trader, &[]).expect("sell failed");

    let c = curve_account(&w);
    assert_eq!(c.real_sol_reserves, predicted.sr, "sr after sell");
    assert_eq!(c.token_reserves, predicted.t, "t after sell");
    assert_eq!(c.outstanding, predicted.outstanding, "outstanding after sell");
    assert_eq!(
        token_amount(&w, &ata_of(&trader.pubkey(), &w.mint)),
        buy1.tokens_out - sell_amount
    );
    assert_eq!(
        w.svm.get_account(&w.sol_vault).unwrap().lamports,
        c.real_sol_reserves + rent_floor,
        "vault lamports must mirror the priced reserve plus rent"
    );
}

#[test]
fn slippage_rejects_rather_than_rounds() {
    let mut w = setup();
    let trader = Keypair::new();
    w.svm.airdrop(&trader.pubkey(), 50 * SOL).unwrap();

    let mut predicted = math_of(&w);
    let quote = curve::buy(&mut predicted, SOL).unwrap();
    let before = curve_account(&w);

    let ix = trade_ix(&w, &trader.pubkey(), "buy", SOL, quote.tokens_out + 1);
    assert!(send(&mut w.svm, &[ix], &trader, &[]).is_err(), "over-min buy must fail");
    let after = curve_account(&w);
    assert_eq!(after.real_sol_reserves, before.real_sol_reserves);
    assert_eq!(after.token_reserves, before.token_reserves);

    let ix = trade_ix(&w, &trader.pubkey(), "buy", SOL, quote.tokens_out);
    send(&mut w.svm, &[ix], &trader, &[]).expect("exact-min buy must succeed");

    let mut predicted = math_of(&w);
    let sq = curve::sell(&mut predicted, quote.tokens_out).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "sell", quote.tokens_out, sq.net_out + 1);
    assert!(send(&mut w.svm, &[ix], &trader, &[]).is_err(), "over-min sell must fail");
}

#[test]
fn a_one_lamport_donation_neither_reverts_nor_moves_the_price() {
    let mut w = setup();
    let trader = Keypair::new();
    w.svm.airdrop(&trader.pubkey(), 50 * SOL).unwrap();

    let ix = trade_ix(&w, &trader.pubkey(), "buy", SOL, 0);
    send(&mut w.svm, &[ix], &trader, &[]).expect("first buy failed");

    let griefer = Keypair::new();
    w.svm.airdrop(&griefer.pubkey(), SOL).unwrap();
    let donate = solana_sdk::system_instruction::transfer(&griefer.pubkey(), &w.sol_vault, 1);
    send(&mut w.svm, &[donate], &griefer, &[]).unwrap();

    let mut predicted = math_of(&w);
    let quote = curve::buy(&mut predicted, SOL).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "buy", SOL, quote.tokens_out);
    send(&mut w.svm, &[ix], &trader, &[]).expect("post-donation buy failed");
    let c = curve_account(&w);
    assert_eq!(c.real_sol_reserves, predicted.sr, "donation must not enter pricing");
    assert_eq!(c.token_reserves, predicted.t);

    let mut predicted = math_of(&w);
    let sq = curve::sell(&mut predicted, c.outstanding / 2).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "sell", c.outstanding / 2, sq.net_out);
    send(&mut w.svm, &[ix], &trader, &[]).expect("post-donation sell failed");
}

#[test]
fn events_ride_inner_instructions_with_the_pinned_bytes() {
    let mut w = setup();
    let trader = Keypair::new();
    w.svm.airdrop(&trader.pubkey(), 50 * SOL).unwrap();

    let mut predicted = math_of(&w);
    let quote = curve::buy(&mut predicted, 3 * SOL).unwrap();
    let ix = trade_ix(&w, &trader.pubkey(), "buy", 3 * SOL, 0);
    let meta = send(&mut w.svm, &[ix], &trader, &[]).expect("buy failed");

    let event_ix_tag = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    let mut found = None;
    for group in &meta.inner_instructions {
        for inner in group {
            let data = &inner.instruction.data;
            if data.len() >= 16 && data[..8] == event_ix_tag {
                found = Some(data.clone());
            }
        }
    }
    let data = found.expect("no event CPI found in inner instructions");
    assert_eq!(&data[8..16], streamed_coin::TradeEvent::DISCRIMINATOR, "event discriminator");
    assert_eq!(data.len(), 16 + 113, "TradeEvent wire size");

    let ev = streamed_coin::TradeEvent::deserialize(&mut &data[16..]).unwrap();
    assert_eq!(ev.mint, w.mint);
    assert_eq!(ev.trader, trader.pubkey());
    assert!(ev.is_buy);
    assert_eq!(ev.sol_amount, 3 * SOL);
    assert_eq!(ev.token_amount, quote.tokens_out);
    assert_eq!(ev.fee, quote.fee);
    let c = curve_account(&w);
    assert_eq!(ev.virtual_sol, c.virtual_sol_reserves, "post-trade virtual reserve");
    assert_eq!(ev.real_sol, c.real_sol_reserves, "post-trade real reserve");
    assert_eq!(ev.token_reserves, c.token_reserves, "post-trade token reserve");
}

// --- the claim flow (§3.4) ---------------------------------------------------

fn now(w: &World) -> i64 {
    w.svm.get_sysvar::<Clock>().unix_timestamp
}

/// Move the cluster clock. The blockhash is expired with it, so a transaction
/// rebuilt after the jump is a new transaction and not a duplicate of the one
/// that ran before it.
fn advance(w: &mut World, seconds: i64) {
    let mut clock = w.svm.get_sysvar::<Clock>();
    clock.unix_timestamp += seconds;
    w.svm.set_sysvar(&clock);
    w.svm.expire_blockhash();
}

fn global_account(w: &World) -> streamed_coin::Global {
    let data = w.svm.get_account(&w.global).unwrap().data;
    streamed_coin::Global::deserialize(&mut &data[8..]).unwrap()
}

/// The attestation over `destination` for the coin's CURRENT nonce, followed
/// by `initiate_claim`. The two must be adjacent, in this order.
fn initiate_ixs(w: &World, destination: &Pubkey, expiry: i64, signers: &[&Keypair]) -> [Instruction; 2] {
    let nonce = curve_account(w).claim_nonce;
    let message = streamed_coin::claim_message(KICK_ID, destination, expiry, nonce);
    let attest = common::ed25519_ix(&message, signers);
    let mut data = ix_disc("initiate_claim");
    KICK_ID.serialize(&mut data).unwrap();
    expiry.serialize(&mut data).unwrap();
    let initiate = Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new(w.global, false),
            AccountMeta::new(w.curve, false),
            AccountMeta::new_readonly(*destination, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::instructions::id(), false),
            AccountMeta::new_readonly(w.event_authority, false),
            AccountMeta::new_readonly(streamed_coin::ID, false),
        ],
        data,
    };
    [attest, initiate]
}

fn finalize_ix(w: &World, destination: &Pubkey, payer: &Pubkey) -> Instruction {
    let kid = KICK_ID.to_le_bytes();
    let mut data = ix_disc("finalize_claim");
    KICK_ID.serialize(&mut data).unwrap();
    Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new_readonly(w.global, false),
            AccountMeta::new(w.curve, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new(pda(&[b"creator_vault", &kid]), false),
            AccountMeta::new_readonly(*destination, false),
            AccountMeta::new(ata_of(destination, &w.mint), false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(token_program(), false),
            AccountMeta::new_readonly(ata_program(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(w.event_authority, false),
            AccountMeta::new_readonly(streamed_coin::ID, false),
        ],
        data,
    }
}

fn veto_ix(w: &World, authority: &Pubkey) -> Instruction {
    let mut data = ix_disc("veto_claim");
    KICK_ID.serialize(&mut data).unwrap();
    Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new_readonly(w.global, false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(w.curve, false),
            AccountMeta::new_readonly(w.event_authority, false),
            AccountMeta::new_readonly(streamed_coin::ID, false),
        ],
        data,
    }
}

fn update_global_ix(w: &World, params: &GlobalParams) -> Instruction {
    let mut data = ix_disc("update_global");
    params.serialize(&mut data).unwrap();
    Instruction {
        program_id: streamed_coin::ID,
        accounts: vec![
            AccountMeta::new(w.global, false),
            AccountMeta::new_readonly(w.authority.pubkey(), true),
        ],
        data,
    }
}

/// The custom error code out of a failed transaction, and which instruction
/// raised it. The index matters: the Ed25519 precompile reports its own
/// failures as `Custom` codes too, so a code alone cannot say whether the
/// transaction died in the precompile or in our handler.
fn custom_error(err: &Box<litesvm::types::FailedTransactionMetadata>) -> Option<(u8, u32)> {
    match err.err {
        TransactionError::InstructionError(at, InstructionError::Custom(code)) => Some((at, code)),
        _ => None,
    }
}

fn expect_error(
    result: Result<litesvm::types::TransactionMetadata, Box<litesvm::types::FailedTransactionMetadata>>,
    expected: CurveError,
    what: &str,
) {
    match result {
        Ok(_) => panic!("{what}: succeeded, expected {expected:?}"),
        Err(e) => {
            let (_, code) = custom_error(&e)
                .unwrap_or_else(|| panic!("{what}: expected {expected:?}, got {:?}", e.err));
            assert_eq!(code, u32::from(expected), "{what}: got {:?}", e.err);
        }
    }
}

/// Anchor's own error codes start here, so a `Custom` code below it came from
/// something other than our program — the Ed25519 precompile, in this file.
const ANCHOR_ERROR_BASE: u32 = 6_000;

/// The first event-CPI in `meta` carrying `disc`, as its bytes after the
/// event-ix tag.
fn find_event(meta: &litesvm::types::TransactionMetadata, disc: &[u8]) -> Option<Vec<u8>> {
    let event_ix_tag = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    for group in &meta.inner_instructions {
        for inner in group {
            let data = &inner.instruction.data;
            if data.len() >= 16 && data[..8] == event_ix_tag && &data[8..16] == disc {
                return Some(data[8..].to_vec());
            }
        }
    }
    None
}

fn creator_cut() -> u64 {
    SUPPLY - float_of(SUPPLY)
}

/// The whole flow on an existing coin: two oracles attest, the streamer's
/// wallet signs, the claim waits out its timelock, and then anyone at all can
/// release the vault to the wallet that was named.
#[test]
fn a_streamer_claims_the_reserve_after_the_timelock() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let started = now(&w);

    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    let meta = send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("initiate_claim failed");

    let c = curve_account(&w);
    assert_eq!(c.claim_state, streamed_coin::CLAIM_PENDING);
    assert_eq!(c.pending_destination, destination.pubkey());
    assert_eq!(c.pending_unlock_at, started + CLAIM_DELAY);
    assert_eq!(c.pending_oracle_epoch, 0);
    assert_eq!(global_account(&w).claims_this_period, 1, "the cap counted it");

    let ev = find_event(&meta, streamed_coin::ClaimInitiatedEvent::DISCRIMINATOR).expect("ClaimInitiatedEvent");
    assert_eq!(ev.len(), 8 + 96, "ClaimInitiatedEvent wire size");
    let ev = streamed_coin::ClaimInitiatedEvent::deserialize(&mut &ev[8..]).unwrap();
    assert_eq!(ev.kick_user_id, KICK_ID);
    assert_eq!(ev.mint, w.mint);
    assert_eq!(ev.destination, destination.pubkey());
    assert_eq!(ev.unlock_at, started + CLAIM_DELAY);
    assert_eq!(ev.claim_nonce, 0);

    // Too early: one second short is still locked.
    let anyone = Keypair::new();
    w.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    advance(&mut w, CLAIM_DELAY - 1);
    let fin = finalize_ix(&w, &destination.pubkey(), &anyone.pubkey());
    expect_error(send(&mut w.svm, &[fin], &anyone, &[]), CurveError::ClaimTimelocked, "finalize early");

    // On the unlock, a stranger paying the fee releases the whole vault.
    advance(&mut w, 1);
    let fin = finalize_ix(&w, &destination.pubkey(), &anyone.pubkey());
    let meta = send(&mut w.svm, &[fin], &anyone, &[]).expect("finalize_claim failed");
    let kid = KICK_ID.to_le_bytes();
    assert_eq!(token_amount(&w, &pda(&[b"creator_vault", &kid])), 0, "vault emptied");
    assert_eq!(
        token_amount(&w, &ata_of(&destination.pubkey(), &w.mint)),
        creator_cut(),
        "the 15% landed in the destination's token account"
    );
    let c = curve_account(&w);
    assert_eq!(c.claim_state, streamed_coin::CLAIM_CLAIMED);
    assert_eq!(c.pending_destination, destination.pubkey(), "kept as the record of where it went");
    let ev = find_event(&meta, streamed_coin::ClaimFinalizedEvent::DISCRIMINATOR).expect("ClaimFinalizedEvent");
    assert_eq!(ev.len(), 8 + 80, "ClaimFinalizedEvent wire size");
    let ev = streamed_coin::ClaimFinalizedEvent::deserialize(&mut &ev[8..]).unwrap();
    assert_eq!(ev.amount, creator_cut());
    assert_eq!(ev.destination, destination.pubkey());

    // Terminal: nothing moves it back, and no attestation reopens it.
    advance(&mut w, 1);
    let fin = finalize_ix(&w, &destination.pubkey(), &anyone.pubkey());
    expect_error(send(&mut w.svm, &[fin], &anyone, &[]), CurveError::ClaimNotPending, "finalize twice");
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    expect_error(
        send(&mut w.svm, &ixs, &w.authority, &[&destination]),
        CurveError::AlreadyClaimed,
        "initiate after claimed",
    );
    // Trading is untouched by any of it.
    let trader = Keypair::new();
    w.svm.airdrop(&trader.pubkey(), 10 * SOL).unwrap();
    let buy = trade_ix(&w, &trader.pubkey(), "buy", SOL, 0);
    send(&mut w.svm, &[buy], &trader, &[]).expect("buy after claim");
}

/// A veto moves the nonce, so the attestation that started the vetoed claim
/// no longer matches any message the program will accept. The streamer needs
/// a fresh one, which then works.
#[test]
fn a_vetoed_attestation_dies_with_the_nonce() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("initiate");

    // Only the authority may veto.
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let by_stranger = veto_ix(&w, &stranger.pubkey());
    assert!(send(&mut w.svm, &[by_stranger], &stranger, &[]).is_err());

    let veto = veto_ix(&w, &w.authority.pubkey());
    let meta = send(&mut w.svm, &[veto], &w.authority, &[]).expect("veto");
    let c = curve_account(&w);
    assert_eq!(c.claim_state, streamed_coin::CLAIM_UNCLAIMED);
    assert_eq!(c.pending_destination, Pubkey::default());
    assert_eq!(c.claim_nonce, 1);
    let ev = find_event(&meta, streamed_coin::ClaimVetoedEvent::DISCRIMINATOR).expect("ClaimVetoedEvent");
    assert_eq!(ev.len(), 8 + 48, "ClaimVetoedEvent wire size");
    assert_eq!(streamed_coin::ClaimVetoedEvent::deserialize(&mut &ev[8..]).unwrap().claim_nonce, 1);

    // Replaying the vetoed attestation: same signatures, valid crypto, but
    // over a message the program no longer builds.
    w.svm.expire_blockhash();
    expect_error(
        send(&mut w.svm, &ixs, &w.authority, &[&destination]),
        CurveError::BadAttestation,
        "replay after veto",
    );
    // Vetoing what is not pending is refused.
    let veto = veto_ix(&w, &w.authority.pubkey());
    expect_error(
        send(&mut w.svm, &[veto], &w.authority, &[]),
        CurveError::ClaimNotPending,
        "veto nothing",
    );

    // A fresh attestation over nonce 1 starts again.
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[1], &w.oracles[2]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("re-initiate");
    assert_eq!(curve_account(&w).claim_state, streamed_coin::CLAIM_PENDING);
}

#[test]
fn the_threshold_counts_distinct_oracle_keys_only() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let outsider = Keypair::new();

    // One oracle is not two.
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::OracleThresholdNotMet, "one signer");
    // The same oracle twice is still one.
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[0]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::OracleThresholdNotMet, "one signer twice");
    // A valid signature from a key outside the set counts for nothing.
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &outsider]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::OracleThresholdNotMet, "outsider");
    // Two distinct members do it, whichever two.
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[2], &w.oracles[0]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("two distinct oracles");
}

/// The configuration a fresh `initialize_global` lands in when only one oracle
/// address is supplied: the same key in all three slots. With a threshold of
/// two, no attestation can ever pass, and the program says so rather than
/// counting one key as three.
#[test]
fn one_key_in_every_slot_can_never_meet_a_threshold_of_two() {
    let mut w = setup_bare_with(None, 10);
    let only = w.oracles[0].pubkey();
    let one_key = update_global_ix(&w, &global_params(&w.authority.pubkey(), &w.treasury, [only, only, only], 10));
    send(&mut w.svm, &[one_key], &w.authority, &[]).expect("update_global");
    let create = create_coin_ix(&w, &w.authority.pubkey());
    send(&mut w.svm, &[create], &w.authority, &[&w.mint_kp]).expect("create_coin");

    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[0]]);
    expect_error(
        send(&mut w.svm, &ixs, &w.authority, &[&destination]),
        CurveError::OracleThresholdNotMet,
        "one key, three slots",
    );
}

/// Rotating the oracle set bumps the epoch, and a claim initiated under the
/// old epoch can never finalize. The legitimate claimant does not need a
/// veto: a fresh attestation from the new set replaces the stale claim.
#[test]
fn rotating_the_oracle_set_cancels_the_claim_in_flight() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("initiate");

    let fresh: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    let rotated = global_params(
        &w.authority.pubkey(),
        &w.treasury,
        [fresh[0].pubkey(), fresh[1].pubkey(), fresh[2].pubkey()],
        10,
    );
    let rotate = update_global_ix(&w, &rotated);
    send(&mut w.svm, &[rotate], &w.authority, &[]).expect("rotate");
    assert_eq!(global_account(&w).oracle_epoch, 1);

    advance(&mut w, CLAIM_DELAY);
    let fin = finalize_ix(&w, &destination.pubkey(), &w.authority.pubkey());
    expect_error(
        send(&mut w.svm, &[fin], &w.authority, &[]),
        CurveError::OracleEpochMismatch,
        "finalize under a rotated set",
    );

    // The old set no longer counts.
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::OracleThresholdNotMet, "old oracles");

    // The new set re-initiates over the stale pending claim, no veto needed.
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&fresh[0], &fresh[2]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("re-initiate under the new epoch");
    let c = curve_account(&w);
    assert_eq!(c.pending_oracle_epoch, 1);
    assert_eq!(c.claim_nonce, 0, "no veto happened, so the nonce did not move");

    // But a pending claim under the CURRENT epoch cannot be replaced.
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&fresh[0], &fresh[1]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::ClaimPending, "double initiate");

    advance(&mut w, CLAIM_DELAY);
    let fin = finalize_ix(&w, &destination.pubkey(), &w.authority.pubkey());
    send(&mut w.svm, &[fin], &w.authority, &[]).expect("finalize under the new epoch");
    assert_eq!(token_amount(&w, &ata_of(&destination.pubkey(), &w.mint)), creator_cut());
}

/// Signatures are verified by the Ed25519 precompile before any program runs.
/// The program never checks a signature itself, so this is the test that the
/// precompile really is in the path: a flipped signature byte must fail the
/// transaction with something that is not one of our errors.
#[test]
fn a_forged_signature_is_stopped_before_the_program_runs() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let mut ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    // Second record's signature starts at 2 + 28 + 96 + 32.
    ixs[0].data[2 + 28 + 96 + 32] ^= 0x01;
    let err = send(&mut w.svm, &ixs, &w.authority, &[&destination]).err().expect("forged signature accepted");
    // Instruction 0 is the Ed25519 precompile, instruction 1 is ours. The
    // precompile reports failures as `Custom` codes too, so the index and the
    // code's range are what say which one rejected it — and it must be the
    // precompile, because the program never verifies a signature itself.
    let (at, code) = custom_error(&err).expect("expected a custom error");
    assert_eq!(at, 0, "rejected by the program instead of the precompile: {:?}", err.err);
    assert!(code < ANCHOR_ERROR_BASE, "an Anchor error, so the program ran: {:?}", err.err);
    assert_eq!(curve_account(&w).claim_state, streamed_coin::CLAIM_UNCLAIMED);
}

#[test]
fn an_attestation_that_points_outside_its_own_instruction_is_refused() {
    let mut w = setup();
    let destination = Keypair::new();
    let expiry = now(&w) + 600;
    let mut ixs = initiate_ixs(&w, &destination.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    // message_instruction_index of the first record: 0 names the Ed25519
    // instruction itself by position, which the precompile accepts and the
    // program does not.
    ixs[0].data[2 + 12..2 + 14].copy_from_slice(&0u16.to_le_bytes());
    expect_error(
        send(&mut w.svm, &ixs, &w.authority, &[&destination]),
        CurveError::BadAttestation,
        "explicit instruction index",
    );
}

#[test]
fn an_expired_attestation_is_refused() {
    let mut w = setup();
    let destination = Keypair::new();
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w), &[&w.oracles[0], &w.oracles[1]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::AttestationExpired, "expiry == now");
}

/// The destination signs the transaction, and the attestation names it. A
/// different wallet presenting somebody else's attestation builds a different
/// message, which no oracle signed.
#[test]
fn an_attestation_is_usable_only_by_the_wallet_it_names() {
    let mut w = setup();
    let named = Keypair::new();
    let thief = Keypair::new();
    let expiry = now(&w) + 600;
    let mut ixs = initiate_ixs(&w, &named.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    ixs[1].accounts[2] = AccountMeta::new_readonly(thief.pubkey(), true);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&thief]), CurveError::BadAttestation, "wrong wallet");
    // And without the named wallet's signature the transaction does not even
    // reach the program.
    let ixs = initiate_ixs(&w, &named.pubkey(), expiry, &[&w.oracles[0], &w.oracles[1]]);
    let unsigned = Transaction::new_with_payer(&ixs, Some(&w.authority.pubkey()));
    assert!(w.svm.send_transaction(unsigned).is_err());
}

#[test]
fn finalize_pays_only_the_named_destination() {
    let mut w = setup();
    let destination = Keypair::new();
    let other = Keypair::new();
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("initiate");
    advance(&mut w, CLAIM_DELAY);
    let fin = finalize_ix(&w, &other.pubkey(), &w.authority.pubkey());
    expect_error(send(&mut w.svm, &[fin], &w.authority, &[]), CurveError::WrongDestination, "other wallet");
    assert_eq!(curve_account(&w).claim_state, streamed_coin::CLAIM_PENDING);
}

/// `claim_cap_per_period` bounds how many claims can be started per window.
/// With a cap of one, the second initiation in a window is refused even after
/// the first was vetoed, and the next window opens it again.
#[test]
fn initiations_are_capped_per_period() {
    let mut w = setup_bare_with(None, 1);
    let create = create_coin_ix(&w, &w.authority.pubkey());
    send(&mut w.svm, &[create], &w.authority, &[&w.mint_kp]).expect("create_coin");
    let destination = Keypair::new();

    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("first initiate");
    let veto = veto_ix(&w, &w.authority.pubkey());
    send(&mut w.svm, &[veto], &w.authority, &[]).expect("veto");

    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    expect_error(send(&mut w.svm, &ixs, &w.authority, &[&destination]), CurveError::ClaimRateLimited, "cap reached");

    advance(&mut w, CLAIM_PERIOD);
    let ixs = initiate_ixs(&w, &destination.pubkey(), now(&w) + 600, &[&w.oracles[0], &w.oracles[1]]);
    send(&mut w.svm, &ixs, &w.authority, &[&destination]).expect("next window");
    let g = global_account(&w);
    assert_eq!(g.claims_this_period, 1, "the window rolled and counted again");
}

/// The discriminators js/events.js pins for the claim events are the real
/// Anchor derivations, same as the two trade-side ones.
#[test]
fn the_claim_event_discriminators_are_the_pinned_ones() {
    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(hex(streamed_coin::ClaimInitiatedEvent::DISCRIMINATOR), "a307a68e65b19861");
    assert_eq!(hex(streamed_coin::ClaimFinalizedEvent::DISCRIMINATOR), "1e5558005330e717");
    assert_eq!(hex(streamed_coin::ClaimVetoedEvent::DISCRIMINATOR), "b6f3a110946c5130");
}
