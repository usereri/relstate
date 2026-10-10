import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM, MEMO_PROGRAM } from "../src/contracts.ts";
import { PAY_RENT_DISCRIMINATOR, RENT_PAYMENT_ALLOWLIST, assertRentPaymentShape, type RentPaymentRules } from "../src/rentshape.ts";
import { RejectedTransaction, inspectTransaction } from "../src/txinspect.ts";
import { RELSTATE, SYSTEM, TOKEN22, W, R, WS, RS, ZK, acct, build, cast, createAccountData, ix, plan, tx1, tx5, type Cast } from "./rentfixtures.ts";

async function check(c: Cast, instructions: Instruction[], rules: RentPaymentRules = c.rules) {
  const tx = inspectTransaction(await build(c, instructions), { maxBytes: 1232, maxInstructions: 32 });
  return () => assertRentPaymentShape(tx, rules);
}
/** Asserts a rejection; `code` is checked when the filter sets a specific one, the message otherwise. */
async function denied(c: Cast, instructions: Instruction[], expected: string | RegExp, rules?: RentPaymentRules) {
  const run = await check(c, instructions, rules);
  assert.throws(run, (e) => {
    assert.ok(e instanceof RejectedTransaction, `expected RejectedTransaction, got ${String(e)}`);
    return typeof expected === "string" ? e.code === expected : expected.test(e.message);
  });
}
const accepted = async (c: Cast, instructions: Instruction[]) => (await check(c, instructions))();

describe("rent payment allowlist", () => {
  // A regression guard: widening this list widens what a treasury-cosigned transaction may call.
  it("is exactly System, Token-2022, ZK ElGamal, relstate and ComputeBudget", () => {
    assert.deepEqual(
      [...RENT_PAYMENT_ALLOWLIST].sort(),
      [SYSTEM, TOKEN22, ZK, RELSTATE, "ComputeBudget111111111111111111111111111111"].sort(),
    );
  });
});

describe("the real plan shape", () => {
  it("accepts tx 1: createAccount into a ZK-owned context and a proof verify", async () => {
    const c = await cast();
    await accepted(c, tx1(c));
  });

  it("accepts tx 5: transfer, pay_rent directly after it, then three closes", async () => {
    const c = await cast();
    await accepted(c, tx5(c));
  });

  it("accepts compute-budget instructions around the plan", async () => {
    const c = await cast();
    const p = plan(c);
    await accepted(c, [p.computeLimit(), p.computePrice(1000n), ...tx5(c)]);
  });

  it("accepts the caps exactly: lamports, space and the number of creates", async () => {
    const c = await cast();
    const p = plan(c);
    await accepted(c, [p.createContext(c.ctxA, { lamports: 5_000_000n, space: 512n }), p.createContext(c.ctxB)]);
  });
});

