// src/screens/auth/SignUp.tsx
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from '../../auth/AuthProvider';
import { signup, createWorkspace } from '../../api/endpoints';
import { ApiError } from '../../api/client';

const MARKETS = [
  { label: 'India — IST (UTC+5:30)', tz: 'Asia/Kolkata' },
  { label: 'Vietnam — ICT (UTC+7)', tz: 'Asia/Ho_Chi_Minh' },
  { label: 'United States — ET (UTC−5)', tz: 'America/New_York' },
  { label: 'Germany — CET (UTC+1)', tz: 'Europe/Berlin' },
];

interface Fields { name: string; workspace: string; email: string; password: string; timezone: string }

export function SignUp(): JSX.Element {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<Fields>({ defaultValues: { timezone: MARKETS[0].tz } });
  const [error, setError] = useState<string | null>(null);

  if (status === 'authed') return <Navigate to="/" replace />;

  // Create the account, sign in (the backend allows login before email verification), then create the
  // first workspace in the chosen market's timezone — and land in the app.
  const onSubmit = handleSubmit(async (d) => {
    setError(null);
    try {
      await signup({ email: d.email, password: d.password, name: d.name });
      await login(d.email, d.password);
      await createWorkspace(d.workspace, d.timezone);
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.displayMessage : 'Could not create your workspace.');
    }
  });

  return (
    <AuthLayout aside={<SignUpAside />}>
      <h1 style={{ fontSize: 32, margin: '34px 0 8px' }}>Create your workspace</h1>
      <p className="dim" style={{ marginBottom: 28 }}>Free for 3 accounts. No card, no trial clock.</p>
      <div className="oauth">
        <button type="button" className="btn btn-ghost" disabled>Sign up with Google</button>
        <button type="button" className="btn btn-ghost" disabled>Sign up with Apple</button>
      </div>
      <div className="divider">or with email</div>
      <form onSubmit={onSubmit}>
        <div className="grid g2" style={{ gap: 12 }}>
          <div className="field"><label className="fl">Your name</label><input className="inp" placeholder="Himanshu Raval" {...register('name', { required: true })} /></div>
          <div className="field"><label className="fl">Workspace name</label><input className="inp" placeholder="Amara Textiles" {...register('workspace', { required: true })} /></div>
        </div>
        <div className="field"><label className="fl">Work email</label><input className="inp" type="email" autoComplete="email" placeholder="you@company.com" {...register('email', { required: true })} /></div>
        <div className="field"><label className="fl">Password</label><input className="inp" type="password" autoComplete="new-password" placeholder="At least 10 characters" {...register('password', { required: true, minLength: 10 })} /></div>
        <div className="field"><label className="fl">Primary market</label>
          <select className="inp" {...register('timezone')}>
            {MARKETS.map((m) => <option key={m.tz} value={m.tz}>{m.label}</option>)}
          </select>
          <p className="dim" style={{ fontSize: 12, marginTop: 6 }}>Sets your default posting hours. You can add a market per account later.</p>
        </div>
        {error && <FormError message={error} />}
        <button className="btn btn-primary" style={{ padding: 11, width: '100%' }} disabled={isSubmitting}>{isSubmitting ? 'Creating…' : 'Create workspace'}</button>
      </form>
      <p className="dim" style={{ marginTop: 16, fontSize: 12 }}>Already have one? <Link to="/signin" style={{ color: 'var(--brand)', fontWeight: 600 }}>Sign in</Link></p>
    </AuthLayout>
  );
}

function SignUpAside(): JSX.Element {
  const items: [string, string][] = [
    ['◈', 'Connect global and regional accounts in one flow'],
    ['✎', 'Write once, override per network where it matters'],
    ['≡', "Set posting slots in each market's local time"],
    ['✓', 'Route drafts to a reviewer before anything ships'],
  ];
  return (
    <>
      <span className="eyebrow">What you get on day one</span>
      <h2 style={{ fontSize: 26, margin: '14px 0 20px' }}>34 networks, one composer, and a queue that fills itself.</h2>
      {items.map(([i, t]) => (
        <div key={t} className="row" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--brand-wash)', color: 'var(--brand)', display: 'grid', placeItems: 'center', flex: 'none' }}>{i}</span>
          <span style={{ fontSize: 14, color: 'var(--ink-2)' }}>{t}</span>
        </div>
      ))}
    </>
  );
}
