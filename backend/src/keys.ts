// Key loading. Three Solana keys with three different jobs, plus the auditor's
// ElGamal/AES pair. Nothing here ever logs a secret.
import { existsSync, readFileSync } from "node:fs";
import type { webcrypto } from "node:crypto";
import { createKeyPairSignerFromBytes, getBase58Encoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { AeKey, ConfidentialKeys, ElGamalKeypair } from "@solana/zk-sdk";
import { parseKeySpecs } from "./appraisers.ts";
import { env } from "./env.ts";

export type KeyRole = "feePayer" | "treasury" | "attestationIssuer";

export type LoadedKey = {
  signer: KeyPairSigner;
  /** True when the key was generated for this process because none was configured (mock mode only). */
  ephemeral: boolean;
};

/**
 * Thrown for any unreadable key spec. Its message and cause name WHAT was wrong, never the spec or
 * the file's contents: a spec is either a path or the secret itself, and an error message cannot
 * tell which until it is too late.
 */
export class KeySpecError extends Error {
  constructor(message: string) {
    super(message); // deliberately no `cause`: Node's inspector prints cause chains
    this.name = "KeySpecError";
  }
}

const decodeSecret = (text: string): Uint8Array | null => {
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      return Array.isArray(parsed) ? new Uint8Array(parsed as number[]) : null;
    } catch {
      return null; // JSON.parse's message can quote the input
    }
  }
  try {
    return new Uint8Array(getBase58Encoder().encode(t));
  } catch {
    return null;
  }
};

/**
 * 64 raw bytes: 32-byte seed followed by the 32-byte public key, as the Solana CLI writes them.
 *
 * What `spec` is gets decided WITHOUT touching the filesystem first: an inline JSON array or a
 * base58 string that decodes to 64 bytes is the key itself. Only anything else is treated as a path,
 * and only if a file exists there. The old order (anything not starting with `[` is a path) handed a
 * base58 secret to `readFileSync`, whose ENOENT error quotes it.
 */
export function parseKeyPairBytes(spec: string): Uint8Array {
  const inline = decodeSecret(spec);
  if (inline !== null && inline.length === 64) return inline;
  const trimmed = spec.trim();
  if (trimmed.startsWith("[") || !existsSync(trimmed)) {
    throw new KeySpecError("not an inline keypair (a 64-byte JSON array or base58 secret) and no file exists at that path");
  }
  let raw: string;
  try {
    raw = readFileSync(trimmed, "utf8");
  } catch {
    throw new KeySpecError("the keypair file exists but could not be read");
  }
  const fromFile = decodeSecret(raw);
  if (fromFile === null) throw new KeySpecError("the keypair file is neither a JSON byte array nor a base58 secret");
  return fromFile;
}

