// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { can } from '../../../authz/abilities';
import type { ApprovalItem, ValidationResponse } from '../../../api/types';

// The card reads role/user from the workspace + auth contexts; mock them so a test can pick the role.
const mockCtx = vi.hoisted(() => ({ role: 'owner' as string, userId: 'u-owner' }));
vi.mock('../../../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ active: { id: 'ws1', name: 'Studio', role: mockCtx.role, default_timezone: 'Asia/Kolkata' }, workspaces: [], setActiveId: () => {}, timezone: 'Asia/Kolkata' }),
  useZonedFormat: () => ({ time: (v: unknown) => String(v), date: (v: unknown) => String(v), dateTime: (v: unknown) => String(v), zone: 'IST', timezone: 'Asia/Kolkata' }),
}));
vi.mock('../../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: mockCtx.userId, email: 'o@x.com', name: 'Owner' } }) }));
vi.mock('../../../api/endpoints', () => ({
  validatePost: vi.fn(),
  approvePost: vi.fn(),
  requestChanges: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
import { validatePost, listComments } from '../../../api/endpoints';
import { ApprovalCard } from './ApprovalCard';

afterEach(cleanup);

function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    postId: 'p1', authorId: 'author-1', authorName: 'Ada', authorEmail: 'ada@x.com',
    submittedAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z', editedSinceSubmit: false,
    isPaidPromotion: false, requiredApprovals: 1, approvals: [],
    requesterId: 'author-1', requesterName: 'Ada', requesterIsMember: true,
    scheduleType: 'fixed_instant', scheduledAt: '2026-09-05T09:00:00.000Z', schedulePassed: false,
    ...over,
  };
}
function validation(over: Partial<ValidationResponse> = {}): ValidationResponse {
  return { findings: [], counts: [], threadPreviews: [], previews: [], canSchedule: true, ...over };
}
function renderCard(it: ApprovalItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ApprovalCard item={it} nowMs={Date.parse('2026-09-04T10:05:00.000Z')} /></QueryClientProvider>);
}

beforeEach(() => {
  mockCtx.role = 'owner'; mockCtx.userId = 'u-owner';
  vi.mocked(validatePost).mockResolvedValue(validation());
  vi.mocked(listComments).mockResolvedValue([]);
});

// --- Test #1: an Editor cannot see the Approve action, and it isn't just CSS-hidden — it isn't in the
//     DOM at all, because the gate is the ability, not a style. ---
describe('the approve action is gated on the ability, not hidden', () => {
  it('the ability itself denies an editor (and never lets anyone approve their own post)', () => {
    expect(can('editor', 'u-editor', 'approval:approve', { authorId: 'author-1' })).toBe(false);
    expect(can('owner', 'author-1', 'approval:approve', { authorId: 'author-1' })).toBe(false); // own post
    expect(can('owner', 'u-owner', 'approval:approve', { authorId: 'author-1' })).toBe(true);
  });

  it('an Editor sees neither Approve nor Request changes anywhere in the DOM', () => {
    mockCtx.role = 'editor'; mockCtx.userId = 'u-editor';
    renderCard(item());
    expect(screen.queryByRole('button', { name: /approve and schedule/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull();
  });

  it('an Approver (not the author) does see Approve', () => {
    mockCtx.role = 'approver'; mockCtx.userId = 'u-approver';
    renderCard(item());
    expect(screen.getByRole('button', { name: /approve and schedule/i })).toBeTruthy();
  });
});

// --- Test #2: requesting changes without a note is refused (the send button stays disabled until
//     there's a note; the server refuses an empty one regardless). ---
describe('request changes requires a note', () => {
  it('the send button is disabled until a note is typed', () => {
    renderCard(item());
    fireEvent.click(screen.getByRole('button', { name: /request changes/i }));
    const send = screen.getByRole('button', { name: /send back for changes/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);                       // empty note -> refused
    fireEvent.change(screen.getByLabelText(/what needs to change/i), { target: { value: 'Trim the caption' } });
    expect(send.disabled).toBe(false);                      // a real note enables it
  });
});

// --- Test #3: approving a post whose scheduled time has passed shows the "past" reason and blocks the
//     action (the server would refuse it too). ---
describe('a post whose scheduled time has passed', () => {
  it('shows the past reason and disables Approve', async () => {
    renderCard(item({ schedulePassed: true }));
    // Both a badge and the action-side reason name it; assert the action-side reason specifically.
    expect(screen.getByText(/reschedule this post before approving/i)).toBeTruthy();
    expect(screen.getAllByText(/already passed/i).length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      const approve = screen.getByRole('button', { name: /approve and schedule/i }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
    });
  });
});
