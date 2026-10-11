//! The streamed.fun curve program: create, buy and sell on a constant-product
//! curve with virtual reserves and the sell-side solvency floor (spec §3.1 to
//! §3.3), and the claim flow that releases a streamer's reserve once the
//! oracle set has attested their identity (§3.4). Deliberately not the full
//! spec: graduation and metadata are later phases. The account layouts carry
//! the full spec shape now so those phases extend this program instead of
//! migrating it.
//!
//! The curve math lives in `curve.rs`, differentially tested against the
//! JavaScript reference; handlers here validate accounts, call the math, and
//! move exactly what the outcome says. Events go out via `emit_cpi!` only —
//! never plain logs, which can be forged and truncate — and their layouts are
//! pinned byte-for-byte by `js/events.js`.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

pub mod curve;
use curve::{CurveMathError, CurveState};

declare_id!("3TdK7cTcmTQwZuZfJyDQqHLe6kyqRXQif2eCF1jDG7k5");

// On-chain contact details, readable straight off the deployed binary
// (<https://github.com/neodyme-labs/solana-security-txt>). Someone who finds a
// hole in this program can get from a program id to a way to tell us without
// knowing who we are or that the website exists — which is the entire point,
// and why every value here is public and permanent.
// 
// `no-entrypoint` gates it because the section this emits belongs in a
// deployed program and not in a crate linked as a library — the LiteSVM suite
// depends on this crate with that feature for exactly that reason.
// 
// Every field here resolves publicly, which is the whole point and was not true
// while these links pointed at the application's private repository. The email
// must stay a monitored inbox: a security.txt naming a dead address is worse
// than none, because it looks like a channel and is not one.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "streamed.fun",
    project_url: "https://streamed.fun",
    contacts: "email:security@streamed.fun,link:https://github.com/streamed-fun/program/security/advisories/new",
    policy: "https://github.com/streamed-fun/program/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/streamed-fun/program",
    // Honest, and D18 makes it a precondition for mainnet rather than a nice to
    // have. It changes when that is untrue and not before.
    auditors: "None"
}

pub const MIN_CLAIM_DELAY_SECONDS: i64 = 86_400;
pub const MIN_CLAIM_CAP_PER_PERIOD: u16 = 1;

/// `Curve.claim_state` (spec §3.4). 2 is terminal.
pub const CLAIM_UNCLAIMED: u8 = 0;
pub const CLAIM_PENDING: u8 = 1;
pub const CLAIM_CLAIMED: u8 = 2;
/// The attestation message: u64 ‖ 32 ‖ i64 ‖ u64 ‖ 32 bytes.
pub const CLAIM_MESSAGE_LEN: usize = 88;
pub const MAX_NAME_BYTES: usize = 32;
pub const MAX_SYMBOL_BYTES: usize = 10;
pub const MAX_URI_BYTES: usize = 200;

/// Every coin opens at the same price and graduates at the same bar (D20,
/// revised): one flat `default_virtual_sol_reserves` for the open, one flat
/// pair of collected-SOL bars for graduation, pump.fun style. The bars bake
/// into each `Curve` at creation, so retuning `Global` touches future coins
/// only and no live coin's finish line ever moves.
///
/// A coin must be able to graduate at all, so the claimed bar may not exceed
/// the unclaimed one and neither may be zero.
pub const MIN_GRAD_BAR_LAMPORTS: u64 = 1;

const CURVE_SEED: &[u8] = b"curve";
const SOL_VAULT_SEED: &[u8] = b"sol_vault";
const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
const CREATOR_VAULT_SEED: &[u8] = b"creator_vault";

#[program]
pub mod streamed_coin {
    use super::*;

