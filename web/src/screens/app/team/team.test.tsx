// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../../../api/client';
import type { Member } from '../../../api/types';

const mockCtx = vi.hoisted(() => ({ role: 'owner' as string, userId: 'u-owner' }));
vi.mock('../../../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ active: { id: 'ws1', name: 'Studio', role: mockCtx.role, default_timezone: 'Asia/Kolkata' }, workspaces: [], setActiveId: () => {}, timezone: 'Asia/Kolkata' }),
  useZonedFormat: () => ({ time: (v: unknown) => String(v), date: (v: unknown) => String(v), dateTime: (v: unknown) => String(v), zone: 'IST', timezone: 'Asia/Kolkata' }),
}));
vi.mock('../../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: mockCtx.userId, email: 'o@x.com', name: 'Owner' } }) }));
// Keep the top bar (and its notifications bell / router use) out of this unit test.
vi.mock('../../../shell/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../../api/endpoints', () => ({
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  inviteMember: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));
import { listMembers, listInvitations, changeMemberRole } from '../../../api/endpoints';
import { Team } from './Team';

afterEach(cleanup);

const owner: Member = { userId: 'u-owner', name: 'Owner', email: 'o@x.com', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-09-04T09:00:00.000Z' };

function renderTeam() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Team /></QueryClientProvider>);
}

beforeEach(() => {
  mockCtx.role = 'owner'; mockCtx.userId = 'u-owner';
  vi.mocked(listMembers).mockResolvedValue([owner]);
  vi.mocked(listInvitations).mockResolvedValue([]);
});

// --- Test #4: the last Owner cannot demote themselves — and the UI renders the SERVER's refusal reason
//     verbatim, rather than a message the frontend invented. ---
describe('last-owner demotion is refused with the server reason', () => {
  it('renders "Cannot demote the last Owner" exactly as the server sent it', async () => {
    // The server rule refuses the demotion; the message is the server's, rendered verbatim (no request
    // id here so displayMessage is exactly the sentence).
    vi.mocked(changeMemberRole).mockRejectedValue(new ApiError('last_owner', 'Cannot demote the last Owner', 400, null));

    renderTeam();
    const roleSelect = await screen.findByLabelText('Role for Owner');
    fireEvent.change(roleSelect, { target: { value: 'approver' } });

    await waitFor(() => expect(screen.getByText('Cannot demote the last Owner')).toBeTruthy());
    expect(changeMemberRole).toHaveBeenCalledWith('ws1', 'u-owner', 'approver');
  });
});
