import "./noenv.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { getBase58Decoder } from "@solana/kit";
import { KeySpecError, generateKeyPairBytes, loadKeyPairSigner, parseKeyPairBytes, redactSecrets } from "../src/keys.ts";

// Review F3. A key spec is either a PATH or the SECRET ITSELF, and an error cannot tell which. The
// old parser sent anything not starting with "[" to readFileSync, whose ENOENT message quotes its
// argument, and kept the raw error as `cause`, which Node's inspector prints. So a base58 secret in
// TREASURY_KEYPAIR was echoed by the first failure on the way to loading it.

/** Everything an operator could end up pasting from a failure: message, stack, and the whole cause chain. */
const everythingPrinted = (e: unknown) => `${String((e as Error)?.message)}\n${(e as Error)?.stack}\n${inspect(e, { depth: 10 })}`;
const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

describe("key specs never leak into errors", () => {
  it("loads a base58 secret as the key itself, not as a path", async () => {
    const bytes = await generateKeyPairBytes();
    const viaJson = await loadKeyPairSigner(JSON.stringify([...bytes]), "k");
    const viaBase58 = await loadKeyPairSigner(base58(bytes), "k");
    assert.equal(viaBase58.address, viaJson.address);
  });

  // The review's exact reproduction: a secret-looking value that is not a valid key.
  it("does not echo a secret-looking spec that is not a valid key", async () => {
    const fake = "5FakeNotARealSecretKeyThatIsLongEnoughToLookReal1234567890abcdefghijkmnopq";
    const error = await loadKeyPairSigner(fake, "treasury").catch((e: unknown) => e);
    assert.ok(error instanceof KeySpecError);
    assert.ok(!everythingPrinted(error).includes(fake), "the spec appeared in the printed error");
    assert.equal((error as Error).cause, undefined, "a cause would be printed by the inspector");
  });

  it("does not echo a well-formed base58 string of the wrong length", async () => {
    const wrong = base58((await generateKeyPairBytes()).slice(0, 40));
    const error = await loadKeyPairSigner(wrong, "treasury").catch((e: unknown) => e);
    assert.ok(!everythingPrinted(error).includes(wrong));
  });

  it("does not echo malformed inline JSON", async () => {
    const spec = "[1,2,3,SECRETMARKER";
    const error = await loadKeyPairSigner(spec, "treasury").catch((e: unknown) => e);
    assert.ok(!everythingPrinted(error).includes("SECRETMARKER"));
    assert.throws(() => parseKeyPairBytes(spec), (e) => !everythingPrinted(e).includes("SECRETMARKER"));
  });

  it("does not echo the contents of a key file that cannot be parsed", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "keys-")), "bad.json");
    writeFileSync(file, "this is SECRETMARKER and not a key");
    const error = await loadKeyPairSigner(file, "treasury").catch((e: unknown) => e);
    assert.ok(error instanceof KeySpecError);
    assert.ok(!everythingPrinted(error).includes("SECRETMARKER"));
  });

  it("still reads a key file", async () => {
    const bytes = await generateKeyPairBytes();
    const file = join(mkdtempSync(join(tmpdir(), "keys-")), "ok.json");
    writeFileSync(file, JSON.stringify([...bytes]));
    assert.deepEqual([...parseKeyPairBytes(file)], [...bytes]);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of a configured secret", () => {
    assert.equal(redactSecrets("a SECRETVALUE12345 b SECRETVALUE12345", ["SECRETVALUE12345"]), "a <redacted> b <redacted>");
  });
  it("ignores values too short to be a secret rather than mangling the text", () => {
    assert.equal(redactSecrets("a b c", ["a"]), "a b c");
  });
});

describe("scripts/exit-gate.ts", () => {
  // End to end: the gate with a base58 SECRET in TREASURY_KEYPAIR that is not a valid key. It must
  // fail on the key and print nothing of it. Hermetic: the failure is before any network call.
  it("never prints a secret it fails to load", () => {
    const fake = "5FakeNotARealSecretKeyThatIsLongEnoughToLookReal1234567890abcdefghijkmnopq";
    const repo = resolve(import.meta.dirname, "../..");
    const run = spawnSync(process.execPath, ["scripts/exit-gate.ts", "--probe"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, TREASURY_KEYPAIR: fake, FEE_PAYER_KEYPAIR: fake + "2", RUSDC_MINT: "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6", RUSDC_AUDITOR_IKM: "aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybA==" },
      timeout: 60_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.status, 0, "the gate should fail on an unreadable key");
    assert.ok(!output.includes(fake), "the secret appeared in the gate's output");
    assert.ok(!output.includes(fake + "2"));
  });
});
