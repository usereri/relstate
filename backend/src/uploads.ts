import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RejectedTransaction } from "./txinspect.ts";

/**
 * Listing photos for the demo: a small in-memory store, served back by URL.
 *
 * The chain holds the photo as a 120-byte string, so the image itself has to live somewhere that
 * hands out a short address. This is the mock of that somewhere (object storage in production):
 * bounded in count and size, restricted to JPEG (the app re-encodes), and gone on restart.
 */
const MAX_BYTES = 300_000;
const MAX_ITEMS = 200;
const TYPES = new Set(["image/jpeg"]);

/**
 * With `dir` (UPLOADS_DIR, a Fly volume mount) photos survive restarts and deploys; without it
 * they live in memory only. Files are all re-encoded JPEGs, so the name is the whole record.
 */
export function createUploads(dir = process.env.UPLOADS_DIR) {
  const items = new Map<string, { type: string; data: Buffer }>();
  if (dir) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).sort()) {
      if (/^[A-Za-z0-9_-]{12}\.jpg$/.test(f)) items.set(f.slice(0, 12), { type: "image/jpeg", data: readFileSync(join(dir, f)) });
    }
  }
  return {
    put(type: unknown, base64: unknown): string {
      if (typeof type !== "string" || !TYPES.has(type)) throw new RejectedTransaction("photo must be a jpeg image", "malformed-body");
      if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new RejectedTransaction("photo data must be base64", "malformed-body");
      const data = Buffer.from(base64, "base64");
      if (data.length === 0 || data.length > MAX_BYTES) throw new RejectedTransaction(`photo must be under ${MAX_BYTES / 1000} KB`, "malformed-body");
      if (items.size >= MAX_ITEMS) {
        const oldest = items.keys().next().value as string;
        items.delete(oldest);
        if (dir && existsSync(join(dir, `${oldest}.jpg`))) unlinkSync(join(dir, `${oldest}.jpg`));
      }
      const id = randomBytes(9).toString("base64url");
      items.set(id, { type, data });
      if (dir) writeFileSync(join(dir, `${id}.jpg`), data);
      return id;
    },
    get: (id: string) => items.get(id),
  };
}
