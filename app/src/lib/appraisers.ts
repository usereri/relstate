// The appraiser directory, app half (docs/contracts/dispute-mediation.md §3).
//
// The chain holds no strings: an `Appraiser` entry carries `sha256(company name)` and nothing else
// about who they are, so the human-readable directory lives off chain at `GET /api/appraisers`.
// Because the hash is a commitment, the app does not have to *trust* that directory — it can check
// it, which is the whole reason the hash is on chain. A name that hashes to the registry's
// `name_hash` is marked verified; one that does not is still shown, as a name the backend asserts.
//
// Free of React and of web3.js: the registry half comes from `chain.loadAppraisers()`, and merging
// the two is a pure function.
import { sha256 } from "@noble/hashes/sha2";
import { API } from "@/lib/sponsor";
import { safeName } from "@/lib/utils";

/** True when this deployment has a backend that could serve the directory at all. */
export const DIRECTORY_AVAILABLE = !!API;

/** One row of `GET /api/appraisers`: a name for a key the on-chain registry already holds. */
export interface DirectoryEntry {
  wallet: string;
  name: string;
}

/** A registry entry as the picker needs it: what the chain says, with a name where one is known. */
export interface AppraiserOption {
  /** The `Appraiser` PDA, which is what the instructions take. */
  address: string;
  wallet: string;
  /** The directory's name, or `""` when nothing matched this key. */
  name: string;
  /** `sha256(name)` equals the registry's `name_hash`, so the name is committed, not just asserted. */
  nameVerified: boolean;
  active: boolean;
  isDefault: boolean;
  /** Base units of the lease mint, before the per-lease cap. */
  fee: number;
}

/** What `mergeDirectory` needs of a registry entry, which is the shape `chain.AppraiserView` has. */
export interface RegistryEntry {
  address: string;
  wallet: string;
  active: boolean;
  isDefault: boolean;
  fee: number;
  nameHashHex: string;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** `sha256(name)` as lower-case hex, the commitment `register_appraiser` was given. */
export const nameHash = (name: string): string => hex(sha256(new TextEncoder().encode(name)));

/** Accepts either a bare array or `{ appraisers: [...] }`, and drops rows without a usable key. */
export function directoryEntries(body: unknown): DirectoryEntry[] {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { appraisers?: unknown })?.appraisers) ? (body as { appraisers: unknown[] }).appraisers : [];
  return rows.flatMap((row) => {
    // A null or primitive element has to be skipped before any field is read: this function's
    // whole job is to survive a body nobody here wrote, and `null.wallet` throws.
    if (typeof row !== "object" || row === null) return [];
    const r = row as { wallet?: unknown; key?: unknown; name?: unknown };
    const wallet = typeof r.wallet === "string" ? r.wallet : typeof r.key === "string" ? r.key : "";
    return wallet ? [{ wallet, name: typeof r.name === "string" ? r.name : "" }] : [];
  });
}

/**
 * The names for the registry, or an empty directory when there is nobody to ask.
 *
 * An empty answer is not a failure: without a backend, or against one that predates the route, the
 * picker still works off the on-chain registry alone and shows wallet addresses instead of names.
 * Anything else — a 500, a body that is not a list — is raised, because then the directory exists
 * and is broken, which is worth seeing.
 */
export async function loadAppraiserDirectory(): Promise<DirectoryEntry[]> {
  if (!API) return [];
  const res = await fetch(`${API}/api/appraisers`);
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The appraiser directory is unavailable (${res.status}).`);
  }
  return directoryEntries(await res.json());
}

/**
 * The registry, with a name attached where the directory has one.
 *
 * The chain is the authority on who exists: a directory row for a key with no registry entry is
 * dropped, because the program would refuse it as a candidate anyway (the setup script has not
 * registered it yet). Ordering puts the pickable ones first, then names before bare keys, so a
 * suspended entry never heads the list.
 */
export function mergeDirectory(registry: RegistryEntry[], directory: DirectoryEntry[]): AppraiserOption[] {
  const names = new Map(directory.map((d) => [d.wallet, d.name]));
  return registry
    .map((entry) => {
      const raw = names.get(entry.wallet) ?? "";
      // Verify against the RAW string — the registry committed to what was registered — then show
      // the sanitised one. A name is untrusted input that ends up beside an amount, so it must not
      // be able to carry bidi overrides or run long enough to push the amount off the card.
      const verified = !!raw && nameHash(raw) === entry.nameHashHex;
      return {
        address: entry.address,
        wallet: entry.wallet,
        name: safeName(raw),
        nameVerified: verified,
        active: entry.active,
        isDefault: entry.isDefault,
        fee: entry.fee,
      };
    })
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Number(!!b.name) - Number(!!a.name) ||
        (a.name || a.wallet).localeCompare(b.name || b.wallet),
    );
}

/**
 * The label to use where a click commits something — a pick, a binding, a verdict.
 *
 * Only a name the chain's `name_hash` confirms may stand in for identity there; anything else
 * shows the key, because an unverified name is the directory's claim about who this is and the
 * key is the only thing the program actually acts on. Browsing lists may still show an unverified
 * name, where it sits next to its own missing verification mark rather than next to a button.
 */
export function trustedLabel(o: Pick<AppraiserOption, "name" | "nameVerified" | "wallet"> | undefined, shorten: (s: string) => string): string {
  return o?.nameVerified && o.name ? o.name : shorten(o?.wallet ?? "");
}

/**
 * `trustedLabel` for a key you already hold.
 *
 * The directory is off chain and optional: it 404s on a backend that predates the route, and the
 * registry itself may not have loaded when a bound appraiser is already on screen. `trustedLabel`
 * then has no entry and no key to shorten, and would render an empty label exactly where A.4 says
 * the key belongs — on a commit site, next to the deposit it moves.
 */
export function trustedLabelFor(o: Pick<AppraiserOption, "name" | "nameVerified" | "wallet"> | undefined, wallet: string, shorten: (s: string) => string): string {
  return trustedLabel(o ?? { wallet, name: "", nameVerified: false }, shorten);
}

/** How to call an appraiser on screen: their directory name, or a shortened key when there is none. */
export const appraiserLabel = (o: Pick<AppraiserOption, "name" | "wallet">, shorten: (s: string) => string): string =>
  o.name || shorten(o.wallet);
