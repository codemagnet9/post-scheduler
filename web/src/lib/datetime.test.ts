// src/lib/datetime.test.ts
import { describe, it, expect } from 'vitest';
import { formatTime, formatDate, formatInZone } from './datetime';

// One fixed instant: 2026-08-30 04:00:00 UTC.
const INSTANT = '2026-08-30T04:00:00Z';

describe('timezone discipline', () => {
  it('renders the SAME instant in the workspace timezone, not the browser timezone', () => {
    // 04:00 UTC is 09:30 in Mumbai (IST, +5:30) and 11:00 in Hanoi (ICT, +7).
    expect(formatTime(INSTANT, 'Asia/Kolkata')).toBe('09:30');
    expect(formatTime(INSTANT, 'Asia/Ho_Chi_Minh')).toBe('11:00');
    // The two differ => the zone argument, not the machine's zone, decides the output.
    expect(formatTime(INSTANT, 'Asia/Kolkata')).not.toBe(formatTime(INSTANT, 'Asia/Ho_Chi_Minh'));
  });

  it('a Mumbai user viewing a Vietnam workspace sees ICT wall-clock', () => {
    // Whatever the runner's local zone is, passing the workspace zone yields Vietnam time.
    expect(formatTime(INSTANT, 'Asia/Ho_Chi_Minh')).toBe('11:00');
  });

  it('crosses the date line correctly per zone', () => {
    // 22:00 UTC on the 30th is already the 31st in Tokyo (JST, +9): 07:00 next day.
    const late = '2026-08-30T22:00:00Z';
    expect(formatDate(late, 'Asia/Tokyo')).toBe('Aug 31, 2026');
    expect(formatDate(late, 'America/Los_Angeles')).toBe('Aug 30, 2026'); // still the 30th (PDT, -7)
    expect(formatTime(late, 'Asia/Tokyo')).toBe('07:00');
  });

  it('formatInZone honours arbitrary options in the given zone', () => {
    expect(formatInZone(INSTANT, 'Asia/Kolkata', { hour: '2-digit', minute: '2-digit', hour12: true })).toMatch(/9:30\s?AM/);
  });
});
