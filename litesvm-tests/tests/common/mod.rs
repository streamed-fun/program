//! Shared by the fixture and program suites: the Ed25519 program instruction
//! laid out the way `js/claim.js` lays it out and the way `lib.rs` parses it.
//! Any number of signers over one message; every instruction index is
//! `u16::MAX`, "this instruction".

use solana_sdk::{
    instruction::Instruction,
    signature::{Keypair, Signer},
};

#[allow(dead_code)]
pub fn ed25519_ix(message: &[u8], signers: &[&Keypair]) -> Instruction {
    let n = signers.len();
    let header = 2 + 14 * n;
    let msg_off = header + 96 * n;
    let mut data = vec![0u8; msg_off + message.len()];
    data[0] = n as u8;
    let put = |d: &mut Vec<u8>, at: usize, v: u16| d[at..at + 2].copy_from_slice(&v.to_le_bytes());
    for (i, kp) in signers.iter().enumerate() {
        let pk_off = header + 96 * i;
        let sig_off = pk_off + 32;
        let rec = 2 + 14 * i;
        put(&mut data, rec, sig_off as u16);
        put(&mut data, rec + 2, u16::MAX);
        put(&mut data, rec + 4, pk_off as u16);
        put(&mut data, rec + 6, u16::MAX);
        put(&mut data, rec + 8, msg_off as u16);
        put(&mut data, rec + 10, message.len() as u16);
        put(&mut data, rec + 12, u16::MAX);
        data[pk_off..pk_off + 32].copy_from_slice(kp.pubkey().as_ref());
        data[sig_off..sig_off + 64].copy_from_slice(kp.sign_message(message).as_ref());
    }
    data[msg_off..].copy_from_slice(message);
    Instruction {
        program_id: solana_sdk::ed25519_program::id(),
        accounts: vec![],
        data,
    }
}
