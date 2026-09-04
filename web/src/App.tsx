// src/App.tsx — routing. Public auth routes; everything else is gated by RequireAuth, which mounts the
// workspace context and the app shell. A signed-out user hitting a protected URL is redirected to
// /signin with the intended path remembered, so login returns them there.
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';
import { AppShell } from './shell/AppShell';
import { FullPanelLoading } from './components/states';
import { SignIn } from './screens/auth/SignIn';
import { SignUp } from './screens/auth/SignUp';
import { ForgotPassword } from './screens/auth/ForgotPassword';
import { VerifyEmail } from './screens/auth/VerifyEmail';
import { Home } from './screens/app/Home';
import { Composer } from './screens/app/composer/Composer';
import { Calendar } from './screens/app/calendar/Calendar';
import { Queue } from './screens/app/queue/Queue';
import { Analytics } from './screens/app/analytics/Analytics';
import { Approvals } from './screens/app/approvals/Approvals';
import { Team } from './screens/app/team/Team';
import { Settings } from './screens/app/settings/Settings';
import { Networks } from './screens/app/networks/Networks';
import { OAuthCallback } from './screens/app/networks/OAuthCallback';
import { Setup } from './screens/app/setup/Setup';
import { NotFound } from './screens/NotFound';
import { Placeholder } from './screens/app/Placeholder';

function RequireAuth(): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPanelLoading label="Signing you in…" />;
  if (status === 'anon') return <Navigate to="/signin" state={{ from: location.pathname + location.search }} replace />;
  return (
    <WorkspaceProvider>
      <AppShell />
    </WorkspaceProvider>
  );
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/forgot" element={<ForgotPassword />} />
      <Route path="/verify" element={<VerifyEmail />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/composer" element={<Composer />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/networks" element={<Networks />} />
        {/* The OAuth return lands here — inside the shell so the rail is present. */}
        <Route path="/oauth/callback" element={<OAuthCallback />} />
        <Route path="/team" element={<Team />} />
        <Route path="/developer" element={<Placeholder title="Developer" icon="‹›" />} />
        <Route path="/settings" element={<Settings />} />
        {/* A real 404, not a silent redirect. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
