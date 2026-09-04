// src/screens/app/approvals/CommentThread.tsx
// A threaded note box per post. Comments are server state; a new comment is NON-OPTIMISTIC — the box
// clears and the thread refetches only after the server confirms the insert. Anyone who can see the
// post can comment (the server enforces the same view ability).
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listComments, addComment } from '../../../api/endpoints';
import { useWorkspace, useZonedFormat } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { Avatar } from '../../../components/Avatar';
import { Skeleton } from '../../../components/states';

export function CommentThread({ postId }: { postId: string }): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const fmt = useZonedFormat();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const commentsQ = useQuery({ queryKey: ['comments', ws, postId], queryFn: () => listComments(ws, postId) });
  const addM = useMutation({
    mutationFn: (body: string) => addComment(ws, postId, body),
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['comments', ws, postId] }); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    addM.mutate(body);
  };

  const comments = commentsQ.data ?? [];

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
      <div className="dim" style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
        Discussion{comments.length ? ` · ${comments.length}` : ''}
      </div>

      {commentsQ.isLoading ? (
        <Skeleton w="80%" h={12} />
      ) : comments.length === 0 ? (
        <p className="dim" style={{ fontSize: 12.5, margin: '0 0 12px' }}>No comments yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
          {comments.map((c) => {
            const who = c.author_name ?? c.author_email ?? 'Former member';
            return (
              <div key={c.id} className="row" style={{ alignItems: 'flex-start', gap: 9 }}>
                <Avatar name={who} seed={c.author_id ?? 'anon'} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 7, marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{who}</span>
                    <span className="dim mono" style={{ fontSize: 10.5 }}>{fmt.dateTime(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
                  </div>
                  <p className="body" style={{ fontSize: 13, margin: 0, whiteSpace: 'pre-wrap' }}>{c.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={submit} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input
          className="inp"
          style={{ flex: 1 }}
          placeholder="Add a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Add a comment"
        />
        <button type="submit" className="btn btn-soft btn-sm" disabled={!draft.trim() || addM.isPending}>
          {addM.isPending ? 'Posting…' : 'Comment'}
        </button>
      </form>
      {addM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 8 }}>{addM.error.displayMessage}</div>}
    </div>
  );
}
