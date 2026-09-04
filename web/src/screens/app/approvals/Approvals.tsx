// src/screens/app/approvals/Approvals.tsx
// The approvals inbox. Reviewers (Owner/Approver) see every pending post; an Editor sees only their own
// submissions to watch status (the server decides who sees what — this screen just renders the list it's
// given); an Analyst sees an empty inbox. Each item is an ApprovalCard with the full inline preview and
// the four awkward-case badges.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { listApprovals } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { ApprovalCard } from './ApprovalCard';

export function Approvals(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const isReviewer = active.role === 'owner' || active.role === 'approver';

  const approvalsQ = useQuery({ queryKey: ['approvals', ws], queryFn: () => listApprovals(ws) });
  // One "now" for the whole render pass, so every card's relative age ("updated 3m ago") is consistent.
  const nowMs = useMemo(() => Date.now(), [approvalsQ.dataUpdatedAt]);

  const items = approvalsQ.data ?? [];

  const subtitle = isReviewer
    ? 'Drafts submitted for your review.'
    : 'Your posts waiting on a reviewer.';

  return (
    <Screen title="Approvals">
      <p className="dim" style={{ fontSize: 13.5, marginTop: -8, marginBottom: 18 }}>{subtitle}</p>

      {approvalsQ.isLoading ? (
        <div className="card"><div className="card-b"><SkeletonRows rows={3} /></div></div>
      ) : approvalsQ.error ? (
        <div className="card"><ErrorState error={approvalsQ.error instanceof ApiError ? approvalsQ.error : null} onRetry={() => approvalsQ.refetch()} /></div>
      ) : items.length === 0 ? (
        <div className="card"><EmptyState
          icon="✓"
          title={isReviewer ? 'Nothing to review' : 'Nothing awaiting approval'}
          description={isReviewer
            ? 'When an editor submits a draft, it lands here with its full preview and checks.'
            : active.role === 'analyst'
              ? 'Analysts don’t submit or review posts.'
              : 'Submit a draft from the composer and it will appear here until a reviewer decides.'}
        /></div>
      ) : (
        <div>
          {items.map((item) => <ApprovalCard key={item.postId} item={item} nowMs={nowMs} />)}
        </div>
      )}
    </Screen>
  );
}
