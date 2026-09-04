// src/auth/AuthProvider.tsx
// Access token in memory; on load we try to re-mint it from the httpOnly refresh cookie (a page
// reload shouldn't sign you out). If a session expires WHILE you're working, we do NOT navigate away
// and lose your unsaved form — we raise a re-authentication overlay ON TOP of the current screen; the
// route stays mounted, so the composer draft (etc.) survives. Re-auth dismisses the overlay in place.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { refreshSession, setAccessToken, setOnUnauthorized, ApiError } from '../api/client';
import { login as apiLogin, logout as apiLogout, me } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import type { User } from '../api/types';

type Status = 'loading' | 'authed' | 'anon';

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [reauth, setReauth] = useState(false);
  const statusRef = useRef<Status>('loading');
  statusRef.current = status;

  const finishLogin = useCallback(async () => {
    const u = await me();
    setUser(u);
    setStatus('authed');
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await apiLogin(email, password);
    await finishLogin();
    setReauth(false);
  }, [finishLogin]);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setAccessToken(null);          // drop the in-memory access token
    queryClient.clear();           // and every cached workspace's data — no leak to the next signer-in
    localStorage.removeItem('meridian.activeWorkspace');
    setUser(null);
    setStatus('anon');
  }, []);

  // Bootstrap: cookie -> access token -> /me. Failure just means "not signed in".
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then(() => { if (!cancelled) return finishLogin(); })
      .catch(() => { if (!cancelled) setStatus('anon'); });
    return () => { cancelled = true; };
  }, [finishLogin]);

  // A 401-then-failed-refresh during an authenticated call => the session expired mid-work.
  useEffect(() => {
    setOnUnauthorized(() => { if (statusRef.current === 'authed') setReauth(true); });
    return () => setOnUnauthorized(null);
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, logout }}>
      {children}
      {reauth && user && <ReauthOverlay email={user.email} onDone={() => setReauth(false)} login={login} />}
    </AuthContext.Provider>
  );
}

function ReauthOverlay({ email, onDone, login }: { email: string; onDone: () => void; login: (e: string, p: string) => Promise<void> }): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await login(email, password); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.displayMessage : 'Could not sign in.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.34)', display: 'grid', placeItems: 'center', zIndex: 100, padding: 20 }}>
      <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 32, width: 'min(420px, 100%)', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)' }}>
        <h3 style={{ fontSize: 22 }}>Your session expired</h3>
        <p className="dim" style={{ margin: '8px 0 20px', fontSize: 14 }}>Sign back in to continue — your unsaved work is still here.</p>
        <form onSubmit={submit}>
          <div className="field"><label className="fl">Email</label><input className="inp" value={email} readOnly /></div>
          <div className="field"><label className="fl">Password</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input className="inp" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <div className="hint h-bad" style={{ marginBottom: 14 }}>{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
