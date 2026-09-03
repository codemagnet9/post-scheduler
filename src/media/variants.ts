// src/media/variants.ts
// Per-network renditions driven by the capability descriptors, cached by (asset, purpose) so the
// same crop/transcode is never produced twice. The transform itself (sharp for images, ffmpeg for
// video) is an injectable VariantRenderer; this module owns the spec decision and the cache.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tenant';
import type { StorageAdapter } from './storage';
import type { CapabilityDescriptor } from '../providers/types';
import type { MediaProbe } from './probe';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export interface VariantSpec {
  purpose: string; // unique per (network, transform), e.g. 'instagram:1:1:crop'
  targetWidth: number;
  targetHeight: number;
  crop: boolean;
  mimeType: string;
  isVideo: boolean;
}

export type VariantDecision =
  | { kind: 'passthrough' } // source already fits — publish the original
  | { kind: 'variant'; spec: VariantSpec }
  | { kind: 'unsatisfiable'; reason: string }; // Phase 5 blocker

// Decide the rendition needed to publish this asset to a network.
export function computeVariantSpec(caps: CapabilityDescriptor, probe: MediaProbe, kind: 'image' | 'video' | 'gif'): VariantDecision {
  const { width: w, height: h } = probe;
  if (caps.permittedAspectRatios === 'any' || !w || !h) return { kind: 'passthrough' };

  const ratio = w / h;
  const best = caps.permittedAspectRatios
    .map((ar) => ({ ar, diff: Math.abs(ratio - ar.w / ar.h) }))
    .sort((a, b) => a.diff - b.diff)[0];

  if (best.diff <= caps.aspectRatioTolerance) return { kind: 'passthrough' };

  // Source aspect is outside the network's permitted set. Video can't be safely re-cropped without
  // destroying the frame — that is a hard blocker; an image can be centre-cropped.
  if (kind === 'video') return { kind: 'unsatisfiable', reason: 'aspect' };

  const target = best.ar.w / best.ar.h;
  const targetWidth = ratio > target ? Math.round(h * target) : w;
  const targetHeight = ratio > target ? h : Math.round(w / target);
  return {
    kind: 'variant',
    spec: { purpose: `${caps.provider}:${best.ar.w}:${best.ar.h}:crop`, targetWidth, targetHeight, crop: true, mimeType: 'image/jpeg', isVideo: false },
  };
}

export interface VariantRenderer {
  render(source: Buffer, spec: VariantSpec): Promise<{ bytes: Buffer; width: number; height: number; mimeType: string; durationSec?: number }>;
}

// Injectable renderer: production wires sharp/ffmpeg at boot (media/bootstrap.ts); tests inject a fake.
let renderer: VariantRenderer | null = null;
export function setVariantRenderer(r: VariantRenderer | null): void {
  renderer = r;
}
export function getVariantRenderer(): VariantRenderer {
  if (!renderer) throw new Error('no variant renderer configured (sharp/ffmpeg in production, injected in tests)');
  return renderer;
}

// Return the storage key of the variant for (asset, spec), generating and caching it on first miss.
export async function ensureVariant(
  tx: Tx,
  storage: StorageAdapter,
  renderer: VariantRenderer,
  params: { assetId: string; workspaceId: string; sourceKey: string; spec: VariantSpec },
): Promise<{ storageKey: string; cached: boolean }> {
  const existing = rows<{ storage_key: string }>(await tx.execute(sql`
    select storage_key from media_variants where media_asset_id = ${params.assetId} and purpose = ${params.spec.purpose}
  `));
  if (existing.length) return { storageKey: existing[0].storage_key, cached: true };

  const source = await storage.getObject(params.sourceKey);
  const out = await renderer.render(source, params.spec);
  const variantKey = `variants/${params.assetId}/${params.spec.purpose}`;
  await storage.putObject(variantKey, out.bytes, out.mimeType);
  await tx.execute(sql`
    insert into media_variants (media_asset_id, workspace_id, purpose, storage_key, mime_type, width, height, byte_size, duration_ms, status)
    values (${params.assetId}, ${params.workspaceId}, ${params.spec.purpose}, ${variantKey}, ${out.mimeType}, ${out.width}, ${out.height}, ${out.bytes.length}, ${out.durationSec != null ? Math.round(out.durationSec * 1000) : null}, 'ready')
    on conflict (media_asset_id, purpose) do nothing
  `);
  return { storageKey: variantKey, cached: false };
}
