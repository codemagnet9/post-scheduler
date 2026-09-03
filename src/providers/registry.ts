// src/providers/registry.ts
// The ONLY door to adapters. Services call resolveAdapter(provider); no service imports a concrete
// adapter, and none branches on provider name. Adding a network touches exactly two places:
//   (1) the new src/providers/adapters/<network>/ folder, and
//   (2) the registerAdapter(...) line in src/providers/adapters/index.ts.
import type { ProviderAdapter, ProviderKey } from './types';

const registry = new Map<ProviderKey, ProviderAdapter>();

// Guard against drift between capability flags and optional-method presence — the mechanism that
// makes "declare in capabilities, don't throw at call time" enforceable rather than a convention.
export function assertAdapterConsistency(a: ProviderAdapter): void {
  const c = a.capabilities;
  const mism: string[] = [];
  if (c.supportsRecentPostLookup !== (typeof a.recentPosts === 'function')) mism.push('recentPosts');
  if (c.supportsMetrics !== (typeof a.fetchMetrics === 'function')) mism.push('fetchMetrics');
  if (c.supportsDelete !== (typeof a.deletePost === 'function')) mism.push('deletePost');
  if (c.supportsRevoke !== (typeof a.revokeAuthorization === 'function')) mism.push('revokeAuthorization');
  if (c.supportsMediaUpload !== (typeof a.uploadMedia === 'function')) mism.push('uploadMedia');
  if (c.provider !== a.key) mism.push('key/capabilities.provider');
  // A publish call that can outlast its own lease lets the sweeper reclaim a still-running attempt
  // and turn a success into a false needs_review. Fail the boot rather than discover this in prod.
  if (c.publishTimeoutSeconds >= c.publishLeaseSeconds) {
    mism.push(`publishTimeoutSeconds (${c.publishTimeoutSeconds}) must be < publishLeaseSeconds (${c.publishLeaseSeconds})`);
  }
  if (mism.length) throw new Error(`adapter '${a.key}' capability/method mismatch: ${mism.join(', ')}`);
}

export function registerAdapter(adapter: ProviderAdapter): void {
  assertAdapterConsistency(adapter);
  registry.set(adapter.key, adapter);
}

export function resolveAdapter(provider: ProviderKey): ProviderAdapter {
  const a = registry.get(provider);
  if (!a) throw new Error(`no adapter registered for provider '${provider}'`);
  return a;
}

export function hasAdapter(provider: ProviderKey): boolean {
  return registry.has(provider);
}

export function listProviders(): ProviderKey[] {
  return [...registry.keys()];
}

// Test-only: adapters registered ad hoc in unit tests need to be removable.
export function unregisterAdapter(provider: ProviderKey): void {
  registry.delete(provider);
}
