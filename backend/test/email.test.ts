import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConsoleEmailSender, maskEmail } from "../src/email.ts";

describe("createConsoleEmailSender", () => {
  it("logs the masked address, never the full one, in mock mode", async () => {
    const lines: string[] = [];
    const sender = createConsoleEmailSender({ log: (...args) => lines.push(args.join(" ")), mode: "mock" });
    await sender.send({ to: "biuro@acme.example", subject: "s", text: "body" });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /e-mail to b\*\*\*@acme\.example:/);
    assert.equal(lines[0]!.includes("biuro@acme.example"), false, "the full address must not appear in the log line");
  });

  it("logs the masked address, never the full one, in live mode (S3)", async () => {
    const lines: string[] = [];
    const sender = createConsoleEmailSender({ log: (...args) => lines.push(args.join(" ")), mode: "live" });
    await sender.send({ to: "biuro@acme.example", subject: "s", text: "see https://x/t/secret-token", secrets: ["secret-token"] });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /e-mail to b\*\*\*@acme\.example:/);
    assert.equal(lines[0]!.includes("biuro@acme.example"), false, "the full address must not appear in the log line");
    assert.equal(lines[0]!.includes("secret-token"), false, "the secret must still be redacted");
  });
});

describe("maskEmail", () => {
  it("keeps the first local character and the domain", () => {
    assert.equal(maskEmail("biuro@acme.example"), "b***@acme.example");
  });
});
