// src/screens/auth/ForgotPassword.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { AuthLayout, FormError } from './AuthLayout';
import { requestPasswordReset } from '../../api/endpoints';
import { ApiError } from '../../api/client';

export function ForgotPassword(): JSX.Element {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<{ email: string }>();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = handleSubmit(async (d) => {
    setError(null);
    try { await requestPasswordReset(d.email); setSent(true); } // always 200 — never reveals if the account exists
    catch (e) { setError(e instanceof ApiError ? e.displayMessage : 'Could not send the reset link.'); }
  });

  return (
    <AuthLayout aside={<ForgotAside />}>
      <h1 style={{ fontSize: 32, margin: '34px 0 8px' }}>Reset your password</h1>
      {sent ? (
        <>
          <p className="dim" style={{ marginBottom: 20 }}>If an account exists for that email, we've sent a link to reset your password. It expires in an hour.</p>
          <Link className="btn btn-ghost" to="/signin" style={{ alignSelf: 'flex-start' }}>Back to sign in</Link>
        </>
      ) : (
        <>
          <p className="dim" style={{ marginBottom: 28 }}>Enter your email and we'll send a reset link.</p>
          <form onSubmit={onSubmit}>
            <div className="field"><label className="fl" htmlFor="email">Work email</label>
              <input className="inp" id="email" type="email" autoComplete="email" {...register('email', { required: true })} /></div>
            {error && <FormError message={error} />}
            <button className="btn btn-primary" style={{ padding: 11, width: '100%' }} disabled={isSubmitting}>{isSubmitting ? 'Sending…' : 'Send reset link'}</button>
          </form>
          <p className="dim" style={{ marginTop: 20, fontSize: 13 }}><Link to="/signin" style={{ color: 'var(--brand)', fontWeight: 600 }}>Back to sign in</Link></p>
        </>
      )}
    </AuthLayout>
  );
}

function ForgotAside(): JSX.Element {
  return (
    <>
      <span className="eyebrow">Locked out?</span>
      <h2 style={{ fontSize: 26, margin: '14px 0 20px' }}>A reset link keeps your queue running while you get back in.</h2>
      <p className="dim" style={{ fontSize: 14 }}>Scheduled posts keep publishing on their own — signing back in just returns you to the console.</p>
    </>
  );
}
