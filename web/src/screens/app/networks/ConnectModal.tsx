// src/screens/app/networks/ConnectModal.tsx
// The connect handshake. Pick a network, start the connect: an OAuth network hands back a URL and we
// send the browser there; a credential network hands back a field list and we collect it, then complete.
// Reconnect uses the SAME start against an existing account's provider — the callback reattaches to the
// existing row (unique on workspace+provider+account), so scheduled posts survive.
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startConnect, completeCredentialConnect } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { Avatar } from '../../../components/Avatar';
import type { CatalogEntry, BeginConnect } from '../../../api/types';

type Mode = { kind: 'pick' } | { kind: 'reconnect'; provider: string; displayName: string };

export function ConnectModal({ catalog, mode, onClose }: { catalog: CatalogEntry[]; mode: Mode; onClose: () => void }): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<{ provider: string; displayName: string } | null>(
    mode.kind === 'reconnect' ? { provider: mode.provider, displayName: mode.displayName } : null,
  );
  const [handshake, setHandshake] = useState<BeginConnect | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const startM = useMutation({
    mutationFn: (provider: string) => startConnect(ws, provider),
    onSuccess: (r) => {
      if (r.kind === 'oauth_redirect') {
        // Real OAuth: hand the browser to the provider. The callback reattaches or errors on return.
        window.location.assign(r.url);
        return;
      }
      setHandshake(r); // credentials: collect the fields
    },
  });

  const completeM = useMutation({
    mutationFn: () => completeCredentialConnect(ws, chosen!.provider, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account-health', ws] });
      qc.invalidateQueries({ queryKey: ['accounts', ws] });
      qc.invalidateQueries({ queryKey: ['summary', ws] });
      onClose();
    },
  });

  const pick = (entry: { provider: string; displayName: string }) => {
    setChosen(entry);
    startM.mutate(entry.provider);
  };

  const submitFields = (e: FormEvent) => { e.preventDefault(); completeM.mutate(); };

  const title = mode.kind === 'reconnect' ? `Reconnect ${mode.displayName}` : 'Connect a network';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.34)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 20 }} onClick={onClose}>
      <div role="dialog" aria-label={title} style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 30, width: 'min(520px, 100%)', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 22, marginBottom: 6 }}>{title}</h3>
        {mode.kind === 'reconnect' && <p className="dim" style={{ fontSize: 13.5, marginBottom: 18 }}>You’ll re-authorize the same account, so its scheduled posts keep their place.</p>}

        {/* Step 1: pick a network (skipped when reconnecting) */}
        {mode.kind === 'pick' && !handshake && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {catalog.length === 0 && <p className="dim" style={{ fontSize: 13 }}>No networks are available to connect right now.</p>}
            {catalog.map((c) => (
              <button key={c.provider} className="row" disabled={startM.isPending}
                style={{ gap: 12, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 12, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => pick({ provider: c.provider, displayName: c.displayName })}>
                <Avatar name={c.displayName} seed={c.provider} size={34} square />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{c.displayName}</span>
                  <span className="dim" style={{ fontSize: 12 }}>{c.capabilities.surface} · {c.capabilities.charLimit.toLocaleString()} chars</span>
                </span>
                <span aria-hidden style={{ color: 'var(--ink-dim)' }}>→</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2 (credentials): collect fields */}
        {handshake?.kind === 'credentials' && chosen && (
          <form onSubmit={submitFields} style={{ marginTop: 6 }}>
            <p className="dim" style={{ fontSize: 13, marginBottom: 16 }}>Enter your {chosen.displayName} credentials. They’re stored encrypted and never shown again.</p>
            {handshake.fields.map((f) => (
              <div className="field" key={f.key}>
                <label className="fl" htmlFor={`cf-${f.key}`}>{f.label}</label>
                <input id={`cf-${f.key}`} className="inp" type={f.secret ? 'password' : 'text'} autoComplete="off"
                  value={fields[f.key] ?? ''} onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))} />
              </div>
            ))}
            {completeM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 12 }}>{completeM.error.displayMessage}</div>}
            <div className="row" style={{ gap: 10, marginTop: 8 }}>
              <button className="btn btn-primary" disabled={completeM.isPending}>{completeM.isPending ? 'Connecting…' : 'Connect'}</button>
              <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}

        {startM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 14 }}>{startM.error.displayMessage}</div>}
        {startM.isPending && <p className="dim" style={{ fontSize: 13, marginTop: 14 }}>Starting…</p>}

        {mode.kind === 'pick' && !handshake && (
          <div className="row" style={{ marginTop: 18 }}><button className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
        )}
      </div>
    </div>
  );
}
