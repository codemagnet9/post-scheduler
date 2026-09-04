// src/shell/CommandPalette.tsx
// The ⌘K command palette: type to filter navigation + actions, arrow keys to move, Enter to run, Esc to
// close. It doubles as the shell's search affordance (the top-bar search box opens it), so "/" and ⌘K
// land in the same place. Purely client-side navigation — it never guesses server state.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface Command { id: string; label: string; hint?: string; to: string; keywords?: string }

const COMMANDS: Command[] = [
  { id: 'new', label: 'New post', hint: 'N', to: '/composer', keywords: 'compose write draft create' },
  { id: 'home', label: 'Go to Home', to: '/', keywords: 'dashboard' },
  { id: 'calendar', label: 'Go to Calendar', to: '/calendar', keywords: 'schedule' },
  { id: 'queue', label: 'Go to Queue', to: '/queue', keywords: 'upcoming scheduled' },
  { id: 'approvals', label: 'Go to Approvals', to: '/approvals', keywords: 'review' },
  { id: 'analytics', label: 'Go to Analytics', to: '/analytics', keywords: 'metrics stats' },
  { id: 'networks', label: 'Go to Networks', to: '/networks', keywords: 'accounts connect oauth' },
  { id: 'team', label: 'Go to Team', to: '/team', keywords: 'members invite roles' },
  { id: 'settings', label: 'Go to Settings', to: '/settings', keywords: 'preferences workspace billing security' },
  { id: 'setup', label: 'Finish setup', to: '/setup', keywords: 'onboarding guide slots' },
];

export function CommandPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return COMMANDS;
    return COMMANDS.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(needle));
  }, [q]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);

  const run = (c: Command | undefined) => { if (c) { onClose(); navigate(c.to); } };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.34)', display: 'grid', placeItems: 'start center', paddingTop: '12vh', zIndex: 200 }} onClick={onClose}>
      <div role="dialog" aria-label="Command palette" style={{ background: 'var(--bg)', borderRadius: 16, width: 'min(560px, 92vw)', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="inp"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or jump to…"
          aria-label="Search or jump to"
          style={{ border: 0, borderBottom: '1px solid var(--line-soft)', borderRadius: 0, fontSize: 15, padding: '16px 18px' }}
        />
        <div role="listbox" aria-label="Commands" style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {results.length === 0 && <p className="dim" style={{ padding: 16, fontSize: 13 }}>No matches.</p>}
          {results.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
              className="row"
              style={{ width: '100%', gap: 10, textAlign: 'left', border: 0, borderRadius: 10, padding: '11px 12px', cursor: 'pointer', background: i === active ? 'var(--surface-2)' : 'transparent' }}
            >
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>{c.label}</span>
              {c.hint && <kbd style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ink-dim)' }}>{c.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
