// The off-chain half of the appraiser registry (docs/contracts/dispute-mediation.md §3, §10).
//
// The chain holds one `Appraiser` PDA per company: the wallet that signs verdicts, a fee, an
// `active` flag, an `is_default` flag and `name_hash = sha256(name)`. It deliberately holds no
// strings, so the human-readable directory lives off chain and is served by `GET /api/appraisers`.
// The hash is what keeps that honest: anyone can take a name from the directory, hash it, and check
// it against the registry entry the program wrote.
//
// Everything here is CONFIGURATION, never source. The demo's three firms are fictional
// ("Rzeczoznawca A/B/C") and their keys are ours; a key hard-coded in this file would be a key in
// git, and a name hard-coded here would be a lie on every network whose registry says otherwise.
// `scripts/setup-appraisers.ts` registers exactly what this parses, so the directory and the
// registry come from one source.
import { createHash } from "node:crypto";
import { isAddress, type Address } from "@solana/kit";

/** `Pubkey::default()`. `register_appraiser` refuses it (`InvalidAppraiser`), because the all-zero key is how `Dispute` spells "unset". */
export const UNSET_PUBKEY = "11111111111111111111111111111111";

/**
 * `deposit / APPRAISER_FEE_CAP_DIVISOR` is the per-lease cap on the fee (§6).
 *
 * Mirrors the program's `#[constant]` of the same name. `test/appraisers.test.ts` pins it against
 * `app/idl/relstate.json`, so a change in the program fails there rather than quietly showing the
 * wrong figure in a verdict preview.
 */
export const APPRAISER_FEE_CAP_DIVISOR = 10n;

/** A name long enough to be a sentence is a UI accident, not a company. Nothing on chain cares: the hash is 32 bytes either way. */
export const MAX_APPRAISER_NAME_LENGTH = 64;

const U64_MAX = 18_446_744_073_709_551_615n;

/** Thrown for any unusable `APPRAISERS` value. Names and wallets are public, so the message may quote them. */
export class AppraiserConfigError extends Error {
  constructor(message: string) {
    super(`APPRAISERS: ${message}`);
    this.name = "AppraiserConfigError";
  }
}

export type AppraiserEntry = {
  /** As published, and as hashed. Trimmed of surrounding whitespace first, so the directory and the hash agree. */
  name: string;
  /** The key that signs verdicts, and the `Appraiser` PDA's seed. */
  wallet: Address;
  /** Base units of the lease mint, capped per lease at `deposit / APPRAISER_FEE_CAP_DIVISOR`. */
  fee: bigint;
  /** Eligible for `bind_default_appraiser`. Exactly one entry carries it; see `parseAppraiserDirectory`. */
  isDefault: boolean;
};

/**
 * `sha256(name)`, the 32 bytes the registry stores in `Appraiser.name_hash`.
 *
 * Over the name exactly as the directory publishes it, so the check a third party runs
 * (hash the name from `/api/appraisers`, compare with the chain) is the check this performs.
 */
export const appraiserNameHash = (name: string): Uint8Array => new Uint8Array(createHash("sha256").update(name, "utf8").digest());

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** Base-unit integer from a config value, accepting a string (preferred) or a whole number. */
function parseFee(value: unknown, where: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new AppraiserConfigError(`${where}: fee ${value} is not a whole number of base units (quote it as a string for large values)`);
    value = String(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppraiserConfigError(`${where}: fee is required, as a base-unit integer string (e.g. "2000000" for 2 USDC at 6 decimals)`);
  }
  // Digits only: BigInt() would also take "0x10", "0b1" and "0o7", which an operator did not mean as 16, 1, 7.
  const text = value.trim();
  if (/^-\d+$/.test(text)) throw new AppraiserConfigError(`${where}: fee cannot be negative`);
  if (!/^\d+$/.test(text)) throw new AppraiserConfigError(`${where}: fee "${value}" is not an integer (digits only)`);
  const fee = BigInt(text);
  if (fee > U64_MAX) throw new AppraiserConfigError(`${where}: fee does not fit in a u64`);
  return fee;
}

