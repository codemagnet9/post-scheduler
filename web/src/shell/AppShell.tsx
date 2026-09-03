// src/shell/AppShell.tsx
// The one white panel floating on the paper ground (.app: 30px radius, 16px margin) with the rail and
// the routed screen. This is the frame every signed-in screen renders inside.
import { Outlet } from 'react-router-dom';
import { Rail } from './Rail';

export function AppShell(): JSX.Element {
  return (
    <div className="app">
      <Rail />
      <div className="main"><Outlet /></div>
    </div>
  );
}
