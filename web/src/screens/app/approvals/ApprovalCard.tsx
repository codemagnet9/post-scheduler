// src/screens/app/approvals/ApprovalCard.tsx
// One pending post in the approvals inbox. It shows the FULL composer preview inline (the same
// PreviewList + BeforeYouSchedule the composer uses — merged text and per-network local times come from
// the server's validate call, never recomputed here) and makes the four awkward backend cases legible
// as badges. Actions are ABILITY-GATED: an Editor never sees Approve or Request changes at all (not
// hidden with CSS — simply not rendered), matching the server's ability matrix. Every action is
// NON-OPTIMISTIC: the post only moves once the server confirms, then the list refetches.
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { validatePost, approvePost, requestChanges } from '../../../api/endpoints';
import { useWorkspace, useZonedFormat } from '../../../workspace/WorkspaceProvider';
import { useAuth } from '../../../auth/AuthProvider';
import { can } from '../../../authz/abilities';
import { ApiError } from '../../../api/client';
import { Avatar } from '../../../components/Avatar';
import { Skeleton, SkeletonRows } from '../../../components/states';
import { PreviewList } from '../composer/PreviewList';
import { BeforeYouSchedule } from '../composer/BeforeYouSchedule';
import { CommentThread } from './CommentThread';
import type { ApprovalItem } from '../../../api/types';
import { deriveBadges, approvalProgress, approverLabel, authorLabel, type BadgeTone } from './approvalsLogic';

const TONE: Record<BadgeTone, string> = { warn: 'b-warn', bad: 'b-bad', info: 'b-info', mute: 'b-mute' };

export function ApprovalCard({ item, nowMs }: { item: ApprovalItem; nowMs: number }): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const fmt = useZonedFormat();
  const { user } = useAuth();
  const qc = useQueryClient();
  const userId = user?.id ?? '';

  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');

  // The same validation the composer shows — the previews (with per-market resolved times) and the
  // findings both come straight from here.
  const validateQ = useQuery({ queryKey: ['validate', ws, item.postId], queryFn: () => validatePost(ws, item.postId) });

  const refetchInbox = () => {
    qc.invalidateQueries({ queryKey: ['approvals', ws] });
    qc.invalidateQueries({ queryKey: ['summary', ws] }); // the rail's approvals badge
  };
  const approveM = useMutation({ mutationFn: () => approvePost(ws, item.postId), onSuccess: refetchInbox });
  const changesM = useMutation({
    mutationFn: (n: string) => requestChanges(ws, item.postId, n),
    onSuccess: () => { setShowNote(false); setNote(''); refetchInbox(); },
  });

  const mayApprove = can(active.role, userId, 'approval:approve', { authorId: item.authorId });
  const mayRequestChanges = can(active.role, userId, 'approval:request_changes');
  const badges = deriveBadges(item, nowMs);
  const progress = approvalProgress(item);
  const validation = validateQ.data;
  // The server refuses approval while there are blockers (a lapsed schedule is one). Reflect that here
  // so the button state matches what the server would do, and name the reason.
  const blockedByValidation = validation ? !validation.canSchedule : false;
  const approveDisabled = approveM.isPending || item.schedulePassed || blockedByValidation || validateQ.isLoading;

  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    const n = note.trim();
    if (!n) return; // the button is already disabled; belt-and-braces (the server refuses too)
    changesM.mutate(n);
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-h" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 11, alignItems: 'center' }}>
          <Avatar name={authorLabel(item)} seed={item.authorId ?? item.postId} size={36} />
          <div>
            <h3 style={{ margin: 0 }}>{authorLabel(item)}</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              Submitted {item.submittedAt ? fmt.dateTime(item.submittedAt) : '—'}
              {item.requesterName && item.requesterId !== item.authorId ? ` · by ${item.requesterName}` : ''}
            </span>
          </div>
        </div>
        {badges.length > 0 && (
          <div className="row wrapf sp" style={{ gap: 6, justifyContent: 'flex-end' }}>
            {badges.map((b, i) => <span key={i} className={`badge ${TONE[b.tone]}`}>{b.text}</span>)}
          </div>
        )}
      </div>

      <div className="card-b">
        {/* two-approver progress (paid promotions), incl. anyone who has since left */}
        {progress && (
          <div className="hint h-info" style={{ marginBottom: 14 }}>
            <span>
              {progress.approved.length > 0
                ? <>Approved by {progress.approved.map(approverLabel).join(', ')}. </>
                : <>No approvals yet. </>}
              {progress.remaining > 0
                ? <strong>{progress.remaining} more {progress.remaining === 1 ? 'approval' : 'approvals'} needed.</strong>
                : <strong>All required approvals recorded.</strong>}
            </span>
          </div>
        )}

        <div className="grid g2" style={{ gap: 22, alignItems: 'start' }}>
          <div>
            <div className="dim" style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>Preview</div>
            {validateQ.isLoading ? <SkeletonRows rows={2} />
              : validateQ.error ? <div className="hint h-bad">{validateQ.error instanceof ApiError ? validateQ.error.displayMessage : 'Could not load preview.'}</div>
              : validation && <PreviewList previews={validation.previews} threadPreviews={validation.threadPreviews} />}
          </div>
          <div>
            {validateQ.isLoading ? <Skeleton w="100%" h={120} r={16} />
              : validation && <BeforeYouSchedule findings={validation.findings} />}
          </div>
        </div>

        {/* actions — ability-gated. An Editor sees neither button. */}
        {(mayApprove || mayRequestChanges) && (
          <div className="row wrapf" style={{ gap: 10, marginTop: 16 }}>
            {mayApprove && (
              <button className="btn btn-primary" onClick={() => approveM.mutate()} disabled={approveDisabled}>
                {approveM.isPending ? 'Approving…' : 'Approve and schedule'}
              </button>
            )}
            {mayRequestChanges && !showNote && (
              <button className="btn btn-ghost" onClick={() => setShowNote(true)}>Request changes</button>
            )}
          </div>
        )}

        {/* the "past" reason, named where the action is — the server would refuse it too */}
        {mayApprove && item.schedulePassed && (
          <p className="hint h-bad" style={{ marginTop: 10 }}>
            That scheduled time has already passed — reschedule this post before approving.
          </p>
        )}
        {mayApprove && !item.schedulePassed && blockedByValidation && (
          <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>Resolve the blockers above before approving.</p>
        )}
        {approveM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 10 }}>{approveM.error.displayMessage}</div>}

        {/* request-changes note — REQUIRED. The button stays disabled until there's a note; the server
            refuses an empty one regardless. */}
        {mayRequestChanges && showNote && (
          <form onSubmit={submitNote} style={{ marginTop: 14 }}>
            <label className="fl">What needs to change?</label>
            <textarea
              className="inp"
              style={{ minHeight: 80, resize: 'vertical' }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Tell the editor what to fix before resubmitting…"
              aria-label="What needs to change?"
            />
            <div className="row" style={{ gap: 10, marginTop: 10 }}>
              <button type="submit" className="btn btn-danger" disabled={!note.trim() || changesM.isPending}>
                {changesM.isPending ? 'Sending…' : 'Send back for changes'}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => { setShowNote(false); setNote(''); }}>Cancel</button>
            </div>
            {changesM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 10 }}>{changesM.error.displayMessage}</div>}
          </form>
        )}

        <CommentThread postId={item.postId} />
      </div>
    </div>
  );
}
