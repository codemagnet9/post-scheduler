// src/analytics/glossary.ts
// The structured form of the per-network mapping documented in normalize.ts's header comment — the
// SAME facts, exposed so the UI can render them instead of re-describing analytics in its own words.
// Only lists REGISTERED adapters (never invents a network that isn't actually wired up), and a
// provider's `supportsMetrics` flag is read live from its capability descriptor, never hard-coded here
// — so this can never drift into claiming a network supports metrics that the adapter doesn't.
import { listProviders, resolveAdapter } from '../providers/registry';
import { METRIC_FIELDS, type MetricField } from './normalize';

export interface FieldMapping { field: MetricField; status: 'supported' | 'unavailable'; note?: string }
export interface ProviderGlossaryEntry {
  provider: string;
  displayName: string;
  supportsMetrics: boolean;
  fields: FieldMapping[];
  summary: string;
}

// Hand-documented per-provider notes — literally the same facts as normalize.ts's header comment,
// just structured. A registered provider with no entry here (a new adapter not yet documented) still
// appears, with an honest generic summary rather than an invented one.
const NOTES: Record<string, { summary: string; fields: Partial<Record<MetricField, string>> }> = {
  bluesky: {
    summary: 'The AT Protocol exposes no impressions, reach, clicks or saves — only engagement counts and reposts.',
    fields: { engagements: 'likeCount + repostCount + replyCount', shares: 'repostCount' },
  },
  line: {
    summary: 'LINE exposes no publishing metrics at all — every field is unavailable, not zero.',
    fields: {},
  },
};

export function metricsGlossary(): ProviderGlossaryEntry[] {
  return listProviders().map((provider) => {
    const caps = resolveAdapter(provider).capabilities;
    const note = NOTES[provider];
    const fields: FieldMapping[] = METRIC_FIELDS.map((field) => {
      const mapped = caps.supportsMetrics ? note?.fields[field] : undefined;
      return mapped ? { field, status: 'supported', note: mapped } : { field, status: 'unavailable' };
    });
    return {
      provider,
      displayName: caps.displayName,
      supportsMetrics: caps.supportsMetrics,
      fields,
      summary: note?.summary
        ?? (caps.supportsMetrics
          ? `${caps.displayName} reports a subset of metrics — see the fields below.`
          : `${caps.displayName} reports no publishing metrics — every field is unavailable, not zero.`),
    };
  });
}