    pub fn initialize_global(ctx: Context<InitializeGlobal>, args: GlobalParams) -> Result<()> {
        validate_global_params(&args)?;
        let g = &mut ctx.accounts.global;
        g.authority = ctx.accounts.authority.key();
        g.creator_authority = args.creator_authority;
        g.oracle_pubkeys = args.oracle_pubkeys;
        g.oracle_threshold = args.oracle_threshold;
        g.relayer_pubkey = args.relayer_pubkey;
        g.treasury = args.treasury;
        g.fee_bps = args.fee_bps;
        g.creator_share_bps = args.creator_share_bps;
        g.token_total_supply = args.token_total_supply;
        g.token_decimals = args.token_decimals;
        g.default_virtual_sol_reserves = args.default_virtual_sol_reserves;
        g.claim_delay_seconds = args.claim_delay_seconds;
        g.claim_period_seconds = args.claim_period_seconds;
        g.claim_cap_per_period = args.claim_cap_per_period;
        g.claims_this_period = 0;
        g.claim_period_start = 0;
        g.oracle_epoch = 0;
        g.grad_bar_lamports = args.grad_bar_lamports;
        g.grad_bar_claimed_lamports = args.grad_bar_claimed_lamports;
        g.bump = ctx.bumps.global;
        require!(
            g.token_total_supply > 0 && g.default_virtual_sol_reserves > 0,
            CurveError::BadGlobalParam
        );
        Ok(())
    }

    /// Bounded tuning only (spec §3.2): the multisig can move the economics
    /// but no value accepted here can halt trading or confiscate. Supply,
    /// decimals and the virtual reserve are creation-time constants and are
    /// deliberately not updatable per coin; changing the defaults affects
    /// future coins only. Rotating the oracle set or threshold increments
    /// `oracle_epoch`, which cancels every in-flight claim at once.
    pub fn update_global(ctx: Context<UpdateGlobal>, args: GlobalParams) -> Result<()> {
        validate_global_params(&args)?;
        let g = &mut ctx.accounts.global;
        if args.oracle_pubkeys != g.oracle_pubkeys || args.oracle_threshold != g.oracle_threshold {
            g.oracle_epoch = g.oracle_epoch.checked_add(1).unwrap();
        }
        g.creator_authority = args.creator_authority;
        g.oracle_pubkeys = args.oracle_pubkeys;
        g.oracle_threshold = args.oracle_threshold;
        g.relayer_pubkey = args.relayer_pubkey;
        g.treasury = args.treasury;
        g.fee_bps = args.fee_bps;
        g.creator_share_bps = args.creator_share_bps;
        g.token_total_supply = args.token_total_supply;
        g.token_decimals = args.token_decimals;
        g.default_virtual_sol_reserves = args.default_virtual_sol_reserves;
        g.claim_delay_seconds = args.claim_delay_seconds;
        g.claim_period_seconds = args.claim_period_seconds;
        g.claim_cap_per_period = args.claim_cap_per_period;
        // Retuning the open or the bars affects future coins only: every
        // existing `Curve` carries its own opening reserve and its own baked
        // graduation bars, so no live coin's finish line ever moves.
        g.grad_bar_lamports = args.grad_bar_lamports;
        g.grad_bar_claimed_lamports = args.grad_bar_claimed_lamports;
        Ok(())
    }

    /// D19: the mint is a supplied keypair, never a PDA, so addresses can be
    /// ground for a vanity suffix. It signs once here, mints the fixed supply
    /// split 15/85 into the two vaults, and then its authority is set to
    /// `None` (D5) — the keypair is spent the moment this returns. Metadata
    /// is a later phase; the name/symbol/uri byte limits are enforced now so
    /// the interface does not change when the Metaplex CPI arrives.
    pub fn create_coin(
        ctx: Context<CreateCoin>,
        kick_user_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require!(name.len() <= MAX_NAME_BYTES, CurveError::NameTooLong);
        require!(symbol.len() <= MAX_SYMBOL_BYTES, CurveError::SymbolTooLong);
        require!(uri.len() <= MAX_URI_BYTES, CurveError::UriTooLong);

        let global = &ctx.accounts.global;
        let supply = global.token_total_supply;
        let creator_cut =
            (supply as u128 * global.creator_share_bps as u128 / 10_000) as u64;
        let float = supply - creator_cut;
        require!(float > 0, CurveError::BadGlobalParam);

        // D20 (revised): every coin opens at the same price and there is no
        // price argument, so this instruction cannot be used to open a coin
        // anywhere else. The graduation bars bake in here from `Global`, so
        // this coin's finish line is fixed the moment it exists.
        let opening_reserve = global.default_virtual_sol_reserves;
        require!(opening_reserve > 0, CurveError::BadGlobalParam);

        let c = &mut ctx.accounts.curve;
        c.kick_user_id = kick_user_id;
        c.mint = ctx.accounts.mint.key();
        c.token_vault = ctx.accounts.token_vault.key();
        c.sol_vault = ctx.accounts.sol_vault.key();
        c.creator_vault = ctx.accounts.creator_vault.key();
        c.virtual_sol_reserves = opening_reserve;
        c.grad_bar_lamports = global.grad_bar_lamports;
        c.grad_bar_claimed_lamports = global.grad_bar_claimed_lamports;
        c.real_sol_reserves = 0;
        c.token_reserves = float;
        c.claim_state = 0;
        c.pending_destination = Pubkey::default();
        c.pending_unlock_at = 0;
        c.outstanding = 0;
        c.claim_nonce = 0;
        c.pending_oracle_epoch = 0;
        c.venue = 0;
        c.venue_pool = Pubkey::default();
        c.created_at = Clock::get()?.unix_timestamp;
        c.bump = ctx.bumps.curve;
        c.vault_bump = ctx.bumps.sol_vault;

        let rent_floor = Rent::get()?.minimum_balance(0);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            rent_floor,
        )?;

