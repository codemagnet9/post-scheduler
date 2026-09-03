// src/screens/auth/AuthLayout.tsx
// The ported split-screen auth frame (.auth): form on the left, marketing aside on the right that
// collapses on narrow screens. Every auth screen composes this.
import type { ReactNode } from 'react';
import { Logo } from '../../components/Logo';

export function AuthLayout({ children, aside }: { children: ReactNode; aside: ReactNode }): JSX.Element {
  return (
    <div className="auth">
      <div className="auth-form">
        <Logo />
        {children}
      </div>
      <div className="auth-aside">
        <div style={{ maxWidth: 400 }}>{aside}</div>
      </div>
    </div>
  );
}

// The signed-out error line, always carrying the request id so a support chat can find the log.
export function FormError({ message }: { message: string }): JSX.Element {
  return <div className="hint h-bad" style={{ marginBottom: 16 }}>{message}</div>;
}
