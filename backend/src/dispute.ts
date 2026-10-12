// Reading a `Dispute` account, and the appraiser-name rules the program applies to it
// (docs/contracts/dispute-mediation.md §3, §4).
//
// Revision 2 of mediation removed the appraiser registry, so this is all the backend needs from the
// mediation state: who the parties agreed on, and whether a wallet is bound yet. `POST /api/invites`
// is the only caller — it may issue an invitation only for the company the two parties have actually
// agreed on, and the only way to check that is to hash the name the way the program does and compare
// it with `dispute.agreed_name_hash`.
//
// Same approach as `lease.ts`: no Anchor client, every offset read from the program's own IDL
// through `layout.ts`, and a size/discriminator check so a struct that changed under a stale IDL
// fails loudly at the first request instead of decoding into a plausible wrong answer.
import { createHash } from "node:crypto";
import { getAddressDecoder, getBase64Encoder, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { accountDiscriminator, addressSeed, programDerived, sameDiscriminator } from "./anchor.ts";
import { accountLayout, fieldOffset, type Layout } from "./layout.ts";

const addressDecoder = getAddressDecoder();
const DISPUTE_ACCOUNT = accountDiscriminator("Dispute");

/** `Pubkey::default()`. The all-zero key is how `Dispute` spells "unset"; `propose_appraiser_key` refuses it (`InvalidAppraiserKey`). */
export const UNSET_PUBKEY = "11111111111111111111111111111111";

/** `[b"dispute", lease]` — exists for exactly as long as the lease is in `Mediation`. */
export const disputePda = (lease: Address): Promise<Address> => programDerived("dispute", addressSeed(lease));

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The all-zero 32-byte hash, which is how `Dispute` spells "no name agreed" / "has not picked". */
const UNSET_HASH = "0".repeat(64);

export class DisputeDecodeError extends Error {}
export class DisputeNotFound extends Error {}

export class InvalidAppraiserName extends Error {}

/** `Candidate` is `name[N] + name_len(1) + name_hash(32) + fee(8)`: everything after the name is fixed. */
const CANDIDATE_TAIL = 1 + 32 + 8;

/**
 * The stride of one `Candidate`, which is the gap between the two candidate arrays' own offsets.
 * Derived rather than declared, so `MAX_NAME_LEN` and `MAX_CANDIDATES` only ever live in the program.
 */
const candidateStride = (layout: Layout): number =>
  (fieldOffset(layout, "Dispute", "tenant_candidates") - fieldOffset(layout, "Dispute", "landlord_candidates")) / MAX_CANDIDATES;

/** `MAX_CANDIDATES` — three per side (doc §3); the IDL carries it as the candidate arrays' length. */
export const MAX_CANDIDATES = 3;

/**
 * The program's `MAX_NAME_LEN`, in **bytes** of UTF-8: `display_name` compares `out.len()`, which is
 * a byte count in Rust. Read off `Candidate.name`'s array length rather than written down here, so a
 * program that widens the field does not leave the backend refusing names it now accepts.
 */
export const appraiserNameLimit = (layout: Layout = accountLayout("Dispute")): number => candidateStride(layout) - CANDIDATE_TAIL;

/**
 * A character class from explicit code-point ranges. Written this way rather than as a regex
 * literal full of `\u` escapes because the escapes are the whole content of these three sets: one
 * mistyped digit is a hole, and a literal invisible character pasted into the source is invisible
 * to review as well.
 */
const classOf = (ranges: readonly (readonly [number, number])[]): RegExp =>
  new RegExp(`[${ranges.map(([lo, hi]) => (lo === hi ? `\\u{${lo.toString(16)}}` : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`)).join("")}]`, "u");

/**
 * Unicode `White_Space`, which is what Rust's `str::split_whitespace` splits on — enumerated
 * rather than written as `\s`, because the two sets are not the same and the difference is exactly
 * what this is defending against: JavaScript's `\s` includes U+FEFF (the BOM) and omits U+0085
 * (NEL). Collapsing a BOM here as whitespace, where the program instead keeps it and then rejects
 * it as invisible, would have the backend hashing a name the program never would.
 */
const WHITESPACE_RANGES = [
  [0x09, 0x0d], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680],
  [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
] as const;

/**
 * Unicode format (Cf) and bidi-control code points — the program's `is_invisible` (`state.rs`),
 * range for range. They render as nothing (or reorder what is around them), so two names differing
 * only by one would look identical to a person and hash differently (review G6).
 *
 * Whitespace-class separators (NBSP, U+2028/2029, U+3000…) are deliberately absent: the collapse
 * above has already dealt with them, exactly as the program's comment says.
 */
const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0001, 0xe0001], [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef],
] as const;

/** Rust's `char::is_control`: category Cc, and nothing else. NUL is in here. */
const CONTROL_RANGES = [[0x00, 0x1f], [0x7f, 0x9f]] as const;

// One character, not a run: `split` on it leaves empty strings between adjacent separators, and
// dropping those is what collapses a run to a single space.
const WHITESPACE = classOf(WHITESPACE_RANGES);
const INVISIBLE = classOf(INVISIBLE_RANGES);
const CONTROL = classOf(CONTROL_RANGES);

/**
 * The program's `display_name`: trim, collapse every run of whitespace to one space, then require 1
 * to `MAX_NAME_LEN` **bytes** with no control and no invisible character. The result is the stored
 * display form, and the only thing {@link appraiserNameHash} may be given.
 *
 * This is a reimplementation of on-chain logic, which is a thing worth being nervous about: if it
 * drifts, `POST /api/invites` either refuses a name the parties legitimately agreed on, or accepts
 * one whose hash does not match and the route then rejects it on the comparison anyway. Both fail
 * closed, and `test/dispute.test.ts` pins the edges the program's own `name_validation_edges` test
 * pins.
 */
export function displayAppraiserName(raw: string, limit = appraiserNameLimit()): string {
  const out = raw.split(WHITESPACE).filter((word) => word !== "").join(" ");
  const bytes = Buffer.byteLength(out, "utf8");
  if (out === "") throw new InvalidAppraiserName("the appraiser company name is empty");
  if (bytes > limit) throw new InvalidAppraiserName(`the appraiser company name is ${bytes} bytes of UTF-8, the program's limit is ${limit}`);
  if (CONTROL.test(out)) throw new InvalidAppraiserName("the appraiser company name contains a control character");
  if (INVISIBLE.test(out)) throw new InvalidAppraiserName("the appraiser company name contains an invisible (zero-width, format or bidi) character");
  return out;
}

