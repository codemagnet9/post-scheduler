// src/screens/app/networks/DisconnectModal.tsx
// Voluntary disconnect requires typing the account's name to confirm — and it says plainly what will
// happen to work in flight: a VOLUNTARY disconnect SKIPS the account's queued posts, loudly (they will
// not publish). This is the deliberate counterpart to an involuntary auth_expired, where posts stay
// scheduled and resume on reconnect. Surfacing the difference here is the whole point of the rule.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { disconnectAccount } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import type { AccountHealth } from '../../../api/types';

export function DisconnectModal({ account, onClose }: { account: AccountHealth; onClose: () => void }): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const name = account.handle ?? account.displayName ?? account.provider;
  const [confirm, setConfirm] = useState('');
  const matches = confirm.trim() === name;

  const disconnectM = useMutation({
    mutationFn: () => disconnectAccount(ws, account.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account-health', ws] });
      qc.invalidateQueries({ queryKey: ['accounts', ws] });
      qc.invalidateQueries({ queryKey: ['summary', ws] });
      onClose();
    },
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.34)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 20 }} onClick={onClose}>
      <div role="dialog" aria-label={`Disconnect ${name}`} style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 30, width: 'min(480px, 100%)', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 21, marginBottom: 8, color: 'var(--bad)' }}>Disconnect {name}?</h3>

        {account.queuedCount > 0 ? (
          <div className="hint h-warn" style={{ marginBottom: 14 }}>
            <span>△</span>
            <span>
              <strong>{account.queuedCount} scheduled {account.queuedCount === 1 ? 'post' : 'posts'} for this account will be skipped</strong> and will not publish.
              Disconnecting is deliberate — this is different from an expired login, where posts wait and resume when you reconnect.
            </span>
          </div>
        ) : (
          <p className="dim" style={{ fontSize: 13.5, marginBottom: 14 }}>
            No posts are queued for this account. Published history and analytics are kept.
          </p>
        )}

        <p className="dim" style={{ fontSize: 13, marginBottom: 14 }}>Type <strong>{name}</strong> to confirm.</p>
        <div className="field">
          <label className="fl" htmlFor="disc-confirm">Account name</label>
          <input id="disc-confirm" className="inp" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name} aria-label="Type account name to confirm" />
        </div>
        {disconnectM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 12 }}>{disconnectM.error.displayMessage}</div>}
        <div className="row" style={{ gap: 10, marginTop: 6 }}>
          <button className="btn btn-danger" disabled={!matches || disconnectM.isPending} onClick={() => disconnectM.mutate()}>
            {disconnectM.isPending ? 'Disconnecting…' : 'Disconnect account'}
          </button>
          <button className="btn btn-quiet" onClick={onClose}>Keep connected</button>
        </div>
      </div>
    </div>
  );
}
