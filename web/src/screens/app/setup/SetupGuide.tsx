// src/screens/app/setup/SetupGuide.tsx
// The compact "Finish setup" card shown on Home until onboarding is complete, plus the full checklist
// used on the Setup screen. Each step is skippable — this only tracks what's left, computed from real
// data (useSetupStatus), so it disappears on its own once the evidence exists.
import { Link } from 'react-router-dom';
import { useSetupStatus, type SetupStep } from './useSetupStatus';

function StepRow({ step }: { step: SetupStep }): JSX.Element {
  return (
    <div className="row" style={{ gap: 12, padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span aria-hidden style={{
        width: 26, height: 26, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 13,
        background: step.done ? 'var(--ok-wash)' : 'var(--surface-2)', color: step.done ? 'var(--ok)' : 'var(--ink-dim)',
        border: step.done ? 'none' : '1px dashed var(--line)',
      }}>{step.done ? '✓' : '○'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, textDecoration: step.done ? 'none' : 'none' }}>{step.label}</div>
        <div className="dim" style={{ fontSize: 12 }}>{step.hint}</div>
      </div>
      {step.done ? <span className="badge b-ok"><span aria-hidden>✓</span> Done</span>
        : <Link className="btn btn-ghost btn-sm" to={step.to}>Start</Link>}
    </div>
  );
}

// The full checklist (Setup screen).
export function SetupChecklist(): JSX.Element {
  const { steps, doneCount, total } = useSetupStatus();
  return (
    <div className="card">
      <div className="card-h"><h3>Get set up</h3><span className="dim sp" style={{ fontSize: 12 }}>{doneCount} of {total} done</span></div>
      <div className="card-b">
        {steps.map((s) => <StepRow key={s.key} step={s} />)}
      </div>
    </div>
  );
}

// The dismissible Home card. Hidden entirely once complete.
export function FinishSetupCard(): JSX.Element | null {
  const { steps, doneCount, total, complete, loading } = useSetupStatus();
  if (loading || complete) return null;
  const next = steps.find((s) => !s.done);
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', background: 'var(--brand-wash)' }}>
      <div className="card-h">
        <h3>Finish setting up</h3>
        <span className="dim sp" style={{ fontSize: 12 }}>{doneCount} of {total} done</span>
      </div>
      <div className="card-b">
        <p style={{ fontSize: 13.5, marginBottom: 12 }}>
          {next ? <>Next: <strong>{next.label.toLowerCase()}</strong> — {next.hint}</> : 'A couple of steps left.'}
        </p>
        <div className="row" style={{ gap: 10 }}>
          {next && <Link className="btn btn-primary btn-sm" to={next.to}>{next.label}</Link>}
          <Link className="btn btn-quiet btn-sm" to="/setup">See all steps</Link>
        </div>
      </div>
    </div>
  );
}