/**
 * `sha256(ascii_lowercase(display))`, the program's `name_hash`. Hex, lower case.
 *
 * ASCII-only case folding, deliberately: `String.prototype.toLowerCase` is full Unicode and would
 * fold `"WYCENA ŁÓDŹ"`, which the program treats as a different company from `"Wycena Łódź"` (§4).
 */
export const appraiserNameHash = (display: string): string =>
  hex(new Uint8Array(createHash("sha256").update(display.replace(/[A-Z]/g, (c) => c.toLowerCase()), "utf8").digest()));

/** One appraisal company a party proposed. `nameHash` is the only thing the program compares. */
export type Candidate = {
  /** The normalised display form the program stored. */
  name: string;
  nameHash: string;
  /** Base units of the lease's mint. */
  fee: bigint;
};

export type DisputeRecord = {
  lease: Address;
  landlordCandidates: Candidate[];
  tenantCandidates: Candidate[];
  /** Hex `name_hash` of each side's pick, or null while that side has not picked. */
  landlordPick: string | null;
  tenantPick: string | null;
  /** Hex `name_hash` of the agreed company, or null while phase 1 is not done. */
  agreedNameHash: string | null;
  /** The lower of the fees proposed for the agreed company; 0 while nothing is agreed. */
  agreedFee: bigint;
  /** The wallet one party proposed for the agreed company, or null while none is proposed. */
  proposedKey: Address | null;
  /** Which party proposed it; only the other may confirm. Null while nothing is proposed. */
  keyProposer: Address | null;
  landlordKeyProposals: number;
  tenantKeyProposals: number;
  /** The bound wallet, or null while nothing is bound. */
  appraiser: Address | null;
  selectionDeadline: number;
  /** 0 until bound; then `bound_at + VERDICT_WINDOW_SECS`. */
  verdictDeadline: number;
};

