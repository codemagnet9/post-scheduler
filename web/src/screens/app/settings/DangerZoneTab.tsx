// src/screens/app/settings/DangerZoneTab.tsx
// Delete the workspace. This is a real, hard-to-reverse action, so it requires typing the workspace
// name to confirm (the server ALSO re-checks the typed name and refuses a mismatch — the button being
// enabled is a convenience, not the guard). On success we drop the active workspace and refetch the
// list, landing the user on whatever workspace remains.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteWorkspace } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';

export function DangerZoneTab(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const matches = confirm.trim() === active.name;

  const deleteM = useMutation({
    mutationFn: () => deleteWorkspace(ws, confirm.trim()),
    onSuccess: async () => {
      localStorage.removeItem('meridian.activeWorkspace');
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      // The WorkspaceProvider re-reads the list and falls back to a remaining workspace (or the
      // no-workspace state) on the next render — no navigation needed here.
    },
  });

  return (
    <div className="card" style={{ borderColor: 'var(--bad)' }}>
      <div className="card-h"><h3 style={{ color: 'var(--bad)' }}>Delete this workspace</h3></div>
      <div className="card-b" style={{ maxWidth: 520 }}>
        <p style={{ fontSize: 13.5, marginBottom: 4 }}>
          Deleting <strong>{active.name}</strong> removes its posts, schedule, connected accounts and members.
          This can’t be undone from here.
        </p>
        <p className="dim" style={{ fontSize: 13, marginBottom: 16 }}>
          Type the workspace name <strong>{active.name}</strong> to confirm.
        </p>
        <div className="field" style={{ maxWidth: 360 }}>
          <label className="fl">Workspace name</label>
          <input className="inp" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={active.name} aria-label="Type workspace name to confirm" />
        </div>
        {deleteM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 12 }}>{deleteM.error.displayMessage}</div>}
        <button className="btn btn-danger" disabled={!matches || deleteM.isPending} onClick={() => deleteM.mutate()}>
          {deleteM.isPending ? 'Deleting…' : 'Delete workspace permanently'}
        </button>
      </div>
    </div>
  );
}
