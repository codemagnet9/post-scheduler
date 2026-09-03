// src/screens/app/calendar/Calendar.tsx
// Month / Week / List calendar. Everything renders in the ACTIVE viewing zone (default: the workspace
// zone), labelled "Showing …", switchable to any market. Dropping an event calls the API to move it —
// nothing is committed locally until the server confirms; a refusal shows the reason and the event
// stays where it was.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { listCalendar, rescheduleTarget, retryTarget } from '../../../api/endpoints';
import type { BoardEvent } from '../../../api/types';
import { ApiError } from '../../../api/client';
import { ErrorState, SkeletonRows } from '../../../components/states';
import { formatTime } from '../../../lib/datetime';
import { marketLabel } from '../composer/logic';
import { attemptReschedule, cellKey, eventClass, eventTimeLabel, monthGrid, weekGrid, zonedDateKey, type DayCell } from './calendarLogic';
import { EventDetail } from './EventDetail';

type View = 'month' | 'week' | 'list';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function rangeFor(view: View, cells: DayCell[]): { from: string; to: string } {
  if (view === 'list') return { from: new Date(Date.now() - 7 * 86_400_000).toISOString(), to: new Date(Date.now() + 45 * 86_400_000).toISOString() };
  const first = Date.UTC(cells[0].y, cells[0].m, cells[0].d);
  const last = Date.UTC(cells[cells.length - 1].y, cells[cells.length - 1].m, cells[cells.length - 1].d);
  return { from: new Date(first - 86_400_000).toISOString(), to: new Date(last + 2 * 86_400_000).toISOString() };
}