describe("rent payment shape: the treasury in a Token-2022 instruction", () => {
  const roles: Array<[string, (c: Cast) => ReturnType<typeof acct>[]]> = [
    ["as the source", (c) => [acct(c.treasury.address, W), acct(c.mint, R), acct(c.destToken, W), acct(c.wallet, RS)]],
    ["as the mint", (c) => [acct(c.walletToken, W), acct(c.treasury.address, R), acct(c.destToken, W), acct(c.wallet, RS)]],
    ["as the destination", (c) => [acct(c.walletToken, W), acct(c.mint, R), acct(c.treasury.address, W), acct(c.wallet, RS)]],
    ["as the authority", (c) => [acct(c.walletToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.treasury.address, RS)]],
    ["as a proof-context account", (c) => [acct(c.walletToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.treasury.address, R), acct(c.wallet, RS)]],
  ];
  for (const [name, accounts] of roles) {
    it(`rejects a confidential transfer with the treasury ${name}`, async () => {
      const c = await cast();
      await denied(c, [plan(c).transfer(accounts(c))], "treasury-in-token-instruction");
    });
  }

  // Only [27, 7] is allowed at all: the treasury is the mint and freeze authority, so any other
  // Token-2022 instruction is a way to mint, freeze or burn.
  const others: Array<[string, number[]]> = [
    ["MintTo", [7, 1, 0, 0, 0, 0, 0, 0, 0]],
    ["Burn", [8, 1, 0, 0, 0, 0, 0, 0, 0]],
    ["FreezeAccount", [10]],
    ["ThawAccount", [11]],
    ["SetAuthority", [6, 0, 0]],
    ["plain Transfer", [3, 1, 0, 0, 0, 0, 0, 0, 0]],
    ["TransferChecked", [12, 1, 0, 0, 0, 0, 0, 0, 0, 6]],
    ["another confidential-transfer sub-instruction", [27, 8]],
    ["a confidential-transfer extension byte alone", [27]],
    ["no data at all", []],
  ];
  for (const [name, data] of others) {
    for (const withTreasury of [true, false]) {
      it(`rejects ${name} ${withTreasury ? "naming the treasury" : "without the treasury"}`, async () => {
        const c = await cast();
        const accounts = withTreasury
          ? [acct(c.walletToken, W), acct(c.mint, W), acct(c.treasury.address, RS)]
          : [acct(c.walletToken, W), acct(c.mint, W), acct(c.wallet, RS)];
        await denied(c, [ix(TOKEN22, data, accounts)], /not permitted/);
      });
    }
  }
});

describe("rent payment shape: System program", () => {
  const sysData = (tag: number, length: number) => {
    const d = new Uint8Array(length);
    new DataView(d.buffer).setUint32(0, tag, true);
    return d;
  };

  it("rejects a System transfer out of the treasury", async () => {
    const c = await cast();
    await denied(c, [ix(SYSTEM, [2, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0], [acct(c.treasury.address, WS), acct(c.other.address, W)])], /only System createAccount/);
  });

  it("rejects Assign, Allocate and CreateAccountWithSeed", async () => {
    const c = await cast();
    for (const [tag, length] of [[1, 36], [8, 12], [3, 100], [9, 44], [4, 76]] as const) {
      await denied(c, [ix(SYSTEM, sysData(tag, length), [acct(c.treasury.address, WS), acct(c.other.address, WS)])], /only System createAccount/);
    }
  });

  it("rejects a 52-byte instruction whose tag is not createAccount", async () => {
    const c = await cast();
    await denied(c, [ix(SYSTEM, sysData(2, 52), [acct(c.treasury.address, WS), acct(c.other.address, W)])], /only System createAccount/);
  });

  it("rejects a createAccount whose data is the wrong length", async () => {
    const c = await cast();
    for (const length of [51, 53, 0, 4]) {
      await denied(c, [ix(SYSTEM, createAccountData(1n, 100n, ZK, length), [acct(c.treasury.address, WS), acct(c.ctxA, WS)])], /only System createAccount/);
    }
  });

  it("rejects a createAccount into an account the ZK program does not own", async () => {
    const c = await cast();
    const p = plan(c);
    for (const owner of [SYSTEM, TOKEN22, RELSTATE, c.other.address]) {
      await denied(c, [p.createContext(c.ctxA, { owner })], /must be owned by the ZK proof program/);
    }
  });

  it("rejects lamports above maxContextLamports", async () => {
    const c = await cast();
    await denied(c, [plan(c).createContext(c.ctxA, { lamports: 5_000_001n })], "context-too-expensive");
  });

  it("rejects space 0 and space above maxContextSpace", async () => {
    const c = await cast();
    await denied(c, [plan(c).createContext(c.ctxA, { space: 0n })], "context-too-large");
    await denied(c, [plan(c).createContext(c.ctxA, { space: 513n })], "context-too-large");
  });

  it("rejects the treasury as the new account", async () => {
    const c = await cast();
    await denied(c, [ix(SYSTEM, createAccountData(1n, 100n, ZK), [acct(c.treasury.address, WS), acct(c.treasury.address, WS)])], /funded by the treasury into a different account/);
  });

  it("rejects a createAccount funded by anyone but the treasury, or with the wrong account count", async () => {
    const c = await cast();
    const data = createAccountData(1n, 100n, ZK);
    await denied(c, [ix(SYSTEM, data, [acct(c.wallet, WS), acct(c.ctxA, WS)])], /funded by the treasury/);
    await denied(c, [ix(SYSTEM, data, [acct(c.treasury.address, WS), acct(c.ctxA, WS), acct(c.ctxB, WS)])], /funded by the treasury/);
    await denied(c, [ix(SYSTEM, data, [acct(c.treasury.address, WS)])], /funded by the treasury/);
  });

  it("rejects more than maxCreateAccounts creates", async () => {
    const c = await cast();
    const p = plan(c);
    await denied(c, [p.createContext(c.ctxA), p.createContext(c.ctxB), p.createContext(c.ctxC)], "too-many-accounts");
  });
});

