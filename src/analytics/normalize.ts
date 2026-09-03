// src/analytics/normalize.ts
// The common metric shape and the ONE definition of engagement rate.
//
// A field that a network does not supply reads as UNAVAILABLE (null), never as 0 — pretending a
// missing number is zero is the central dishonesty of social analytics, and we refuse it here.
//
// PER-NETWORK MAPPING (what each field maps to; "—" = unavailable on that network):
//   Bluesky   impressions —      reach —   engagements likeCount+repostCount+replyCount
//             clicks —           saves —   shares repostCount
//             (the AT Protocol exposes no impressions/reach/clicks/saves.)
//   LINE      supportsMetrics = false -> NO metrics at all; every field is UNAVAILABLE. The UI must
//             render "not available on this network", not a row of zeros.
//   (Instagram/TikTok/etc. will map impressions/reach/saves/clicks when those adapters are built;
//    each adapter documents its own mapping in its fetchMetrics.)
export const METRIC_FIELDS = ['impressions', 'reach', 'engagements', 'clicks', 'saves', 'shares'] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

// Absent OR null = unavailable. A present number (including 0) is a real measured value.
export type NormalizedMetrics = Partial<Record<MetricField, number | null>>;

// ENGAGEMENT RATE — the single definition used EVERYWHERE (headline, top posts, export):
//   engagement rate = engagements / impressions        (denominator = impressions)
// Unavailable when impressions is null/absent or 0 — never a divide-by-zero, never a fake 0%.
export function engagementRate(engagements: number | null | undefined, impressions: number | null | undefined): number | null {
  if (engagements == null || impressions == null || impressions <= 0) return null;
  return engagements / impressions;
}

// The SQL form of the SAME definition, for aggregate read models (summed over the period).
export const ENGAGEMENT_RATE_SQL = 'case when sum(impressions) > 0 then sum(engagements)::float8 / sum(impressions) else null end';

// Column values for a snapshot insert: each field is the number or NULL (unavailable).
export function snapshotColumns(m: NormalizedMetrics): Record<MetricField, number | null> {
  const out = {} as Record<MetricField, number | null>;
  for (const f of METRIC_FIELDS) out[f] = m[f] ?? null;
  return out;
}
