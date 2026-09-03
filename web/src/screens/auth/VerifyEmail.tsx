// src/screens/auth/VerifyEmail.tsx
// Consumes the ?token from the verification email. With no token it just tells the user to check their
// inbox; with one it verifies and confirms (or shows a typed error carrying the request id).
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthLayout, FormError } from './AuthLayout';
import { verifyEmail } from '../../api/endpoints';
import { ApiError } from '../../api/client';

type State = 'idle' | 'verifying' | 'ok' | 'error';

export function VerifyEmail(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>(token ? 'verifying' : 'idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    verifyEmail(token)
      .then(() => { if (!cancelled) setState('ok'); })
      .catch((e) => { if (!cancelled) { setState('error'); setError(e instanceof ApiError ? e.displayMessage : 'This link is invalid or has expired.'); } });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <AuthLayout aside={<VerifyAside />}>
      <h1 style={{ fontSize: 32, margin: '34px 0 8px' }}>Verify your email</h1>
      {state === 'idle' && <p className="dim" style={{ marginBottom: 24 }}>Check your inbox for a verification link. You can keep using Meridian while you confirm.</p>}
      {state === 'verifying' && <p className="dim" style={{ marginBottom: 24 }}>Verifying your email…</p>}
      {state === 'ok' && (
        <>
          <div className="hint h-ok" style={{ marginBottom: 20 }}>Your email is verified. You're all set.</div>
          <Link className="btn btn-primary" to="/" style={{ alignSelf: 'flex-start', padding: 11 }}>Go to Meridian</Link>
        </>
      )}
      {state === 'error' && (
        <>
          {error && <FormError message={error} />}
          <Link className="btn btn-ghost" to="/signin" style={{ alignSelf: 'flex-start' }}>Back to sign in</Link>
        </>
      )}
    </AuthLayout>
  );
}

function VerifyAside(): JSX.Element {
  return (
    <>
      <span className="eyebrow">Almost there</span>
      <h2 style={{ fontSize: 26, margin: '14px 0 20px' }}>One click and your workspace is fully live.</h2>
      <p className="dim" style={{ fontSize: 14 }}>Verifying confirms it's really you before anything publishes on your behalf.</p>
    </>
  );
}
