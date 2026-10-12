import "./noenv.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getAddressEncoder, generateKeyPairSigner, type Address } from "@solana/kit";
import { accountDiscriminator } from "../src/anchor.ts";
import { fetchAllAppraisers, staleDefaults } from "../src/appraiser-chain.ts";
import { appraiserNameHash, hex } from "../src/appraisers.ts";
import { FALLBACK_LAYOUTS } from "../src/layout.ts";

const enc = getAddressEncoder();
const { env } = await import("../src/env.ts");
const { createApp } = await import("../src/server.ts");
const A = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;

function appraiserBytes(wallet: Address, o: { active: boolean; isDefault: boolean; fee: bigint; name?: string }) {
  const L = FALLBACK_LAYOUTS.Appraiser!;
  const d = new Uint8Array(L.size);
  d.set(accountDiscriminator("Appraiser"));
  d.set(enc.encode(wallet), L.offsets.wallet!);
  d[L.offsets.active!] = o.active ? 1 : 0;
  d[L.offsets.is_default!] = o.isDefault ? 1 : 0;
  new DataView(d.buffer).setBigUint64(L.offsets.fee!, o.fee, true);
  if (o.name) d.set(appraiserNameHash(o.name), L.offsets.name_hash!);
  return d;
}
const info = (d: Uint8Array | null) => ({ value: d ? { owner: "x", data: [Buffer.from(d).toString("base64"), "base64"], lamports: 1n, executable: false, space: 0n } : null });

const entry = { name: "Rzeczoznawca A", wallet: A, fee: 2_000_000n, isDefault: true };
const servicesWith = (getAccountInfo: () => { send: () => Promise<unknown> }) =>
  ({ appraisers: () => [entry], client: () => ({ rpc: { getAccountInfo } }) }) as never;
const mutableEnv = env as unknown as { mode: string };
const original = env.mode;
afterEach(() => { mutableEnv.mode = original; });
const fetchDirectory = async (services: never) => {
  const res = await createApp(services).request("/api/appraisers");
  return ((await res.json()) as { appraisers: Record<string, unknown>[] }).appraisers[0]!;
};

describe("GET /api/appraisers reads the registry in live mode", () => {
  it("overrides fee/active/default with the chain's and flags drift", async () => {
    mutableEnv.mode = "live";
    const row = await fetchDirectory(servicesWith(() => ({ send: async () => info(appraiserBytes(A, { active: false, isDefault: false, fee: 5n, name: entry.name })) })));
    assert.deepEqual([row.fee, row.feeSource, row.active, row.isDefault, row.registered, row.drift], ["5", "chain", false, false, true, true]);
    assert.equal(row.nameHash, hex(appraiserNameHash(entry.name)));
  });
  it("reports no drift when the chain matches", async () => {
    mutableEnv.mode = "live";
    const row = await fetchDirectory(servicesWith(() => ({ send: async () => info(appraiserBytes(A, { active: true, isDefault: true, fee: 2_000_000n, name: entry.name })) })));
    assert.deepEqual([row.feeSource, row.drift], ["chain", false]);
  });
  it("says registered:false for an entry the chain does not hold", async () => {
    mutableEnv.mode = "live";
    const row = await fetchDirectory(servicesWith(() => ({ send: async () => info(null) })));
    assert.deepEqual([row.registered, row.feeSource, row.fee], [false, "directory", "2000000"]);
  });
  it("falls back to the directory when the RPC throws", async () => {
    mutableEnv.mode = "live";
    const row = await fetchDirectory(servicesWith(() => ({ send: async () => { throw new Error("boom"); } })));
    assert.deepEqual([row.feeSource, row.registered], ["directory", null]);
  });
  it("falls back after 3 s when the RPC hangs", async () => {
    mutableEnv.mode = "live";
    const started = Date.now();
    const row = await fetchDirectory(servicesWith(() => ({ send: () => new Promise(() => {}) })));
    const took = Date.now() - started;
    assert.deepEqual([row.feeSource, row.fee], ["directory", "2000000"]);
    assert.ok(took >= 2900 && took < 5000, `took ${took} ms`);
  });
  it("memoises for a few seconds: two requests, one registry read", async () => {
    mutableEnv.mode = "live";
    let reads = 0;
    const app = createApp(servicesWith(() => { reads++; return { send: async () => info(appraiserBytes(A, { active: true, isDefault: true, fee: 1n })) }; }));
    for (let i = 0; i < 3; i++) assert.equal((await app.request("/api/appraisers")).status, 200);
    assert.equal(reads, 1);
  });
  it("is rate-limited per IP like the other unauthenticated routes", async () => {
    mutableEnv.mode = "mock";
    const app = createApp(servicesWith(() => { throw new Error("unused"); }));
    const statuses: number[] = [];
    for (let i = 0; i < env.authRatePerMinute + 2; i++) statuses.push((await app.request("/api/appraisers")).status);
    assert.equal(statuses.at(-1), 429);
    assert.equal(statuses[0], 200);
  });
  it("never touches the RPC outside live mode", async () => {
    mutableEnv.mode = "mock";
    const row = await fetchDirectory(servicesWith(() => { throw new Error("must not be called"); }));
    assert.equal(row.feeSource, "directory");
  });
});

describe("setup script: stale-default discovery", () => {
  it("fetchAllAppraisers asks for the Appraiser discriminator and decodes every row", async () => {
    const [b, c] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    let params: unknown[] = [];
    const rpc = {
      getProgramAccounts: (...args: unknown[]) => {
        params = args;
        return { send: async () => [b, c].map((w, i) => ({ pubkey: w, account: { data: [Buffer.from(appraiserBytes(w, { active: true, isDefault: i === 0, fee: BigInt(i) })).toString("base64"), "base64"] } })) };
      },
    };
    const records = await fetchAllAppraisers(rpc as never);
    assert.deepEqual(records.map((r) => [r.wallet, r.isDefault]), [[b, true], [c, false]]);
    const filter = ((params[1] as { filters: { memcmp: { offset: bigint; bytes: string; encoding: string } }[] }).filters)[0]!.memcmp;
    assert.equal(filter.offset, 0n);
    assert.equal(filter.encoding, "base58");
    const { getBase58Encoder } = await import("@solana/kit");
    assert.deepEqual([...getBase58Encoder().encode(filter.bytes)], [...accountDiscriminator("Appraiser")]);
  });
  it("staleDefaults returns only flagged entries missing from the directory", () => {
    const rec = (wallet: string, isDefault: boolean) => ({ wallet: wallet as Address, active: true, isDefault, fee: 0n, nameHash: "" });
    const out = staleDefaults([rec("old", true), rec("kept", true), rec("oldUnflagged", false)], ["kept"]);
    assert.deepEqual(out.map((r) => r.wallet), ["old"]);
  });
});
