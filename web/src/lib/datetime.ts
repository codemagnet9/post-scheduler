// src/lib/datetime.ts
// TIMEZONE DISCIPLINE. Every date shown in the app is formatted HERE, in the ACTIVE WORKSPACE's
// timezone — never the browser's. A user in Mumbai looking at a Vietnam workspace sees ICT. The only
// way to render a time is through these helpers (or the useZonedFormat hook that binds the workspace
// tz), so no component can accidentally reach for the local zone.
//
// Every function takes an explicit IANA `timeZone`; there is no implicit "local" fallback on purpose.

type Instant = string | number | Date;
const toDate = (v: Instant): Date => (v instanceof Date ? v : new Date(v));

export function formatInZone(value: Instant, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(toDate(value));
}

// 24-hour wall-clock in the given zone, e.g. "09:30".
export const formatTime = (value: Instant, timeZone: string): string =>
  formatInZone(value, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });

// e.g. "Aug 30, 2026".
export const formatDate = (value: Instant, timeZone: string): string =>
  formatInZone(value, timeZone, { year: 'numeric', month: 'short', day: '2-digit' });

// e.g. "Aug 30, 09:30".
export const formatDateTime = (value: Instant, timeZone: string): string =>
  formatInZone(value, timeZone, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

// The zone's short name for the label the design shows next to a time (e.g. IST / ICT / GMT+7,
// depending on what ICU provides for the zone). Kept in this one place so it stays consistent.
export function zoneAbbrev(timeZone: string, at: Instant = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(toDate(at));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

// The CALENDAR DATE (YYYY-MM-DD) an instant falls on in a given zone — the zone-aware counterpart to
// `new Date().toISOString().slice(0,10)`, which is always UTC's date and therefore wrong here. This is
// how "today" and range boundaries are computed IN THE WORKSPACE'S ZONE, not the browser's.
export const ymdInZone = (value: Instant, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(toDate(value));
