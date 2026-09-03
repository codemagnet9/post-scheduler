import { describe, it, expect } from 'vitest';
import { overrideForNetworkTab, canDirectSchedule, buildSchedulePayload, tightestCount } from './logic';
import type { CharCount } from '../../../api/types';

describe('override patch (set then cleared returns to inherited)', () => {
  it('real text becomes an override; clearing to empty returns to inherited (null)', () => {
    expect(overrideForNetworkTab('Xin chào các bạn')).toEqual({ text: 'Xin chào các bạn' }); // Vietnamese, unchanged
    expect(overrideForNetworkTab('')).toEqual({ text: null });
    expect(overrideForNetworkTab('   ')).toEqual({ text: null });
  });
});

describe('role gating', () => {
  it('only Owner/Approver can schedule directly; Editor and Analyst cannot', () => {
    expect(canDirectSchedule('owner')).toBe(true);
    expect(canDirectSchedule('approver')).toBe(true);
    expect(canDirectSchedule('editor')).toBe(false);
    expect(canDirectSchedule('analyst')).toBe(false);
  });
});

describe('schedule payload', () => {
  const now = new Date('2026-08-30T00:00:00.000Z');
  it('audience-local sends the wall clock for the API to resolve per market', () => {
    expect(buildSchedulePayload('time', { date: '2026-09-01', time: '09:30', basis: 'audience', workspaceTimezone: 'Asia/Kolkata', now }))
      .toEqual({ type: 'audience_local', localDate: '2026-09-01', localTime: '09:30' });
  });
  it('fixed bases send the wall clock + zone for the API to resolve (no client conversion)', () => {
    expect(buildSchedulePayload('time', { date: '2026-09-01', time: '09:30', basis: 'utc', workspaceTimezone: 'Asia/Kolkata', now }))
      .toEqual({ type: 'fixed_instant', localDate: '2026-09-01', localTime: '09:30', fixedTimezone: 'UTC' });
    expect(buildSchedulePayload('time', { date: '2026-09-01', time: '09:30', basis: 'workspace', workspaceTimezone: 'Asia/Kolkata', now }))
      .toEqual({ type: 'fixed_instant', localDate: '2026-09-01', localTime: '09:30', fixedTimezone: 'Asia/Kolkata' });
  });
  it('now and queue map to their types', () => {
    expect(buildSchedulePayload('now', { date: '', time: '', basis: 'audience', workspaceTimezone: 'UTC', now }))
      .toEqual({ type: 'fixed_instant', scheduledAt: now.toISOString() });
    expect(buildSchedulePayload('queue', { date: '', time: '', basis: 'audience', workspaceTimezone: 'Asia/Tokyo', now }).type).toBe('queued');
  });
});

describe('tightestCount', () => {
  it('picks the network with the least characters remaining', () => {
    const counts: CharCount[] = [
      { targetId: 'a', provider: 'x', unit: 'graphemes', count: 10, limit: 100, remaining: 90 },
      { targetId: 'b', provider: 'bluesky', unit: 'graphemes', count: 290, limit: 300, remaining: 10 },
    ];
    expect(tightestCount(counts)?.targetId).toBe('b');
  });
});
