import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSigner, getAddressEncoder, type Address, type TransactionSigner } from "@solana/kit";
import { accountDiscriminator, configPda } from "../src/anchor.ts";
import { VerdictRefused, appraiserPda, associatedToken, createAppraiserChain, disputePda } from "../src/appraiser-chain.ts";
import { RELSTATE_PROGRAM } from "../src/contracts.ts";
import { FALLBACK_LAYOUTS } from "../src/layout.ts";
import { LEASE_DISCRIMINATOR, LEASE_STATUS } from "../src/lease.ts";
import { redactSecrets } from "../src/keys.ts";

const enc = getAddressEncoder();
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const PROGRAM = RELSTATE_PROGRAM as Address;
type Acct = { owner: Address; data: Uint8Array };
const addr = async () => (await generateKeyPairSigner()).address;

function leaseBytes(o: { landlord: Address; tenant: Address; mint: Address; deposit: bigint; status: (typeof LEASE_STATUS)[number] }) {
  const L = FALLBACK_LAYOUTS.Lease!;
  const d = new Uint8Array(L.size);
  d.set(LEASE_DISCRIMINATOR);
  d.set(enc.encode(o.landlord), L.offsets.landlord!);
  d.set(enc.encode(o.tenant), L.offsets.tenant!);
  d.set(enc.encode(o.mint), L.offsets.mint!);
  new DataView(d.buffer).setBigUint64(L.offsets.deposit_amount!, o.deposit, true);
  d[L.offsets.status!] = LEASE_STATUS.indexOf(o.status);
  return d;
}
function disputeBytes(lease: Address, appraiser: Address | null) {
  const L = FALLBACK_LAYOUTS.Dispute!;
  const d = new Uint8Array(L.size);
  d.set(accountDiscriminator("Dispute"));
  d.set(enc.encode(lease), L.offsets.lease!);
  if (appraiser) d.set(enc.encode(appraiser), L.offsets.appraiser!);
  return d;
}
function appraiserBytes(wallet: Address, o: { active: boolean; fee: bigint }) {
  const L = FALLBACK_LAYOUTS.Appraiser!;
  const d = new Uint8Array(L.size);
  d.set(accountDiscriminator("Appraiser"));
  d.set(enc.encode(wallet), L.offsets.wallet!);
  d[L.offsets.active!] = o.active ? 1 : 0;
  new DataView(d.buffer).setBigUint64(L.offsets.fee!, o.fee, true);
  return d;
}
function configBytes(admin: Address) {
  const d = new Uint8Array(8 + 32 + 1 + 4);
  d.set(accountDiscriminator("Config"));
  d.set(enc.encode(admin), 8);
  return d;
}

async function world(opts: { status?: (typeof LEASE_STATUS)[number]; dispute?: "none" | "unbound" | "bound"; record?: "none" | "active" | "suspended"; haveKey?: boolean; platform?: boolean; adminIsAppraiser?: boolean; ataExists?: boolean } = {}) {
  const [landlord, tenant, mint, lease, payer] = [await addr(), await addr(), await addr(), await addr(), await generateKeyPairSigner()];
  const appraiser = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  const accounts = new Map<string, Acct>();
  const put = (a: Address, owner: Address, data: Uint8Array) => accounts.set(a, { owner, data });
  put(lease, PROGRAM, leaseBytes({ landlord, tenant, mint, deposit: 1_000n, status: opts.status ?? "mediation" }));
  put(mint, TOKEN, new Uint8Array(82));
  put(await configPda(), PROGRAM, configBytes(opts.adminIsAppraiser ? appraiser.address : await addr()));
  if ((opts.dispute ?? "bound") !== "none") put(await disputePda(lease), PROGRAM, disputeBytes(lease, (opts.dispute ?? "bound") === "bound" ? appraiser.address : null));
  if ((opts.record ?? "active") !== "none") put(await appraiserPda(appraiser.address), PROGRAM, appraiserBytes(appraiser.address, { active: opts.record !== "suspended", fee: 50n }));
  if (opts.ataExists) put(await associatedToken(appraiser.address, mint, TOKEN), TOKEN, new Uint8Array(165));
  const rpc = {
    getAccountInfo: (a: Address) => ({
      send: async () => {
        const acct = accounts.get(a);
        return { value: acct ? { owner: acct.owner, data: [Buffer.from(acct.data).toString("base64"), "base64"], lamports: 1n, executable: false, space: BigInt(acct.data.length) } : null };
      },
    }),
  };
  let runs = 0;
  const run = async () => {
    runs++;
    return ["sig"] as never;
  };
  const signers = new Map<string, TransactionSigner>(opts.haveKey === false ? [[other.address, other]] : [[appraiser.address, appraiser]]);
  const chain = createAppraiserChain({
    rpc: rpc as never,
    run,
    payer,
    appraisers: signers,
    forbidden: new Map(opts.platform ? [[appraiser.address, "treasury"]] : []),
  });
  return { chain, lease, appraiser, runs: () => runs };
}
const refuses = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof VerdictRefused && e.code === code, `expected ${code}`);

