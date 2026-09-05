import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, retuneParams, solToLamports } from './retune.js';

const existing = {
  authority: 'AUTH',
  creatorAuthority: 'CREATOR',
  oraclePubkeys: ['O1', 'O2', 'O3'],
  oracleThreshold: 2,
  relayerPubkey: 'RELAYER',
  treasury: 'TREASURY',
  feeBps: 100,
  creatorShareBps: 1500,
  tokenTotalSupply: 10_000_000_000_000n,
  tokenDecimals: 6,
  defaultVirtualSolReserves: 30_000_000_000n,
  claimDelaySeconds: 172_800n,
  claimPeriodSeconds: 86_400n,
  claimCapPerPeriod: 10,
  claimsThisPeriod: 3,
  claimPeriodStart: 1_700_000_000n,
  oracleEpoch: 4n,
  gradBarLamports: 160_000_000_000n,
  gradBarClaimedLamports: 136_000_000_000n,
  bump: 255
};

test('SOL amounts parse to exact lamports', () => {
  assert.equal(solToLamports('1'), 1_000_000_000n);
  assert.equal(solToLamports('0.85'), 850_000_000n);
  assert.equal(solToLamports('160'), 160_000_000_000n);
  assert.equal(solToLamports('0.000000001'), 1n);
  assert.throws(() => solToLamports('1.0000000001'));
  assert.throws(() => solToLamports('-1'));
  assert.throws(() => solToLamports('abc'));
});

test('a retune carries every role and number forward untouched', () => {
  const params = retuneParams(existing, { gradBarLamports: 1_000_000_000n, gradBarClaimedLamports: 850_000_000n });
  assert.equal(params.creatorAuthority, 'CREATOR');
  assert.equal(params.relayerPubkey, 'RELAYER');
  assert.equal(params.treasury, 'TREASURY');
  assert.deepEqual(params.oraclePubkeys, ['O1', 'O2', 'O3']);
  assert.equal(params.oracleThreshold, 2);
  assert.equal(params.feeBps, 100);
  assert.equal(params.defaultVirtualSolReserves, 30_000_000_000n);
  assert.equal(params.gradBarLamports, 1_000_000_000n);
  assert.equal(params.gradBarClaimedLamports, 850_000_000n);
  assert.deepEqual(changedFields(retuneParams(existing), params), ['gradBarLamports', 'gradBarClaimedLamports']);
});

test('state that is not a parameter never leaks into the arguments', () => {
  const params = retuneParams(existing);
  for (const key of ['authority', 'claimsThisPeriod', 'claimPeriodStart', 'oracleEpoch', 'bump']) {
    assert.equal(key in params, false, key);
  }
  assert.equal(Object.keys(params).length, 15);
});

test('the oracle list is copied, not shared', () => {
  const params = retuneParams(existing);
  params.oraclePubkeys[0] = 'X';
  assert.equal(existing.oraclePubkeys[0], 'O1');
});

test('the program-side bounds on the bars are checked before anything is sent', () => {
  assert.throws(() => retuneParams(existing, { gradBarLamports: 0n }), /at least 1 lamport/);
  assert.throws(() => retuneParams(existing, { gradBarClaimedLamports: 0n }), /between/);
  assert.throws(() => retuneParams(existing, { gradBarLamports: 1_000_000_000n }), /between/);
  assert.doesNotThrow(() =>
    retuneParams(existing, { gradBarLamports: 1_000_000_000n, gradBarClaimedLamports: 1_000_000_000n })
  );
});

test('a misspelled field is an error rather than a no-op', () => {
  assert.throws(() => retuneParams(existing, { gradBar: 1n }), /no parameter gradBar/);
});
