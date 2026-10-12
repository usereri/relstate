// Identity attestations: the chain's half of KYC (docs/contracts/attestation.md).
//
// The whole design is one sentence: a vendor decides who someone is, the backend turns that into
// a hash and a level, and the program stores it under a PDA keyed by the wallet, signed by a key
// that does nothing else. Three properties are worth stating explicitly, because each is a
// deliberate choice rather than an accident of the implementation:
//
//   * the **issuer key is not the fee payer key**. The fee payer co-signs whatever a user builds
//     (see `/api/sponsor`), so if it could also vouch for identity, a crafted sponsored
//     transaction would be able to attest its own wallet. Here the fee payer pays rent and
//     nothing more, and an attestation without the issuer's own signature does not exist;
//   * **no personal data touches the chain**. `subject_hash` is `sha256(applicant_id || salt)`,
//     computed server-side with a salt we never publish (docs/privacy.md);
//   * the gate is **off by default** (`Config::require_kyc`). A fresh network, the local test
//     suite and the `demo` build all work with no identity layer at all, and the devnet demo
//     deploy turns it on.
use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct Attest<'info> {
    /// Pays the attestation account's rent and the transaction fee. Separate from `issuer` so the
    /// backend's sponsor key can fund the write while only the issuer key authorises it; passing
    /// the same key for both is allowed, it simply means that key does both jobs.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = config.issuer == issuer.key() @ ErrorCode::NotIssuer)]
    pub issuer: Signer<'info>,
    /// CHECK: the wallet being attested. Only its key is used — as the PDA seed and as a stored
    /// field — so it needs no type and never signs: KYC is granted *to* a wallet, not asked for
    /// by one.
    pub wallet: UncheckedAccount<'info>,
    /// Init-or-update, so re-verifying a wallet (a new level, a fresh expiry, or a comeback after
    /// a revocation) is the same instruction as verifying it the first time. The seeds pin it to
    /// `wallet`, and every field is overwritten below, so there is nothing a second call can
    /// leave half-set.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [ATTESTATION_SEED, wallet.key().as_ref()],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attest(
    ctx: Context<Attest>,
    level: u8,
    expires_at: i64,
    subject_hash: [u8; 32],
) -> Result<()> {
    // Unreachable through the account constraint (nobody holds the all-zero key), but an
    // unconfigured issuer deserves this error rather than a confusing signature failure.
    require_keys_neq!(
        ctx.accounts.config.issuer,
        Pubkey::default(),
        ErrorCode::IssuerNotSet
    );
    require!(
        (KYC_LEVEL_BASIC..=KYC_LEVEL_ENHANCED).contains(&level),
        ErrorCode::InvalidAttestationLevel
    );
    require!(
        subject_hash != [0u8; 32],
        ErrorCode::InvalidSubjectHash
    );

    let now = Clock::get()?.unix_timestamp;
    // An already-expired attestation would pass the gate nowhere and read as "verified" in the
    // UI's raw fields, so it is an operator mistake worth refusing at the door.
    require!(
        expires_at == 0 || expires_at > now,
        ErrorCode::AttestationExpiryInPast
    );

    let attestation = &mut ctx.accounts.attestation;
    attestation.wallet = ctx.accounts.wallet.key();
    attestation.issuer = ctx.accounts.issuer.key();
    attestation.level = level;
    attestation.verified_at = now;
    attestation.expires_at = expires_at;
    // A re-attestation clears an earlier revocation: someone who was revoked and then passes the
    // check again is verified again, and only the issuer can do that.
    attestation.revoked = false;
    attestation.subject_hash = subject_hash;
    attestation.bump = ctx.bumps.attestation;

    emit!(Attested {
        wallet: attestation.wallet,
        level,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = config.issuer == issuer.key() @ ErrorCode::NotIssuer)]
    pub issuer: Signer<'info>,
    /// CHECK: the attested wallet. Only its key is used, as the PDA seed.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ATTESTATION_SEED, wallet.key().as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, Attestation>,
}

/// Marks the attestation revoked, leaving the record in place: the account still says a check was
/// passed and then withdrawn, which is more useful to a landlord — and to us — than a hole where
/// an account used to be. Idempotent, so a repeated vendor "rejected" event is harmless.
pub fn handle_revoke(ctx: Context<Revoke>) -> Result<()> {
    let attestation = &mut ctx.accounts.attestation;
    attestation.revoked = true;
    emit!(AttestationRevoked {
        wallet: attestation.wallet,
    });
    Ok(())
}

/// The gate `apply` and `propose_lease` sit behind. A no-op unless the config says otherwise.
///
/// `attestation` arrives as a raw `AccountInfo` rather than a typed `Account`, because the most
/// common failure is that the account does not exist at all: an unverified wallet has nothing at
/// that address, and the caller deserves `KycRequired` — which the app can turn into "verify your
/// identity first" — rather than Anchor's `AccountNotInitialized`. The address itself is still
/// pinned by the `seeds` constraint on the calling instruction, so a caller cannot point this at
/// someone else's attestation.
pub fn enforce_kyc(
    config: &Config,
    attestation: &AccountInfo,
    wallet: &Pubkey,
    now: i64,
) -> Result<()> {
    if !config.require_kyc {
        return Ok(());
    }
    require!(
        attestation_is_valid(config, attestation, wallet, now)?,
        ErrorCode::KycRequired
    );
    Ok(())
}

