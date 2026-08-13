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
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::str::FromStr;
use streamed_coin::curve::{self, CurveState};
use streamed_coin::GlobalParams;

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
}

fn global_params(authority: &Pubkey, treasury: &Pubkey) -> GlobalParams {
    GlobalParams {
        creator_authority: *authority,
        oracle_pubkeys: [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()],
        oracle_threshold: 2,
        relayer_pubkey: *authority,
        treasury: *treasury,
        fee_bps: 100,
        creator_share_bps: 1_500,
        token_total_supply: SUPPLY,
        token_decimals: 6,
        default_virtual_sol_reserves: VIRTUAL_SOL,
        claim_delay_seconds: 172_800,
        claim_period_seconds: 86_400,
        claim_cap_per_period: 10,
        grad_bar_lamports: GRAD_BAR,
        grad_bar_claimed_lamports: GRAD_BAR_CLAIMED,
    }
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

    let mut data = ix_disc("initialize_global");
    global_params(&authority.pubkey(), &treasury).serialize(&mut data).unwrap();
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
    let mut bad = global_params(&w.authority.pubkey(), &w.treasury);
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
    let mut tuned = global_params(&w.authority.pubkey(), &w.treasury);
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