        let kid = kick_user_id.to_le_bytes();
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, &kid, &[c.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.creator_vault.to_account_info(),
                    authority: c.to_account_info(),
                },
                &[curve_seeds],
            ),
            creator_cut,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: c.to_account_info(),
                },
                &[curve_seeds],
            ),
            float,
        )?;
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::SetAuthority {
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                    current_authority: c.to_account_info(),
                },
                &[curve_seeds],
            ),
            token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        emit_cpi!(CoinCreatedEvent {
            kick_user_id,
            mint: ctx.accounts.mint.key(),
            decimals: global.token_decimals,
            grad_bar_lamports: global.grad_bar_lamports,
            grad_bar_claimed_lamports: global.grad_bar_claimed_lamports,
            virtual_sol_reserves: opening_reserve,
        });
        Ok(())
    }

    pub fn buy(
        ctx: Context<Trade>,
        kick_user_id: u64,
        sol_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        require!(ctx.accounts.curve.venue == 0, CurveError::Migrated);
        let mut state = math_state(&ctx.accounts.curve, &ctx.accounts.global);
        let out = curve::buy(&mut state, sol_in).map_err(map_math_err)?;
        require!(out.tokens_out >= min_tokens_out, CurveError::SlippageExceeded);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            sol_in,
        )?;

        let kid = kick_user_id.to_le_bytes();
        let vault_bump = [ctx.accounts.curve.vault_bump];
        let vault_seeds: &[&[u8]] = &[SOL_VAULT_SEED, &kid, &vault_bump];
        if out.fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sol_vault.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                out.fee,
            )?;
        }

        let curve_bump = [ctx.accounts.curve.bump];
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, &kid, &curve_bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.trader_ata.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            out.tokens_out,
        )?;

        let c = &mut ctx.accounts.curve;
        c.real_sol_reserves = state.sr;
        c.token_reserves = state.t;
        c.outstanding = state.outstanding;

        emit_cpi!(TradeEvent {
            mint: c.mint,
            trader: ctx.accounts.trader.key(),
            is_buy: true,
            sol_amount: sol_in,
            token_amount: out.tokens_out,
            fee: out.fee,
            virtual_sol: c.virtual_sol_reserves,
            real_sol: c.real_sol_reserves,
            token_reserves: c.token_reserves,
        });
        Ok(())
    }

    /// Every token sent is absorbed (spec §3.3): curve-origin tokens price at
    /// pure constant product, vault-origin extraction is till-capped, and the
    /// unpayable overflow stays in the token vault outside `token_reserves`,
    /// retired from circulation forever. No change is ever returned.
    pub fn sell(
        ctx: Context<Trade>,
        kick_user_id: u64,
        tokens_in: u64,
        min_sol_out: u64,
    ) -> Result<()> {
        require!(ctx.accounts.curve.venue == 0, CurveError::Migrated);
        let mut state = math_state(&ctx.accounts.curve, &ctx.accounts.global);
        let out = curve::sell(&mut state, tokens_in).map_err(map_math_err)?;
        require!(out.net_out >= min_sol_out, CurveError::SlippageExceeded);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.trader_ata.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        let kid = kick_user_id.to_le_bytes();
        let vault_bump = [ctx.accounts.curve.vault_bump];
        let vault_seeds: &[&[u8]] = &[SOL_VAULT_SEED, &kid, &vault_bump];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.trader.to_account_info(),
                },
                &[vault_seeds],
            ),
            out.net_out,
        )?;
        if out.fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sol_vault.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                out.fee,
            )?;
        }

        let c = &mut ctx.accounts.curve;
        c.real_sol_reserves = state.sr;
        c.token_reserves = state.t;
        c.outstanding = state.outstanding;

        emit_cpi!(TradeEvent {
            mint: c.mint,
            trader: ctx.accounts.trader.key(),
            is_buy: false,
            sol_amount: out.net_out,
            token_amount: tokens_in,
            fee: out.fee,
            virtual_sol: c.virtual_sol_reserves,
            real_sol: c.real_sol_reserves,
            token_reserves: c.token_reserves,
        });
        Ok(())
    }

    /// Starts a claim on the creator vault (spec §3.4). The identity proof is
    /// off chain: the oracle set attests over Ed25519 that `kick_user_id`
    /// belongs to `destination`. That attestation rides in the Ed25519
    /// program instruction immediately preceding this one, and this handler
    /// reads it back through the instructions sysvar to check the message
    /// bytes and count distinct oracle signers. No tokens move here: the claim
    /// becomes pending for `claim_delay_seconds`, during which the authority
    /// can veto it and anyone can see it.
    ///
    /// `destination` signs, so an attestation cannot be used by anyone but its
    /// intended recipient. The fee payer is whoever pays the transaction; the
    /// relayer normally does, but nothing here requires it.
    pub fn initiate_claim(
        ctx: Context<InitiateClaim>,
        kick_user_id: u64,
        expiry: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let destination = ctx.accounts.destination.key();
        let global = &mut ctx.accounts.global;
        let curve = &mut ctx.accounts.curve;

        let message = claim_message(kick_user_id, &destination, expiry, curve.claim_nonce);
        let signers = count_oracle_signatures(
            &ctx.accounts.instructions,
            &message,
            &global.oracle_pubkeys,
        )?;
        require!(
            signers >= global.oracle_threshold,
            CurveError::OracleThresholdNotMet
        );
        require!(now < expiry, CurveError::AttestationExpired);

        // A pending claim whose oracle epoch is stale was cancelled by a
        // rotation and can never finalize, so a fresh attestation may replace
        // it without a veto. Anything else pending or already claimed is
        // final for this instruction.
        let stale_pending = curve.claim_state == CLAIM_PENDING
            && curve.pending_oracle_epoch != global.oracle_epoch;
        match curve.claim_state {
            CLAIM_UNCLAIMED => {}
            CLAIM_PENDING if stale_pending => {}
            CLAIM_PENDING => return Err(error!(CurveError::ClaimPending)),
            _ => return Err(error!(CurveError::AlreadyClaimed)),
        }

        if now - global.claim_period_start >= global.claim_period_seconds {
            global.claim_period_start = now;
            global.claims_this_period = 0;
        }
        require!(
            global.claims_this_period < global.claim_cap_per_period,
            CurveError::ClaimRateLimited
        );
        global.claims_this_period += 1;

        curve.claim_state = CLAIM_PENDING;
        curve.pending_destination = destination;
        curve.pending_unlock_at = now
            .checked_add(global.claim_delay_seconds)
            .ok_or(CurveError::MathOverflow)?;
        curve.pending_oracle_epoch = global.oracle_epoch;

        emit_cpi!(ClaimInitiatedEvent {
            kick_user_id,
            mint: curve.mint,
            destination,
            unlock_at: curve.pending_unlock_at,
            oracle_epoch: curve.pending_oracle_epoch,
            claim_nonce: curve.claim_nonce,
        });
        Ok(())
    }

    /// Completes a pending claim once its timelock has passed (spec §3.4).
    /// Permissionless: it carries no authority, so there is nothing to gain by
    /// front-running it. The whole creator vault moves to the destination the
    /// pending claim named, into an associated token account the fee payer
    /// creates if it is missing. `claim_state == 2` is terminal.
    pub fn finalize_claim(ctx: Context<FinalizeClaim>, kick_user_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let curve = &ctx.accounts.curve;
        require!(curve.claim_state == CLAIM_PENDING, CurveError::ClaimNotPending);
        require!(now >= curve.pending_unlock_at, CurveError::ClaimTimelocked);
        require!(
            curve.pending_oracle_epoch == ctx.accounts.global.oracle_epoch,
            CurveError::OracleEpochMismatch
        );
        require_keys_eq!(
            ctx.accounts.destination.key(),
            curve.pending_destination,
            CurveError::WrongDestination
        );

        let amount = ctx.accounts.creator_vault.amount;
        let kid = kick_user_id.to_le_bytes();
        let bump = [curve.bump];
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, &kid, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.creator_vault.to_account_info(),
                    to: ctx.accounts.destination_ata.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            amount,
        )?;

        let curve = &mut ctx.accounts.curve;
        curve.claim_state = CLAIM_CLAIMED;
        // `pending_destination` stays: it is now the record of where the vault
        // went, and nothing reads it as pending once the state is terminal.
        curve.pending_unlock_at = 0;

        emit_cpi!(ClaimFinalizedEvent {
            kick_user_id,
            mint: curve.mint,
            destination: curve.pending_destination,
            amount,
        });
        Ok(())
    }

    /// Cancels a pending claim during its timelock (spec §3.4). Authority
    /// only. The nonce moves, so every attestation signed over the old nonce
    /// stops matching any message this program will accept; a legitimate
    /// claimant gets a fresh attestation and starts again. This touches only
    /// the claim state machine and never trading, which is why it does not
    /// conflict with D9.
    pub fn veto_claim(ctx: Context<VetoClaim>, kick_user_id: u64) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        require!(curve.claim_state == CLAIM_PENDING, CurveError::ClaimNotPending);
        curve.claim_state = CLAIM_UNCLAIMED;
        curve.pending_destination = Pubkey::default();
        curve.pending_unlock_at = 0;
        curve.pending_oracle_epoch = 0;
        curve.claim_nonce = curve.claim_nonce.checked_add(1).ok_or(CurveError::MathOverflow)?;

        emit_cpi!(ClaimVetoedEvent {
            kick_user_id,
            mint: curve.mint,
            claim_nonce: curve.claim_nonce,
        });
        Ok(())
    }
}

