/**
 * What kind of mint a lease is settled in.
 *
 * `pay_rent` picks its path from the mint's extensions, not from the lease or the instruction data
 * (docs/contracts/program-interface.md §3): a Token-2022 mint carrying `ConfidentialTransferMint`
 * moves rent through a confidential transfer the caller composes, anything else moves a public
 * amount inside the instruction. The UI has to make the same decision to know which button to
 * offer, so it asks the mint the same question the program does.
 *
 * Deliberately web3.js + `@solana/spl-token`, not the kit island: this runs before anyone has
 * asked for a private operation, and it must not pull in the `@solana/zk-sdk` wasm to answer.
 */
import * as anchor from "@anchor-lang/core";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, getExtensionData, unpackMint } from "@solana/spl-token";
import { connection } from "./chain";
import { MINT, RPC } from "./config";

const { PublicKey } = anchor.web3;

export interface MintKind {
  address: string;
  /** Token-2022 rather than the classic SPL token program. */
  isToken2022: boolean;
  /** True when the mint carries `ConfidentialTransferMint`, i.e. rent on it is private. */
  confidential: boolean;
  /** True when the mint sets an auditor ElGamal key, so every transfer stays decryptable by us. */
  hasAuditor: boolean;
  decimals: number;
}

/**
 * The ElGamal auditor pubkey sits at offset 33 of the extension: authority (32) + the
 * `auto_approve_new_accounts` flag (1). All-zero means "no auditor", which `set_mint_allowed`
 * refuses for a confidential mint — so this is a configuration check, not a trust decision.
 */
const AUDITOR_OFFSET = 33;
const AUDITOR_LEN = 32;

function readKind(address: string, owner: anchor.web3.PublicKey, data: Buffer): MintKind {
  const isToken2022 = owner.equals(TOKEN_2022_PROGRAM_ID);
  const mint = unpackMint(new PublicKey(address), { data, owner } as anchor.web3.AccountInfo<Buffer>, owner);
  const extension = isToken2022 ? getExtensionData(ExtensionType.ConfidentialTransferMint, mint.tlvData) : null;
  const auditor = extension?.subarray(AUDITOR_OFFSET, AUDITOR_OFFSET + AUDITOR_LEN);
  return {
    address,
    isToken2022,
    confidential: extension !== null,
    hasAuditor: !!auditor && auditor.length === AUDITOR_LEN && auditor.some((b) => b !== 0),
    decimals: mint.decimals,
  };
}

const cache = new Map<string, Promise<MintKind>>();

/**
 * Reads and caches a mint's kind. Only a successful read is cached: a 429 or an RPC blip must not
 * pin the session to "public rent", which would quietly offer the wrong flow for the rest of the
 * page's life.
 */
export function mintKind(which: string = MINT): Promise<MintKind> {
  const held = cache.get(which);
  if (held) return held;
  const pending = connection
    .getAccountInfo(new PublicKey(which))
    .then((info) => {
      if (!info) throw new Error(`The mint ${which} does not exist on ${RPC}.`);
      return readKind(which, info.owner, info.data);
    })
    .catch((e) => {
      cache.delete(which);
      throw e;
    });
  cache.set(which, pending);
  return pending;
}
