// src/scheduling/time.ts
// Wall-clock -> UTC, implemented with Intl zone offsets (no external tz library), so the DST edge
// cases are handled EXPLICITLY to the rules fixed in Phase 1:
//   - spring-forward GAP (a wall time that doesn't exist): fire at the first valid instant — the
//     transition moment (e.g. 02:30 on the jump day -> 03:00).
//   - fall-back OVERLAP (a wall time that happens twice): take the FIRST occurrence (earlier UTC).
// Handles non-hour offsets (Asia/Kolkata +5:30) and no-DST zones (Asia/Ho_Chi_Minh +7) uniformly.

export type DstAdjustment = 'none' | 'gap_shifted_forward' | 'overlap_took_first';

// Offset in minutes such that localMillis = utcMillis + offset*60000.
function offsetMinutes(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - utcMs) / 60000;
}

const localMs = (timeZone: string, utcMs: number): number => utcMs + offsetMinutes(timeZone, utcMs) * 60000;

// First instant (to the minute) in (loMs, hiMs] whose offset differs from the offset at loMs.
function findTransition(timeZone: string, loMs: number, hiMs: number): number {
  const offLo = offsetMinutes(timeZone, loMs);
  let lo = loMs;
  let hi = hiMs;
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
    if (offsetMinutes(timeZone, mid) === offLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function resolveWallClockToUTC(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): { instant: Date; adjustment: DstAdjustment } {
  const wallMs = Date.UTC(y, mo - 1, d, h, mi);
  // Sample the offsets on both sides of any transition within ±12h of the wall time.
  const offBefore = offsetMinutes(timeZone, wallMs - 12 * 3600_000);
  const offAfter = offsetMinutes(timeZone, wallMs + 12 * 3600_000);
  const candidates = [...new Set([wallMs - offBefore * 60000, wallMs - offAfter * 60000])]
    .filter((t) => localMs(timeZone, t) === wallMs) // only instants that actually read back as W
    .sort((a, b) => a - b);

  if (candidates.length === 1) return { instant: new Date(candidates[0]), adjustment: 'none' };
  if (candidates.length === 2) return { instant: new Date(candidates[0]), adjustment: 'overlap_took_first' };
  // Gap: no instant maps to W. Fire at the transition moment (first valid instant after the gap).
  const transition = findTransition(timeZone, wallMs - 12 * 3600_000, wallMs + 12 * 3600_000);
  return { instant: new Date(transition), adjustment: 'gap_shifted_forward' };
}

// Turn a schedule intent + an account's IANA zone into that target's absolute UTC instant.
export interface ScheduleIntent {
  type: 'fixed_instant' | 'audience_local' | 'queued';
  scheduledAt?: Date | null;   // fixed_instant + queued (the resolved slot occurrence)
  localDate?: string | null;   // 'YYYY-MM-DD' for audience_local
  localTime?: string | null;   // 'HH:MM' for audience_local
}

export function resolveTargetInstant(intent: ScheduleIntent, accountTimeZone: string): { instant: Date; adjustment: DstAdjustment } {
  if (intent.type === 'audience_local') {
    const [y, mo, d] = (intent.localDate ?? '').split('-').map(Number);
    const [h, mi] = (intent.localTime ?? '').split(':').map(Number);
    return resolveWallClockToUTC(accountTimeZone, y, mo, d, h, mi);
  }
  // fixed_instant and queued are already absolute instants (same for every target).
  return { instant: intent.scheduledAt!, adjustment: 'none' };
}