/**
 * Parses the `APPRAISERS` directory: a JSON array of
 * `{ name, wallet, fee, default? }`. A blank value is an unconfigured directory, not an error —
 * that is what lets the backend boot in a fresh clone with no registry.
 *
 * **Exactly one entry must carry `default: true`** whenever the directory is non-empty. The program
 * cannot enforce that (there is no on-chain index to iterate, §4), so it is enforced here, where
 * both the route and the setup script read it: that is the only place the invariant can hold before
 * a transaction is sent.
 */
export function parseAppraiserDirectory(raw: string | undefined): AppraiserEntry[] {
  const text = (raw ?? "").trim();
  if (text === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echoes `text`: it is operator-supplied and a truncated paste is unreadable anyway.
    throw new AppraiserConfigError('not valid JSON. Expected a JSON array, e.g. [{"name":"Rzeczoznawca A","wallet":"<base58>","fee":"2000000","default":true}]');
  }
  if (!Array.isArray(parsed)) throw new AppraiserConfigError("must be a JSON array of appraiser objects");

  const entries: AppraiserEntry[] = [];
  for (const [index, item] of parsed.entries()) {
    const where = `entry ${index}`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AppraiserConfigError(`${where}: expected an object with name, wallet and fee`);
    }
    const fields = item as Record<string, unknown>;

    if (typeof fields.name !== "string" || fields.name.trim() === "") throw new AppraiserConfigError(`${where}: name is required`);
    const name = fields.name.trim();
    if (name.length > MAX_APPRAISER_NAME_LENGTH) {
      throw new AppraiserConfigError(`${where}: name is ${name.length} characters, cap is ${MAX_APPRAISER_NAME_LENGTH}`);
    }

    if (typeof fields.wallet !== "string" || !isAddress(fields.wallet)) {
      throw new AppraiserConfigError(`${where} (${name}): wallet must be a base58 address, got ${JSON.stringify(fields.wallet)}`);
    }
    if (fields.wallet === UNSET_PUBKEY) {
      throw new AppraiserConfigError(`${where} (${name}): wallet cannot be the all-zero key; the program refuses it (InvalidAppraiser)`);
    }

    if (fields.default !== undefined && typeof fields.default !== "boolean") {
      throw new AppraiserConfigError(`${where} (${name}): default must be true or false`);
    }

    entries.push({ name, wallet: fields.wallet, fee: parseFee(fields.fee, `${where} (${name})`), isDefault: fields.default === true });
  }

  // A repeated wallet would mean two directory names for one registry entry, and a repeated name
  // two entries with the same `name_hash`: in both cases the directory stops identifying anything.
  for (const [field, of] of [["wallet", (e: AppraiserEntry) => e.wallet], ["name", (e: AppraiserEntry) => e.name]] as const) {
    const seen = new Set<string>();
    for (const entry of entries) {
      const value = of(entry);
      if (seen.has(value)) throw new AppraiserConfigError(`${field} ${value} appears twice`);
      seen.add(value);
    }
  }

  const defaults = entries.filter((e) => e.isDefault);
  if (defaults.length !== 1) {
    throw new AppraiserConfigError(
      defaults.length === 0
        ? 'exactly one entry must carry "default": true — it is the appraiser bind_default_appraiser falls back to when the two sides never agree'
        : `exactly one entry may carry "default": true, but ${defaults.length} do (${defaults.map((e) => e.name).join(", ")}). The program cannot enforce uniqueness, so keep one`,
    );
  }
  return entries;
}

/** The entry flagged default, or undefined for an unconfigured directory. */
export const defaultAppraiser = (entries: readonly AppraiserEntry[]): AppraiserEntry | undefined => entries.find((e) => e.isDefault);

/**
 * Key specs for the demo appraiser console, **semicolon**-separated.
 *
 * Semicolons rather than commas because a key spec may itself be an inline JSON byte array, which
 * is full of commas. Each spec is a path, an inline array or a base58 secret — `keys.ts` decides
 * which without touching the filesystem, so a secret here never reaches an error message.
 */
export const parseKeySpecs = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(";")
    .map((spec) => spec.trim())
    .filter((spec) => spec !== "");
