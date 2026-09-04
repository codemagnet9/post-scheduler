// src/shell/AppShell.tsx
// The one white panel floating on the paper ground (.app: 30px radius, 16px margin) with the rail and
// the routed screen. This is the frame every signed-in screen renders inside. It also owns the command
// palette + global keyboard shortcuts, and a crash boundary so one screen's error never blanks the app.
import { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Rail } from './Rail';
import { CommandPalette } from './CommandPalette';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { ErrorBoundary } from '../components/ErrorBoundary';

export function AppShell(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useGlobalShortcuts(openPalette);

  return (
    <div className="app">
      <Rail />
      <div className="main"><ErrorBoundary><Outlet /></ErrorBoundary></div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
