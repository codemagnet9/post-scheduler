// src/screens/app/settings/WorkspaceTab.tsx
// Workspace identity (name + primary-market timezone) and the "your workspaces" card. The timezone here
// IS the workspace zone every date in the app renders in — changing it re-labels the whole app, so it's
// stated plainly. Save reflects the server's returned detail; the workspace list is refetched so the
// rail + switcher pick up a rename.
import { useState, useEffect, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceDetail, updateWorkspace } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { ErrorState, SkeletonRows } from '../../../components/states';
import { Avatar } from '../../../components/Avatar';

const ZONES = [
  'UTC', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Lagos', 'Africa/Johannesburg',
  'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

export function WorkspaceTab(): JSX.Element {
  const { active, workspaces, setActiveId } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();

  const detailQ = useQuery({ queryKey: ['workspace-detail', ws], queryFn: () => getWorkspaceDetail(ws) });
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [saved, setSaved] = useState(false);

  // Seed the form from the server once loaded (and whenever we switch workspace).
  useEffect(() => {
    if (detailQ.data) { setName(detailQ.data.name); setTimezone(detailQ.data.defaultTimezone); }
  }, [detailQ.data]);

  const saveM = useMutation({
    mutationFn: () => updateWorkspace(ws, { name: name.trim(), timezone }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['workspace-detail', ws] });
      qc.invalidateQueries({ queryKey: ['workspaces'] }); // rail/switcher labels + the active zone
    },
  });

  const submit = (e: FormEvent) => { e.preventDefault(); setSaved(false); if (name.trim()) saveM.mutate(); };
  const zoneOptions = detailQ.data && !ZONES.includes(detailQ.data.defaultTimezone) ? [detailQ.data.defaultTimezone, ...ZONES] : ZONES;

  return (
    <>
      <div className="card">
        <div className="card-h"><h3>Workspace</h3></div>
        <div className="card-b">
          {detailQ.isLoading ? <SkeletonRows rows={2} />
            : detailQ.error ? <ErrorState error={detailQ.error instanceof ApiError ? detailQ.error : null} onRetry={() => detailQ.refetch()} />
            : (
              <form onSubmit={submit} style={{ maxWidth: 460 }}>
                <div className="field">
                  <label className="fl">Name</label>
                  <input className="inp" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} aria-label="Workspace name" />
                </div>
                <div className="field">
                  <label className="fl">Primary market timezone</label>
                  <select className="inp" value={timezone} onChange={(e) => { setTimezone(e.target.value); setSaved(false); }} aria-label="Workspace timezone">
                    {zoneOptions.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                  <p className="dim" style={{ fontSize: 12, marginTop: 7 }}>Every date across the app renders in this zone — not the viewer’s.</p>
                </div>
                {saveM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 12 }}>{saveM.error.displayMessage}</div>}
                <div className="row" style={{ gap: 12 }}>
                  <button className="btn btn-primary" disabled={!name.trim() || saveM.isPending}>{saveM.isPending ? 'Saving…' : 'Save changes'}</button>
                  {saved && !saveM.isPending && <span className="badge b-ok">Saved</span>}
                </div>
              </form>
            )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>Your workspaces</h3>
          <span className="dim sp" style={{ fontSize: 12 }}>{workspaces.length}</span>
        </div>
        <div className="card-b">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {workspaces.map((w) => (
              <div key={w.id} className="row" style={{ gap: 11, padding: '8px 4px' }}>
                <Avatar name={w.name} seed={w.id} size={30} square />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{w.name}</div>
                  <div className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>{w.role} · {w.default_timezone.replace(/_/g, ' ')}</div>
                </div>
                {w.id === active.id
                  ? <span className="badge b-info">Current</span>
                  : <button className="btn btn-ghost btn-sm" onClick={() => setActiveId(w.id)}>Switch</button>}
              </div>
            ))}
          </div>
          <p className="dim" style={{ fontSize: 12.5, marginTop: 12 }}>Create a new workspace from the switcher at the top of the rail.</p>
        </div>
      </div>
    </>
  );
}
