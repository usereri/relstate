// Account layouts, read from the program's own IDL in one place.
//
// Two backend features depend on the byte layout of relstate accounts without having an Anchor
// client: `lease.ts` reads fields off a `Lease`, and rent dust funds exactly the rent of an
// `Application` and a `Profile`. Both used to hard-code sizes and offsets, which is a trap: the
// program's accounts change (a dispute workstream adds fields before the first deploy), nothing
// fails to compile, and the symptoms are a wrong rent amount or a wrong figure in an audit.
//
// So the layout is COMPUTED from the IDL Anchor generates (target/idl/relstate.json, or the file
// named by RELSTATE_IDL) whenever it is present, and falls back to the snapshot below only when it
// is not. A test asserts the snapshot equals what the IDL says, so a layout change fails exactly
// one test, pointing at exactly this file. Nothing else needs hunting.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | { option: IdlType } | { vec: IdlType };
type IdlField = { name: string; type: IdlType };
type IdlTypeDef = { name: string; type: { kind: "struct"; fields?: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: (IdlField | IdlType)[] }[] } };
export type Idl = { types?: IdlTypeDef[] };

export type Layout = {
  /** Total account size, including Anchor's 8-byte discriminator: what `getMinimumBalanceForRentExemption` and `space =` take. */
  size: number;
  /** Byte offset of every field, discriminator included. */
  offsets: Readonly<Record<string, number>>;
};

const SCALARS: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32,
};

function sizeOf(type: IdlType, idl: Idl, where: string): number {
  if (typeof type === "string") {
    const size = SCALARS[type];
    if (size === undefined) throw new Error(`${where}: unsupported field type ${type}`);
    return size;
  }
  if ("array" in type) return sizeOf(type.array[0], idl, where) * type.array[1];
  if ("option" in type) return 1 + sizeOf(type.option, idl, where);
  if ("defined" in type) {
    const def = idl.types?.find((t) => t.name === type.defined.name);
    if (!def) throw new Error(`${where}: type ${type.defined.name} is not in the IDL`);
    if (def.type.kind === "struct") return (def.type.fields ?? []).reduce((n, f) => n + sizeOf(f.type, idl, `${where}.${f.name}`), 0);
    // Anchor/Borsh: a one-byte tag plus the largest variant.
    return 1 + Math.max(0, ...def.type.variants.map((v) => (v.fields ?? []).reduce((n, f) => n + sizeOf("type" in (f as IdlField) ? (f as IdlField).type : (f as IdlType), idl, where), 0)));
  }
  // vec / string need a max_len that the IDL does not carry, so a size cannot be derived honestly.
  throw new Error(`${where}: variable-length types have no fixed size to derive`);
}

/** Pure: the layout of one struct account, from an IDL object. */
export function computeLayout(idl: Idl, account: string): Layout {
  const def = idl.types?.find((t) => t.name === account);
  if (!def || def.type.kind !== "struct") throw new Error(`the IDL has no struct account ${account}`);
  const offsets: Record<string, number> = {};
  let at = 8; // Anchor's discriminator
  for (const field of def.type.fields ?? []) {
    offsets[field.name] = at;
    at += sizeOf(field.type, idl, `${account}.${field.name}`);
  }
  return { size: at, offsets };
}

/**
 * The snapshot used when no IDL is on disk (a deployed backend does not carry `target/`). It is
 * NOT authoritative: `test/layout.test.ts` fails the moment it disagrees with the IDL.
 */
export const FALLBACK_LAYOUTS: Readonly<Record<string, Layout>> = {
  Lease: {
    size: 193,
    offsets: {
      landlord: 8, tenant: 40, mint: 72, lease_id: 104, rent_amount: 112, deposit_amount: 120, start_ts: 128,
      term_periods: 136, paid_count: 138, lease_hash: 140, status: 172, bump: 173, period_secs: 174, grace_secs: 182, region: 190, discount_pct: 192,
    },
  },
  Profile: {
    size: 88,
    offsets: {
      wallet: 8, leases_completed: 40, paid_on_time: 44, paid_late: 48, deposits_returned_full: 52, deposit_total: 56,
      deducted_total: 64, defaults: 72, deposits_claimed: 76, rent_paid_total: 80,
    },
  },
  Application: { size: 104, offsets: { listing: 8, landlord: 40, tenant: 72 } },
};

export const IDL_PATH = (): string => process.env.RELSTATE_IDL?.trim() || resolve(import.meta.dirname, "../../target/idl/relstate.json");

let loaded: { idl: Idl | null } | undefined;
/** The IDL on disk, or null. Read once: it changes only when the program is rebuilt. */
export function loadIdl(): Idl | null {
  if (loaded === undefined) {
    const path = IDL_PATH();
    loaded = { idl: existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Idl) : null };
  }
  return loaded.idl;
}
/** Test seam: forget the cached IDL. */
export const resetIdlCache = (): void => {
  loaded = undefined;
};

/** The layout of a relstate account: from the IDL when present, else the snapshot. */
export function accountLayout(account: string, idl: Idl | null = loadIdl()): Layout {
  if (idl) return computeLayout(idl, account);
  const fallback = FALLBACK_LAYOUTS[account];
  if (!fallback) throw new Error(`no IDL on disk and no fallback layout for ${account}`);
  return fallback;
}

/** Byte offset of a named field. Throws, naming the field, if the program no longer has it. */
export function fieldOffset(layout: Layout, account: string, field: string): number {
  const at = layout.offsets[field];
  if (at === undefined) throw new Error(`${account} has no field ${field}: the program changed, update what reads it`);
  return at;
}
