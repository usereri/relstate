import { randomBytes } from "node:crypto";
import { RejectedTransaction } from "./txinspect.ts";

/**
 * Listing photos for the demo: a small in-memory store, served back by URL.
 *
 * The chain holds the photo as a 120-byte string, so the image itself has to live somewhere that
 * hands out a short address. This is the mock of that somewhere (object storage in production):
 * bounded in count and size, restricted to three image types, and gone on restart.
 */
const MAX_BYTES = 300_000;
const MAX_ITEMS = 200;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function createUploads() {
  const items = new Map<string, { type: string; data: Buffer }>();
  return {
    put(type: unknown, base64: unknown): string {
      if (typeof type !== "string" || !TYPES.has(type)) throw new RejectedTransaction("photo must be a jpeg, png or webp image", "malformed-body");
      if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new RejectedTransaction("photo data must be base64", "malformed-body");
      const data = Buffer.from(base64, "base64");
      if (data.length === 0 || data.length > MAX_BYTES) throw new RejectedTransaction(`photo must be under ${MAX_BYTES / 1000} KB`, "malformed-body");
      if (items.size >= MAX_ITEMS) items.delete(items.keys().next().value as string); // oldest out
      const id = randomBytes(9).toString("base64url");
      items.set(id, { type, data });
      return id;
    },
    get: (id: string) => items.get(id),
  };
}
