// src/screens/auth/SignIn.tsx
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from '../../auth/AuthProvider';
import { ApiError } from '../../api/client';

interface Fields { email: string; password: string }

export function SignIn(): JSX.Element {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<Fields>();
  const [error, setError] = useState<string | null>(null);

  if (status === 'authed') return <Navigate to={from} replace />;

  const onSubmit = handleSubmit(async (data) => {
    setError(null);
    try {
      await login(data.email, data.password);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.displayMessage : 'Could not sign in. Check your details and try again.');
    }
  });

  return (
    <AuthLayout aside={<SignInAside />}>
      <h1 style={{ fontSize: 32, margin: '34px 0 8px' }}>Welcome back</h1>
      <p className="dim" style={{ marginBottom: 28 }}>Sign in to your Meridian workspace.</p>
      <div className="oauth">
        <button type="button" className="btn btn-ghost" disabled>Continue with Google</button>
        <button type="button" className="btn btn-ghost" disabled>Continue with Apple</button>
      </div>
      <div className="divider">or with email</div>
      <form onSubmit={onSubmit}>
        <div className="field"><label className="fl" htmlFor="email">Work email</label>
          <input className="inp" id="email" type="email" autoComplete="email" {...register('email', { required: true })} /></div>
        <div className="field"><label className="fl" htmlFor="password">Password</label>
          <input className="inp" id="password" type="password" autoComplete="current-password" {...register('password', { required: true })} /></div>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 22 }}>
          <label className="row" style={{ gap: 8, fontSize: 13, color: 'var(--ink-2)' }}><input type="checkbox" defaultChecked /> Keep me signed in</label>
          <Link to="/forgot" style={{ fontSize: 13, color: 'var(--brand)', fontWeight: 600 }}>Forgot password?</Link>
        </div>
        {error && <FormError message={error} />}
        <button className="btn btn-primary" style={{ padding: 11, width: '100%' }} disabled={isSubmitting}>{isSubmitting ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="dim" style={{ marginTop: 20, fontSize: 13 }}>New here? <Link to="/signup" style={{ color: 'var(--brand)', fontWeight: 600 }}>Create a workspace</Link></p>
    </AuthLayout>
  );
}

function SignInAside(): JSX.Element {
  const rows = ['Mumbai · 09:30 · Instagram', 'Hanoi · 11:00 · Zalo', 'Tokyo · 13:00 · LINE', 'Berlin · 06:00 · LinkedIn'];
  return (
    <>
      <span className="eyebrow">Publishing right now</span>
      <h2 style={{ fontSize: 26, margin: '14px 0 20px' }}>Nine posts are going out in the next hour, across four time zones.</h2>
      {rows.map((t) => (
        <div key={t} className="row" style={{ gap: 10, padding: '11px 14px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 11, marginBottom: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)' }} />
          <span className="mono" style={{ fontSize: 12.5 }}>{t}</span>
        </div>
      ))}
    </>
  );
}
