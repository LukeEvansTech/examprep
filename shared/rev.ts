// A short, stable fingerprint of a transcription, so a review can be tied to the exact version
// it confirmed (FNV-1a over the JSON; not cryptographic, it only needs to detect change).
import type { Interactive } from "./schema.ts";

export function transcriptionRev(it: Interactive | undefined | null): string {
  const s = JSON.stringify(it ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