describe("verdict console: plan / submit against a stubbed chain", () => {
  it("plans a verdict for the bound appraiser and sends nothing", async () => {
    const w = await world();
    const plan = await w.chain.plan({ lease: w.lease, deduction: 900n });
    assert.equal(plan.appraiser, w.appraiser.address);
    assert.equal(plan.split.toTenant + plan.split.toLandlord + plan.split.feePaid, 1_000n);
    assert.equal(plan.appraiserAtaExists, false);
    assert.equal(w.runs(), 0, "plan must never send");
  });
  it("submit runs exactly one plan (ATA create + verdict) and returns the signatures", async () => {
    const w = await world({ ataExists: true });
    const r = await w.chain.submit({ lease: w.lease, deduction: 100n });
    assert.deepEqual(r.signatures, ["sig"]);
    assert.equal(w.runs(), 1);
  });
  it("refuses a lease that is not in mediation", async () => {
    const w = await world({ status: "active" });
    await refuses(w.chain.submit({ lease: w.lease, deduction: 1n }), "not-in-mediation");
    assert.equal(w.runs(), 0);
  });
  it("refuses a deduction above the deposit", async () => {
    const w = await world();
    await refuses(w.chain.submit({ lease: w.lease, deduction: 1_001n }), "deduction-above-deposit");
  });
  it("refuses when there is no dispute account, or no appraiser is bound", async () => {
    const a = await world({ dispute: "none" });
    await refuses(a.chain.submit({ lease: a.lease, deduction: 1n }), "no-dispute");
    const b = await world({ dispute: "unbound" });
    await refuses(b.chain.submit({ lease: b.lease, deduction: 1n }), "appraiser-not-bound");
    assert.equal(a.runs() + b.runs(), 0);
  });
  it("refuses an unregistered or suspended bound appraiser", async () => {
    const a = await world({ record: "none" });
    await refuses(a.chain.submit({ lease: a.lease, deduction: 1n }), "appraiser-unregistered");
    const b = await world({ record: "suspended" });
    await refuses(b.chain.submit({ lease: b.lease, deduction: 1n }), "appraiser-inactive");
  });
  it("signs only for the chain-bound appraiser: holding some other appraiser's key is not enough", async () => {
    const w = await world({ haveKey: false });
    await refuses(w.chain.submit({ lease: w.lease, deduction: 1n }), "no-appraiser-key");
    assert.equal(w.runs(), 0);
  });
  it("plan (the dry run) applies the same platform-key and admin refusals as submit", async () => {
    const a = await world({ platform: true });
    await refuses(a.chain.plan({ lease: a.lease, deduction: 1n }), "appraiser-is-platform-key");
    const b = await world({ adminIsAppraiser: true });
    await refuses(b.chain.plan({ lease: b.lease, deduction: 1n }), "appraiser-is-admin");
  });
  it("refuses a bound appraiser that is a platform key or the Config admin", async () => {
    const a = await world({ platform: true });
    await refuses(a.chain.submit({ lease: a.lease, deduction: 1n }), "appraiser-is-platform-key");
    const b = await world({ adminIsAppraiser: true });
    await refuses(b.chain.submit({ lease: b.lease, deduction: 1n }), "appraiser-is-admin");
    assert.equal(a.runs() + b.runs(), 0);
  });
});

describe("redaction", () => {
  it("redactSecrets covers the console token and each appraiser key spec", async () => {
    const { env } = await import("../src/env.ts");
    (env.appraisers as { keypairs: string }).keypairs = "AAAAAAAAAAAAAAAAAAAAAAAA;BBBBBBBBBBBBBBBBBBBBBBBB";
    (env.appraisers as { consoleToken: string }).consoleToken = "console-token-1234567890";
    const out = redactSecrets("x AAAAAAAAAAAAAAAAAAAAAAAA y BBBBBBBBBBBBBBBBBBBBBBBB z console-token-1234567890");
    assert.equal(out, "x <redacted> y <redacted> z <redacted>");
  });
});
