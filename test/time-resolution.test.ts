// test/time-resolution.test.ts
// Wall-clock -> UTC across real DST boundaries in real zones, plus a non-hour offset and a no-DST
// zone (both are actual Meridian markets). Pure — no DB.
import { describe, it, expect } from 'vitest';
import { resolveWallClockToUTC, resolveTargetInstant } from '../src/scheduling/time';

describe('time resolution', () => {
  it('no-DST zone Asia/Ho_Chi_Minh (+7) resolves straight through', () => {
    const { instant, adjustment } = resolveWallClockToUTC('Asia/Ho_Chi_Minh', 2026, 6, 15, 9, 30);
    expect(adjustment).toBe('none');
    expect(instant.getTime()).toBe(Date.UTC(2026, 5, 15, 2, 30)); // 09:30 +07:00 => 02:30 UTC
  });

  it('non-hour offset Asia/Kolkata (+5:30) resolves correctly', () => {
    const { instant, adjustment } = resolveWallClockToUTC('Asia/Kolkata', 2026, 6, 15, 9, 30);
    expect(adjustment).toBe('none');
    expect(instant.getTime()).toBe(Date.UTC(2026, 5, 15, 4, 0)); // 09:30 +05:30 => 04:00 UTC
  });

  it('spring-forward GAP (America/New_York, 2024-03-10 02:30 does not exist) fires at the transition', () => {
    const { instant, adjustment } = resolveWallClockToUTC('America/New_York', 2024, 3, 10, 2, 30);
    expect(adjustment).toBe('gap_shifted_forward');
    expect(instant.getTime()).toBe(Date.UTC(2024, 2, 10, 7, 0)); // clocks jump to 03:00 EDT = 07:00 UTC
  });

  it('fall-back OVERLAP (America/New_York, 2024-11-03 01:30 happens twice) takes the FIRST', () => {
    const { instant, adjustment } = resolveWallClockToUTC('America/New_York', 2024, 11, 3, 1, 30);
    expect(adjustment).toBe('overlap_took_first');
    expect(instant.getTime()).toBe(Date.UTC(2024, 10, 3, 5, 30)); // first 01:30 is EDT (-4) => 05:30 UTC
  });

  it('a Southern-Hemisphere spring-forward (Australia/Sydney, 2024-10-06 02:30) also shifts forward', () => {
    const { adjustment } = resolveWallClockToUTC('Australia/Sydney', 2024, 10, 6, 2, 30);
    expect(adjustment).toBe('gap_shifted_forward');
  });

  it('resolveTargetInstant handles audience-local through a gap', () => {
    const { instant, adjustment } = resolveTargetInstant({ type: 'audience_local', localDate: '2024-03-10', localTime: '02:30' }, 'America/New_York');
    expect(adjustment).toBe('gap_shifted_forward');
    expect(instant.getTime()).toBe(Date.UTC(2024, 2, 10, 7, 0));
  });

  it('resolveTargetInstant passes a fixed instant through untouched', () => {
    const fixed = new Date('2026-01-01T12:00:00Z');
    const { instant } = resolveTargetInstant({ type: 'fixed_instant', scheduledAt: fixed }, 'Asia/Kolkata');
    expect(instant.getTime()).toBe(fixed.getTime());
  });
});
