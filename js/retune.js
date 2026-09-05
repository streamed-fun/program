// Building update_global arguments from a decoded Global, so a retune carries
// every current value forward and changes only what was asked for. The
// instruction takes the full parameter set, which means a caller that fills the
// unmentioned fields from defaults silently rotates the creator authority, the
// relayer and the treasury to whatever those defaults are.

export const LAMPORTS_PER_SOL = 1_000_000_000n;

const PARAM_FIELDS = [
  'creatorAuthority',
  'oraclePubkeys',
  'oracleThreshold',
  'relayerPubkey',
  'treasury',
  'feeBps',
  'creatorShareBps',
  'tokenTotalSupply',
  'tokenDecimals',
  'defaultVirtualSolReserves',
  'claimDelaySeconds',
  'claimPeriodSeconds',
  'claimCapPerPeriod',
  'gradBarLamports',
  'gradBarClaimedLamports'
];

/// Parse a SOL amount written as a decimal string ("1", "0.85", "160") into
/// lamports exactly, with no float in between.
export function solToLamports(text) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a SOL amount: ${JSON.stringify(text)}`);
  const whole = BigInt(m[1]) * LAMPORTS_PER_SOL;
  const frac = m[2] ? BigInt(m[2].padEnd(9, '0')) : 0n;
  return whole + frac;
}

/// The update_global params for `existing` with `overrides` applied. Only the
/// fields named in `overrides` change; an override of an unknown field throws
/// rather than being dropped on the floor.
export function retuneParams(existing, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!PARAM_FIELDS.includes(key)) throw new Error(`update_global has no parameter ${key}`);
  }
  const params = {};
  for (const key of PARAM_FIELDS) {
    params[key] = key in overrides ? overrides[key] : existing[key];
  }
  params.oraclePubkeys = [...params.oraclePubkeys];
  if (params.gradBarLamports < 1n) throw new Error('graduation bar must be at least 1 lamport');
  if (params.gradBarClaimedLamports < 1n || params.gradBarClaimedLamports > params.gradBarLamports) {
    throw new Error('claimed graduation bar must be between 1 lamport and the unclaimed bar');
  }
  return params;
}

/// The fields whose value differs between two param sets, for printing.
export function changedFields(before, after) {
  const out = [];
  for (const key of PARAM_FIELDS) {
    const a = before[key];
    const b = after[key];
    const same = Array.isArray(a) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
    if (!same) out.push(key);
  }
  return out;
}
