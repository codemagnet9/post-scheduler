// src/shell/Rail.tsx
// The left rail: workspace switcher, nav with LIVE counts (from the single summary endpoint, not one
// request per badge), and the user menu. Ported from the prototype's rail markup.
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSummary } from '../api/endpoints';
import type { WorkspaceSummary } from '../api/types';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { Skeleton } from '../components/states';

type CountKey = keyof Pick<WorkspaceSummary, 'queue' | 'approvals' | 'networks'>;
interface NavItem { to: string; label: string; icon: string; end?: boolean; count?: CountKey }

const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Publish', items: [
    { to: '/', label: 'Home', icon: '◇', end: true },
    { to: '/composer', label: 'Compose', icon: '✎' },
    { to: '/calendar', label: 'Calendar', icon: '▦' },
    { to: '/queue', label: 'Queue', icon: '≡', count: 'queue' },
    { to: '/approvals', label: 'Approvals', icon: '✓', count: 'approvals' },
  ] },
  { group: 'Measure', items: [{ to: '/analytics', label: 'Analytics', icon: '▨' }] },
  { group: 'Manage', items: [
    { to: '/networks', label: 'Networks', icon: '◈', count: 'networks' },
    { to: '/team', label: 'Team', icon: '⊙' },
    { to: '/developer', label: 'Developer', icon: '‹›' },
    { to: '/settings', label: 'Settings', icon: '⚙' },
  ] },
];

export function Rail(): JSX.Element {
  const { active, workspaces, setActiveId } = useWorkspace();
  const { user, logout } = useAuth();
  const summaryQ = useQuery({ queryKey: ['summary', active.id], queryFn: () => getSummary(active.id) });
  const summary = summaryQ.data;
  const [wsOpen, setWsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  const countBadge = (key?: CountKey) => {
    if (!key) return null;
    if (!summary) return <span className="ct"><Skeleton w={16} h={11} /></span>;
    return <span className="ct">{summary[key]}</span>;
  };

  return (
    <aside className="rail">
      {/* workspace switcher */}
      <div style={{ position: 'relative' }}>
        <div className="ws" onClick={() => setWsOpen((o) => !o)}>
          <Avatar name={active.name} seed={active.id} size={32} square />
          <span>
            <span className="nm">{active.name}</span><br />
            <span className="sub">STUDIO · {summary ? summary.networks : '—'} ACCOUNTS</span>
          </span>
          <span className="chev">⌄</span>
        </div>
        {wsOpen && (
          <Popover onClose={() => setWsOpen(false)}>
            {workspaces.map((w) => (
              <button key={w.id} className={`rl${w.id === active.id ? ' on' : ''}`} style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }}
                onClick={() => { setActiveId(w.id); setWsOpen(false); }}>
                <Avatar name={w.name} seed={w.id} size={22} square /> {w.name}
                <span className="ct" style={{ textTransform: 'capitalize' }}>{w.role}</span>
              </button>
            ))}
          </Popover>
        )}
      </div>

      {/* nav */}
      <nav className="railnav">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="rgroup">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `rl${isActive ? ' on' : ''}`}>
                <span className="ic">{i.icon}</span>{i.label}{countBadge(i.count)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* foot: setup + user menu */}
      <div className="rail-foot">
        <NavLink to="/networks" className="rl" style={{ marginBottom: 4 }}><span className="ic">✦</span>Setup guide</NavLink>
        <div style={{ position: 'relative' }}>
          <div className="ruser" onClick={() => setUserOpen((o) => !o)}>
            <Avatar name={user?.name ?? user?.email ?? '?'} seed={user?.id ?? 'u'} size={30} />
            <span>
              <span style={{ fontSize: 13.5, fontWeight: 600, display: 'block', lineHeight: 1.2, whiteSpace: 'nowrap' }}>{user?.name ?? user?.email ?? 'You'}</span>
              <span className="dim" style={{ fontSize: 11, textTransform: 'capitalize' }}>{active.role}</span>
            </span>
            <span className="dim" style={{ marginLeft: 'auto' }}>⋯</span>
          </div>
          {userOpen && (
            <Popover onClose={() => setUserOpen(false)} above>
              <div style={{ padding: '8px 12px' }}><div style={{ fontSize: 12.5, fontWeight: 600 }}>{user?.name ?? 'Signed in'}</div><div className="dim" style={{ fontSize: 11.5 }}>{user?.email}</div></div>
              <NavLink to="/settings" className="rl" onClick={() => setUserOpen(false)}><span className="ic">⚙</span>Settings</NavLink>
              <button className="rl" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left', color: 'var(--bad)' }} onClick={() => logout()}>
                <span className="ic" style={{ color: 'var(--bad)' }}>⏻</span>Sign out
              </button>
            </Popover>
          )}
        </div>
      </div>
    </aside>
  );
}

// A small dismiss-on-outside-click popover (transparent backdrop catches the outside click).
function Popover({ children, onClose, above }: { children: ReactNode; onClose: () => void; above?: boolean }): JSX.Element {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={onClose} />
      <div style={{ position: 'absolute', left: 0, right: 0, zIndex: 41, ...(above ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 6 }), background: 'var(--bg)', borderRadius: 16, padding: 8, boxShadow: '0 18px 48px -16px rgba(25,25,23,.32)' }}>
        {children}
      </div>
    </>
  );
}
