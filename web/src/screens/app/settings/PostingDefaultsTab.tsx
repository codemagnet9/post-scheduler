// src/screens/app/settings/PostingDefaultsTab.tsx
// Posting defaults persist through the workspace settings jsonb (updateWorkspace merges, so saving one
// toggle never clobbers the others). These are workspace preferences the composer/queue read as their
// starting state — the server still owns validation and scheduling; nothing here recomputes anything.
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceDetail, updateWorkspace } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { ErrorState, SkeletonRows } from '../../../components/states';
import type { WorkspaceSettings } from '../../../api/types';

const WEEK_START = [{ v: 1, label: 'Monday' }, { v: 0, label: 'Sunday' }, { v: 6, label: 'Saturday' }];
const BASIS = [
  { v: 'audience', label: 'Audience local (each market’s wall-clock)' },
  { v: 'workspace', label: 'Workspace timezone' },
  { v: 'utc', label: 'UTC' },
] as const;

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }): JSX.Element {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '10px 0' }}>
      <span style={{ fontSize: 13.5 }}>{label}</span>
      <button type="button" className="tog" aria-pressed={on} aria-label={label} onClick={onClick} />
    </div>
  );
}

export function PostingDefaultsTab(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const detailQ = useQuery({ queryKey: ['workspace-detail', ws], queryFn: () => getWorkspaceDetail(ws) });

  const [s, setS] = useState<WorkspaceSettings>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (detailQ.data) setS(detailQ.data.settings ?? {}); }, [detailQ.data]);

  const saveM = useMutation({
    mutationFn: (next: WorkspaceSettings) => updateWorkspace(ws, { settings: next }),
    onSuccess: () => { setSaved(true); qc.invalidateQueries({ queryKey: ['workspace-detail', ws] }); },
  });

  // Persist immediately on each change (merge-safe server-side), reflecting the coded default when unset.
  const patch = (p: Partial<WorkspaceSettings>) => { const next = { ...s, ...p }; setS(next); setSaved(false); saveM.mutate(next); };

  const weekStart = s.weekStartsOn ?? 1;
  const basis = s.defaultScheduleBasis ?? 'audience';

  return (
    <div className="card">
      <div className="card-h">
        <h3>Posting defaults</h3>
        {saved && !saveM.isPending && <span className="badge b-ok sp">Saved</span>}
        {saveM.isPending && <span className="dim sp" style={{ fontSize: 12 }}>Saving…</span>}
      </div>
      <div className="card-b" style={{ maxWidth: 520 }}>
        {detailQ.isLoading ? <SkeletonRows rows={3} />
          : detailQ.error ? <ErrorState error={detailQ.error instanceof ApiError ? detailQ.error : null} onRetry={() => detailQ.refetch()} />
          : (
            <>
              <div className="field">
                <label className="fl">Calendar week starts on</label>
                <select className="inp" value={weekStart} onChange={(e) => patch({ weekStartsOn: Number(e.target.value) })} aria-label="Week starts on" style={{ width: 'auto' }}>
                  {WEEK_START.map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="fl">Default schedule basis for new posts</label>
                <select className="inp" value={basis} onChange={(e) => patch({ defaultScheduleBasis: e.target.value as WorkspaceSettings['defaultScheduleBasis'] })} aria-label="Default schedule basis">
                  {BASIS.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
                </select>
              </div>
              <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 6 }}>
                <Toggle label="Editors must send posts for approval" on={s.requireApprovalForEditors ?? true} onClick={() => patch({ requireApprovalForEditors: !(s.requireApprovalForEditors ?? true) })} />
                <Toggle label="Auto-fill empty queue slots" on={s.autoQueueFill ?? false} onClick={() => patch({ autoQueueFill: !(s.autoQueueFill ?? false) })} />
              </div>
              {saveM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 12 }}>{saveM.error.displayMessage}</div>}
            </>
          )}
      </div>
    </div>
  );
}
