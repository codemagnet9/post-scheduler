// src/screens/app/composer/BeforeYouSchedule.tsx
// The findings panel. Messages are rendered VERBATIM — severity, network name and message come from
// the API (the same copy the publisher enforces); the frontend never rewords, shortens or templates
// them, and never evaluates a rule or counts a character itself.
import type { Finding, Severity } from '../../../api/types';

const HINT: Record<Severity, string> = { blocker: 'h-bad', warning: 'h-warn', info: 'h-info' };
const ICON: Record<Severity, string> = { blocker: '!', warning: '△', info: '✓' };

export function BeforeYouSchedule({ findings, stale }: { findings: Finding[]; stale?: boolean }): JSX.Element {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');
  const toCheck = blockers.length + warnings.length;
  const ordered = [...blockers, ...warnings, ...infos];

  return (
    <div className="card">
      <div className="card-h">
        <h3>Before you schedule</h3>
        {toCheck > 0
          ? <span className={`badge ${blockers.length ? 'b-bad' : 'b-warn'} sp`}>{toCheck} to check</span>
          : <span className="badge b-ok sp">All clear</span>}
      </div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 9, opacity: stale ? 0.65 : 1 }}>
        {ordered.length === 0 && <p className="dim" style={{ fontSize: 13 }}>Add content and networks to see checks.</p>}
        {ordered.map((f, i) => (
          // The message is inserted as-is — do not template or edit this string.
          <div key={`${f.targetId ?? 'post'}-${f.code}-${i}`} className={`hint ${f.severity === 'info' && f.code === 'all_clear' ? 'h-ok' : HINT[f.severity]}`}>
            {ICON[f.severity]} <span>{f.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
