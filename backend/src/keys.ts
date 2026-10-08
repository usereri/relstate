// Key loading. Three Solana keys with three different jobs, plus the auditor's
// ElGamal/AES pair. Nothing here ever logs a secret.
import { readFileSync } from "node:fs";
import type { webcrypto } from "node:crypto";
import { createKeyPairSignerFromBytes, getBase58Encoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { AeKey, ConfidentialKeys, ElGamalKeypair } from "@solana/zk-sdk";
import { env } from "./env.ts";

export type KeyRole = "feePayer" | "treasury" | "attestationIssuer";

export type LoadedKey = {
  signer: KeyPairSigner;
  /** True when the key was generated for this process because none was configured (mock mode only). */
  ephemeral: boolean;
};

/** 64 raw bytes: 32-byte seed followed by the 32-byte public key, as the Solana CLI writes them. */
export function parseKeyPairBytes(spec: string): Uint8Array {
  const trimmed = spec.trim();
  const raw = trimmed.startsWith("[") ? trimmed : readFileSync(trimmed, "utf8").trim();
  if (raw.startsWith("[")) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("keypair JSON is not an array");
    return new Uint8Array(parsed as number[]);
  }
  return new Uint8Array(getBase58Encoder().encode(raw));
}

/** Accepts a path to a CLI keypair file, an inline JSON byte array, or a base58 secret key. */
export async function loadKeyPairSigner(spec: string, label: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  try {
    bytes = parseKeyPairBytes(spec);
  } catch (cause) {
    // Never echo `spec` itself: it may be the secret rather than a path.
    throw new Error(`${label}: could not read the keypair (expected a file path, a JSON byte array, or a base58 secret key)`, { cause });
  }
  if (bytes.length !== 64) throw new Error(`${label}: expected 64 keypair bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}

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

/** Test seam: drops the memoised keys so a test can re-read a changed environment. */
export function resetKeyCache(): void {
  loaded.clear();
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