/** Accepts a path to a CLI keypair file, an inline JSON byte array, or a base58 secret key. */
export async function loadKeyPairSigner(spec: string, label: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  try {
    bytes = parseKeyPairBytes(spec);
  } catch (e) {
    // The cause is dropped on purpose, and the message never echoes `spec`: it may be the secret.
    throw new KeySpecError(`${label}: could not read the keypair (${e instanceof KeySpecError ? e.message : "expected a file path, a JSON byte array, or a base58 secret key"})`);
  }
  if (bytes.length !== 64) throw new KeySpecError(`${label}: expected 64 keypair bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}

/**
 * Replaces every configured secret with `<redacted>`, for the one place that prints an arbitrary
 * error: a script's top-level catch. Defence in depth behind the sanitised errors above, since a
 * future failure path will not necessarily have been written with this in mind.
 */
export function redactSecrets(text: string, secrets: readonly string[] = secretValues()): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 12) out = out.split(secret).join("<redacted>");
  return out;
}
const secretValues = (): string[] =>
  [
    env.feePayerKeypair,
    env.treasuryKeypair,
    env.attestationIssuerKeypair,
    env.rusdcAuditorIkm,
    env.onramp.stripeSecretKey,
    env.onramp.stripeWebhookSecret,
    env.sessionSecret,
    env.adminToken,
    env.appraisers.consoleToken,
    // Both the whole variable and each spec in it: one of them may be an inline secret, and the
    // combined string would not match a message that printed only the one that failed.
    env.appraisers.keypairs,
    ...parseKeySpecs(env.appraisers.keypairs),
  ].filter((v) => v !== "");

/** Ed25519 keypair bytes in CLI layout, via WebCrypto — same approach as `spikes/ct`. */
export async function generateKeyPairBytes(): Promise<Uint8Array> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).slice(-32);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return new Uint8Array([...seed, ...publicKey]);
}

const specs: Record<KeyRole, () => string> = {
  feePayer: () => env.feePayerKeypair,
  treasury: () => env.treasuryKeypair,
  attestationIssuer: () => env.attestationIssuerKeypair,
};

const loaded = new Map<KeyRole, Promise<LoadedKey>>();

/**
 * In `live` mode a missing key is an error (`assertEnvConsistent` catches it at
 * boot). In `mock` mode we mint a throwaway key instead, which is what lets the
 * backend start and serve every route in a fresh clone with no secrets. An
 * ephemeral key can sign but has no lamports, so callers that broadcast must
 * check `ephemeral` first.
 */
export function getKey(role: KeyRole): Promise<LoadedKey> {
  const cached = loaded.get(role);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<LoadedKey> => {
    const spec = specs[role]();
    if (spec !== "") return { signer: await loadKeyPairSigner(spec, role), ephemeral: false };
    if (env.mode === "live") throw new Error(`${role}: no keypair configured and BACKEND_MODE=live`);
    return { signer: await createKeyPairSignerFromBytes(await generateKeyPairBytes()), ephemeral: true };
  })();
  loaded.set(role, promise);
  return promise;
}

/**
 * The appraiser keys the demo console may sign a verdict with, indexed by their own wallet address.
 *
 * No wallet → key mapping is configured anywhere: the address IS derived from the key, so a
 * mismatch between "which appraiser this is" and "which key signs for them" cannot be configured
 * into existence. A key that is not the bound appraiser's is simply absent from this map, and
 * `appraiser-chain.ts` refuses rather than substituting another one.
 *
 * Unlike the three role keys there is no ephemeral fallback: a throwaway appraiser key would sign
 * verdicts as a wallet no registry entry names, which fails on chain and would look like a bug in
 * the program. An unconfigured console is an empty map.
 */
export async function loadAppraiserSigners(specs: readonly string[]): Promise<Map<string, KeyPairSigner>> {
  const byAddress = new Map<string, KeyPairSigner>();
  for (const [index, spec] of specs.entries()) {
    // The label is the POSITION, never the spec: the spec may be the secret itself.
    const signer = await loadKeyPairSigner(spec, `APPRAISER_KEYPAIRS[${index}]`);
    if (byAddress.has(signer.address)) {
      throw new KeySpecError(`APPRAISER_KEYPAIRS[${index}]: ${signer.address} is listed twice`);
    }
    byAddress.set(signer.address, signer);
  }
  return byAddress;
}

let appraiserSigners: Promise<Map<string, KeyPairSigner>> | undefined;
/** Memoised `loadAppraiserSigners` over `APPRAISER_KEYPAIRS`. */
export function getAppraiserSigners(): Promise<Map<string, KeyPairSigner>> {
  return (appraiserSigners ??= loadAppraiserSigners(parseKeySpecs(env.appraisers.keypairs)));
}

/** Test seam: drops the memoised keys so a test can re-read a changed environment. */
export function resetKeyCache(): void {
  loaded.clear();
  appraiserSigners = undefined;
}

export type ConfidentialKeyPair = { elgamal: ElGamalKeypair; ae: AeKey };

/** The wallet-side derivation, for reference and for tests: sign `solana-conf-bal/v1`, hand the signature here. */
export function confidentialKeysFromSignature(signature: Uint8Array): ConfidentialKeyPair {
  const keys = ConfidentialKeys.fromSignature(signature);
  return { elgamal: keys.elgamal(), ae: keys.ae() };
}

/** The message a wallet must sign to derive its confidential keys: `solana-conf-bal/v1`. */
export function confidentialSignerMessage(): Uint8Array {
  return ConfidentialKeys.signerMessage();
}

export function confidentialKeysFromIkm(ikm: Uint8Array): ConfidentialKeyPair {
  if (ikm.length !== 32) throw new Error(`confidential key material must be 32 bytes, got ${ikm.length}`);
  const keys = ConfidentialKeys.fromIkm(ikm);
  return { elgamal: keys.elgamal(), ae: keys.ae() };
}

/**
 * The auditor pair configured on the rUSDC mint. Held only here, so that every
 * confidential transfer on the mint stays decryptable for compliance
 * (`docs/privacy.md`). `RUSDC_AUDITOR_IKM` is the 32-byte seed in base64;
 * `scripts/make-rusdc.ts` generates it.
 */
export function getAuditorKeys(): ConfidentialKeyPair {
  if (env.rusdcAuditorIkm === "") throw new Error("RUSDC_AUDITOR_IKM is not set (run scripts/make-rusdc.ts)");
  return confidentialKeysFromIkm(Buffer.from(env.rusdcAuditorIkm, "base64"));
}

/** The auditor ElGamal public key, base58-encoded the way the mint extension stores it. */
export function auditorElgamalAddress(keys: ConfidentialKeyPair = getAuditorKeys()): string {
  return getBase58Decoder().decode(keys.elgamal.pubkey().toBytes());
}

export { AeKey, ElGamalKeypair };
