import "./noenv.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MEMORY, openStore } from "../src/store.ts";

/** A fresh scratch directory per test that wants a real file, cleaned up afterwards. */
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relstate-store-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Collection: get/has/set/delete/size/values", () => {
  it("round-trips a value and reports it present", () => {
    const store = openStore();
    const c = store.collection<{ n: number }>("t");
    assert.equal(c.has("a"), false);
    assert.equal(c.get("a"), undefined);
    c.set("a", { n: 1 });
    assert.equal(c.has("a"), true);
    assert.deepEqual(c.get("a"), { n: 1 });
    assert.equal(c.size(), 1);
  });

  it("delete removes the row and reports whether it was there", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    assert.equal(c.delete("x"), false);
    c.set("x", 1);
    assert.equal(c.delete("x"), true);
    assert.equal(c.has("x"), false);
    assert.equal(c.delete("x"), false);
  });

  it("set overwrites an existing key in place", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("a", 1);
    c.set("a", 2);
    assert.equal(c.get("a"), 2);
    assert.equal(c.size(), 1);
  });

  it("values() lists every record, in whatever order entries() does", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("a", 1);
    c.set("b", 2);
    assert.deepEqual(c.values().sort(), [1, 2]);
  });
});

describe("Collection: entries() order", () => {
  it("iterates in insertion order, like the Map it replaced", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("b", 1);
    c.set("a", 2);
    c.set("c", 3);
    assert.deepEqual(c.entries().map(([k]) => k), ["b", "a", "c"]);
  });

  it("re-setting an existing key keeps its original position", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.set("a", 99); // rewritten, not re-appended
    assert.deepEqual(c.entries(), [
      ["a", 99],
      ["b", 2],
      ["c", 3],
    ]);
  });
});

describe("Collection: namespacing", () => {
  it("two collections with the same key do not interfere", () => {
    const store = openStore();
    const a = store.collection<string>("alpha");
    const b = store.collection<string>("beta");
    a.set("k", "from-alpha");
    b.set("k", "from-beta");
    assert.equal(a.get("k"), "from-alpha");
    assert.equal(b.get("k"), "from-beta");
    a.delete("k");
    assert.equal(a.has("k"), false);
    assert.equal(b.has("k"), true);
  });
});

describe("Collection: bigint codec", () => {
  it("round-trips a bare bigint", () => {
    const store = openStore();
    const c = store.collection<{ amount: bigint }>("t");
    c.set("a", { amount: 93_023_255n });
    assert.deepEqual(c.get("a"), { amount: 93_023_255n });
    assert.equal(typeof c.get("a")!.amount, "bigint");
  });

  it("round-trips a bigint nested inside an array and inside an object", () => {
    const store = openStore();
    const c = store.collection<{ list: bigint[]; nested: { fee: bigint } }>("t");
    c.set("a", { list: [1n, 2n, 3n], nested: { fee: 500_000n } });
    assert.deepEqual(c.get("a"), { list: [1n, 2n, 3n], nested: { fee: 500_000n } });
  });

  it("a negative bigint round-trips too", () => {
    const store = openStore();
    const c = store.collection<{ n: bigint }>("t");
    c.set("a", { n: -5n });
    assert.equal(c.get("a")!.n, -5n);
  });

  it("a user-supplied string is never mistaken for the bigint tag", () => {
    const store = openStore();
    const c = store.collection<{ note: string }>("t");
    // The tag is only ever recognised on a parsed OBJECT; a plain string field, even one that
    // contains the tag's own text, is not an object and so is never touched by the reviver.
    c.set("a", { note: '{"$bigint":"123"}' });
    assert.deepEqual(c.get("a"), { note: '{"$bigint":"123"}' });
    c.set("b", { note: "$bigint" });
    assert.deepEqual(c.get("b"), { note: "$bigint" });
  });

  it("an object shaped exactly like the tag IS decoded to a bigint (every real caller's fields are strings, never this shape)", () => {
    const store = openStore();
    const c = store.collection<unknown>("t");
    c.set("a", { $bigint: "123" });
    assert.equal(c.get("a"), 123n);
  });
});

