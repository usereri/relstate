import { sha256 } from "@noble/hashes/sha2";

export interface Doc {
  name: string;
  size: number;
  hash: number[]; // 32 bytes, what goes on-chain
  hex: string;
}

/** SHA-256 in JS (not crypto.subtle, which is unavailable over plain http on a phone). */
export async function hashFile(file: Blob, name: string): Promise<Doc> {
  const bytes = sha256(new Uint8Array(await file.arrayBuffer()));
  const hash = Array.from(bytes);
  return { name, size: file.size, hash, hex: hash.map((b) => b.toString(16).padStart(2, "0")).join("") };
}

export async function sampleLease(): Promise<Doc> {
  const res = await fetch("/sample-lease.pdf");
  return hashFile(await res.blob(), "sample-lease.pdf");
}
