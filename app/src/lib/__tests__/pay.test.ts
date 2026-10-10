import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseView, Me } from "../chain";
import type { WalletProvider } from "../wallet";

// pay.ts reaches the kit island only through `chain.confidential()`, and chain.ts builds a
// Connection at import. Faking both keeps these tests off the network and off the zk wasm.
const log: string[] = [];
const conf = {
  openSession: vi.fn(),
  accountState: vi.fn(),
  mintDecimals: vi.fn(),
  loadBalance: vi.fn(),
  planCreateAccount: vi.fn(),
  planDeposit: vi.fn(),
  planApplyPending: vi.fn(),
  planTransfer: vi.fn(),
  transferMessageIndex: vi.fn(),
  confidentialTokenAccount: vi.fn(),
  fromWeb3Instruction: vi.fn(),
  runPlan: vi.fn(),
};
const chainErrorMessage = vi.fn((e: unknown) => `chain:${String(e)}`);

vi.mock("../chain", () => ({
  confidential: async () => conf,
  payRentInstruction: vi.fn(async () => ({})),
  errorMessage: (e: unknown) => chainErrorMessage(e),
}));
vi.mock("../mint", () => ({ mintKind: vi.fn(async () => ({ confidential: true, decimals: 6 })) }));

const { PayError, enablePrivateReceiving, format, payErrorMessage, payRentPrivately, securePrivateBalance } = await import("../pay");

const wallet = {} as WalletProvider;
type Message = { tag: string };
const submit = vi.fn(async (m: Message) => {
  log.push(`submit:${m.tag}`);
  return `sig-${m.tag}`;
});
const submitSetup = vi.fn(async (m: Message) => {
  log.push(`submitSetup:${m.tag}`);
  return `setup-${m.tag}`;
});
// The rent payment's proof plan funds its context-state accounts from the payer, which /api/sponsor
// refuses, so it has its own route and its own (treasury) payer.
const submitRentPayment = vi.fn(async (m: Message) => {
  log.push(`submitRent:${m.tag}`);
  return `rent-${m.tag}`;
});
const payer = { address: "sponsor" };
const setupPayer = { address: "treasury" };

beforeEach(() => {
  log.length = 0;
  vi.clearAllMocks();
  conf.openSession.mockResolvedValue({ submit, submitSetup, submitRentPayment, payer, setupPayer });
  conf.accountState.mockResolvedValue({ exists: true, configured: true, publicAmount: 0n });
  conf.mintDecimals.mockResolvedValue(6);
  conf.planCreateAccount.mockImplementation(async () => (log.push("plan:create"), [{ tag: "create" }]));
  conf.planDeposit.mockImplementation(async () => (log.push("plan:deposit"), [{ tag: "deposit" }]));
  conf.planApplyPending.mockImplementation(async () => (log.push("plan:apply"), [{ tag: "apply" }]));
  // The real runPlan submits each message through the session in order; the fake keeps that contract.
  conf.runPlan.mockImplementation(async (session: { submit: (m: Message) => Promise<string> }, messages: Message[]) => {
    const out: string[] = [];
    for (const m of messages) out.push(await session.submit(m));
    return out;
  });
});

describe("format", () => {
  it("renders base units with the default six decimals", () => {
    expect(format(2_500_000n)).toBe("2.50");
  });

  it("renders zero as 0.00", () => {
    expect(format(0n)).toBe("0.00");
  });

  // The backend does this in integer arithmetic; a rounded-up figure here would disagree with it.
  it("truncates to two places and never rounds up", () => {
    expect(format(1_999_999n)).toBe("1.99");
    expect(format(9_999n)).toBe("0.00");
    expect(format(10_000n)).toBe("0.01");
  });

  it("groups thousands", () => {
    expect(format(1_234_567_890_000n)).toBe("1,234,567.89");
  });

  it("honours a non-default number of decimals", () => {
    expect(format(12_345n, 2)).toBe("123.45");
    expect(format(1_500_000_000n, 9)).toBe("1.50");
    expect(format(7n, 0)).toBe("7.00");
  });

  it("accepts a number as well as a bigint", () => {
    expect(format(2_000_000)).toBe(format(2_000_000n));
  });
});

