// src/screens/app/setup/Setup.tsx
// The onboarding screen: the checklist plus the two steps a user can do inline here — connect networks
// (a shortcut to the Networks screen) and set the posting schedule (add/remove weekly slots). Each slot
// is a recurring weekly time IN A MARKET'S OWN ZONE (the server resolves the wall-clock to an instant,
// DST-correct — the browser never converts). Slots feed the self-filling queue.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { listSlots, addSlot, removeSlot, getAccountHealth } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { SetupChecklist } from './SetupGuide';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Setup(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();

  const slotsQ = useQuery({ queryKey: ['slots', ws], queryFn: () => listSlots(ws) });
  const accountsQ = useQuery({ queryKey: ['account-health', ws], queryFn: () => getAccountHealth(ws) });

  // Markets you can add a slot for: the workspace zone, plus every connected account's zone.
  const zones = Array.from(new Set([active.default_timezone, ...(accountsQ.data ?? []).map((a) => a.timezone)]));
  const [market, setMarket] = useState(active.default_timezone);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [localTime, setLocalTime] = useState('09:00');

  const addM = useMutation({
    mutationFn: () => addSlot(ws, { market, dayOfWeek, localTime }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slots', ws] }),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => removeSlot(ws, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slots', ws] }),
  });

  const submit = (e: FormEvent) => { e.preventDefault(); addM.mutate(); };
  const slots = slotsQ.data ?? [];

  return (
    <Screen title="Get set up">
      <p className="dim" style={{ fontSize: 13.5, marginTop: -8, marginBottom: 18 }}>Three steps to your first published post. Skip any of them — this just tracks what’s left.</p>

      <SetupChecklist />

      <div className="grid g2" style={{ alignItems: 'start' }}>
        {/* connect networks shortcut */}
        <div className="card">
          <div className="card-h"><h3>Connect networks</h3></div>
          <div className="card-b">
            <p className="dim" style={{ fontSize: 13.5, marginBottom: 14 }}>Link the accounts your brand posts to. Meridian keeps their tokens fresh.</p>
            <Link className="btn btn-primary btn-sm" to="/networks">Manage networks</Link>
          </div>
        </div>

        {/* posting schedule */}
        <div className="card">
          <div className="card-h"><h3>Posting schedule</h3>{slots.length > 0 && <span className="dim sp" style={{ fontSize: 12 }}>{slots.length} {slots.length === 1 ? 'slot' : 'slots'}</span>}</div>
          <div className="card-b">
            <form onSubmit={submit} className="row wrapf" style={{ gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
              <div className="field" style={{ margin: 0, flex: '1 1 160px' }}>
                <label className="fl">Market</label>
                <select className="inp" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Slot market timezone">
                  {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="fl">Day</label>
                <select className="inp" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))} aria-label="Slot day of week" style={{ width: 'auto' }}>
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="fl">Time</label>
                <input className="inp" type="time" value={localTime} onChange={(e) => setLocalTime(e.target.value)} aria-label="Slot local time" style={{ width: 'auto' }} />
              </div>
              <button className="btn btn-primary btn-sm" disabled={addM.isPending}>{addM.isPending ? 'Adding…' : 'Add slot'}</button>
            </form>
            {addM.error instanceof ApiError && <div className="hint h-bad" style={{ marginBottom: 12 }}>{addM.error.displayMessage}</div>}

            {slotsQ.isLoading ? <SkeletonRows rows={3} />
              : slotsQ.error ? <ErrorState error={slotsQ.error instanceof ApiError ? slotsQ.error : null} onRetry={() => slotsQ.refetch()} />
              : slots.length === 0 ? <EmptyState icon="≡" title="No slots yet" description="Add a weekly time above and the queue starts filling itself." />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {slots.map((s) => (
                    <div key={s.id} className="row" style={{ gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--line-soft)' }}>
                      <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{DAYS[s.day_of_week]} · {s.local_time}</span>
                      <span className="dim" style={{ fontSize: 12 }}>{s.market_timezone.replace(/_/g, ' ')}</span>
                      <button className="btn btn-quiet btn-sm sp" onClick={() => removeM.mutate(s.id)} disabled={removeM.isPending} aria-label={`Remove ${DAYS[s.day_of_week]} ${s.local_time} slot`}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      </div>
    </Screen>
  );
}
