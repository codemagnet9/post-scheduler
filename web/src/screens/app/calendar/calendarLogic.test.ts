import { describe, it, expect } from 'vitest';
import { monthGrid, cellKey, zonedDateKey, eventTimeLabel, eventClass, attemptReschedule } from './calendarLogic';
import { ApiError } from '../../../api/client';

describe('calendar renders in the workspace zone, not the browser', () => {
  const INSTANT = '2026-08-30T04:00:00.000Z'; // 09:30 in Kolkata, 11:00 in Ho Chi Minh
  it('an event time is the wall clock in the given zone', () => {
    expect(eventTimeLabel(INSTANT, 'Asia/Kolkata')).toBe('09:30');
    expect(eventTimeLabel(INSTANT, 'Asia/Ho_Chi_Minh')).toBe('11:00');
    expect(eventTimeLabel(INSTANT, 'Asia/Kolkata')).not.toBe(eventTimeLabel(INSTANT, 'Asia/Ho_Chi_Minh'));
  });
  it('an event lands on the correct calendar day for the viewing zone', () => {
    const late = '2026-08-30T22:00:00.000Z';
    expect(zonedDateKey(late, 'Asia/Tokyo')).toBe('2026-08-31');       // already next day in JST
    expect(zonedDateKey(late, 'America/Los_Angeles')).toBe('2026-08-30'); // still the 30th in PDT
  });
});

describe('month grid', () => {
  it('is a Monday-start 6x7 grid with the month\'s own days flagged', () => {
    const g = monthGrid(2026, 7); // August 2026
    expect(g).toHaveLength(42);
    expect(g.filter((c) => c.inMonth)).toHaveLength(31); // August has 31 days
    const aug15 = g.find((c) => cellKey(c) === '2026-08-15');
    expect(aug15?.inMonth).toBe(true);
  });
});

describe('event colour by state', () => {
  it('maps state to the prototype pill classes', () => {
    expect(eventClass('scheduled')).toBe('s-sched');
    expect(eventClass('published')).toBe('s-pub');
    expect(eventClass('failed')).toBe('s-fail');
    expect(eventClass('draft')).toBe('s-draft');
  });
});

describe('reschedule refusal surfaces the reason (never a silent optimistic move)', () => {
  it('returns the server reason and request id on refusal, ok on success', async () => {
    const refused = await attemptReschedule(() => Promise.reject(new ApiError('conflict', 'That time has already passed — pick a time in the future.', 409, 'req-42')));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('That time has already passed');
      expect(refused.reason).toContain('req-42'); // the request id is shown for support
    }
    expect(await attemptReschedule(() => Promise.resolve({}))).toEqual({ ok: true });
  });
});
