// src/screens/app/approvals/approvalsLogic.ts
// Pure helpers for the approvals inbox — no React, no network — so the four awkward cases are
// unit-testable. Nothing here evaluates a business rule: every input (editedSinceSubmit, schedulePassed,
// requiredApprovals, isMember) is a SERVER-computed field on ApprovalItem. These functions only turn
// those flags into the badges and the "who approved / who's owed" line the screen renders.
import type { ApprovalItem, ApprovalApprover } from '../../../api/types';

export type BadgeTone = 'warn' | 'bad' | 'info' | 'mute';
export interface ApprovalBadge { tone: BadgeTone; text: string }

// A coarse "3m ago" / "2h ago" / "4d ago" from an elapsed duration. This is display-only elapsed time
// (no wall-clock, no zone), so it doesn't go through the workspace-tz formatters — it's a relative
// span, not a point in time. `nowMs` is injected for testability.
export function relativeAge(iso: string, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - new Date(iso).getTime());
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// The badges that make the awkward backend cases legible. Order is by urgency: a lapsed schedule and an
// edit-that-voided-the-approval come first because they block or reset the review.
export function deriveBadges(item: ApprovalItem, nowMs: number): ApprovalBadge[] {
  const badges: ApprovalBadge[] = [];

  // (a) edited while under review — Phase 8 voids the approval, so the reviewer is looking at a moving
  //     target. Surface exactly how long ago it changed.
  if (item.editedSinceSubmit && item.updatedAt) {
    badges.push({ tone: 'warn', text: `Was updated ${relativeAge(item.updatedAt, nowMs)}` });
  }

  // (b) the fixed slot already passed while it waited — approving now would try to schedule in the past.
  if (item.schedulePassed) {
    badges.push({ tone: 'bad', text: 'Scheduled time has already passed' });
  }

  // (c) a paid promotion needs two distinct approvers.
  if (item.isPaidPromotion) {
    badges.push({ tone: 'info', text: `Paid promotion · needs ${item.requiredApprovals} approvals` });
  }

  // (d) the person who requested review is no longer in the workspace.
  if (item.requesterId && !item.requesterIsMember) {
    const who = item.requesterName ?? 'The requester';
    badges.push({ tone: 'mute', text: `${who} has left this workspace` });
  }

  return badges;
}

// The two-approver progress line: who has approved (with a "left the workspace" note if they since
// departed) and how many approvals are still owed. Returns null for a single-approval post that already
// has no recorded approvals — nothing to show yet.
export interface ApprovalProgress {
  approved: ApprovalApprover[];
  required: number;
  remaining: number;
}
export function approvalProgress(item: ApprovalItem): ApprovalProgress | null {
  if (item.requiredApprovals <= 1 && item.approvals.length === 0) return null;
  return {
    approved: item.approvals,
    required: item.requiredApprovals,
    remaining: Math.max(0, item.requiredApprovals - item.approvals.length),
  };
}

export function approverLabel(a: ApprovalApprover): string {
  const name = a.name ?? a.email ?? 'Unknown';
  return a.isMember ? name : `${name} (removed from workspace)`;
}

export function authorLabel(item: ApprovalItem): string {
  return item.authorName ?? item.authorEmail ?? 'Unknown author';
}
