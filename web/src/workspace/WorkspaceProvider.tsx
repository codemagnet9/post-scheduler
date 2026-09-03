// src/workspace/WorkspaceProvider.tsx
// Holds the active workspace and — crucially for timezone discipline — its timezone, which every date
// on screen is rendered in. useZonedFormat() binds that zone so screens format dates without ever
// touching the browser's zone.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWorkspaces } from '../api/endpoints';
import type { Workspace } from '../api/types';
import { ApiError } from '../api/client';
import { formatDate, formatDateTime, formatTime, zoneAbbrev } from '../lib/datetime';
import { FullPanelLoading, FullPanelError } from '../components/states';

const ACTIVE_KEY = 'meridian.activeWorkspace';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  active: Workspace;
  setActiveId: (id: string) => void;
  timezone: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within <WorkspaceProvider>');
  return ctx;
}

// Date formatters already bound to the active workspace's zone — the app's ONLY way to render a time.
export function useZonedFormat() {
  const { timezone } = useWorkspace();
  return useMemo(() => ({
    time: (v: string | number | Date) => formatTime(v, timezone),
    date: (v: string | number | Date) => formatDate(v, timezone),
    dateTime: (v: string | number | Date) => formatDateTime(v, timezone),
    zone: zoneAbbrev(timezone),
    timezone,
  }), [timezone]);
}

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });
  const [activeId, setActive] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY));

  const setActiveId = (id: string) => { localStorage.setItem(ACTIVE_KEY, id); setActive(id); };

  if (isLoading) return <FullPanelLoading label="Loading your workspaces…" />;
  if (error) return <FullPanelError error={error instanceof ApiError ? error : null} onRetry={() => refetch()} />;

  const workspaces = data ?? [];
  if (!workspaces.length) {
    // A signed-in user with no workspace is a real state; a later phase adds the create-workspace flow.
    return <FullPanelError error={null} message="You are not a member of any workspace yet." />;
  }
  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  return (
    <WorkspaceContext.Provider value={{ workspaces, active, setActiveId, timezone: active.default_timezone }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