/// The bytes the oracle set signs (spec §3.4):
/// `kick_user_id ‖ destination ‖ expiry ‖ claim_nonce ‖ program_id`, every
/// integer little-endian. The JavaScript mirror builds the same 88 bytes in
/// `js/claim.js`, and the two are pinned against each other by a fixture.
pub fn claim_message(
    kick_user_id: u64,
    destination: &Pubkey,
    expiry: i64,
    claim_nonce: u64,
) -> [u8; CLAIM_MESSAGE_LEN] {
    let mut m = [0u8; CLAIM_MESSAGE_LEN];
    m[0..8].copy_from_slice(&kick_user_id.to_le_bytes());
    m[8..40].copy_from_slice(destination.as_ref());
    m[40..48].copy_from_slice(&expiry.to_le_bytes());
    m[48..56].copy_from_slice(&claim_nonce.to_le_bytes());
    m[56..88].copy_from_slice(crate::ID.as_ref());
    m
}

/// How many distinct members of the oracle set signed `message` in the
/// Ed25519 program instruction immediately before this one.
///
/// The Ed25519 precompile has already verified every signature in that
/// instruction, or the transaction would not be running. What is left to
/// check is what was signed and by whom. Its data is a count, a padding byte,
/// then one 14-byte offsets record per signature, then the payload the offsets
/// point into:
///
///   signature_offset u16 ‖ signature_instruction_index u16 ‖
///   public_key_offset u16 ‖ public_key_instruction_index u16 ‖
///   message_data_offset u16 ‖ message_data_size u16 ‖
///   message_instruction_index u16
///
/// Every index must be `u16::MAX`, meaning "this instruction": an offsets
/// record pointing into some other instruction's data is a layout this handler
/// does not read, so it is refused rather than resolved. Every record's message
/// must be the expected 88 bytes exactly; a signature over anything else fails
/// the whole instruction rather than merely not counting, because an
/// attestation bundle carrying a foreign message is not a bundle to trust.
///
/// The same key signing twice is one signature, and so is the same key
/// appearing in two slots of `oracle_pubkeys`: a signer counts once, for the
/// first slot holding its key.
fn count_oracle_signatures(
    instructions: &AccountInfo,
    message: &[u8; CLAIM_MESSAGE_LEN],
    oracles: &[Pubkey; 3],
) -> Result<u8> {
    use anchor_lang::solana_program::sysvar::instructions::get_instruction_relative;
    let ix = get_instruction_relative(-1, instructions)
        .map_err(|_| error!(CurveError::BadAttestation))?;
    require_keys_eq!(
        ix.program_id,
        anchor_lang::solana_program::ed25519_program::ID,
        CurveError::BadAttestation
    );
    let data = &ix.data;
    require!(data.len() >= 2, CurveError::BadAttestation);
    let count = data[0] as usize;
    require!(count >= 1, CurveError::BadAttestation);
    let u16_at = |at: usize| u16::from_le_bytes([data[at], data[at + 1]]);

    let mut seen = [false; 3];
    for i in 0..count {
        let rec = 2 + i * 14;
        require!(data.len() >= rec + 14, CurveError::BadAttestation);
        let signature_ix = u16_at(rec + 2);
        let pubkey_off = u16_at(rec + 4) as usize;
        let pubkey_ix = u16_at(rec + 6);
        let msg_off = u16_at(rec + 8) as usize;
        let msg_len = u16_at(rec + 10) as usize;
        let msg_ix = u16_at(rec + 12);
        require!(
            signature_ix == u16::MAX && pubkey_ix == u16::MAX && msg_ix == u16::MAX,
            CurveError::BadAttestation
        );
        require!(msg_len == CLAIM_MESSAGE_LEN, CurveError::BadAttestation);
        require!(
            data.len() >= msg_off + msg_len && data.len() >= pubkey_off + 32,
            CurveError::BadAttestation
        );
        require!(
            data[msg_off..msg_off + msg_len] == message[..],
            CurveError::BadAttestation
        );
        let pubkey = &data[pubkey_off..pubkey_off + 32];
        if let Some(slot) = oracles.iter().position(|o| o.as_ref() == pubkey) {
            seen[slot] = true;
        }
    }
    Ok(seen.iter().filter(|s| **s).count() as u8)
}

