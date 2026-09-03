// src/screens/app/composer/ScheduleActions.tsx
// The commit buttons. An Editor sees ONLY "Send for approval" — the direct schedule path is
// Owner/Approver. Scheduling is disabled when the API says there's a blocker (canSchedule=false); a
// warning does not disable it. Nothing here is optimistic — the caller flips busy while the request is
// in flight and only reflects success once the server confirms.
import type { Role } from '../../../api/types';
import { canDirectSchedule } from './logic';

export function ScheduleActions({ role, canSchedule, busy, error, onSchedule, onSubmit }: {
  role: Role;
  canSchedule: boolean;
  busy?: boolean;
  error?: string | null;
  onSchedule: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const direct = canDirectSchedule(role);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <div className="hint h-bad">{error}</div>}
      <div className="row" style={{ gap: 9 }}>
        {direct ? (
          <>
            <button type="button" className="btn btn-primary" style={{ flex: 1, padding: 11 }} disabled={!canSchedule || busy} onClick={onSchedule}>
              {busy ? 'Scheduling…' : 'Schedule post'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onSubmit}>Send for approval</button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" style={{ flex: 1, padding: 11 }} disabled={!canSchedule || busy} onClick={onSubmit}>
            {busy ? 'Submitting…' : 'Send for approval'}
          </button>
        )}
      </div>
      {!canSchedule && <p className="dim" style={{ fontSize: 12 }}>Resolve the blockers above before this can go out.</p>}
    </div>
  );
}
