// src/screens/app/setup/useSetupStatus.ts
// Derives onboarding progress from REAL data — not a stored "onboarded" flag that drifts from reality.
// A step is done when its evidence exists: the workspace exists (you're in it), at least one network is
// connected, and at least one posting slot is set. Each step is skippable; the guide just tracks what's
// left. The result drives the rail's "Setup guide" badge and Home's "Finish setup" card.
import { useQuery } from '@tanstack/react-query';
import { getAccountHealth, listSlots } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';

export interface SetupStep { key: 'workspace' | 'connect' | 'slots'; label: string; hint: string; done: boolean; to: string }
export interface SetupStatus { steps: SetupStep[]; doneCount: number; total: number; complete: boolean; loading: boolean }

export function useSetupStatus(): SetupStatus {
  const { active } = useWorkspace();
  const ws = active.id;
  const accountsQ = useQuery({ queryKey: ['account-health', ws], queryFn: () => getAccountHealth(ws) });
  const slotsQ = useQuery({ queryKey: ['slots', ws], queryFn: () => listSlots(ws) });

  const hasAccounts = (accountsQ.data ?? []).length > 0;
  const hasSlots = (slotsQ.data ?? []).length > 0;

  const steps: SetupStep[] = [
    { key: 'workspace', label: 'Create your workspace', hint: `${active.name} · ${active.default_timezone.replace(/_/g, ' ')}`, done: true, to: '/settings?tab=workspace' },
    { key: 'connect', label: 'Connect your first network', hint: 'Link an account so you have somewhere to publish.', done: hasAccounts, to: '/networks' },
    { key: 'slots', label: 'Set your posting schedule', hint: 'Add weekly slots so the queue can fill itself.', done: hasSlots, to: '/setup' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return {
    steps,
    doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
    loading: accountsQ.isLoading || slotsQ.isLoading,
  };
}