export function decodeDispute(data: Uint8Array, layout: Layout = accountLayout("Dispute")): DisputeRecord {
  if (!sameDiscriminator(data, DISPUTE_ACCOUNT)) {
    throw new DisputeDecodeError("this account is not a Dispute: its 8-byte Anchor discriminator does not match");
  }
  if (data.length !== layout.size) {
    throw new DisputeDecodeError(
      `expected a ${layout.size}-byte Dispute account, got ${data.length} bytes. The Dispute struct changed: ` +
        "rebuild the program (target/idl) or update FALLBACK_LAYOUTS in backend/src/layout.ts.",
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (field: string) => fieldOffset(layout, "Dispute", field);
  const address = (offset: number): Address => addressDecoder.decode(data.subarray(offset, offset + 32));
  const hash = (offset: number): string => hex(data.subarray(offset, offset + 32));
  const set = <T>(value: T, unset: T): T | null => (value === unset ? null : value);

  // Only `[..count]` of each array is meaningful; the rest is zero padding the program never reads.
  const stride = candidateStride(layout);
  const nameLimit = stride - CANDIDATE_TAIL;
  const candidates = (field: string, countField: string): Candidate[] => {
    const base = at(field);
    const count = Math.min(data[at(countField)] ?? 0, MAX_CANDIDATES);
    return Array.from({ length: count }, (_, i) => {
      const entry = base + i * stride;
      const len = Math.min(data[entry + nameLimit] ?? 0, nameLimit);
      return {
        name: Buffer.from(data.subarray(entry, entry + len)).toString("utf8"),
        nameHash: hex(data.subarray(entry + nameLimit + 1, entry + nameLimit + 33)),
        fee: view.getBigUint64(entry + nameLimit + 33, true),
      };
    });
  };

  return {
    lease: address(at("lease")),
    landlordCandidates: candidates("landlord_candidates", "landlord_count"),
    tenantCandidates: candidates("tenant_candidates", "tenant_count"),
    landlordPick: set(hash(at("landlord_pick")), UNSET_HASH),
    tenantPick: set(hash(at("tenant_pick")), UNSET_HASH),
    agreedNameHash: set(hash(at("agreed_name_hash")), UNSET_HASH),
    agreedFee: view.getBigUint64(at("agreed_fee"), true),
    proposedKey: set(address(at("proposed_key")), UNSET_PUBKEY as Address),
    keyProposer: set(address(at("key_proposer")), UNSET_PUBKEY as Address),
    landlordKeyProposals: data[at("landlord_key_proposals")] ?? 0,
    tenantKeyProposals: data[at("tenant_key_proposals")] ?? 0,
    appraiser: set(address(at("appraiser")), UNSET_PUBKEY as Address),
    selectionDeadline: Number(view.getBigInt64(at("selection_deadline"), true)),
    verdictDeadline: Number(view.getBigInt64(at("verdict_deadline"), true)),
  };
}

/**
 * The mediation state of a lease, or null when the lease is not in `Mediation` (the account is
 * created by `escalate_to_mediation` and closed on every exit).
 *
 * The owner check is the authorisation that matters, exactly as in `fetchLease`: only the program
 * may own a `Dispute`, so only the program can have written the agreed name an invitation is issued
 * against.
 */
export async function fetchDispute(rpc: Rpc<GetAccountInfoApi>, lease: Address, program: Address): Promise<DisputeRecord | null> {
  const address = await disputePda(lease);
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" }).send();
  if (value === null) return null;
  if (value.owner !== program) throw new DisputeNotFound(`${address} is not a ${program} account`);
  return decodeDispute(new Uint8Array(getBase64Encoder().encode(value.data[0])));
}