describe("rent payment shape: ZK proof program", () => {
  it("rejects a close whose lamport destination is not the treasury", async () => {
    const c = await cast();
    const bad = ix(ZK, [0], [acct(c.ctxA.address, W), acct(c.wallet.address, W), acct(c.treasury.address, RS)]);
    await denied(c, [bad], "close-destination");
  });

  it("rejects a close whose authority is not the treasury", async () => {
    const c = await cast();
    const bad = ix(ZK, [0], [acct(c.ctxA.address, W), acct(c.treasury.address, W), acct(c.wallet, RS)]);
    await denied(c, [bad], "close-destination");
  });

  it("rejects a close with the wrong number of accounts", async () => {
    const c = await cast();
    await denied(c, [ix(ZK, [0], [acct(c.ctxA.address, W), acct(c.treasury.address, W)])], "close-destination");
    await denied(c, [ix(ZK, [0], [acct(c.ctxA.address, W), acct(c.treasury.address, W), acct(c.treasury.address, RS), acct(c.other.address, R)])], "close-destination");
    await denied(c, [ix(ZK, [0], [])], "close-destination");
  });

  it("rejects the treasury as the context being closed or verified", async () => {
    const c = await cast();
    const t = c.treasury.address;
    await denied(c, [ix(ZK, [0], [acct(t, W), acct(t, W), acct(t, RS)])], /cannot be the context-state account/);
    await denied(c, [ix(ZK, [3, 1], [acct(t, W), acct(t, R)])], /cannot be the context-state account/);
  });

  it("rejects the treasury at any index of a verify beyond the authority slot", async () => {
    const c = await cast();
    const t = c.treasury.address;
    await denied(c, [ix(ZK, [3, 1], [acct(c.ctxA.address, W), acct(c.other.address, R), acct(t, R)])], /must record the treasury as its context-state authority/);
    await denied(c, [ix(ZK, [3, 1], [acct(c.ctxA.address, W), acct(t, R), acct(c.other.address, R), acct(t, R)])], /must record the treasury as its context-state authority/);
  });

  // The direction the suite did not cover. Rejecting the treasury everywhere BUT slot 1 is not the
  // same as requiring it IN slot 1: the authority is only recorded at verify time (it is not a
  // signer), so a client who names themselves keeps the power to close the context we funded, to
  // themselves, in a transaction of their own, outside any route.
  describe("the context-state authority must be the treasury", () => {
    it("refuses a verify that records the attacker's wallet as authority (tx 1 shape)", async () => {
      const c = await cast();
      const p = plan(c);
      await denied(c, [p.createContext(c.ctxA), ix(ZK, [3, 1, 2, 3], [acct(c.ctxA.address, W), acct(c.wallet, R)])], "wrong-context-authority");
    });

    it("refuses it at the maximum cost: two max-size contexts, both naming the attacker", async () => {
      const c = await cast();
      const big = { lamports: c.rules.maxContextLamports, space: c.rules.maxContextSpace };
      await denied(
        c,
        [
          ix(SYSTEM, createAccountData(big.lamports, big.space, ZK), [acct(c.treasury.address, WS), acct(c.ctxA.address, WS)]),
          ix(SYSTEM, createAccountData(big.lamports, big.space, ZK), [acct(c.treasury.address, WS), acct(c.ctxB.address, WS)]),
          ix(ZK, [3, 1], [acct(c.ctxA.address, W), acct(c.wallet, R)]),
          ix(ZK, [7, 1], [acct(c.ctxB.address, W), acct(c.wallet, R)]),
        ],
        "wrong-context-authority",
      );
    });

    it("refuses any other pubkey as the authority", async () => {
      const c = await cast();
      await denied(c, [ix(ZK, [3, 1], [acct(c.ctxA.address, W), acct(c.other.address, R)])], "wrong-context-authority");
    });

    it("refuses a verify with only the context account, and one with a third account", async () => {
      const c = await cast();
      await denied(c, [ix(ZK, [3, 1], [acct(c.ctxA.address, W)])], "wrong-context-authority");
      await denied(c, [ix(ZK, [3, 1], [acct(c.ctxA.address, W), acct(c.treasury.address, R), acct(c.other.address, R)])], "wrong-context-authority");
    });

    it("refuses an inline-proof verify with no accounts at all", async () => {
      const c = await cast();
      await denied(c, [ix(ZK, [3, 1], [])], "wrong-context-authority");
    });

    it("still accepts the legitimate authority", async () => {
      const c = await cast();
      await accepted(c, tx1(c));
    });
  });

  it("rejects ZK tags 13 and 255 and an empty instruction", async () => {
    const c = await cast();
    for (const data of [[13], [255], []]) {
      await denied(c, [ix(ZK, data, [acct(c.ctxA.address, W), acct(c.treasury.address, R)])], /tag .* is not permitted/);
    }
  });
});

