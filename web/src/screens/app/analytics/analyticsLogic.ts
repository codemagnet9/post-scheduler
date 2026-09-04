// src/screens/app/analytics/analyticsLogic.ts
// Pure analytics helpers. EVERY number here — headline values, engagement rate, period-over-period
// change, daily series values — comes from the API. This file never sums, divides or recomputes a
// metric; it only turns already-computed server values into display strings, and does pure CALENDAR
// arithmetic (never real timezone math) to build the 7d/30d/90d range presets.
import type { DailyPoint, NetworkPostCount } from '../../../api/types';

export type RangePreset = '7d' | '30d' | '90d';
const PRESET_DAYS: Record<RangePreset, number> = { '7d': 7, '30d': 30, '90d': 90 };

// Pure Y-M-D arithmetic. Safe because `todayYMD` is already a CALENDAR DATE in the target zone (from
// ymdInZone) — counting days backward from it never needs to know what zone it came from.
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// An inclusive [from, to] pair of calendar-date strings for a preset ending on `todayYMD` — "30d"
// means today and the 29 days before it. The caller is responsible for computing `todayYMD` in the
// WORKSPACE's zone (ymdInZone(new Date(), workspaceZone)), never the browser's.
export function presetRange(preset: RangePreset, todayYMD: string): { from: string; to: string } {
  return { from: addDays(todayYMD, -(PRESET_DAYS[preset] - 1)), to: todayYMD };
}

// --- display formatting: the API already computed every number; this only renders it ---

// Large counts (impressions, engagements) in compact form, matching the prototype's "1.24M" style.
export function formatCompact(value: number | null): string {
  if (value === null) return '—'; // unavailable — NEVER a fake 0
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: value < 1000 ? 0 : 1 }).format(value);
}

// Exact counts (table cells) with thousands separators.
export function formatCount(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

// A ratio (0..1) as a percentage, e.g. 0.084 -> "8.4%". Used for engagement rate everywhere it's
// shown — headline, top posts table — so the SAME server-computed ratio always reads the same way.
export function formatPercent(value: number | null, digits = 1): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export interface ChangeDisplay { text: string; direction: 'up' | 'down' | null }
// The server's period-over-period relative change, formatted with a sign and direction. null (no
// prior-period data, or a previous value of 0) reads as "no prior period", never a fake 0% or a dash
// that could be mistaken for "flat".
export function formatChange(changePct: number | null): ChangeDisplay {
  if (changePct === null) return { text: 'no prior period', direction: null };
  const direction = changePct >= 0 ? 'up' : 'down';
  const sign = changePct >= 0 ? '+' : '−';
  return { text: `${sign}${Math.abs(changePct * 100).toFixed(1)}% vs previous period`, direction };
}

// --- daily series -> chart lines + legend ---
// c1-c4 are the ONLY series colours (from tokens.css) — never re-picked, cycled deterministically so a
// network keeps the same colour whether or not it currently has a line.
const SERIES_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
export const colorFor = (index: number): string => SERIES_COLORS[index % SERIES_COLORS.length];

export interface SeriesLine { provider: string; color: string; points: { day: string; value: number }[] }
export interface LegendEntry { provider: string; color: string; hasData: boolean; reason: 'not_supported' | 'no_data' | null }
export interface SeriesResult { lines: SeriesLine[]; legend: LegendEntry[] }

// A network with NO non-null value for the selected metric across the whole range gets NO line drawn
// (never a line pinned at 0) — but it still appears in the legend, explicitly marked, so its absence
// reads as "no data" rather than as the network having silently vanished from the dashboard.
export function buildSeries(points: DailyPoint[], networks: NetworkPostCount[], metric: 'engagements' | 'impressions'): SeriesResult {
  const providers = [...new Set([...networks.map((n) => n.provider), ...points.map((p) => p.provider)])].sort();
  const byProvider = new Map<string, { day: string; value: number }[]>();
  for (const p of points) {
    const v = p[metric];
    if (v === null) continue; // a gap, not a zero
    const arr = byProvider.get(p.provider) ?? [];
    arr.push({ day: p.day, value: v });
    byProvider.set(p.provider, arr);
  }
  const lines: SeriesLine[] = [];
  const legend: LegendEntry[] = [];
  providers.forEach((provider, i) => {
    const color = colorFor(i);
    const supported = networks.find((n) => n.provider === provider)?.metricsSupported ?? true;
    const seriesPoints = byProvider.get(provider) ?? [];
    if (seriesPoints.length > 0) {
      lines.push({ provider, color, points: seriesPoints });
      legend.push({ provider, color, hasData: true, reason: null });
    } else {
      legend.push({ provider, color, hasData: false, reason: supported ? 'no_data' : 'not_supported' });
    }
  });
  return { lines, legend };
}

// A short axis/tooltip label for a pure calendar date, e.g. "Aug 1". No zone conversion applies here
// — a Y-M-D string has no time-of-day, so there's nothing to convert; UTC is used purely as a fixed,
// environment-independent way to decode the string back into a label.
export const formatYMD = (ymd: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));

// The API returns provider KEYS ('bluesky', 'x', …), not display names — capitalize rather than
// inventing marketing copy for networks we don't have a curated name for.
export const providerLabel = (provider: string): string =>
  provider.length ? provider[0].toUpperCase() + provider.slice(1) : provider;

// Every distinct day between from and to (both 'YYYY-MM-DD', to exclusive) — the chart's x-axis, so a
// day with zero networks reporting is still a position on the axis, not a collapsed gap.
export function daysBetween(fromYMD: string, toYMDExclusive: string): string[] {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMDExclusive.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  const out: string[] = [];
  for (let t = start; t < end; t += 86_400_000) {
    const dt = new Date(t);
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}
