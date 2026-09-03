// test/providers.test.ts
// Exercises the abstraction with the fake provider: capability/method consistency, deterministic
// publish, every taxonomy failure, the ambiguous-failure decision table, and — the one that
// matters most — accept-then-timeout reconciled via recentPosts (the Phase 6 exactly-once seed).
import { describe, it, expect } from 'vitest';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { assertAdapterConsistency, registerAdapter, resolveAdapter, unregisterAdapter } from '../src/providers/registry';
import { resolveAmbiguous, NormalizedError, AmbiguousFailure } from '../src/providers/errors';
import { validateAgainstCapabilities } from '../src/providers/validate';
import { contentFingerprint } from '../src/providers/fingerprint';
import { blueskyAdapter } from '../src/providers/adapters/bluesky';
import { lineAdapter } from '../src/providers/adapters/line';
import type { PublishInput } from '../src/providers/types';

const account = { providerAccountId: 'acct-1', credentials: { accessToken: 't' } };
const post = { text: 'hello world', media: [] as PublishInput['post']['media'] };
const input: PublishInput = { account, post };

describe('registry consistency', () => {
  it('the two real adapters pass the capability<->method consistency check', () => {
    expect(() => assertAdapterConsistency(blueskyAdapter)).not.toThrow();
    expect(() => assertAdapterConsistency(lineAdapter)).not.toThrow();
  });

  it('rejects an adapter whose flags disagree with its methods', () => {
    // Claim recent-post lookup but omit the method.
    const { adapter } = createFakeProvider({ supportsRecentPostLookup: false });
    const lying = { ...adapter, capabilities: { ...adapter.capabilities, supportsRecentPostLookup: true } };
    expect(() => assertAdapterConsistency(lying)).toThrow(/recentPosts/);
  });

  it('rejects an adapter whose publish timeout is not below its lease (Fix 1)', () => {
    const { adapter } = createFakeProvider({ key: 'fake-badlease' });
    const bad = { ...adapter, capabilities: { ...adapter.capabilities, publishTimeoutSeconds: 60, publishLeaseSeconds: 60 } };
    expect(() => assertAdapterConsistency(bad)).toThrow(/publishTimeoutSeconds/);
  });

  it('rejects an adapter that claims media upload without implementing uploadMedia', () => {
    const { adapter } = createFakeProvider({ supportsMediaUpload: false }); // no uploadMedia method
    const lying = { ...adapter, capabilities: { ...adapter.capabilities, supportsMediaUpload: true } };
    expect(() => assertAdapterConsistency(lying)).toThrow(/uploadMedia/);
  });

  it('register/resolve round-trips and rejects unknown providers', () => {
    const { adapter } = createFakeProvider({ key: 'fake-reg' });
    registerAdapter(adapter);
    expect(resolveAdapter('fake-reg').key).toBe('fake-reg');
    unregisterAdapter('fake-reg');
    expect(() => resolveAdapter('fake-reg')).toThrow(/no adapter/);
  });
});

describe('publish outcomes', () => {
  it('ok publish returns a provider post id, deterministic in the idempotency key', async () => {
    const { adapter, control } = createFakeProvider();
    control.mode = { kind: 'ok' };
    const a = await adapter.publish(input, { idempotencyKey: 'key-1' });
    const b = await adapter.publish(input, { idempotencyKey: 'key-1' });
    expect(a.providerPostId).toBe(b.providerPostId); // same key -> same id
  });

  it('maps each taxonomy failure to a NormalizedError with that code', async () => {
    const codes = ['rate_limited', 'auth_expired', 'invalid_media', 'content_rejected', 'duplicate_content', 'provider_unavailable', 'permanent_failure'] as const;
    for (const code of codes) {
      const { adapter, control } = createFakeProvider();
      control.mode = { kind: 'fail', code, reason: 'boom', retryAfterSec: code === 'rate_limited' ? 42 : undefined };
      await expect(adapter.publish(input, { idempotencyKey: 'k' })).rejects.toMatchObject({ code });
    }
  });

  it('rate_limited carries retryAfter for the backoff', async () => {
    const { adapter, control } = createFakeProvider();
    control.mode = { kind: 'fail', code: 'rate_limited', retryAfterSec: 90 };
    await adapter.publish(input, { idempotencyKey: 'k' }).catch((e: NormalizedError) => {
      expect(e).toBeInstanceOf(NormalizedError);
      expect(e.retryAfterSec).toBe(90);
    });
  });
});

describe('ambiguous failure — the double-post defence', () => {
  it('accept_then_timeout throws AmbiguousFailure but the post IS recorded', async () => {
    const { adapter, control } = createFakeProvider();
    control.mode = { kind: 'accept_then_timeout' };
    await expect(adapter.publish(input, { idempotencyKey: 'k' })).rejects.toBeInstanceOf(AmbiguousFailure);

    // recentPosts finds the item that was actually created, matched by content fingerprint.
    const recent = await adapter.recentPosts!({ account });
    const target = contentFingerprint(post);
    const match = recent.find((r) => r.fingerprint === target);
    expect(match).toBeDefined();
    // The publisher would adopt match.providerPostId and mark the target published — no second post.
  });

  it('decision table keys off capabilities only', () => {
    const both = createFakeProvider({ supportsRecentPostLookup: true, supportsIdempotencyKey: true }).adapter.capabilities;
    const idemOnly = createFakeProvider({ supportsRecentPostLookup: false, supportsIdempotencyKey: true }).adapter.capabilities;
    const neither = createFakeProvider({ supportsRecentPostLookup: false, supportsIdempotencyKey: false }).adapter.capabilities;
    expect(resolveAmbiguous(both)).toBe('lookup');
    expect(resolveAmbiguous(idemOnly)).toBe('retry_idempotent');
    expect(resolveAmbiguous(neither)).toBe('needs_review');
  });

  it('real adapters land in the right ambiguous branch', () => {
    expect(resolveAmbiguous(blueskyAdapter.capabilities)).toBe('lookup');          // has lookup
    expect(resolveAmbiguous(lineAdapter.capabilities)).toBe('retry_idempotent');   // retry key, no lookup
  });
});

describe('validation reads only the capability descriptor', () => {
  const caps = createFakeProvider().adapter.capabilities;

  it('flags text over the limit', () => {
    const r = validateAgainstCapabilities({ ...caps, maxTextLength: 5 }, { text: 'too long', media: [] });
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe('text_too_long');
  });

  it('flags too many media and unsupported types', () => {
    const many = validateAgainstCapabilities(caps, { text: '', media: Array(5).fill({ kind: 'image', url: 'u' }) });
    expect(many.issues.some((i) => i.code === 'too_many_media')).toBe(true);
    const wrong = validateAgainstCapabilities({ ...caps, acceptedMediaTypes: ['image'] }, { text: '', media: [{ kind: 'video', url: 'u' }] });
    expect(wrong.issues.some((i) => i.code === 'media_type_unsupported')).toBe(true);
  });

  it('warns (not errors) when first comment is unsupported', () => {
    const r = validateAgainstCapabilities({ ...caps, supportsFirstComment: false }, { text: 'hi', media: [], firstComment: 'first!' });
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.level === 'warning' && i.code === 'first_comment_unsupported')).toBe(true);
  });
});
