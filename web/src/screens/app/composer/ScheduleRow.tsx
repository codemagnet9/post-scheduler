// src/screens/app/composer/ScheduleRow.tsx
// Publish now / pick a time / add to queue, with date, time and time basis. Choosing "Audience local
// time" makes each target resolve to its own market's instant — the per-target resolved times appear
// on the previews (computed by the API, shown there), so this row just captures intent.
import type { ScheduleMode, TimeBasis } from './logic';

export function ScheduleRow({ mode, date, time, basis, onChange }: {
  mode: ScheduleMode; date: string; time: string; basis: TimeBasis;
  onChange: (next: { mode?: ScheduleMode; date?: string; time?: string; basis?: TimeBasis }) => void;
}): JSX.Element {
  const seg = (m: ScheduleMode, label: string) => (
    <button type="button" className={mode === m ? 'on' : ''} onClick={() => onChange({ mode: m })}>{label}</button>
  );
  return (
    <div className="card">
      <div className="card-h"><h3>Schedule</h3></div>
      <div className="card-b">
        <div className="seg" style={{ marginBottom: 16 }}>
          {seg('now', 'Publish now')}
          {seg('time', 'Pick a time')}
          {seg('queue', 'Add to queue')}
        </div>

        {mode === 'time' && (
          <div className="grid g3" style={{ gap: 12 }}>
            <div><label className="fl">Date</label><input className="inp" type="date" value={date} onChange={(e) => onChange({ date: e.target.value })} /></div>
            <div><label className="fl">Time</label><input className="inp" type="time" value={time} onChange={(e) => onChange({ time: e.target.value })} /></div>
            <div><label className="fl">Time basis</label>
              <select className="inp" value={basis} onChange={(e) => onChange({ basis: e.target.value as TimeBasis })}>
                <option value="audience">Audience local time</option>
                <option value="workspace">My workspace time</option>
                <option value="utc">UTC</option>
              </select>
            </div>
          </div>
        )}

        {mode === 'time' && basis === 'audience' && (
          <div className="hint h-info" style={{ marginTop: 14 }}>◷ <span><b>Audience local time.</b> Each account publishes at {time || 'this time'} in its own market — see the exact instant per network on the previews.</span></div>
        )}
        {mode === 'queue' && <div className="hint h-info" style={{ marginTop: 4 }}>≡ <span>This drops into the next open slot for each market.</span></div>}
        {mode === 'now' && <div className="hint h-warn" style={{ marginTop: 4 }}>△ <span>Publishes to every selected network as soon as you schedule.</span></div>}
      </div>
    </div>
  );
}
