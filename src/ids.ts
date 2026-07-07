import { createHash } from "node:crypto";

// Fixed namespace UUID for this integration, so the same Jupiter id always maps
// to the same ZenMoney UUID (idempotent re-syncs, no duplicates).
const NAMESPACE = "6f1c2a10-1e2b-5c3d-9a4e-jupitercard00".replace(/[^0-9a-f]/g, "0");

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}
function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic UUIDv5 (SHA-1) of `name` under a fixed namespace. */
export function stableUuid(name: string): string {
  const hash = createHash("sha1").update(Buffer.concat([uuidToBytes(NAMESPACE), Buffer.from(name)])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  return bytesToUuid(bytes);
}
