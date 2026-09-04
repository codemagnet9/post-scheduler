// src/shell/Screen.tsx
// The per-screen top header (.top) + page container (.page), ported from the prototype's shell(). Page
// titles use the exact clamp(34px,3.6vw,48px) scale from the CSS — set there, never overridden here.
// The notifications bell lives in this top bar so it appears on every screen (a shell panel, not a page).
// Mounting a Screen also sets the browser tab title, so every route has its own document title.
import { useEffect, type ReactNode } from 'react';
import { NotificationsBell } from './NotificationsBell';
import { OPEN_PALETTE_EVENT } from './useGlobalShortcuts';

export function Screen({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }): JSX.Element {
  useEffect(() => { document.title = `${title} · Meridian`; }, [title]);
  const openPalette = () => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
  return (
    <>
      <header className="top">
        <div><h1>{title}</h1></div>
        <div className="sp">
          {/* The search box IS the command palette opener — clicking it (or ⌘K, or "/") opens it. */}
          <button type="button" className="search" onClick={openPalette} aria-label="Search or jump to (Command K)" style={{ border: 0, fontFamily: 'inherit' }}>
            <span aria-hidden>⌕</span> Search posts, accounts…<kbd>⌘K</kbd>
          </button>
          {actions}
          <NotificationsBell />
        </div>
      </header>
      <div className="page">{children}</div>
    </>
  );
}