describe("rent payment shape: the confidential transfer", () => {
  it("rejects a source that is not the wallet's own token account", async () => {
    const c = await cast();
    const accounts = [acct(c.destToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.wallet, RS)];
    await denied(c, [plan(c).transfer(accounts)], "wrong-source");
  });

  it("rejects a mint that is not rUSDC", async () => {
    const c = await cast();
    const accounts = [acct(c.walletToken, W), acct(c.other.address, R), acct(c.destToken, W), acct(c.wallet, RS)];
    await denied(c, [plan(c).transfer(accounts)], "wrong-mint");
  });

  it("rejects an authority that is not the wallet", async () => {
    const c = await cast();
    const accounts = [acct(c.walletToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.other, RS)];
    await denied(c, [plan(c).transfer(accounts)], "wrong-authority");
  });

  it("rejects the wallet as authority when it is not a signer", async () => {
    const c = await cast();
    const accounts = [acct(c.walletToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.wallet.address, R)];
    await denied(c, [plan(c).transfer(accounts)], "wrong-authority");
  });

  it("rejects an instruction with no accounts", async () => {
    const c = await cast();
    await denied(c, [plan(c).transfer([])], "wrong-source");
  });

  it("rejects two transfers in one transaction", async () => {
    const c = await cast();
    const p = plan(c);
    await denied(c, [p.transfer(), p.transfer()], /more than one confidential transfer/);
  });

  it("rejects transfer data above 512 bytes, and accepts exactly 512", async () => {
    const c = await cast();
    const p = plan(c);
    await denied(c, [p.transfer(undefined, [27, 7, ...new Array(511).fill(1)])], /cap is 512/);
    await accepted(c, [p.transfer(undefined, [27, 7, ...new Array(510).fill(1)])]);
  });
});

