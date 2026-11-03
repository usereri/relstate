// The three Anchor conventions the backend has to reproduce because it carries no Anchor client:
// the instruction prefix, the account prefix, and the `Config` PDA every admin instruction takes.
//
// Hand-rolled over @solana/kit for the reason `providers/kyc-chain.ts` states at length: this is a
// kit codebase with no web3.js and no Anchor dependency, and pulling one in for a handful of
// instructions would double its dependency tree. Each builder's discriminator and account order is
// asserted against the generated IDL in tests, so a program change fails there and not on stage.
import { createHash } from "node:crypto";
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { RELSTATE_PROGRAM } from "./contracts.ts";

export const PROGRAM = RELSTATE_PROGRAM as Address;

const prefix = (text: string): Uint8Array => new Uint8Array(createHash("sha256").update(text).digest().subarray(0, 8));

/** Anchor's instruction prefix: the first 8 bytes of `sha256("global:<snake_case_name>")`. */
export const instructionDiscriminator = (name: string): Uint8Array => prefix(`global:${name}`);

/** Anchor's account prefix: the first 8 bytes of `sha256("account:<TypeName>")`. */
export const accountDiscriminator = (name: string): Uint8Array => prefix(`account:${name}`);

const addresses = getAddressEncoder();

/** PDA seed parts: a literal seed as text, an address as its 32 bytes. */
export const seeds = (...parts: (string | Uint8Array)[]): Uint8Array[] =>
  parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p));

export const addressSeed = (address: Address): Uint8Array => new Uint8Array(addresses.encode(address));

export async function programDerived(...parts: (string | Uint8Array)[]): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: seeds(...parts) });
  return pda;
}

/** `[b"config"]`: the account that holds the admin, the mint allowlist and the KYC policy. */
export const configPda = (): Promise<Address> => programDerived("config");

/** True when `data` starts with Anchor's 8-byte discriminator for the expected type. */
export const sameDiscriminator = (data: Uint8Array, expected: Uint8Array): boolean =>
  data.length >= 8 && expected.every((b, i) => data[i] === b);
