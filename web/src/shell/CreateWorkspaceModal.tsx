// src/shell/CreateWorkspaceModal.tsx
// Create a new workspace (the server seeds its defaults). The user picks a name and the workspace's
// PRIMARY MARKET timezone — that zone becomes default_timezone and every date in the new workspace
// renders in it (never the browser's). On success we switch to the new workspace and refetch the list.
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { createWorkspace } from '../api/endpoints';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { ApiError } from '../api/client';

// A small curated set of primary-market zones. The workspace zone is an explicit choice, not the
// browser's — so this defaults to UTC and the user selects their market.
const ZONES = [
  'UTC',
  'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Africa/Lagos', 'Africa/Johannesburg',
  'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney',
];

export function CreateWorkspaceModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { setActiveId } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');

  const createM = useMutation({
    mutationFn: () => createWorkspace(name.trim(), timezone),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      setActiveId(r.workspaceId);
      onClose();
      navigate('/');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createM.mutate();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.34)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 20 }} onClick={onClose}>
      <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 32, width: 'min(460px, 100%)', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 22, marginBottom: 6 }}>Create a workspace</h3>
        <p className="dim" style={{ fontSize: 13.5, marginBottom: 20 }}>A workspace groups its own accounts, posts and team. You’ll be its Owner.</p>
        <form onSubmit={submit}>
          <div className="field">
            <label className="fl">Workspace name</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input className="inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" aria-label="Workspace name" />
          </div>
          <div className="field">
            <label className="fl">Primary market timezone</label>
            <select className="inp" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="Primary market timezone">
              {ZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
            <p className="dim" style={{ fontSize: 12, marginTop: 7 }}>Every date in this workspace shows in this zone.</p>
          </div>
          {createM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 14 }}>{createM.error.displayMessage}</div>}
          <div className="row" style={{ gap: 10, marginTop: 8 }}>
            <button className="btn btn-primary" disabled={!name.trim() || createM.isPending}>{createM.isPending ? 'Creating…' : 'Create workspace'}</button>
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
