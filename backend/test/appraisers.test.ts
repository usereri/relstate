import "./noenv.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  APPRAISER_FEE_CAP_DIVISOR,
  AppraiserConfigError,
  MAX_APPRAISER_NAME_LENGTH,
  UNSET_PUBKEY,
  appraiserNameHash,
  defaultAppraiser,
  hex,
  parseAppraiserDirectory,
  parseKeySpecs,
} from "../src/appraisers.ts";
import { constant } from "./idlfixtures.ts";

// The directory is the off-chain half of the registry, and the only place the "exactly one default"
// rule can be enforced before a transaction is sent: the program deliberately does not check it
// (docs/contracts/dispute-mediation.md §4, "The default appraiser").

const A = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const C = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

const directory = (entries: unknown) => JSON.stringify(entries);
const demo = [
  { name: "Rzeczoznawca A", wallet: A, fee: "2000000" },
  { name: "Rzeczoznawca B", wallet: B, fee: "1500000", default: true },
  { name: "Rzeczoznawca C", wallet: C, fee: 2_500_000 },
];

const refuses = (value: unknown, pattern: RegExp) =>
  assert.throws(() => parseAppraiserDirectory(typeof value === "string" ? value : directory(value)), (e: unknown) => e instanceof AppraiserConfigError && pattern.test(e.message));

describe("parseAppraiserDirectory", () => {
  it("treats an unset or blank value as an unconfigured directory, not an error", () => {
    for (const value of [undefined, "", "   ", "\n"]) assert.deepEqual(parseAppraiserDirectory(value), []);
  });

  it("parses the demo's three fictional firms, with the fee as base units either as a string or a number", () => {
    const entries = parseAppraiserDirectory(directory(demo));
    assert.deepEqual(
      entries.map((e) => [e.name, e.wallet, e.fee, e.isDefault]),
      [
        ["Rzeczoznawca A", A, 2_000_000n, false],
        ["Rzeczoznawca B", B, 1_500_000n, true],
        ["Rzeczoznawca C", C, 2_500_000n, false],
      ],
    );
    assert.equal(defaultAppraiser(entries)?.name, "Rzeczoznawca B");
    assert.equal(defaultAppraiser([]), undefined);
  });

  it("trims a name, and hashes exactly what it publishes", () => {
    const [entry] = parseAppraiserDirectory(directory([{ ...demo[1], name: "  Rzeczoznawca B  " }]));
    assert.equal(entry!.name, "Rzeczoznawca B");
    // The check a third party runs: hash the published name, compare with Appraiser.name_hash.
    assert.equal(hex(appraiserNameHash(entry!.name)), createHash("sha256").update("Rzeczoznawca B").digest("hex"));
  });

  it("accepts a zero fee: the program allows it and §6's rule then pays the appraiser nothing", () => {
    assert.equal(parseAppraiserDirectory(directory([{ ...demo[1], fee: "0" }]))[0]!.fee, 0n);
  });

  describe("refuses", () => {
    it("a value that is not JSON, without echoing it", () => {
      assert.throws(
        () => parseAppraiserDirectory("Rzeczoznawca A:SECRETLOOKINGVALUE"),
        (e: unknown) => e instanceof AppraiserConfigError && /not valid JSON/.test(e.message) && !e.message.includes("SECRETLOOKINGVALUE"),
      );
    });
    it("a JSON value that is not an array", () => refuses('{"name":"A"}', /must be a JSON array/));
    it("an entry that is not an object", () => refuses(["Rzeczoznawca A"], /entry 0: expected an object/));
    it("a missing or blank name", () => {
      refuses([{ wallet: A, fee: "1", default: true }], /entry 0: name is required/);
      refuses([{ name: "  ", wallet: A, fee: "1", default: true }], /name is required/);
    });
    it("a name longer than the cap", () => refuses([{ name: "x".repeat(MAX_APPRAISER_NAME_LENGTH + 1), wallet: A, fee: "1", default: true }], /cap is 64/));
    it("a wallet that is not an address", () => refuses([{ name: "A", wallet: "not-base58!", fee: "1", default: true }], /wallet must be a base58 address/));
    it("the all-zero wallet, which the program itself refuses", () => refuses([{ name: "A", wallet: UNSET_PUBKEY, fee: "1", default: true }], /all-zero key/));
    it("a missing fee", () => refuses([{ name: "A", wallet: A, default: true }], /fee is required/));
    it("a negative or non-integer fee", () => {
      refuses([{ name: "A", wallet: A, fee: "-1", default: true }], /cannot be negative/);
      refuses([{ name: "A", wallet: A, fee: "1.5", default: true }], /is not an integer/);
      refuses([{ name: "A", wallet: A, fee: 1.5, default: true }], /not a whole number/);
    });
    it("a fee above u64", () => refuses([{ name: "A", wallet: A, fee: "18446744073709551616", default: true }], /does not fit in a u64/));
    it("a non-boolean default", () => refuses([{ name: "A", wallet: A, fee: "1", default: "yes" }], /default must be true or false/));
    it("the same wallet twice: one registry entry cannot have two directory names", () => {
      refuses([{ name: "A", wallet: A, fee: "1", default: true }, { name: "B", wallet: A, fee: "1" }], new RegExp(`wallet ${A} appears twice`));
    });
    it("the same name twice: two entries would share one name_hash", () => {
      refuses([{ name: "A", wallet: A, fee: "1", default: true }, { name: "A", wallet: B, fee: "1" }], /name A appears twice/);
    });
    it("no default at all: bind_default_appraiser would have nothing to fall back to", () => {
      refuses(demo.map((e) => ({ ...e, default: false })), /exactly one entry must carry/);
    });
    it("more than one default, naming them: the program cannot enforce uniqueness", () => {
      refuses(demo.map((e) => ({ ...e, default: true })), /but 3 do \(Rzeczoznawca A, Rzeczoznawca B, Rzeczoznawca C\)/);
    });
  });
});

describe("APPRAISER_FEE_CAP_DIVISOR", () => {
  it("is the program's own constant", () => {
    assert.equal(String(APPRAISER_FEE_CAP_DIVISOR), constant("APPRAISER_FEE_CAP_DIVISOR"));
  });
});

describe("parseKeySpecs", () => {
  it("splits on semicolons, so an inline JSON byte array survives", () => {
    assert.deepEqual(parseKeySpecs("[1,2,3];/keys/b.json"), ["[1,2,3]", "/keys/b.json"]);
  });
  it("trims and drops empties, so a trailing separator is harmless", () => {
    assert.deepEqual(parseKeySpecs(" /a.json ; ; /b.json ;"), ["/a.json", "/b.json"]);
  });
  it("is empty for an unset value", () => {
    for (const value of [undefined, "", ";;"]) assert.deepEqual(parseKeySpecs(value), []);
  });
});