describe("rent payment shape: pay_rent", () => {
  it("rejects a wrong discriminator, an extended one and a truncated one", async () => {
    const c = await cast();
    const p = plan(c);
    const flipped = new Uint8Array(PAY_RENT_DISCRIMINATOR);
    flipped[0]! ^= 1;
    await denied(c, [p.transfer(), p.payRent(undefined, flipped)], /only pay_rent/);
    await denied(c, [p.transfer(), p.payRent(undefined, new Uint8Array([...PAY_RENT_DISCRIMINATOR, 0]))], /only pay_rent/);
    await denied(c, [p.transfer(), p.payRent(undefined, PAY_RENT_DISCRIMINATOR.subarray(0, 7))], /only pay_rent/);
  });

  it("rejects a tenant that is not the wallet, or is not a signer", async () => {
    const c = await cast();
    const p = plan(c);
    const accounts = (tenant: ReturnType<typeof acct>) => [tenant, acct(c.lease, W), acct(c.mint, R), acct(c.walletToken, W), acct(c.destToken, W), acct(c.profile, W)];
    await denied(c, [p.transfer(), p.payRent(accounts(acct(c.other, WS)))], "wrong-authority");
    // (A pay_rent whose tenant is the wallet but not a signer cannot be built here: the transfer
    // before it already makes the wallet a signer in the message header, and roles are per message.)
    await denied(c, [p.transfer(), p.payRent([])], "wrong-authority");
  });

  it("rejects the wrong mint and the wrong token account", async () => {
    const c = await cast();
    const p = plan(c);
    const base = (mint: Address, token: Address) => [acct(c.wallet, WS), acct(c.lease, W), acct(mint, R), acct(token, W), acct(c.destToken, W)];
    await denied(c, [p.transfer(), p.payRent(base(c.other.address, c.walletToken))], "wrong-mint");
    await denied(c, [p.transfer(), p.payRent(base(c.mint, c.destToken))], "wrong-mint");
    await denied(c, [p.transfer(), p.payRent([acct(c.wallet, WS), acct(c.lease, W)])], "wrong-mint");
  });

  it("rejects the treasury anywhere among its accounts", async () => {
    const c = await cast();
    const p = plan(c);
    for (let slot = 1; slot < 8; slot++) {
      if (slot === 2 || slot === 3) continue; // those slots are pinned to the mint and token account
      const accounts = [acct(c.wallet, WS), acct(c.lease, W), acct(c.mint, R), acct(c.walletToken, W), acct(c.destToken, W), acct(c.profile, W), acct(TOKEN22, R), acct(SYSTEM, R)];
      accounts[slot] = acct(c.treasury.address, W);
      await denied(c, [p.transfer(), p.payRent(accounts)], "treasury-in-program-instruction");
    }
  });

  it("rejects pay_rent when it is the first instruction", async () => {
    const c = await cast();
    await denied(c, [plan(c).payRent()], "missing-transfer");
  });

  it("rejects pay_rent with no transfer before it, or with a different instruction between", async () => {
    const c = await cast();
    const p = plan(c);
    await denied(c, [p.verify(), p.payRent()], "missing-transfer");
    await denied(c, [p.transfer(), p.computeLimit(), p.payRent()], "missing-transfer");
    await denied(c, [p.transfer(), p.close(c.ctxA.address), p.payRent()], "missing-transfer");
    await denied(c, [p.payRent(), p.transfer()], "missing-transfer");
  });

  it("rejects two pay_rents, however they are arranged", async () => {
    const c = await cast();
    const p = plan(c);
    await denied(c, [p.transfer(), p.payRent(), p.payRent()], "missing-transfer");
    await denied(c, [p.transfer(), p.payRent(), p.transfer(), p.payRent()], /more than one confidential transfer/);
  });
});

describe("rent payment shape: programs", () => {
  it("rejects the associated-token program and the memo program", async () => {
    const c = await cast();
    for (const program of [ASSOCIATED_TOKEN_PROGRAM, MEMO_PROGRAM, "Stake11111111111111111111111111111111111111"]) {
      await denied(c, [...tx1(c), ix(program as Address, [1], [acct(c.wallet, WS)])], "program-not-allowed");
    }
  });
});