fn math_state(c: &Curve, g: &Global) -> CurveState {
    CurveState {
        sv: c.virtual_sol_reserves,
        sr: c.real_sol_reserves,
        t: c.token_reserves,
        outstanding: c.outstanding,
        surplus: 0,
        fee_bps: g.fee_bps,
        paid_in: 0,
        paid_out: 0,
    }
}

fn validate_global_params(args: &GlobalParams) -> Result<()> {
    require!(args.fee_bps <= curve::MAX_FEE_BPS, CurveError::BadGlobalParam);
    require!(args.creator_share_bps < 10_000, CurveError::BadGlobalParam);
    require!(
        args.claim_delay_seconds >= MIN_CLAIM_DELAY_SECONDS,
        CurveError::BadGlobalParam
    );
    require!(
        args.claim_cap_per_period >= MIN_CLAIM_CAP_PER_PERIOD,
        CurveError::BadGlobalParam
    );
    require!(args.claim_period_seconds > 0, CurveError::BadGlobalParam);
    require!(
        args.oracle_threshold >= 1 && args.oracle_threshold <= 3,
        CurveError::BadGlobalParam
    );
    // Claiming accelerates graduation and never gates it, so the claimed bar
    // may not sit above the unclaimed one, and a zero bar would graduate a
    // coin with an empty pool.
    require!(
        args.grad_bar_lamports >= MIN_GRAD_BAR_LAMPORTS,
        CurveError::BadGlobalParam
    );
    require!(
        args.grad_bar_claimed_lamports >= MIN_GRAD_BAR_LAMPORTS
            && args.grad_bar_claimed_lamports <= args.grad_bar_lamports,
        CurveError::BadGlobalParam
    );
    Ok(())
}

