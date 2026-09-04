// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { Notification } from '../api/types';

vi.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ active: { id: 'ws1', name: 'Studio', role: 'owner', default_timezone: 'Asia/Kolkata' }, workspaces: [], setActiveId: () => {}, timezone: 'Asia/Kolkata' }),
  useZonedFormat: () => ({ time: (v: unknown) => String(v), date: (v: unknown) => String(v), dateTime: (v: unknown) => String(v), zone: 'IST', timezone: 'Asia/Kolkata' }),
}));
vi.mock('../api/endpoints', () => ({ listNotifications: vi.fn(), markNotificationRead: vi.fn() }));
import { listNotifications, markNotificationRead } from '../api/endpoints';
import { NotificationsBell } from './NotificationsBell';

afterEach(cleanup);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}
function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <NotificationsBell />
        <Routes><Route path="*" element={<LocationProbe />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const notif = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1', event_type: 'needs_approval', title: 'A post needs your approval', body: 'Ada submitted a draft',
  deep_link: '/w/ws1/posts/p-42', read_at: null, created_at: '2026-09-04T10:00:00.000Z', ...over,
});

beforeEach(() => {
  vi.mocked(markNotificationRead).mockResolvedValue({ ok: true });
});

// --- Test #5: clicking a notification navigates to exactly the thing it's about — a post opens the
//     composer ON THAT POST — and marks it read. ---
describe('a notification deep link opens the right screen', () => {
  it('opens the composer on the post the notification is about, and marks it read', async () => {
    vi.mocked(listNotifications).mockResolvedValue([notif()]);
    renderBell();

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    const item = await screen.findByText('A post needs your approval');
    fireEvent.click(item);

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/composer?post=p-42'));
    expect(markNotificationRead).toHaveBeenCalledWith('ws1', 'n1');
  });

  it('shows an unread count for unread notifications', async () => {
    vi.mocked(listNotifications).mockResolvedValue([notif(), notif({ id: 'n2', read_at: '2026-09-04T11:00:00.000Z' })]);
    renderBell();
    // one unread of two -> the bell badge reads 1
    await waitFor(() => expect(screen.getByRole('button', { name: /1 unread/i })).toBeTruthy());
  });
});
