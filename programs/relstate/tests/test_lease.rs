use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{clock::Clock, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    litesvm_token::{
        get_spl_account, spl_token, CreateAssociatedTokenAccount, CreateMint, MintTo, TOKEN_ID,
    },
    relstate::{constants::*, state::*},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const RENT: u64 = 1_000;
const DEPOSIT: u64 = 2_000;
const PERIOD: i64 = 100;
const TERM: u16 = 3;
const START_BALANCE: u64 = 10_000;

struct Env {
    svm: LiteSVM,
    landlord: Keypair,
    tenant: Keypair,
    mint: Pubkey,
    landlord_ata: Pubkey,
    tenant_ata: Pubkey,
    lease: Pubkey,
    vault: Pubkey,
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn profile_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PROFILE_SEED, wallet.as_ref()], &relstate::id()).0
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/relstate.so"
        ));
        svm.add_program(relstate::id(), bytes).unwrap();

        let landlord = Keypair::new();
        let tenant: Keypair = Keypair::new();
        svm.airdrop(&landlord.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&tenant.pubkey(), 10_000_000_000).unwrap();

        let mint = CreateMint::new(&mut svm, &landlord)
            .decimals(6)
            .send()
            .unwrap();
        let landlord_ata = CreateAssociatedTokenAccount::new(&mut svm, &landlord, &mint)
            .owner(&landlord.pubkey())
            .send()
            .unwrap();
        let tenant_ata = CreateAssociatedTokenAccount::new(&mut svm, &tenant, &mint)
            .owner(&tenant.pubkey())
            .send()
            .unwrap();
        MintTo::new(&mut svm, &landlord, &mint, &tenant_ata, START_BALANCE)
            .send()
            .unwrap();

        let lease = Pubkey::find_program_address(
            &[LEASE_SEED, landlord.pubkey().as_ref(), &1u64.to_le_bytes()],
            &relstate::id(),
        )
        .0;
        let vault = Pubkey::find_program_address(&[VAULT_SEED, lease.as_ref()], &relstate::id()).0;

        Env {
            svm,
            landlord,
            tenant,
            mint,
            landlord_ata,
            tenant_ata,
            lease,
            vault,
        }
    }

    fn create_ix(&self) -> Instruction {
        Instruction::new_with_bytes(
            relstate::id(),
            &relstate::instruction::CreateLease {
                lease_id: 1,
                rent_amount: RENT,
                deposit_amount: DEPOSIT,
                period_secs: PERIOD,
                term_periods: TERM,
                lease_hash: [7; 32],
            }
            .data(),
            relstate::accounts::CreateLease {
                landlord: self.landlord.pubkey(),
                tenant: self.tenant.pubkey(),
                mint: self.mint,
                lease: self.lease,
                vault: self.vault,
                landlord_profile: profile_pda(&self.landlord.pubkey()),
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn fund_ix(&self) -> Instruction {
        Instruction::new_with_bytes(
            relstate::id(),
            &relstate::instruction::FundDeposit {}.data(),
            relstate::accounts::FundDeposit {
                tenant: self.tenant.pubkey(),
                lease: self.lease,
                mint: self.mint,
                vault: self.vault,
                tenant_ata: self.tenant_ata,
                tenant_profile: profile_pda(&self.tenant.pubkey()),
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn pay_ix(&self) -> Instruction {
        Instruction::new_with_bytes(
            relstate::id(),
            &relstate::instruction::PayRent {}.data(),
            relstate::accounts::PayRent {
                tenant: self.tenant.pubkey(),
                lease: self.lease,
                mint: self.mint,
                tenant_ata: self.tenant_ata,
                landlord_ata: self.landlord_ata,
                tenant_profile: profile_pda(&self.tenant.pubkey()),
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        )
    }

    fn release_ix(&self, signer: Pubkey, deduction: u64) -> Instruction {
        Instruction::new_with_bytes(
            relstate::id(),
            &relstate::instruction::ReleaseDeposit { deduction }.data(),
            relstate::accounts::ReleaseDeposit {
                landlord: signer,
                lease: self.lease,
                mint: self.mint,
                vault: self.vault,
                tenant_ata: self.tenant_ata,
                landlord_ata: self.landlord_ata,
                tenant_profile: profile_pda(&self.tenant.pubkey()),
                landlord_profile: profile_pda(&self.landlord.pubkey()),
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        )
    }

    fn create(&mut self) -> Result<(), String> {
        let ix = self.create_ix();
        send(&mut self.svm, ix, &self.landlord)
    }

    fn fund(&mut self) -> Result<(), String> {
        let ix = self.fund_ix();
        send(&mut self.svm, ix, &self.tenant)
    }

    fn pay(&mut self) -> Result<(), String> {
        let ix = self.pay_ix();
        send(&mut self.svm, ix, &self.tenant)
    }
    fn release(&mut self, deduction: u64) -> Result<(), String> {
        let ix = self.release_ix(self.landlord.pubkey(), deduction);
        send(&mut self.svm, ix, &self.landlord)
    }

    fn active(&mut self) {
        self.create().unwrap();
        self.fund().unwrap();
    }
    fn fully_paid(&mut self) {
        self.active();
        for _ in 0..TERM {
            self.pay().unwrap();
        }
    }

    fn balance(&self, ata: &Pubkey) -> u64 {
        get_spl_account::<spl_token::state::Account>(&self.svm, ata)
            .unwrap()
            .amount
    }
    fn lease_state(&self) -> Lease {
        let data = self.svm.get_account(&self.lease).unwrap().data;
        Lease::try_deserialize(&mut data.as_slice()).unwrap()
    }
    fn profile(&self, wallet: &Pubkey) -> Profile {
        let data = self.svm.get_account(&profile_pda(wallet)).unwrap().data;
        Profile::try_deserialize(&mut data.as_slice()).unwrap()
    }
}

fn assert_fails(res: Result<(), String>, code: &str) {
    let err = res.expect_err("expected the transaction fail");
    assert!(err.contains(code), "expected {code}, got: {err}");
}

#[test]
fn happy_path_builds_track_record() {
    let mut env = Env::new();
    env.fully_paid();

    // rent straight to the landlord, deposit sits in the vault
    assert_eq!(env.balance(&env.landlord_ata), 3 * RENT);
    assert_eq!(env.balance(&env.vault), DEPOSIT);
    assert_eq!(
        env.balance(&env.tenant_ata),
        START_BALANCE - DEPOSIT - 3 * RENT
    );

    env.release(0).unwrap();

    assert_eq!(env.balance(&env.vault), 0);
    assert_eq!(env.balance(&env.tenant_ata), START_BALANCE - 3 * RENT);
    assert!(env.lease_state().status == Status::Closed);

    let t = env.profile(&env.tenant.pubkey());
    assert_eq!((t.leases_completed, t.paid_on_time, t.paid_late), (1, 3, 0));
    assert_eq!((t.deposits_returned_full, t.deposits_withheld), (1, 0));
    let l = env.profile(&env.landlord.pubkey());
    assert_eq!((l.leases_completed, l.deposits_returned_full), (1, 1));
}

#[test]
fn deduction_is_paid_to_landlord_and_recorded() {
    let mut env = Env::new();
    env.fully_paid();
    env.release(500).unwrap();

    assert_eq!(env.balance(&env.tenant_ata), START_BALANCE - 3 * RENT - 500);
    assert_eq!(env.balance(&env.landlord_ata), 3 * RENT + 500);
    let t = env.profile(&env.tenant.pubkey());
    assert_eq!((t.deposits_returned_full, t.deposits_withheld), (0, 1));
}

#[test]
fn late_payment_is_counted() {
    let mut env = Env::new();
    env.active();

    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp += 1_000;
    env.svm.set_sysvar(&clock);
    env.pay().unwrap();

    let t = env.profile(&env.tenant.pubkey());
    assert_eq!((t.paid_on_time, t.paid_late), (0, 1));
}

#[test]
fn cannot_fund_twice() {
    let mut env = Env::new();
    env.active();
    assert_fails(env.fund(), "WrongStatus");
}

#[test]
fn cannot_pay_before_funding() {
    let mut env = Env::new();
    env.create().unwrap();
    // fails before the handler runs: the tenant profile doesn't exist until fund_deposit
    assert!(env.pay().is_err());
}

#[test]
fn cannot_overpay_the_term() {
    let mut env = Env::new();
    env.fully_paid();
    assert_fails(env.pay(), "TermCompleted");
}

#[test]
fn cannot_release_before_term_is_paid() {
    let mut env = Env::new();
    env.active();
    env.pay().unwrap();
    assert_fails(env.release(0), "TermIncomplete");
}

#[test]
fn cannot_deduct_more_than_deposit() {
    let mut env = Env::new();
    env.fully_paid();
    assert_fails(env.release(DEPOSIT + 1), "DeductionTooLarge");
}

#[test]
fn tenant_cannot_release_the_deposit() {
    let mut env = Env::new();
    env.fully_paid();
    let ix = env.release_ix(env.tenant.pubkey(), 0);
    assert!(send(&mut env.svm, ix, &env.tenant).is_err());
    assert_eq!(env.balance(&env.vault), DEPOSIT);
}