/// Reads the account by hand and answers one question: does this wallet currently hold a valid
/// attestation? Every way of failing — no account, foreign owner, unreadable data, wrong subject,
/// an issuer that has since been rotated out, level 0, revoked, expired — answers `false`, so the
/// caller has exactly one error to report and an attacker learns nothing from which one it was.
fn attestation_is_valid(
    config: &Config,
    info: &AccountInfo,
    wallet: &Pubkey,
    now: i64,
) -> Result<bool> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(false);
    }
    let data = info.try_borrow_data()?;
    let Ok(attestation) = Attestation::try_deserialize(&mut &data[..]) else {
        return Ok(false);
    };
    Ok(attestation.is_valid(wallet, &config.issuer, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000;

    fn config(issuer: Pubkey, require_kyc: bool) -> Config {
        Config {
            admin: Pubkey::new_unique(),
            bump: 255,
            mints: vec![],
            issuer,
            require_kyc,
        }
    }

    fn attestation(wallet: Pubkey, issuer: Pubkey) -> Attestation {
        Attestation {
            wallet,
            issuer,
            level: KYC_LEVEL_BASIC,
            verified_at: NOW - 60,
            expires_at: NOW + 60,
            revoked: false,
            subject_hash: [7u8; 32],
            bump: 255,
        }
    }

    #[test]
    fn accepts_a_current_attestation() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        assert!(attestation(wallet, issuer).is_valid(&wallet, &issuer, NOW));
    }

    /// 0 means "no KYC" and is refused at `attest`, but a record carrying it must not pass the
    /// gate either. Enhanced (2) clears a check that only asks for basic.
    #[test]
    fn requires_at_least_basic_level() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        for (level, ok) in [(0u8, false), (KYC_LEVEL_BASIC, true), (KYC_LEVEL_ENHANCED, true)] {
            let mut a = attestation(wallet, issuer);
            a.level = level;
            assert_eq!(a.is_valid(&wallet, &issuer, NOW), ok, "level {level}");
        }
    }

    #[test]
    fn rejects_a_revoked_attestation() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut a = attestation(wallet, issuer);
        a.revoked = true;
        assert!(!a.is_valid(&wallet, &issuer, NOW));
    }

    /// Expiry is strict: the instant it names is already past it. Zero never expires, which is
    /// what `attest` writes when the caller asks for no expiry at all.
    #[test]
    fn rejects_an_expired_attestation_and_accepts_a_permanent_one() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut a = attestation(wallet, issuer);
        a.expires_at = NOW;
        assert!(!a.is_valid(&wallet, &issuer, NOW));
        a.expires_at = NOW + 1;
        assert!(a.is_valid(&wallet, &issuer, NOW));
        a.expires_at = 0;
        assert!(a.is_valid(&wallet, &issuer, NOW));
    }

    /// Rotating the issuer in the config invalidates everything the old key signed, without
    /// having to walk the accounts it wrote.
    #[test]
    fn rejects_an_attestation_from_a_rotated_out_issuer() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        let a = attestation(wallet, issuer);
        assert!(!a.is_valid(&wallet, &Pubkey::new_unique(), NOW));
    }

    /// The seeds pin the account to one wallet, so this is belt and braces — but the stored
    /// subject is what the gate actually compares, and a mismatch must never pass.
    #[test]
    fn rejects_an_attestation_for_another_wallet() {
        let (wallet, issuer) = (Pubkey::new_unique(), Pubkey::new_unique());
        let a = attestation(wallet, issuer);
        assert!(!a.is_valid(&Pubkey::new_unique(), &issuer, NOW));
    }

    /// The flag is the whole compatibility story: with it off, the gate asks nothing of an
    /// account that is not there, which is why the existing suite stays green.
    #[test]
    fn the_gate_is_inert_while_require_kyc_is_false() {
        let wallet = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data: [u8; 0] = [];
        let owner = Pubkey::default();
        let missing = AccountInfo::new(
            &wallet, false, false, &mut lamports, &mut data, &owner, false,
        );
        let issuer = Pubkey::new_unique();
        assert!(enforce_kyc(&config(issuer, false), &missing, &wallet, NOW).is_ok());
        assert!(enforce_kyc(&config(issuer, true), &missing, &wallet, NOW).is_err());
    }

    /// An attestation account that exists but is owned by someone else is not ours to trust:
    /// another program could otherwise mint identity by writing the same layout.
    #[test]
    fn a_foreign_owned_account_is_not_an_attestation() {
        let wallet = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let cfg = config(issuer, true);
        let mut buffer = Vec::new();
        attestation(wallet, issuer)
            .try_serialize(&mut buffer)
            .unwrap();

        let key = Pubkey::new_unique();
        let mut lamports = 1u64;
        let ours = crate::ID;
        let theirs = Pubkey::new_unique();
        {
            let mut data = buffer.clone();
            let info = AccountInfo::new(
                &key, false, false, &mut lamports, &mut data, &ours, false,
            );
            assert!(attestation_is_valid(&cfg, &info, &wallet, NOW).unwrap());
        }
        let mut data = buffer;
        let info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut data, &theirs, false,
        );
        assert!(!attestation_is_valid(&cfg, &info, &wallet, NOW).unwrap());
    }

    /// A buffer with the wrong discriminator (another of this program's accounts, say) must read
    /// as "no attestation" rather than as whatever the bytes happen to mean.
    #[test]
    fn a_wrong_discriminator_is_not_an_attestation() {
        let wallet = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let cfg = config(issuer, true);
        let mut buffer = Vec::new();
        attestation(wallet, issuer)
            .try_serialize(&mut buffer)
            .unwrap();
        buffer[0] ^= 0xff;

        let key = Pubkey::new_unique();
        let mut lamports = 1u64;
        let ours = crate::ID;
        let info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut buffer, &ours, false,
        );
        assert!(!attestation_is_valid(&cfg, &info, &wallet, NOW).unwrap());
    }
}
