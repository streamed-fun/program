//! The bonding curve math, ported number-for-number from the executable
//! reference in `js/curve.js` (spec §3.3). That module is the spec;
//! this one must agree with it on every input, which `tests/differential.rs`
//! enforces by replaying generated vectors through both.
//!
//! Pure integer math, no accounts, no CPIs: `u64` state with `u128`
//! intermediates mirroring the reference's BigInt semantics. The instruction
//! handlers in `lib.rs` call these functions and then move exactly the
//! lamports and tokens the outcome says.

pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_TAKE_BPS: u128 = 9_800;
const BPS: u128 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveMathError {
    BadInit,
    FeeOutOfBounds,
    ZeroBuy,
    BuyTooSmall,
    ZeroSell,
    NothingToPay,
    Insolvent,
    Overflow,
}

impl CurveMathError {
    /// The reference implementation's error strings, verbatim, so the
    /// differential vectors can assert on the exact failure and not just
    /// "it failed".
    pub fn msg(self) -> &'static str {
        use CurveMathError::*;
        match self {
            BadInit => "bad init",
            FeeOutOfBounds => "fee out of bounds",
            ZeroBuy => "zero buy",
            BuyTooSmall => "buy too small",
            ZeroSell => "zero sell",
            NothingToPay => "nothing to pay",
            Insolvent => "insolvent: reserve went negative",
            Overflow => "overflow",
        }
    }
}

type CurveResult<T> = Result<T, CurveMathError>;

/// `paid_in`/`paid_out`/`surplus` are reference bookkeeping for the solvency
/// assertions; the on-chain `Curve` account does not store them (retired
/// surplus simply sits in the token vault outside `token_reserves`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveState {
    pub sv: u64,
    pub sr: u64,
    pub t: u64,
    pub outstanding: u64,
    pub surplus: u64,
    pub fee_bps: u16,
    pub paid_in: u128,
    pub paid_out: u128,
}

/// The whole fee is the treasury's (D6): there is no split and no reserve
/// top-up, so `fee` is exactly what leaves for the treasury.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyOutcome {
    pub tokens_out: u64,
    pub fee: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SellOutcome {
    pub net_out: u64,
    pub fee: u64,
    pub retired: u64,
    pub curve_origin: u64,
    pub vault_part: u64,
}

const fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

pub fn create(virtual_sol: u64, float: u64, fee_bps: u16) -> CurveResult<CurveState> {
    if virtual_sol == 0 || float == 0 {
        return Err(CurveMathError::BadInit);
    }
    if fee_bps > MAX_FEE_BPS {
        return Err(CurveMathError::FeeOutOfBounds);
    }
    Ok(CurveState {
        sv: virtual_sol,
        sr: 0,
        t: float,
        outstanding: 0,
        surplus: 0,
        fee_bps,
        paid_in: 0,
        paid_out: 0,
    })
}

pub fn k(c: &CurveState) -> CurveResult<u128> {
    (c.sv as u128 + c.sr as u128)
        .checked_mul(c.t as u128)
        .ok_or(CurveMathError::Overflow)
}

pub fn buy(c: &mut CurveState, sol_in: u64) -> CurveResult<BuyOutcome> {
    if sol_in == 0 {
        return Err(CurveMathError::ZeroBuy);
    }
    let kk = k(c)?;
    let fee = sol_in as u128 * c.fee_bps as u128 / BPS;
    let net = sol_in as u128 - fee;
    let new_eff = c.sv as u128 + c.sr as u128 + net;
    let new_t = ceil_div(kk, new_eff);
    let tokens_out = c.t as u128 - new_t;
    if tokens_out == 0 {
        return Err(CurveMathError::BuyTooSmall);
    }
    let new_sr = u64::try_from(c.sr as u128 + net).map_err(|_| CurveMathError::Overflow)?;
    let new_outstanding = (c.outstanding as u128 + tokens_out)
        .try_into()
        .map_err(|_| CurveMathError::Overflow)?;
    c.sr = new_sr;
    c.t = new_t as u64;
    c.outstanding = new_outstanding;
    c.paid_in += sol_in as u128;
    Ok(BuyOutcome {
        tokens_out: tokens_out as u64,
        fee: fee as u64,
    })
}

pub fn sell(c: &mut CurveState, tokens_in: u64) -> CurveResult<SellOutcome> {
    if tokens_in == 0 {
        return Err(CurveMathError::ZeroSell);
    }
    let kk = k(c)?;
    let eff = c.sv as u128 + c.sr as u128;
    let curve_origin = tokens_in.min(c.outstanding);
    let vault_part = tokens_in - curve_origin;
    let floor_eff = if vault_part > 0 {
        c.sv as u128 + (c.sr as u128 - c.sr as u128 * MAX_TAKE_BPS / BPS)
    } else {
        c.sv as u128
    };
    let wanted = c.t as u128 + tokens_in as u128;
    let priced_t = if floor_eff == 0 {
        wanted
    } else {
        wanted.min(kk / floor_eff)
    };
    if priced_t == 0 {
        return Err(CurveMathError::Overflow);
    }
    let retired = wanted - priced_t;
    let mut new_eff = ceil_div(kk, priced_t);
    if new_eff < floor_eff {
        new_eff = floor_eff;
    }
    let gross = eff.checked_sub(new_eff).ok_or(CurveMathError::Overflow)?;
    if gross == 0 {
        return Err(CurveMathError::NothingToPay);
    }
    let fee = gross * c.fee_bps as u128 / BPS;
    let net_out = gross - fee;
    let new_sr = (c.sr as u128)
        .checked_sub(net_out + fee)
        .ok_or(CurveMathError::Insolvent)?;
    let new_t = u64::try_from(priced_t).map_err(|_| CurveMathError::Overflow)?;
    let new_surplus =
        u64::try_from(c.surplus as u128 + retired).map_err(|_| CurveMathError::Overflow)?;
    c.sr = new_sr as u64;
    c.t = new_t;
    c.outstanding -= curve_origin;
    c.surplus = new_surplus;
    c.paid_out += net_out;
    Ok(SellOutcome {
        net_out: net_out as u64,
        fee: fee as u64,
        retired: retired as u64,
        curve_origin,
        vault_part,
    })
}

pub fn check_invariants(c: &CurveState) -> CurveResult<()> {
    if c.t == 0 {
        return Err(CurveMathError::BadInit);
    }
    if c.paid_out > c.paid_in {
        return Err(CurveMathError::Insolvent);
    }
    Ok(())
}
