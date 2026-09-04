import { describe, it, expect } from 'vitest';
import { ymdInZone } from '../../../lib/datetime';
import { presetRange, formatCompact, formatCount, formatPercent, formatChange, buildSeries, colorFor, daysBetween } from './analyticsLogic';
import type { DailyPoint, NetworkPostCount } from '../../../api/types';

describe('unavailable renders as "—", never 0', () => {
  it('every formatter treats null as unavailable, not zero', () => {
    expect(formatCompact(null)).toBe('—');
    expect(formatCount(null)).toBe('—');
    expect(formatPercent(null)).toBe('—');
    // A genuine zero is a real measured value and reads as "0", not "—" — the two must stay distinct.
    expect(formatCompact(0)).toBe('0');
    expect(formatCount(0)).toBe('0');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('engagement rate matches the server\'s definition on a fixture', () => {
  it('formats the SAME ratio the server computes (engagements ÷ impressions) — never a different formula', () => {
    // Hand-worked fixture matching the server's documented definition (src/analytics/normalize.ts):
    // engagement rate = engagements / impressions. 104,200 engagements over 1,240,000 impressions.
    const engagements = 104_200;
    const impressions = 1_240_000;
    const serverComputedRatio = engagements / impressions; // what the API would return as .value
    expect(formatPercent(serverComputedRatio)).toBe('8.4%');
  });
  it('a network with no impressions makes the rate unavailable, never a fake 0% or a worse-looking rate', () => {
    // A rate the server never computed (null) must render "—" — the frontend must not derive one from
    // engagements alone, which would silently drag the workspace-wide rate down.
    expect(formatPercent(null)).toBe('—');
  });
});

describe('period-over-period change', () => {
  it('formats the server\'s relative changePct with a sign and direction', () => {
    expect(formatChange(0.142)).toEqual({ text: '+14.2% vs previous period', direction: 'up' });
    expect(formatChange(-0.021)).toEqual({ text: '−2.1% vs previous period', direction: 'down' });
  });
  it('null (no prior period, or a previous value of 0) is stated plainly — never a fake 0% or a dash', () => {
    expect(formatChange(null)).toEqual({ text: 'no prior period', direction: null });
  });
});

describe('the range preset is computed from an explicit zone-derived date, not the browser clock', () => {
  it('"30d" ending on a given day spans that day and the 29 before it', () => {
    const r = presetRange('30d', '2026-08-30');
    expect(r).toEqual({ from: '2026-08-01', to: '2026-08-30' });
  });
  it('the SAME instant yields a different "today" — and therefore a different range — per zone', () => {
    // 2026-08-30T23:30:00Z is already Aug 31 in Tokyo (+9) but still Aug 30 in Los Angeles (-7).
    const instant = '2026-08-30T23:30:00.000Z';
    const tokyoToday = ymdInZone(instant, 'Asia/Tokyo');
    const laToday = ymdInZone(instant, 'America/Los_Angeles');
    expect(tokyoToday).toBe('2026-08-31');
    expect(laToday).toBe('2026-08-30');
    expect(presetRange('7d', tokyoToday)).not.toEqual(presetRange('7d', laToday));
  });
});

describe('a network with no data is OMITTED from the chart, but still listed in the legend', () => {
  const networks: NetworkPostCount[] = [
    { provider: 'bluesky', posts: 5, metricsSupported: true },
    { provider: 'x', posts: 3, metricsSupported: true },
    { provider: 'line', posts: 2, metricsSupported: false },
  ];
  const points: DailyPoint[] = [
    { provider: 'bluesky', day: '2026-08-10', engagements: 40, impressions: null },
    { provider: 'bluesky', day: '2026-08-11', engagements: 55, impressions: null },
    // 'x' posted (per `networks`) but has NO rows at all in the daily series for this metric.
    // 'line' doesn't support metrics — also no rows.
  ];

  it('draws a line only for the network that actually has values', () => {
    const { lines } = buildSeries(points, networks, 'engagements');
    expect(lines.map((l) => l.provider)).toEqual(['bluesky']);
    expect(lines[0].points).toEqual([{ day: '2026-08-10', value: 40 }, { day: '2026-08-11', value: 55 }]);
  });

  it('never draws a zero-value line for a network with no data', () => {
    const { lines } = buildSeries(points, networks, 'engagements');
    const flat = lines.flatMap((l) => l.points);
    expect(flat.some((p) => p.value === 0)).toBe(false);
  });

  it('lists EVERY network in the legend, marking the data-less ones explicitly rather than hiding them', () => {
    const { legend } = buildSeries(points, networks, 'engagements');
    expect(legend.map((e) => e.provider)).toEqual(['bluesky', 'line', 'x']); // sorted, all three present
    expect(legend.find((e) => e.provider === 'bluesky')).toMatchObject({ hasData: true, reason: null });
    expect(legend.find((e) => e.provider === 'x')).toMatchObject({ hasData: false, reason: 'no_data' });
    expect(legend.find((e) => e.provider === 'line')).toMatchObject({ hasData: false, reason: 'not_supported' });
  });

  it('colours come only from the c1-c4 tokens, and stay stable whether or not a line is drawn', () => {
    const { legend } = buildSeries(points, networks, 'engagements');
    for (const e of legend) expect(['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)']).toContain(e.color);
    expect(colorFor(0)).toBe('var(--c1)');
    expect(colorFor(4)).toBe('var(--c1)'); // cycles, never invents a 5th colour
  });
});

describe('daysBetween', () => {
  it('lists every day in [from, to) — the x-axis never silently collapses a gap', () => {
    expect(daysBetween('2026-08-28', '2026-09-01')).toEqual(['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
  });
});
