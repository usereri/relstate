import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import idl from "@target/idl/relstate.json";

// chain.ts builds a Connection at module load and config.ts needs an RPC; neither touches the
// network for the pure error-mapping functions under test here.
beforeEach(() => vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899"));
afterEach(() => vi.unstubAllEnvs());

async function load() {
  vi.resetModules();
  return import("../chain");
}

// Read the codes from the IDL, not hard-coded: the point is that the app and the program agree,
// and a reordering of the program's errors must move both.
const errors = (idl as { errors: { name: string; code: number; msg?: string }[] }).errors;
const codeOf = (name: string) => errors.find((e) => e.name === name)!;
const hex = (n: number) => `0x${n.toString(16)}`;

describe("programErrorMessage", () => {
  it("maps KycRequired by name", async () => {
    const { programErrorMessage } = await load();
    expect(programErrorMessage("Error: KycRequired")).toMatch(/Verify your identity/);
  });

  it("maps KycRequired by its custom program error hex code", async () => {
    const { programErrorMessage } = await load();
    const { code } = codeOf("KycRequired");
    expect(programErrorMessage(`Program log: custom program error: ${hex(code)}`)).toMatch(/Verify your identity/);
  });

  it("maps KycRequired from a simulation failure's InstructionError JSON", async () => {
    const { programErrorMessage } = await load();
    const { code } = codeOf("KycRequired");
    const text = JSON.stringify({ InstructionError: [0, { Custom: code }] });
    expect(programErrorMessage(text)).toMatch(/Verify your identity/);
  });

  it("maps another known program error (TooEarly) to its friendly message", async () => {
    const { programErrorMessage } = await load();
    expect(programErrorMessage("Error: TooEarly")).toMatch(/not due yet/);
    const { code } = codeOf("TooEarly");
    expect(programErrorMessage(`custom program error: ${hex(code)}`)).toMatch(/not due yet/);
  });

  it("falls back to the IDL's own message for a program error with no friendly override", async () => {
    const { programErrorMessage, FRIENDLY_PROGRAM_ERRORS } = await load();
    // Read the friendly set off the exported map itself, not a re-listed copy: the two cannot drift.
    const friendly = new Set(Object.keys(FRIENDLY_PROGRAM_ERRORS));
    const other = errors.find((e) => !friendly.has(e.name) && e.msg);
    expect(other).toBeDefined();
    expect(programErrorMessage(other!.name)).toBe(other!.msg);
  });

  it("every one of the seventeen mediation errors (6038-6054, S3's BindingWindowClosed included) maps to a non-empty friendly message", async () => {
    const { programErrorMessage } = await load();
    const mediationErrors = errors.filter((e) => e.code >= 6038 && e.code <= 6054);
    expect(mediationErrors).toHaveLength(17);
    for (const e of mediationErrors) {
      expect(programErrorMessage(e.name), e.name).toBeTruthy();
    }
  });

  it("every key of FRIENDLY_PROGRAM_ERRORS names a real IDL error (a typo'd key would be dead code)", async () => {
    const { FRIENDLY_PROGRAM_ERRORS } = await load();
    const names = new Set(errors.map((e) => e.name));
    for (const key of Object.keys(FRIENDLY_PROGRAM_ERRORS)) {
      expect(names.has(key), key).toBe(true);
    }
  });

  it("is null for unrelated text", async () => {
    const { programErrorMessage } = await load();
    expect(programErrorMessage("just some network noise")).toBeNull();
    expect(programErrorMessage("")).toBeNull();
  });

  it("does not match a longer code that merely starts with a known one", async () => {
    const { programErrorMessage } = await load();
    const { code } = codeOf("KycRequired");
    expect(programErrorMessage(`{"Custom":${code}0}`)).toBeNull();
  });
});

describe("errorMessage", () => {
  it("prefers a known program error found in the message", async () => {
    const { errorMessage } = await load();
    expect(errorMessage({ message: "AnchorError: KycRequired" })).toMatch(/Verify your identity/);
  });

  it("prefers a known program error found inside the simulation logs", async () => {
    const { errorMessage } = await load();
    const { code } = codeOf("TooEarly");
    const err = { simulationResponse: { err: { InstructionError: [0, "Custom"] }, logs: [`Program log: custom program error: ${hex(code)}`] } };
    expect(errorMessage(err)).toMatch(/not due yet/);
  });

  it("falls back to error.errorMessage when no known program error matches", async () => {
    const { errorMessage } = await load();
    expect(errorMessage({ error: { errorMessage: "some anchor detail" } })).toBe("some anchor detail");
  });

  it("explains a simulation failure with AccountNotFound as an unfunded wallet", async () => {
    const { errorMessage } = await load();
    const err = { simulationResponse: { err: { InstructionError: [0, "AccountNotFound"] }, logs: [] } };
    expect(errorMessage(err)).toMatch(/no SOL on this network/);
  });

  it("includes the last log line for an otherwise unrecognised simulation failure", async () => {
    const { errorMessage } = await load();
    const err = { simulationResponse: { err: { InstructionError: [0, "Something"] }, logs: ["first", "last line here"] } };
    expect(errorMessage(err)).toMatch(/last line here/);
  });

  it("falls back to the bare message, or a generic string, with no other information", async () => {
    const { errorMessage } = await load();
    expect(errorMessage({ message: "boom" })).toBe("boom");
    expect(errorMessage({})).toBe("Something went wrong");
    expect(errorMessage(null)).toBe("Something went wrong");
  });

  it("explains a wallet error by name", async () => {
    const { errorMessage } = await load();
    const err = { name: "WalletSignTransactionError", message: "User rejected" };
    expect(errorMessage(err)).toMatch(/User rejected/);
    expect(errorMessage(err)).toMatch(/WalletSignTransactionError/);
  });

  it("explains the Token-2022 0x1 (insufficient public balance for the deposit) in plain language", async () => {
    const { errorMessage } = await load();
    const err = {
      simulationResponse: {
        err: { InstructionError: [0, "Custom"] },
        logs: ["Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1"],
      },
    };
    expect(errorMessage(err)).toMatch(/^Not enough public balance for the deposit/);
  });

  it("still explains the System program's 0x1 (rent) as an unfunded wallet, not the deposit message", async () => {
    const { errorMessage } = await load();
    const err = { message: "11111111111111111111111111111111 failed: custom program error: 0x1" };
    const message = errorMessage(err);
    expect(message).toMatch(/too little SOL to cover the storage rent/);
    expect(message).not.toMatch(/public balance for the deposit/);
  });
});
