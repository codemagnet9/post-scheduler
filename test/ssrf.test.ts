// test/ssrf.test.ts
// Webhook egress guard (Phase 11). The two vectors the brief names: a URL that resolves to a private
// address, and a public URL that redirects to a private one. Plus the address classifier, including
// the cloud metadata IP and IPv6 equivalents.
import { describe, it, expect } from 'vitest';
import { isForbiddenAddress, assertPublicUrl, safeFetch, SsrfError, type LookupFn } from '../src/webhooks/ssrf';

const lookupTo = (map: Record<string, string>): LookupFn => async (host) => {
  const ip = map[host];
  if (!ip) throw new Error(`no test mapping for ${host}`);
  return [{ address: ip, family: ip.includes(':') ? 6 : 4 }];
};

describe('address classifier', () => {
  it('forbids loopback, RFC1918, CGNAT and the cloud metadata IP', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      expect(isForbiddenAddress(ip)).toBe(true);
    }
  });
  it('forbids IPv6 loopback, link-local, ULA and IPv4-mapped private forms', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254']) {
      expect(isForbiddenAddress(ip)).toBe(true);
    }
  });
  it('allows genuine public addresses', () => {
    expect(isForbiddenAddress('93.184.216.34')).toBe(false);   // example.com
    expect(isForbiddenAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects http, and a host that resolves to a private address', async () => {
    await expect(assertPublicUrl('http://example.com/x', lookupTo({ 'example.com': '93.184.216.34' }))).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://internal.corp/x', lookupTo({ 'internal.corp': '10.1.2.3' }))).rejects.toBeInstanceOf(SsrfError);
  });
  it('allows a host that resolves to a public address', async () => {
    await expect(assertPublicUrl('https://good.example/x', lookupTo({ 'good.example': '93.184.216.34' }))).resolves.toBeUndefined();
  });
});

describe('safeFetch', () => {
  it('a URL that resolves to a private address never connects', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return { status: 200, headers: new Headers(), text: async () => 'ok' }; };
    await expect(safeFetch('https://ssrf.test/hook', {
      body: '{}', headers: {}, lookup: lookupTo({ 'ssrf.test': '169.254.169.254' }), fetchImpl,
    })).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(0); // rejected before any connection
  });

  it('a public URL that redirects to a private one is rejected at the redirect', async () => {
    let called = 0;
    const fetchImpl = async (url: string) => {
      called += 1;
      expect(url).toBe('https://public.test/hook'); // only the first hop is ever fetched
      return { status: 302, headers: new Headers({ location: 'https://metadata.internal/latest' }), text: async () => '' };
    };
    await expect(safeFetch('https://public.test/hook', {
      body: '{}', headers: {}, fetchImpl,
      lookup: lookupTo({ 'public.test': '93.184.216.34', 'metadata.internal': '169.254.169.254' }),
    })).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(1); // followed the 302 once, then refused to connect to the private target
  });

  it('delivers to a genuinely public endpoint', async () => {
    const fetchImpl = async () => ({ status: 200, headers: new Headers(), text: async () => 'delivered' });
    const res = await safeFetch('https://good.example/hook', { body: '{}', headers: {}, lookup: lookupTo({ 'good.example': '93.184.216.34' }), fetchImpl });
    expect(res).toEqual({ status: 200, text: 'delivered' });
  });
});