export function Calendar(): JSX.Element {
  const { active, timezone } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [viewZone, setViewZone] = useState<string>(timezone);
  const [detailPostId, setDetailPostId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const cells = useMemo(() => (view === 'week' ? weekGrid(anchor) : monthGrid(anchor.getUTCFullYear(), anchor.getUTCMonth())), [view, anchor]);
  const range = useMemo(() => rangeFor(view, cells), [view, cells]);
  const q = useQuery({ queryKey: ['calendar', ws, range.from, range.to], queryFn: () => listCalendar(ws, range.from, range.to) });
  const events = q.data ?? [];

  const zones = useMemo(() => [...new Set([timezone, ...events.map((e) => e.timezone)])], [timezone, events]);
  const todayKey = zonedDateKey(new Date().toISOString(), viewZone);
  const byDay = useMemo(() => {
    const map = new Map<string, BoardEvent[]>();
    for (const e of events) {
      if (!e.instant) continue;
      const k = zonedDateKey(e.instant, viewZone);
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return map;
  }, [events, viewZone]);

  const shift = (n: number) => setAnchor((a) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + (view === 'week' ? 0 : n), a.getUTCDate() + (view === 'week' ? n * 7 : 0))));

  const onDrop = async (dateKey: string, targetId: string) => {
    const ev = events.find((e) => e.targetId === targetId);
    if (!ev || !ev.instant || ev.state !== 'scheduled') return;
    setPending(targetId); setMoveError(null);
    const res = await attemptReschedule(() => rescheduleTarget(ws, targetId, { localDate: dateKey, localTime: formatTime(ev.instant as string, viewZone), zone: viewZone }));
    setPending(null);
    if (res.ok) qc.invalidateQueries({ queryKey: ['calendar', ws] });
    else setMoveError(res.reason); // event stays put; the reason is shown
  };
  const onRetry = async (targetId: string) => { await retryTarget(ws, targetId).catch(() => undefined); qc.invalidateQueries({ queryKey: ['calendar', ws] }); setDetailPostId(null); };

  const actions = (
    <>
      <div className="seg">
        {(['month', 'week', 'list'] as View[]).map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
      </div>
      <Link className="btn btn-primary btn-sm" to="/composer">＋ New post</Link>
    </>
  );

  return (
    <Screen title="Calendar" actions={actions}>
      <div className="row wrapf" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => shift(-1)}>‹</button>
          <h2 style={{ fontSize: 17, minWidth: 160, textAlign: 'center' }}>{MONTHS[anchor.getUTCMonth()]} {anchor.getUTCFullYear()}</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => shift(1)}>›</button>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setAnchor(new Date())}>Today</button>
        <div className="row sp" style={{ marginLeft: 'auto', gap: 8 }}>
          <span className="dim" style={{ fontSize: 12.5 }}>Showing</span>
          <select className="inp" style={{ width: 'auto', padding: '7px 12px' }} value={viewZone} onChange={(e) => setViewZone(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{marketLabel(z)}</option>)}
          </select>
        </div>
      </div>

      {moveError && <div className="hint h-bad">{moveError}</div>}

      {q.isLoading ? <div className="card"><div className="card-b"><SkeletonRows rows={5} /></div></div>
        : q.error ? <div className="card"><ErrorState error={q.error instanceof ApiError ? q.error : null} onRetry={() => q.refetch()} /></div>
        : view === 'list' ? <ListView events={[...events].filter((e) => e.instant).sort((a, b) => (a.instant! < b.instant! ? -1 : 1))} viewZone={viewZone} onOpen={setDetailPostId} />
        : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="cal">
              {DAYS.map((d) => <div className="dh" key={d}>{d}</div>)}
              {cells.map((c, i) => {
                const key = cellKey(c);
                const dayEvents = byDay.get(key) ?? [];
                return (
                  <div key={i} className={`dc${c.inMonth ? '' : ' off'}${key === todayKey ? ' today' : ''}`} style={view === 'week' ? { minHeight: 320 } : undefined}
                    onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDrop(key, e.dataTransfer.getData('text/plain')); }}>
                    <span className="dn">{c.d}{c.d === 1 ? ` ${MONTHS[c.m].slice(0, 3)}` : ''}</span>
                    {dayEvents.map((ev) => (
                      <span key={ev.targetId} className={`ev ${eventClass(ev.state)}`} draggable={ev.state === 'scheduled'}
                        style={{ opacity: pending === ev.targetId ? 0.5 : 1, cursor: ev.state === 'scheduled' ? 'grab' : 'pointer' }}
                        title={ev.state === 'scheduled' ? 'Drag to reschedule' : undefined}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', ev.targetId)}
                        onClick={() => setDetailPostId(ev.postId)}>
                        <span className="t">{eventTimeLabel(ev.instant as string, viewZone)}</span>{ev.text || ev.provider}
                      </span>
                    ))}
                    {dayEvents.length === 0 && c.inMonth && <Link to="/composer" className="dim" style={{ fontSize: 11, marginTop: 'auto', opacity: 0.45, alignSelf: 'flex-start' }}>＋</Link>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {detailPostId && (
        <EventDetail siblings={events.filter((e) => e.postId === detailPostId)} viewZone={viewZone} onClose={() => setDetailPostId(null)} onRetry={onRetry} />
      )}
    </Screen>
  );
}

function ListView({ events, viewZone, onOpen }: { events: BoardEvent[]; viewZone: string; onOpen: (postId: string) => void }): JSX.Element {
  if (!events.length) return <div className="card"><div className="empty"><span className="ic">▦</span><h3>Nothing on the calendar</h3><p>Schedule a post and it will appear here.</p></div></div>;
  return (
    <div className="card"><div className="card-b flush"><div className="tbl-wrap"><table>
      <thead><tr><th>When</th><th>Network</th><th>Post</th><th>Status</th></tr></thead>
      <tbody>{events.map((e) => (
        <tr key={e.targetId} style={{ cursor: 'pointer' }} onClick={() => onOpen(e.postId)}>
          <td className="num" style={{ whiteSpace: 'nowrap' }}>{marketLabel(e.timezone)} · {formatTime(e.instant as string, viewZone)}</td>
          <td>{e.handle ?? e.provider}</td>
          <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text}</td>
          <td><span className={`badge ${e.state === 'published' ? 'b-ok' : e.state === 'failed' ? 'b-bad' : 'b-warn'}`}>{e.state.replace('_', ' ')}</span></td>
        </tr>
      ))}</tbody>
    </table></div></div></div>
  );
}
