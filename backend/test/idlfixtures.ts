// The program's IDL, for the tests that pin a hand-written mirror against it.
//
// Prefers the Anchor build output (`target/idl/relstate.json`, or `RELSTATE_IDL`) and falls back to
// the tracked copy `scripts/sync-idl.sh` writes into `app/idl/`. The fallback is the point: `target/`
// is git-ignored and never exists in a CI checkout or a fresh worktree, so a test that read only the
// build output either skipped silently or failed on a missing file — and in both cases a stale
// FALLBACK_LAYOUTS or discriminator mirror would have shipped unnoticed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDL_PATH } from "../src/layout.ts";

export type IdlField = { name: string; type: unknown };
export type IdlAccountMeta = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string };
export type ProgramIdl = {
  address: string;
  instructions: Array<{ name: string; discriminator: number[]; accounts: IdlAccountMeta[]; args: IdlField[] }>;
  accounts: Array<{ name: string; discriminator: number[] }>;
  constants: Array<{ name: string; type: string; value: string }>;
  types: Array<{ name: string; type: Record<string, unknown> }>;
};

export const TRACKED_IDL_PATH = resolve(import.meta.dirname, "../../app/idl/relstate.json");

/** The build output if there is one, else the tracked mirror. Null only if neither exists. */
export function idlPath(): string | null {
  for (const path of [IDL_PATH(), TRACKED_IDL_PATH]) if (existsSync(path)) return path;
  return null;
}

const path = idlPath();
export const IDL: ProgramIdl | null = path === null ? null : (JSON.parse(readFileSync(path, "utf8")) as ProgramIdl);

/** The IDL, or a failure naming what to rebuild. Use in a test that cannot say anything without it. */
export function requireIdl(): ProgramIdl {
  if (IDL === null) {
    throw new Error(`no IDL at ${IDL_PATH()} or ${TRACKED_IDL_PATH}: run \`anchor build -- --features demo\` then scripts/sync-idl.sh`);
  }
  return IDL;
}

export const instruction = (name: string) => {
  const found = requireIdl().instructions.find((i) => i.name === name);
  if (found === undefined) throw new Error(`the IDL has no instruction ${name}`);
  return found;
};

export const account = (name: string) => {
  const found = requireIdl().accounts.find((a) => a.name === name);
  if (found === undefined) throw new Error(`the IDL has no account ${name}`);
  return found;
};

export const constant = (name: string): string => {
  const found = requireIdl().constants.find((c) => c.name === name);
  if (found === undefined) throw new Error(`the IDL has no constant ${name}`);
  return found.value;
};
