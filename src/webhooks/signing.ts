// src/webhooks/signing.ts
// Webhook signatures. We sign HMAC-SHA256 over `${timestamp}.${body}` with the endpoint's secret and
// send it as:
//   Meridian-Signature: t=<unix_seconds>,v1=<hex_hmac>
// The timestamp is INSIDE the signed material, so a captured delivery cannot be replayed later: the
// customer recomputes the HMAC AND rejects timestamps outside a tolerance window (default 5 min).
//
// CUSTOMER VERIFICATION (documented in docs/quickstart.md):
//   1. Read the `Meridian-Signature` header; parse `t` and `v1`.
//   2. Reject if |now - t| > 300s  (replay protection).
//   3. Compute expected = HMAC_SHA256(secret, `${t}.${rawRequestBody}`) as hex.
//   4. Constant-time compare expected with v1. Reject on mismatch.
// Use the RAW request body bytes in step 3 — re-serializing parsed JSON can change bytes and break
// the signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'meridian-signature';
export const DEFAULT_TOLERANCE_SEC = 300;

export function sign(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = Object.fromEntries(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return null;
  return { t, v1: parts.v1 };
}

// The exact procedure a customer runs. Exported so our own tests verify against the documented steps,
// not a private shortcut.
export function verify(secret: string, header: string, body: string, nowSec: number, toleranceSec = DEFAULT_TOLERANCE_SEC): { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' } {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return { ok: false, reason: 'stale' }; // replay window
  const expected = createHmac('sha256', secret).update(`${parsed.t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parsed.v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
