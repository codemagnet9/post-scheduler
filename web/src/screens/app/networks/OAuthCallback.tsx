// src/screens/app/networks/OAuthCallback.tsx
// Where a real OAuth provider lands the browser after consent. It consumes the ?state&code (or ?error),
// asks the backend to finalize, and shows the outcome: connected / reconnected / you-declined / an error
// with the request id support can grep for. It never trusts the URL — the backend consumes the
// single-use state, so a replayed callback is reported as such rather than silently "succeeding".
//
// NOTE: reachable end-to-end only once a provider is approved and its redirect URI points here (see the
// WHAT IS NOT DONE list). The fake provider connects via credentials, so it doesn't traverse this page.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { finishOAuthConnect } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';

type Result = { kind: 'working' } | { kind: 'ok'; status: string } | { kind: 'denied' } | { kind: 'error'; message: string };

export function OAuthCallback(): JSX.Element {
  const [params] = useSearchParams();
  const [result, setResult] = useState<Result>({ kind: 'working' });
  const ran = useRef(false); // StrictMode double-invoke guard — the state is single-use, don't consume twice

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const error = params.get('error') ?? undefined;
    finishOAuthConnect({ state: params.get('state') ?? undefined, code: params.get('code') ?? undefined, error })
      .then((r) => setResult(r.status === 'denied' ? { kind: 'denied' } : { kind: 'ok', status: r.status }))
      .catch((e) => setResult({ kind: 'error', message: e instanceof ApiError ? e.displayMessage : 'Could not finish connecting.' }));
  }, [params]);

  return (
    <div style={{ background: 'var(--bg)', borderRadius: 30, margin: 16, minHeight: 'calc(100vh - 32px)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        {result.kind === 'working' && <><h2 style={{ fontSize: 22 }}>Finishing up…</h2><p className="dim" style={{ marginTop: 8 }}>Confirming the connection with the network.</p></>}
        {result.kind === 'ok' && <>
          <div className="empty" style={{ padding: 0 }}><span className="ic" style={{ background: 'var(--ok-wash)', color: 'var(--ok)' }}>✓</span></div>
          <h2 style={{ fontSize: 22, marginTop: 12 }}>{result.status === 'reconnected' ? 'Reconnected' : 'Connected'}</h2>
          <p className="dim" style={{ margin: '8px 0 20px' }}>Your account is ready. Scheduled posts will publish as planned.</p>
          <Link className="btn btn-primary" to="/networks">Back to Networks</Link>
        </>}
        {result.kind === 'denied' && <>
          <h2 style={{ fontSize: 22 }}>You declined the connection</h2>
          <p className="dim" style={{ margin: '8px 0 20px' }}>No account was added. You can try again whenever you’re ready.</p>
          <Link className="btn btn-primary" to="/networks">Back to Networks</Link>
        </>}
        {result.kind === 'error' && <>
          <div className="empty" style={{ padding: 0 }}><span className="ic" style={{ background: 'var(--bad-wash)', color: 'var(--bad)' }}>!</span></div>
          <h2 style={{ fontSize: 22, marginTop: 12 }}>That didn’t work</h2>
          <p style={{ margin: '8px 0 6px' }}>{result.message}</p>
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 20 }}>If it keeps happening, quote the reference above to support.</p>
          <Link className="btn btn-primary" to="/networks">Back to Networks</Link>
        </>}
      </div>
    </div>
  );
}
