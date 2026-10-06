import * as anchor from "@anchor-lang/core";
import type { Sponsor } from "./chain";

// Fee relay (see relay/server.ts). When set, signed-in users never need SOL for fees.
export const SPONSOR_URL: string | undefined = import.meta.env.VITE_SPONSOR_URL;

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${SPONSOR_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Fee relay error (${res.status})`);
  return json;
};

export async function loadSponsor(): Promise<Sponsor> {
  const { feePayer } = await (await fetch(`${SPONSOR_URL}/fee-payer`)).json();
  return {
    feePayer: new anchor.web3.PublicKey(feePayer),
    submit: async (tx) => (await post("/sponsor", { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") })).signature,
  };
}