fn map_math_err(e: CurveMathError) -> Error {
    match e {
        CurveMathError::ZeroBuy | CurveMathError::ZeroSell => error!(CurveError::ZeroAmount),
        CurveMathError::BuyTooSmall => error!(CurveError::BuyTooSmall),
        CurveMathError::NothingToPay => error!(CurveError::NothingToPay),
        CurveMathError::Insolvent => error!(CurveError::Insolvent),
        _ => error!(CurveError::MathOverflow),
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GlobalParams {
    pub creator_authority: Pubkey,
    pub oracle_pubkeys: [Pubkey; 3],
    pub oracle_threshold: u8,
    pub relayer_pubkey: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub creator_share_bps: u16,
    pub token_total_supply: u64,
    pub token_decimals: u8,
    pub default_virtual_sol_reserves: u64,
    pub claim_delay_seconds: i64,
    pub claim_period_seconds: i64,
    pub claim_cap_per_period: u16,
    pub grad_bar_lamports: u64,
    pub grad_bar_claimed_lamports: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Global {
    pub authority: Pubkey,
    pub creator_authority: Pubkey,
    pub oracle_pubkeys: [Pubkey; 3],
    pub oracle_threshold: u8,
    pub relayer_pubkey: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub creator_share_bps: u16,
    pub token_total_supply: u64,
    pub token_decimals: u8,
    pub default_virtual_sol_reserves: u64,
    pub claim_delay_seconds: i64,
    pub claim_period_seconds: i64,
    pub claim_cap_per_period: u16,
    pub claims_this_period: u16,
    pub claim_period_start: i64,
    pub oracle_epoch: u64,
    /// Graduation bars (§3.5), in collected SOL, the same for every coin.
    /// These are the defaults new coins bake in at creation; retuning them
    /// never touches an existing coin.
    pub grad_bar_lamports: u64,
    pub grad_bar_claimed_lamports: u64,
    pub bump: u8,
}

/// The mirrored reserve fields are authoritative for pricing and vault
/// balances may exceed them (spec §3.1): anyone can donate a lamport or a
/// token to any vault, so no instruction may ever assert equality — that
/// would let a stranger brick a coin's trading for one lamport.
#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
    pub creator_vault: Pubkey,
    pub virtual_sol_reserves: u64,
    /// This coin's graduation bars (§3.5), in collected SOL, baked from
    /// `Global` at creation. A retune of the defaults never reaches back here,
    /// so the finish line a buyer bought into is the finish line forever.
    pub grad_bar_lamports: u64,
    pub grad_bar_claimed_lamports: u64,
    pub real_sol_reserves: u64,
    pub token_reserves: u64,
    pub claim_state: u8,
    pub pending_destination: Pubkey,
    pub pending_unlock_at: i64,
    pub outstanding: u64,
    pub claim_nonce: u64,
    pub pending_oracle_epoch: u64,
    pub venue: u8,
    pub venue_pool: Pubkey,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Global::INIT_SPACE,
        seeds = [b"global"],
        bump
    )]
    pub global: Account<'info, Global>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGlobal<'info> {
    #[account(mut, seeds = [b"global"], bump = global.bump, has_one = authority)]
    pub global: Account<'info, Global>,
    pub authority: Signer<'info>,
}

// Every sizeable account here is boxed. Anchor's generated `try_accounts`
// deserializes each one into a stack local, and the unboxed version of this
// struct overran SBF's 4KB frame by 256 bytes — undefined behaviour rather
// than a clean revert. It matters more than usual now that `create_coin` and
// `buy` ride in one transaction (§3.6), which puts both of the heavy
// `try_accounts` frames in a single execution.
#[event_cpi]
#[derive(Accounts)]
#[instruction(kick_user_id: u64)]
pub struct CreateCoin<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = creator_authority)]
    pub global: Box<Account<'info, Global>>,
    pub creator_authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        mint::decimals = global.token_decimals,
        mint::authority = curve
    )]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Curve::INIT_SPACE,
        seeds = [CURVE_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump
    )]
    pub curve: Box<Account<'info, Curve>>,
    #[account(
        init,
        payer = payer,
        seeds = [TOKEN_VAULT_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        seeds = [CREATOR_VAULT_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve
    )]
    pub creator_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(kick_user_id: u64)]
