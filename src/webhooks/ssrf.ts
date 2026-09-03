// src/webhooks/ssrf.ts
// SSRF egress guard for webhook delivery. A customer controls the destination URL, so before we ever
// connect we RESOLVE the hostname and reject any address that points back inside our own network —
// loopback, RFC1918, carrier-grade NAT, link-local (including 169.254.169.254, the cloud metadata
// endpoint that turns "post to my URL" into "read my instance credentials"), and every IPv6
// equivalent, including IPv4-mapped forms. We re-validate after EVERY redirect, because a public host
// is allowed to 302 you to a forbidden one.
//
// Residual risk (documented, not hidden): a TOCTOU DNS-rebind between our lookup and the socket's own
// resolution. Fully closing it means pinning the connection to the validated IP via an undici Agent
// `lookup`; see docs/security-review.md. The checks below are the necessary first line and cover the
// static-address and redirect vectors the tests exercise.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export class SsrfError extends Error {
  constructor(message: string) { super(message); this.name = 'SsrfError'; }
}

export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const CONNECT_TIMEOUT_MS = 10_000;

// --- IP classification -------------------------------------------------------
function ipv4Forbidden(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed => refuse
  const [a, b] = o;
  if (a === 0) return true;                              // 0.0.0.0/8 "this network"
  if (a === 10) return true;                             // 10/8 private
  if (a === 127) return true;                            // 127/8 loopback
  if (a === 169 && b === 254) return true;               // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12 private
  if (a === 192 && b === 168) return true;               // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64/10 carrier-grade NAT
  if (a === 192 && b === 0 && o[2] === 0) return true;   // 192.0.0/24 IETF protocol assignments
  if (a >= 224) return true;                             // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

// Expand an IPv6 string (with :: compression and optional embedded IPv4) to 16 bytes, or null.
function ipv6ToBytes(addr: string): number[] | null {
  let s = addr;
  let tail: number[] = [];
  const dot = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = s.slice(s.lastIndexOf(':') + 1);
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255 || !Number.isInteger(n))) return null;
    tail = parts;
    s = s.slice(0, dot + 1) + '0:0'; // placeholder groups; we overwrite the low 4 bytes with `tail`
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const groups: number[] = [];
  const toBytes = (g: string[]): number[] => g.flatMap((h) => { const v = parseInt(h || '0', 16); return [(v >> 8) & 0xff, v & 0xff]; });
  if (halves.length === 2) {
    const headB = toBytes(head);
    const restB = toBytes(rest);
    const fill = 16 - headB.length - restB.length;
    if (fill < 0) return null;
    groups.push(...headB, ...new Array(fill).fill(0), ...restB);
  } else {
    groups.push(...toBytes(head));
  }
  if (groups.length !== 16) return null;
  if (tail.length === 4) { groups[12] = tail[0]; groups[13] = tail[1]; groups[14] = tail[2]; groups[15] = tail[3]; }
  return groups;
}

function ipv6Forbidden(addr: string): boolean {
  const b = ipv6ToBytes(addr);
  if (!b) return true; // unparseable => refuse
  const allZeroExceptLast = b.slice(0, 15).every((x) => x === 0);
  if (allZeroExceptLast && (b[15] === 0 || b[15] === 1)) return true; // :: unspecified, ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;           // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                            // fc00::/7 unique-local (fc/fd)
  if (b[0] === 0xff) return true;                                     // ff00::/8 multicast
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96 => classify the embedded IPv4.
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  if (mapped || nat64) return ipv4Forbidden(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  return false;
}

export function isForbiddenAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return ipv4Forbidden(ip);
  if (fam === 6) return ipv6Forbidden(ip);
  return true; // not an IP at all => refuse
}

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

// Resolve `url`'s host and reject unless EVERY resolved address is public. Also enforces https.
export async function assertPublicUrl(url: string, lookup: LookupFn = defaultLookup): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new SsrfError('invalid url'); }
  if (u.protocol !== 'https:') throw new SsrfError('only https webhook targets are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // A literal IP host is validated directly (no DNS); otherwise resolve ALL addresses.
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (!addrs.length) throw new SsrfError(`could not resolve ${host}`);
  for (const a of addrs) {
    if (isForbiddenAddress(a.address)) throw new SsrfError(`destination ${host} resolves to a private/forbidden address (${a.address})`);
  }
}

// --- the guarded fetch -------------------------------------------------------
export interface SafeFetchResult { status: number; text: string }
export interface SafeFetchOpts {
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: LookupFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam for the fetch impl
  fetchImpl?: (url: string, init: any) => Promise<any>;
}

async function readCapped(res: { body?: unknown; text?: () => Promise<string> }, maxBytes: number): Promise<string> {
  const stream = res.body as ReadableStream<Uint8Array> | undefined;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(Buffer.from(value));
      if (received >= maxBytes) { await reader.cancel().catch(() => undefined); break; }
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
  }
  return typeof res.text === 'function' ? (await res.text()).slice(0, maxBytes) : '';
}

// POST with SSRF validation at every hop, a redirect cap, a response-size cap, and a total time cap.
export async function safeFetch(rawUrl: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as SafeFetchOpts['fetchImpl'])!;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
  try {
    let url = rawUrl;
    for (let hop = 0; ; hop += 1) {
      await assertPublicUrl(url, lookup); // validate BEFORE each connection, including every redirect
      const res = await fetchImpl(url, { method: 'POST', body: opts.body, headers: opts.headers, redirect: 'manual', signal: ctl.signal });
      const status: number = res.status;
      if (status >= 300 && status < 400) {
        const loc = typeof res.headers?.get === 'function' ? res.headers.get('location') : undefined;
        if (!loc) return { status, text: await readCapped(res, maxBytes) };
        if (hop >= maxRedirects) throw new SsrfError('too many redirects');
        url = new URL(loc, url).toString(); // re-validated at the top of the next iteration
        continue;
      }
      return { status, text: await readCapped(res, maxBytes) };
    }
  } finally {
    clearTimeout(timer);
  }
}