describe("Collection: undefined fields", () => {
  it("a field explicitly set to undefined comes back absent, as JSON already does", () => {
    const store = openStore();
    const c = store.collection<{ a: number; b?: number }>("t");
    c.set("x", { a: 1, b: undefined });
    const back = c.get("x")!;
    assert.equal("b" in back, false);
    assert.equal(back.a, 1);
  });
});

describe("Collection: prune", () => {
  it("deletes only rows whose expiry has passed, and returns how many", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("expired", 1, 1000);
    c.set("future", 2, 5000);
    c.set("forever", 3, null);
    assert.equal(c.prune(2000), 1);
    assert.equal(c.has("expired"), false);
    assert.equal(c.has("future"), true);
    assert.equal(c.has("forever"), true);
  });

  it("a row expiring exactly at `now` is pruned (expiresAt <= now)", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("a", 1, 1000);
    assert.equal(c.prune(999), 0);
    assert.equal(c.prune(1000), 1);
  });

  it("prune never reads the wall clock: a row expired in the real past stays readable until pruned", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    // Expired by any real-world clock, but nothing here ever called Date.now() to decide that.
    c.set("old", 1, 1);
    assert.equal(c.has("old"), true);
    assert.equal(c.get("old"), 1);
  });
});

describe("Store.prune", () => {
  it("sweeps every collection at once", () => {
    const store = openStore();
    const a = store.collection<number>("a");
    const b = store.collection<number>("b");
    a.set("x", 1, 100);
    b.set("y", 2, 100);
    b.set("z", 3, 9999);
    assert.equal(store.prune(200), 2);
    assert.equal(a.has("x"), false);
    assert.equal(b.has("y"), false);
    assert.equal(b.has("z"), true);
  });
});

describe("Store.transaction", () => {
  it("commits every write on success", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    store.transaction(() => {
      c.set("a", 1);
      c.set("b", 2);
    });
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), 2);
  });

  it("rolls back every write when the callback throws", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    c.set("existing", 0);
    assert.throws(() => {
      store.transaction(() => {
        c.set("existing", 99);
        c.set("new", 1);
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(c.get("existing"), 0);
    assert.equal(c.has("new"), false);
  });

  it("returns the callback's value", () => {
    const store = openStore();
    assert.equal(
      store.transaction(() => 42),
      42,
    );
  });

  it("nests inline: an inner transaction commits or rolls back with the outer one", () => {
    const store = openStore();
    const c = store.collection<number>("t");
    store.transaction(() => {
      c.set("a", 1);
      store.transaction(() => {
        c.set("b", 2);
      });
    });
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), 2);

    assert.throws(() => {
      store.transaction(() => {
        c.set("c", 3);
        store.transaction(() => {
          c.set("d", 4);
        });
        throw new Error("boom");
      });
    });
    assert.equal(c.has("c"), false);
    assert.equal(c.has("d"), false);
  });
});

describe("openStore", () => {
  it("creates a missing parent directory for a file path", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const file = join(dir, "nested", "deeper", "relstate.db");
      const store = openStore(file);
      store.collection<number>("t").set("a", 1);
      store.close();
      const reopened = openStore(file);
      assert.equal(reopened.collection<number>("t").get("a"), 1);
      reopened.close();
    } finally {
      cleanup();
    }
  });

  it("reopening a file store prunes whatever expired while it was closed", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const file = join(dir, "relstate.db");
      const first = openStore(file);
      const c = first.collection<number>("t");
      c.set("expired", 1, Date.now() - 1000);
      c.set("forever", 2, null);
      first.close();

      const second = openStore(file);
      assert.equal(second.collection<number>("t").has("expired"), false, "a file store prunes against the wall clock on open");
      assert.equal(second.collection<number>("t").has("forever"), true);
      second.close();
    } finally {
      cleanup();
    }
  });

  it("exposes path and persistent for a file store", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const file = join(dir, "relstate.db");
      const store = openStore(file);
      assert.equal(store.path, file);
      assert.equal(store.persistent, true);
      store.close();
    } finally {
      cleanup();
    }
  });

  it("exposes path and persistent for the in-memory default", () => {
    const store = openStore();
    assert.equal(store.path, MEMORY);
    assert.equal(store.persistent, false);
  });

  it("two in-memory stores do not share state", () => {
    const a = openStore();
    const b = openStore();
    a.collection<number>("t").set("k", 1);
    assert.equal(b.collection<number>("t").has("k"), false);
  });
});
