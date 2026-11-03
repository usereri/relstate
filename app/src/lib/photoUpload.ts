// Listing photo from the landlord's computer: shrink it in the browser, hand it to the backend
// (mock object storage), and use the short URL it returns as the listing's `photo`, because the
// chain only holds 120 bytes of it.
import { API, sessionAuth } from "@/lib/sponsor";

export const UPLOAD_AVAILABLE = !!API;

const MAX_SIDE = 900;

async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
  if (!blob) throw new Error("This image could not be read.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Uploads the picked image and returns the address to store on the listing. */
export async function uploadPhoto(file: File): Promise<string> {
  if (!API) throw new Error("Uploading needs the backend. Type a file name or web address instead.");
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file.");
  const data = await shrink(file);
  const res = await fetch(`${API.replace(/\/$/, "")}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await sessionAuth()}` },
    body: JSON.stringify({ type: "image/jpeg", data }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `Upload failed (${res.status})`);
  return `${API.replace(/\/$/, "")}/api/uploads/${body.id}`;
}
