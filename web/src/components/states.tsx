// src/components/states.tsx
// Loading / empty / error for every container. Skeletons are shaped like the content they replace —
// never a bare spinner. EmptyState is the ported .empty component; ErrorState reuses it with the bad
// tint and always shows the request id so support can find the log line.
import type { CSSProperties, ReactNode } from 'react';
import { ApiError } from '../api/client';

// --- skeletons ---
export function Skeleton({ w = '100%', h = 12, r = 999, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }): JSX.Element {
  return <span className="skel" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />;
}

export function SkeletonText({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <div>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={12} w={i === lines - 1 ? '60%' : '100%'} style={{ margin: '10px 0' }} />
      ))}
    </div>
  );
}

// Matches the g4 stat row: four figures with a label and a big numeral.
export function SkeletonStats(): JSX.Element {
  return (
    <div className="grid g4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="stat" key={i}>
          <Skeleton w={110} h={13} />
          <Skeleton w={90} h={44} r={12} style={{ marginTop: 16 }} />
          <Skeleton w={70} h={12} style={{ marginTop: 16 }} />
        </div>
      ))}
    </div>
  );
}

// Matches a hairline table.
export function SkeletonRows({ rows = 5 }: { rows?: number }): JSX.Element {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          <Skeleton w={34} h={34} r={9} />
          <div style={{ flex: 1 }}><Skeleton w="70%" h={12} /><Skeleton w="40%" h={10} style={{ marginTop: 8 }} /></div>
          <Skeleton w={64} h={22} r={999} />
        </div>
      ))}
    </div>
  );
}

// --- empty ---
export function EmptyState({ icon = '◇', title, description, actions }: { icon?: ReactNode; title: string; description?: string; actions?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <span className="ic">{icon}</span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="row" style={{ marginTop: 8, gap: 9 }}>{actions}</div>}
    </div>
  );
}

// --- error ---
export function ErrorState({ error, message, onRetry }: { error?: ApiError | null; message?: string; onRetry?: () => void }): JSX.Element {
  const text = message ?? error?.message ?? 'Something went wrong.';
  const ref = error?.requestId;
  return (
    <div className="empty">
      <span className="ic" style={{ background: 'var(--bad-wash)', color: 'var(--bad)' }}>!</span>
      <h3>Could not load this</h3>
      <p>{text}</p>
      {ref && <p className="mono" style={{ fontSize: 12, opacity: 0.8 }}>ref: {ref}</p>}
      {onRetry && <div className="row" style={{ marginTop: 8 }}><button className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button></div>}
    </div>
  );
}

// --- pre-shell (whole-panel) variants, used before the app frame exists ---
function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 30, margin: 16, minHeight: 'calc(100vh - 32px)', display: 'grid', placeItems: 'center', padding: 24 }}>
      {children}
    </div>
  );
}
export function FullPanelLoading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return <Panel><div className="dim" style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}><Skeleton w={180} h={14} /><Skeleton w={120} h={12} /><span className="dim" style={{ fontSize: 13 }}>{label}</span></div></Panel>;
}
export function FullPanelError({ error, message, onRetry }: { error?: ApiError | null; message?: string; onRetry?: () => void }): JSX.Element {
  return <Panel><div style={{ maxWidth: 460 }}><ErrorState error={error} message={message} onRetry={onRetry} /></div></Panel>;
}
