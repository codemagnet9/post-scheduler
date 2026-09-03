// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EventDetail } from './EventDetail';
import type { BoardEvent } from '../../../api/types';

afterEach(cleanup);
const ev = (over: Partial<BoardEvent>): BoardEvent => ({
  targetId: 't', postId: 'p', provider: 'x', handle: '@a', displayName: 'A', timezone: 'UTC', state: 'scheduled',
  scheduleType: 'audience_local', instant: null, scheduledAt: null, publishedAt: null, failureCode: null, reason: null, text: 'Launch', authorId: null, ...over,
});

describe('audience-local event detail shows per-target instants', () => {
  it('an audience-local post fanned to two markets is not shown as one instant', () => {
    // 09:30 audience-local => India 04:00Z and Vietnam 02:30Z (same wall clock, different instants).
    const india = ev({ targetId: 'in', handle: '@in', timezone: 'Asia/Kolkata', instant: '2026-09-01T04:00:00.000Z' });
    const vietnam = ev({ targetId: 'vn', handle: '@vn', timezone: 'Asia/Ho_Chi_Minh', instant: '2026-09-01T02:30:00.000Z' });
    render(<EventDetail siblings={[india, vietnam]} viewZone="Asia/Kolkata" onClose={() => {}} />);

    const indiaRow = (screen.getByText((c) => c.startsWith('KOLKATA ·')).textContent ?? '');
    const vnRow = (screen.getByText((c) => c.startsWith('HO CHI MINH ·')).textContent ?? '');

    expect(indiaRow).toContain('09:30');            // India publishes 09:30 its time
    expect(vnRow).toContain('09:30');               // Vietnam publishes 09:30 ITS time...
    expect(vnRow).toContain('08:00');               // ...which is 08:00 in the viewing zone — a DIFFERENT instant
    expect(indiaRow).not.toContain('08:00');        // the two are genuinely different moments
  });
});