pub struct Trade<'info> {
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [CURVE_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = token_vault,
        has_one = sol_vault
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump = curve.vault_bump
    )]
    pub sol_vault: SystemAccount<'info>,
    /// CHECK: constrained to the treasury address stored in `Global`.
    #[account(mut, address = global.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        init_if_needed,
        payer = trader,
        associated_token::mint = mint,
        associated_token::authority = trader
    )]
    pub trader_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(kick_user_id: u64)]
pub struct InitiateClaim<'info> {
    #[account(mut, seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [CURVE_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump = curve.bump
    )]
    pub curve: Box<Account<'info, Curve>>,
    /// The wallet the vault will be released to. Signs to prove live key
    /// possession, so an attestation is only usable by its intended recipient.
    pub destination: Signer<'info>,
    /// CHECK: the instructions sysvar, address-checked. Read for the Ed25519
    /// program instruction immediately preceding this one.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(kick_user_id: u64)]
pub struct FinalizeClaim<'info> {
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [CURVE_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = creator_vault
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub creator_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: compared to `curve.pending_destination` in the handler, after the
    /// state checks, so a stale caller gets the state error and not an address
    /// mismatch.
    pub destination: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = destination
    )]
    pub destination_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(kick_user_id: u64)]
pub struct VetoClaim<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = authority)]
    pub global: Box<Account<'info, Global>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CURVE_SEED, kick_user_id.to_le_bytes().as_ref()],
        bump = curve.bump
    )]
    pub curve: Box<Account<'info, Curve>>,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub fee: u64,
    pub virtual_sol: u64,
    pub real_sol: u64,
    pub token_reserves: u64,
}

