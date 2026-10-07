// Contract 1: the only wallet surface chain.ts may depend on.
// The wallet-adapter wallet, the local test wallet and the embedded (email) wallet all satisfy it.
import type { WalletLike } from "./chain";

export interface WalletProvider extends WalletLike {
  kind: "embedded" | "adapter" | "local";
  /** Sign an arbitrary message. Needed to derive the confidential-balance keys. */
  signMessage?: (msg: Uint8Array) => Promise<Uint8Array>;
}

/** Contract 2 client: send a partially-signed transaction; the backend pays the fee and submits it. */
export async function sendSponsored(txBase64: string, api = import.meta.env.VITE_API ?? "http://localhost:8787"): Promise<string> {
  const res = await fetch(`${api}/api/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txBase64 }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `sponsor failed (${res.status})`);
  return (await res.json()).signature as string;
}
