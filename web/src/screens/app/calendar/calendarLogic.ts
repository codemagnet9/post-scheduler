// src/screens/app/calendar/calendarLogic.ts
// Pure helpers for the calendar. All placement is done in the VIEWING ZONE (an event's cell is its
// date in that zone), never the browser's — that's how a Mumbai user viewing a Vietnam workspace sees
// events fall on the right days. The date helpers are the only ones allowed to format instants.
import { ApiError } from '../../../api/client';
import { formatTime } from '../../../lib/datetime';

export interface DayCell { y: number; m: number; d: number; inMonth: boolean }

// A Monday-start 6×7 grid for the month containing (year, month0). Cells are plain calendar dates.
export function monthGrid(year: number, month0: number): DayCell[] {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstDow = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(year, month0, 1 - firstDow);
  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start + i * 86_400_000);
    cells.push({ y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), inMonth: d.getUTCMonth() === month0 });
  }
  return cells;
}

// One week (Mon-start) containing `anchor`.
export function weekGrid(anchor: Date): DayCell[] {
  const dow = (anchor.getUTCDay() + 6) % 7;
  const start = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), inMonth: true };
  });
}

export const cellKey = (c: { y: number; m: number; d: number }): string =>
  `${c.y}-${String(c.m + 1).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;

// The date an instant falls on IN A GIVEN ZONE, as 'YYYY-MM-DD' (en-CA yields that format).
export function zonedDateKey(instant: string, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

// The wall-clock time of an event in the viewing zone (never the browser zone).
export const eventTimeLabel = (instant: string, zone: string): string => formatTime(instant, zone);

export function eventClass(state: string): string {
  switch (state) {
    case 'published': return 's-pub';
    case 'failed':
    case 'needs_review': return 's-fail';
    case 'draft': return 's-draft';
    case 'canceled': return 's-draft';
    default: return 's-sched';
  }
}

// Perform a reschedule and surface the server's reason on refusal — the move is NEVER committed
// locally until the server confirms, and a refusal returns the exact reason (with request id) to show.
export async function attemptReschedule(fn: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof ApiError ? e.displayMessage : 'Could not move this post.' };
  }
}
