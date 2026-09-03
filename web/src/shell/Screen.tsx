// src/shell/Screen.tsx
// The per-screen top header (.top) + page container (.page), ported from the prototype's shell(). Page
// titles use the exact clamp(34px,3.6vw,48px) scale from the CSS — set there, never overridden here.
import type { ReactNode } from 'react';

export function Screen({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <>
      <header className="top">
        <div><h1>{title}</h1></div>
        <div className="sp">
          <div className="search">⌕ Search posts, accounts…<kbd>⌘K</kbd></div>
          {actions}
        </div>
      </header>
      <div className="page">{children}</div>
    </>
  );
}
