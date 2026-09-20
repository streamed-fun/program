//! Golden fixtures for the JavaScript transaction builder (js/tx.js).
//! The JS side hand-rolls PDAs and legacy transaction serialization with no
//! Solana dependency, so these tests pin the exact bytes the real SDK
//! produces for deterministic inputs; js/tx.test.js asserts the same
//! values. If either side drifts, one of the two suites goes red.

use solana_sdk::{
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{keypair_from_seed, Signer},
    system_instruction,
    transaction::Transaction,
};

mod common;

/// The claim message and the Ed25519 instruction, pinned against
/// js/claim.test.js. Same deterministic keys on both sides: destination from
/// seed 9, oracles from seeds 5 and 6, and Ed25519 signatures are
/// deterministic, so the bytes match exactly or something drifted.
#[test]
fn claim_message_bytes_match_the_js_side() {
    let destination = keypair_from_seed(&[9u8; 32]).unwrap().pubkey();
    let message = streamed_coin::claim_message(4242, &destination, 1_700_000_000, 3);
    let hex: String = message.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "9210000000000000fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61800f1536500000000030000000000000024898889896884b95dec034b882336013e6bb60c7df01b2a5cad39acc0a5cdf2");
}

#[test]
fn a_single_signer_ed25519_instruction_is_the_sdk_layout() {
    let destination = keypair_from_seed(&[9u8; 32]).unwrap().pubkey();
    let oracle = keypair_from_seed(&[5u8; 32]).unwrap();
    let message = streamed_coin::claim_message(4242, &destination, 1_700_000_000, 3);
    // The SDK's own constructor, which is what every other Solana client
    // produces for one signature; ours must be byte-identical to it.
    let sdk = solana_sdk::ed25519_instruction::new_ed25519_instruction_with_signature(
        &message,
        &oracle.sign_message(&message).into(),
        &oracle.pubkey().to_bytes(),
    );
    let ours = common::ed25519_ix(&message, &[&oracle]);
    assert_eq!(ours.program_id, sdk.program_id);
    assert_eq!(ours.data, sdk.data);
}

#[test]
fn a_two_signer_ed25519_instruction_matches_the_js_side() {
    let destination = keypair_from_seed(&[9u8; 32]).unwrap().pubkey();
    let a = keypair_from_seed(&[5u8; 32]).unwrap();
    let b = keypair_from_seed(&[6u8; 32]).unwrap();
    let message = streamed_coin::claim_message(4242, &destination, 1_700_000_000, 3);
    let ix = common::ed25519_ix(&message, &[&a, &b]);
    let hex: String = ix.data.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "02003e00ffff1e00ffffde005800ffff9e00ffff7e00ffffde005800ffff6e7a1cdd29b0b78fd13af4c5598feff4ef2a97166e3ca6f2e4fbfccd80505bf11f4cb0b5d26763eeda60842030c2a5b54713420d1a6f1d51620251adcbdf2bb7d3ff16dc4cb897a1cdb25ba2b61566d07733da7ac7978d4535480454df9665048a875fff1eb38451577acd5afee405456568dd7c89e090863a0557bc7af49f177bfa2c0428e115a3e33e3278bdf0f78fd3a39f1fe5ea262af97b7a27f18fe0028821318fd827f4e90a949c359d9b8475a6d3389051156ffb1cf8e2cb60a7eb039210000000000000fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61800f1536500000000030000000000000024898889896884b95dec034b882336013e6bb60c7df01b2a5cad39acc0a5cdf2");
}

#[test]
fn pda_fixtures_match_the_js_side() {
    let program: Pubkey = streamed_coin::ID;
    let (global, _) = Pubkey::find_program_address(&[b"global"], &program);
    let kid = 4242u64.to_le_bytes();
    let (curve, curve_bump) = Pubkey::find_program_address(&[b"curve", &kid], &program);
    let (sol_vault, _) = Pubkey::find_program_address(&[b"sol_vault", &kid], &program);
    let (event_authority, _) = Pubkey::find_program_address(&[b"__event_authority"], &program);
    // Every one of these moved when the program id was regenerated on
    // PDAs are derived from it, so a new id is a new address
    // space. The bump moved with them (255 to 254), which is the sort of thing
    // that is only obvious when it is asserted.
    assert_eq!(global.to_string(), "F8ASxDoxa3bhuxVo2mYFeiofMgKF1gmVHgqGHPNYHKBY");
    assert_eq!(curve.to_string(), "HrZGLynwphZuhk45AVwTNU9AL6nDLJ2cwmDdEdwrAzFS");
    assert_eq!(curve_bump, 255);
    assert_eq!(sol_vault.to_string(), "HHZm95h9329qzTu9yrEdP4BKfXJ6fcPYbLQoDbaLuFm4");
    assert_eq!(event_authority.to_string(), "GVaqfKhSWJJELuPru9nPrrGqJjabot4gwaAw3SSg8zyj");
}

#[test]
fn transaction_bytes_match_the_js_side() {
    let payer = keypair_from_seed(&[7u8; 32]).unwrap();
    let to = keypair_from_seed(&[9u8; 32]).unwrap();
    assert_eq!(payer.pubkey().to_string(), "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
    let blockhash = Hash::new_from_array([3u8; 32]);
    let ix = system_instruction::transfer(&payer.pubkey(), &to.pubkey(), 1_234_567);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
    let bytes = bincode::serialize(&tx).unwrap();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "01a591caceb1dd1ee85942af3a63cd119a0fdc18c665e292ab5662eeb526fd16b6cb114f6cfa59b39af1f3fbae8948f313f6df0f6e8fbf1a486afcc4ae063ab90a01000103ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22cfd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f6180000000000000000000000000000000000000000000000000000000000000000030303030303030303030303030303030303030303030303030303030303030301020200010c0200000087d6120000000000");
}

#[test]
fn multi_account_transaction_bytes_match_the_js_side() {
    let payer = keypair_from_seed(&[7u8; 32]).unwrap();
    let second = keypair_from_seed(&[8u8; 32]).unwrap();
    let program = Pubkey::new_from_array([11u8; 32]);
    let ro = Pubkey::new_from_array([12u8; 32]);
    let rw = Pubkey::new_from_array([13u8; 32]);
    let blockhash = Hash::new_from_array([3u8; 32]);
    let ix = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new_readonly(ro, false),
            AccountMeta::new(rw, false),
            AccountMeta::new(second.pubkey(), true),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
        data: vec![1, 2, 3, 4, 5],
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &second],
        blockhash,
    );
    let bytes = bincode::serialize(&tx).unwrap();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "026514f137ad99a1a1ba45875dfbe480c8256e89989d6927ad5358c0fdd792c13e5b7b2c51918877f85a6bbfb557df0ffe25106f9da74df545086874b257f96e0435ecec00a774d344730427e8750cf10c74d6e300d6142a392416c6f4d832e0a88f75c3557b484b2209a8c75f4e1c5701b5a70a229e3e9a5ca1ab425bcd52d60802000205ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c1398f62c6d1a457c51ba6a4b5f3dbd2f69fca93216218dc8997e416bd17d93ca0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c030303030303030303030303030303030303030303030303030303030303030301030404020100050102030405");
}