describe("payErrorMessage", () => {
  const JARGON = /elgamal|ciphertext|ATA\b|pending balance|discriminator/i;
  const cases: Array<[string, unknown, RegExp]> = [
    ["a 429", new Error("HTTP 429 Too Many Requests"), /rate-limiting/],
    ["a rate limit", new Error("rate limit exceeded"), /rate-limiting/],
    ["an expired blockhash", new Error("Blockhash expired"), /went stale/],
    ["insufficient funds", new Error("custom program error: insufficient funds"), /not enough/],
    ["MissingConfidentialTransfer", new Error("MissingConfidentialTransfer"), /wrong order/],
    ["no mint configured", new Error("No confidential mint configured (VITE_RUSDC_MINT)"), /no private-payment token/],
    ["missing key derivation", new Error("This wallet cannot derive confidential-balance keys"), /cannot hold a private balance/],
    ["no backend", new Error("No backend configured"), /not connected to a backend/],
    ["a network failure", new TypeError("Failed to fetch"), /Could not reach the backend/],
  ];

  for (const [name, error, expected] of cases) {
    it(`maps ${name} to its own sentence, free of crypto jargon`, () => {
      const message = payErrorMessage(error);
      expect(message).toMatch(expected);
      expect(message).not.toMatch(JARGON);
      expect(chainErrorMessage).not.toHaveBeenCalled();
    });
  }

  it("gives each distinct failure its own message", () => {
    // "429" and "rate limit" are two spellings of one failure, so they share a sentence.
    const messages = cases.filter(([name]) => name !== "a rate limit").map(([, e]) => payErrorMessage(e));
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("passes a PayError's own message through unchanged", () => {
    expect(payErrorMessage(new PayError("Ask your landlord. (429 expired)"))).toBe("Ask your landlord. (429 expired)");
  });

  it("falls through to chain.errorMessage for anything unrecognised", () => {
    const e = new Error("custom program error: 0x1771");
    expect(payErrorMessage(e)).toBe(`chain:${String(e)}`);
    expect(chainErrorMessage).toHaveBeenCalledWith(e);
  });
});

describe("securePrivateBalance", () => {
  it("moves the public balance minus the holdback", async () => {
    conf.accountState.mockResolvedValue({ exists: true, configured: true, publicAmount: 10_000_000n });
    const result = await securePrivateBalance({ wallet, holdback: 3_000_000n });
    expect(conf.planDeposit).toHaveBeenCalledWith(expect.anything(), { amount: 7_000_000n, decimals: 6 });
    expect(result).toMatchObject({ secured: 7_000_000n, heldBack: 3_000_000n, createdAccount: false });
  });

  for (const holdback of [10_000_000n, 12_000_000n]) {
    it(`moves nothing and sends nothing when the holdback is ${holdback} of a 10000000 balance`, async () => {
      conf.accountState.mockResolvedValue({ exists: true, configured: true, publicAmount: 10_000_000n });
      const result = await securePrivateBalance({ wallet, holdback });
      expect(result).toMatchObject({ secured: 0n, heldBack: holdback });
      expect(conf.planDeposit).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(submitSetup).not.toHaveBeenCalled();
    });
  }

  // The deposit changes what apply-pending has to re-encrypt, so a plan built first is rejected on chain.
  it("builds apply-pending only after the deposit has been submitted", async () => {
    conf.accountState.mockResolvedValue({ exists: true, configured: true, publicAmount: 5_000_000n });
    await securePrivateBalance({ wallet });
    expect(log).toEqual(["plan:deposit", "submit:deposit", "plan:apply", "submit:apply"]);
  });

  // Account setup is co-signed by a different backend route; sending it to /api/sponsor is a silent 400.
  it("submits first-use account setup through submitSetup, and the deposit through submit", async () => {
    conf.accountState
      .mockResolvedValueOnce({ exists: true, configured: false, publicAmount: 0n })
      .mockResolvedValue({ exists: true, configured: true, publicAmount: 5_000_000n });
    const result = await securePrivateBalance({ wallet });
    expect(result.createdAccount).toBe(true);
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submitSetup:create", "submit:deposit", "submit:apply"]);
  });
});

describe("enablePrivateReceiving", () => {
  it("creates the account through submitSetup and moves no balance", async () => {
    conf.accountState.mockResolvedValue({ exists: true, configured: false, publicAmount: 9_000_000n });
    const result = await enablePrivateReceiving({ wallet });
    expect(result.created).toBe(true);
    expect(log).toEqual(["plan:create", "submitSetup:create"]);
    expect(conf.planDeposit).not.toHaveBeenCalled();
  });

  it("does nothing for an account that is already configured", async () => {
    const result = await enablePrivateReceiving({ wallet });
    expect(result).toEqual({ created: false, signatures: [] });
    expect(log).toEqual([]);
  });
});

describe("payRentPrivately", () => {
  const me = { wallet } as unknown as Me;
  const lease = { rent: 2_000_000, mint: "mint", landlord: "landlord" } as unknown as LeaseView;

  beforeEach(() => {
    conf.loadBalance.mockResolvedValue({ availableBalance: 5_000_000n, pendingBalance: 0n, totalBalance: 5_000_000n });
    conf.confidentialTokenAccount.mockResolvedValue("landlord-token");
    conf.fromWeb3Instruction.mockResolvedValue({});
    conf.planTransfer.mockResolvedValue([{ tag: "proof" }, { tag: "transfer" }]);
    conf.transferMessageIndex.mockReturnValue(1);
  });

  it("reports the signature of the transaction that carries the transfer", async () => {
    const result = await payRentPrivately({ me, lease });
    expect(result.signature).toBe("rent-transfer");
    expect(result.signatures).toEqual(["rent-proof", "rent-transfer"]);
  });

  it("plans and sends the whole rent payment through the treasury route, never /api/sponsor", async () => {
    await payRentPrivately({ me, lease });
    const planned = conf.planTransfer.mock.calls[0]![0] as { payer: unknown };
    expect(planned.payer).toBe(setupPayer);
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submitRent:proof", "submitRent:transfer"]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("throws an actionable PayError, and sends nothing, when the landlord's account is not set up", async () => {
    conf.accountState.mockImplementation(async (_s: unknown, token?: string) => ({ exists: true, configured: token === undefined, publicAmount: 0n }));
    const error = await payRentPrivately({ me, lease }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayError);
    expect((error as InstanceType<typeof PayError>).actionable).toBe(true);
    expect((error as Error).message).toMatch(/landlord/i);
    expect(conf.planTransfer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses with a PayError when the balance cannot cover the rent", async () => {
    conf.loadBalance.mockResolvedValue({ availableBalance: 1_000_000n, pendingBalance: 0n, totalBalance: 1_000_000n });
    await expect(payRentPrivately({ me, lease })).rejects.toThrow(/Add funds first/);
    expect(conf.planTransfer).not.toHaveBeenCalled();
  });
});
