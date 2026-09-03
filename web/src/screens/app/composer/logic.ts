// src/screens/app/composer/logic.ts
// Pure composer helpers — no React, no network — so the rules that matter are unit-testable. Note:
// the frontend NEVER counts characters or evaluates a validation rule; counts/findings come from the
// API. These helpers only decide *what to send* and *which server value to show*.
import type { CharCount, Role, SchedulePatch } from '../../../api/types';

// A network tab's edit -> override patch. Empty (whitespace-only) means "return to inherited" (null);
// any real text becomes the override. The server does the merge; we only send the field.
export function overrideForNetworkTab(value: string): { text: string | null } {
  return value.trim() === '' ? { text: null } : { text: value };
}

// Direct scheduling is Owner/Approver only (mirrors the backend post:schedule ability). Editors must
// route through approval; Analysts can't compose at all.
export function canDirectSchedule(role: Role): boolean {
  return role === 'owner' || role === 'approver';
}
export function canCompose(role: Role): boolean {
  return role === 'owner' || role === 'approver' || role === 'editor';
}

export type ScheduleMode = 'now' | 'time' | 'queue';
export type TimeBasis = 'audience' | 'workspace' | 'utc';

// Map the schedule row's UI state to the API's schedule patch. The browser NEVER converts a wall clock
// to an instant: audience-local and both fixed bases send the wall clock + its zone, and the API
// resolves the instant with its DST-correct resolver, so client and server can't disagree about what
// "09:30" means. ("Publish now" sends the current instant, which is unambiguous — no wall-clock input.)
export function buildSchedulePayload(
  mode: ScheduleMode,
  opts: { date: string; time: string; basis: TimeBasis; workspaceTimezone: string; now: Date },
): SchedulePatch {
  if (mode === 'now') return { type: 'fixed_instant', scheduledAt: opts.now.toISOString() };
  if (mode === 'queue') return { type: 'queued', queueMarketTimezone: opts.workspaceTimezone };
  // mode === 'time'
  if (opts.basis === 'audience') return { type: 'audience_local', localDate: opts.date, localTime: opts.time };
  // 'utc' or 'workspace' -> a single fixed instant, resolved by the API from the wall clock + zone.
  return { type: 'fixed_instant', localDate: opts.date, localTime: opts.time, fixedTimezone: opts.basis === 'utc' ? 'UTC' : opts.workspaceTimezone };
}

// The tightest per-network count (least characters remaining), for the shared "All networks" toolbar.
export function tightestCount(counts: CharCount[]): CharCount | null {
  if (!counts.length) return null;
  return counts.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

// The city-ish label for a market from its IANA zone: 'Asia/Kolkata' -> 'KOLKATA'.
export function marketLabel(timeZone: string): string {
  const seg = timeZone.split('/').pop() ?? timeZone;
  return seg.replace(/_/g, ' ').toUpperCase();
}