#[event]
pub struct CoinCreatedEvent {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    pub decimals: u8,
    /// The bars this coin baked in at creation, so the indexer knows every
    /// coin's finish line without ever fetching the account.
    pub grad_bar_lamports: u64,
    pub grad_bar_claimed_lamports: u64,
    pub virtual_sol_reserves: u64,
}

/// A claim entered its timelock. This is the event somebody has to watch: the
/// window between it and `unlock_at` is the only time a wrong claim can be
/// vetoed.
#[event]
pub struct ClaimInitiatedEvent {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub unlock_at: i64,
    pub oracle_epoch: u64,
    pub claim_nonce: u64,
}

#[event]
pub struct ClaimFinalizedEvent {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ClaimVetoedEvent {
    pub kick_user_id: u64,
    pub mint: Pubkey,
    /// The nonce after the veto, which every future attestation must carry.
    pub claim_nonce: u64,
}

#[error_code]
pub enum CurveError {
    #[msg("amount must be nonzero")]
    ZeroAmount,
    #[msg("buy too small for one token unit")]
    BuyTooSmall,
    #[msg("sell yields nothing to pay")]
    NothingToPay,
    #[msg("slippage limit exceeded")]
    SlippageExceeded,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("reserve would go negative")]
    Insolvent,
    #[msg("global parameter out of bounds")]
    BadGlobalParam,
    #[msg("name exceeds 32 bytes")]
    NameTooLong,
    #[msg("symbol exceeds 10 bytes")]
    SymbolTooLong,
    #[msg("uri exceeds 200 bytes")]
    UriTooLong,
    #[msg("coin has migrated to its destination venue")]
    Migrated,
    #[msg("the preceding instruction is not a well-formed Ed25519 attestation over the claim message")]
    BadAttestation,
    #[msg("fewer distinct oracle signatures than the threshold")]
    OracleThresholdNotMet,
    #[msg("attestation has expired")]
    AttestationExpired,
    #[msg("a claim is already pending on this coin")]
    ClaimPending,
    #[msg("this coin's reserve has already been claimed")]
    AlreadyClaimed,
    #[msg("claim initiations are capped for this period")]
    ClaimRateLimited,
    #[msg("no claim is pending on this coin")]
    ClaimNotPending,
    #[msg("the claim timelock has not passed")]
    ClaimTimelocked,
    #[msg("the oracle set rotated since this claim was initiated")]
    OracleEpochMismatch,
    #[msg("destination does not match the pending claim")]
    WrongDestination,
}
