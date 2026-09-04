import { describe, it, expect } from 'vitest';
import { deriveBadges, approvalProgress, approverLabel, relativeAge } from './approvalsLogic';
import type { ApprovalItem } from '../../../api/types';

// A base pending item; each test overrides the one field it exercises. Every awkward-case flag is a
// SERVER-computed field — these helpers only turn flags into badges, they never re-derive a rule.
function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    postId: 'p1', authorId: 'a1', authorName: 'Ada', authorEmail: 'ada@x.com',
    submittedAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z', editedSinceSubmit: false,
    isPaidPromotion: false, requiredApprovals: 1, approvals: [],
    requesterId: 'a1', requesterName: 'Ada', requesterIsMember: true,
    scheduleType: 'fixed_instant', scheduledAt: '2026-09-05T09:00:00.000Z', schedulePassed: false,
    ...over,
  };
}

describe('the four awkward cases each surface as a badge', () => {
  const now = new Date('2026-09-04T10:05:00.000Z').getTime();

  it('(a) edited since submit shows how long ago it changed', () => {
    const badges = deriveBadges(item({ editedSinceSubmit: true, updatedAt: '2026-09-04T10:02:00.000Z' }), now);
    expect(badges.some((b) => b.tone === 'warn' && /Was updated 3m ago/.test(b.text))).toBe(true);
  });

  it('(b) a lapsed scheduled time is called out as already passed', () => {
    const badges = deriveBadges(item({ schedulePassed: true }), now);
    expect(badges.some((b) => b.tone === 'bad' && /already passed/i.test(b.text))).toBe(true);
  });

  it('(c) a paid promotion states it needs two approvals', () => {
    const badges = deriveBadges(item({ isPaidPromotion: true, requiredApprovals: 2 }), now);
    expect(badges.some((b) => /needs 2 approvals/i.test(b.text))).toBe(true);
  });

  it('(d) a requester who left the workspace is surfaced', () => {
    const badges = deriveBadges(item({ requesterIsMember: false, requesterName: 'Bo' }), now);
    expect(badges.some((b) => /Bo has left this workspace/.test(b.text))).toBe(true);
  });
});

describe('two-approver progress', () => {
  it('shows who approved and how many are still owed, flagging an approver who left', () => {
    const p = approvalProgress(item({
      isPaidPromotion: true, requiredApprovals: 2,
      approvals: [{ approverId: 'x', name: 'Xin', email: 'xin@x.com', isMember: false }],
    }))!;
    expect(p.required).toBe(2);
    expect(p.remaining).toBe(1);
    expect(approverLabel(p.approved[0])).toBe('Xin (removed from workspace)');
  });

  it('a single-approval post with no approvals yet has nothing to show', () => {
    expect(approvalProgress(item())).toBeNull();
  });
});

describe('relativeAge', () => {
  it('reads as minutes / hours / days, clamped at "just now"', () => {
    const base = new Date('2026-09-04T12:00:00.000Z').getTime();
    expect(relativeAge('2026-09-04T11:58:00.000Z', base)).toBe('2m ago');
    expect(relativeAge('2026-09-04T09:00:00.000Z', base)).toBe('3h ago');
    expect(relativeAge('2026-09-01T12:00:00.000Z', base)).toBe('3d ago');
    expect(relativeAge('2026-09-04T12:00:30.000Z', base)).toBe('just now');
  });
});
