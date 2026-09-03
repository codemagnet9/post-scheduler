// src/screens/app/queue/Queue.tsx
// The queue list. Per-target rows (never rolled up): a failed row shows the provider's own reason and
// a Retry that requeues THAT target alone. Filters by state group / network / author; cursor
// pagination (not load-everything); bulk select for cancel/reschedule. Below: queue health (real read
// models) and the weekly slot editor, whose removals reflow the market — reflected on refetch.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { useAuth } from '../../../auth/AuthProvider';
import {
  cancelTargets, listAccounts, listQueue, listSlots, queueHealth, rescheduleTarget, retryTarget,
  addSlot, removeSlot,
} from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { formatDateTime, zoneAbbrev } from '../../../lib/datetime';
import { marketLabel } from '../composer/logic';

type Group = 'upcoming' | 'drafts' | 'published' | 'failed';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Queue(): JSX.Element {
  const { active, timezone } = useWorkspace();
  const ws = active.id;
  const { user } = useAuth();
  const qc = useQueryClient();

  const [group, setGroup] = useState<Group>('upcoming');
  const [provider, setProvider] = useState('');
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);
  const [bulkWhen, setBulkWhen] = useState<{ date: string; time: string } | null>(null);

  const invalidateAll = () => { qc.invalidateQueries({ queryKey: ['queue', ws] }); qc.invalidateQueries({ queryKey: ['queue-health', ws] }); qc.invalidateQueries({ queryKey: ['calendar', ws] }); };

  const accountsQ = useQuery({ queryKey: ['accounts', ws], queryFn: () => listAccounts(ws) });
  const providers = useMemo(() => [...new Set((accountsQ.data ?? []).map((a) => a.provider))], [accountsQ.data]);

  const queueQ = useInfiniteQuery({
    queryKey: ['queue', ws, group, provider, mine],
    queryFn: ({ pageParam }) => listQueue(ws, { group, provider: provider || undefined, authorId: mine ? user?.id : undefined, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const events = useMemo(() => queueQ.data?.pages.flatMap((p) => p.data) ?? [], [queueQ.data]);

  const healthQ = useQuery({ queryKey: ['queue-health', ws], queryFn: () => queueHealth(ws) });
  const slotsQ = useQuery({ queryKey: ['slots', ws], queryFn: () => listSlots(ws) });

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());

  const doRetry = async (id: string) => { await retryTarget(ws, id).catch((e) => setBanner(e instanceof ApiError ? e.displayMessage : 'Retry failed.')); invalidateAll(); };
  const doCancel = async () => { const r = await cancelTargets(ws, [...selected]).catch(() => ({ canceled: 0 })); setBanner(`Canceled ${r.canceled} ${r.canceled === 1 ? 'post' : 'posts'}.`); clearSel(); invalidateAll(); };
  const doBulkReschedule = async () => {
    if (!bulkWhen) return;
    let moved = 0; const reasons: string[] = [];
    for (const id of selected) {
      try { await rescheduleTarget(ws, id, { localDate: bulkWhen.date, localTime: bulkWhen.time, zone: timezone }); moved += 1; }
      catch (e) { reasons.push(e instanceof ApiError ? e.message : 'move failed'); }
    }
    setBanner(`Moved ${moved} ${moved === 1 ? 'post' : 'posts'}${reasons.length ? ` · ${reasons.length} refused (${reasons[0]})` : ''}.`);
    setBulkWhen(null); clearSel(); invalidateAll();
  };

  const GROUPS: [Group, string][] = [['upcoming', 'Upcoming'], ['drafts', 'Drafts'], ['published', 'Published'], ['failed', 'Failed']];

  return (
    <Screen title="Queue" actions={<Link className="btn btn-primary btn-sm" to="/composer">＋ New post</Link>}>
      <div className="row wrapf" style={{ gap: 9 }}>
        <div className="seg">{GROUPS.map(([g, label]) => <button key={g} className={group === g ? 'on' : ''} onClick={() => { setGroup(g); clearSel(); }}>{label}</button>)}</div>
        <select className="inp" style={{ width: 'auto', padding: '7px 12px' }} value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All networks</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="seg"><button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Everyone</button><button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Mine</button></div>
      </div>

      {banner && <div className="hint h-info" style={{ alignItems: 'center' }}><span>{banner}</span><button className="btn btn-quiet btn-sm sp" style={{ marginLeft: 'auto' }} onClick={() => setBanner(null)}>Dismiss</button></div>}

      {selected.size > 0 && (
        <div className="hint h-info row" style={{ alignItems: 'center' }}>
          <b>{selected.size} selected</b>
          <span className="row sp" style={{ marginLeft: 'auto', gap: 8 }}>
            {bulkWhen ? (
              <>
                <input className="inp" type="date" style={{ width: 'auto', padding: '6px 10px' }} value={bulkWhen.date} onChange={(e) => setBulkWhen({ ...bulkWhen, date: e.target.value })} />
                <input className="inp" type="time" style={{ width: 'auto', padding: '6px 10px' }} value={bulkWhen.time} onChange={(e) => setBulkWhen({ ...bulkWhen, time: e.target.value })} />
                <button className="btn btn-primary btn-sm" onClick={doBulkReschedule}>Move</button>
                <button className="btn btn-quiet btn-sm" onClick={() => setBulkWhen(null)}>Cancel</button>
              </>
            ) : (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setBulkWhen({ date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), time: '09:30' })}>Reschedule</button>
                <button className="btn btn-danger btn-sm" onClick={doCancel}>Cancel posts</button>
              </>
            )}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-h"><h3>{GROUPS.find(([g]) => g === group)?.[1]}</h3><span className="dim sp" style={{ fontSize: 12.5 }}>{events.length} shown</span></div>
        <div className="card-b flush">
          {queueQ.isLoading ? <SkeletonRows rows={5} />
            : queueQ.error ? <ErrorState error={queueQ.error instanceof ApiError ? queueQ.error : null} onRetry={() => queueQ.refetch()} />
            : events.length === 0 ? <EmptyState icon="≡" title="Nothing here" description="Posts in this state will show up here." actions={<Link className="btn btn-primary btn-sm" to="/composer">Write a post</Link>} />
            : (
              <div className="tbl-wrap"><table>
                <thead><tr><th style={{ width: 34 }} /><th>Post</th><th>Network</th><th>When</th><th>Status</th><th /></tr></thead>
                <tbody>{events.map((e) => (
                  <tr key={e.targetId}>
                    <td><input type="checkbox" checked={selected.has(e.targetId)} onChange={() => toggle(e.targetId)} /></td>
                    <td style={{ maxWidth: 340 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text || '(no caption)'}</div>
                      {e.reason && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 3 }}>{e.reason}</div>}
                    </td>
                    <td>{e.handle ?? e.provider}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{e.instant ? `${formatDateTime(e.instant, e.timezone)} ${zoneAbbrev(e.timezone)}` : '—'}</td>
                    <td><StateBadge state={e.state} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {(e.state === 'failed' || e.state === 'needs_review')
                        ? <button className="btn btn-primary btn-sm" onClick={() => doRetry(e.targetId)}>Retry</button>
                        : <Link className="btn btn-quiet btn-sm" to="/composer">Edit</Link>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
        </div>
        {queueQ.hasNextPage && (
          <div className="row" style={{ justifyContent: 'center', paddingTop: 16 }}>
            <button className="btn btn-ghost btn-sm" disabled={queueQ.isFetchingNextPage} onClick={() => queueQ.fetchNextPage()}>{queueQ.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <SlotEditor ws={ws} slots={slotsQ.data ?? []} workspaceTz={timezone} onChange={() => { qc.invalidateQueries({ queryKey: ['slots', ws] }); invalidateAll(); }} loading={slotsQ.isLoading} />
        <QueueHealthCard loading={healthQ.isLoading} health={healthQ.data} />
      </div>
    </Screen>
  );
}

function StateBadge({ state }: { state: string }): JSX.Element {
  const cls = state === 'published' ? 'b-ok' : state === 'failed' || state === 'needs_review' ? 'b-bad' : state === 'draft' || state === 'canceled' ? 'b-mute' : 'b-warn';
  return <span className={`badge ${cls}`}><span className="d" />{state.replace('_', ' ')}</span>;
}

function QueueHealthCard({ loading, health }: { loading: boolean; health?: import('../../../api/types').QueueHealth }): JSX.Element {
  return (
    <div className="card">
      <div className="card-h"><h3>Queue health</h3></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading || !health ? <SkeletonRows rows={2} /> : (
          <>
            <div className="row"><span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Runway</span><span className="mono sp" style={{ marginLeft: 'auto', fontWeight: 700 }}>{health.runwayDays} {health.runwayDays === 1 ? 'day' : 'days'}</span></div>
            <div className="row"><span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Empty slots this week</span><span className="mono sp" style={{ marginLeft: 'auto', fontWeight: 700 }}>{health.emptyThisWeek} / {health.slotsPerWeek}</span></div>
            {health.markets.filter((m) => m.thin).map((m) => (
              <div key={m.market} className="hint h-warn">△ <span><b>{marketLabel(m.market)} is thin.</b> {m.queued} queued against {m.slots} weekly {m.slots === 1 ? 'slot' : 'slots'}.</span></div>
            ))}
            {health.markets.every((m) => !m.thin) && health.markets.length > 0 && <div className="hint h-ok">✓ <span>Every market has enough queued to fill its slots.</span></div>}
          </>
        )}
      </div>
    </div>
  );
}

function SlotEditor({ ws, slots, workspaceTz, onChange, loading }: { ws: string; slots: import('../../../api/types').Slot[]; workspaceTz: string; onChange: () => void; loading: boolean }): JSX.Element {
  const [newTime, setNewTime] = useState('09:30');
  const [newDow, setNewDow] = useState(1);
  const markets = useMemo(() => [...new Set([workspaceTz, ...slots.map((s) => s.market_timezone)])], [slots, workspaceTz]);
  const [market, setMarket] = useState(workspaceTz);

  const add = async () => { await addSlot(ws, { market, dayOfWeek: newDow, localTime: newTime }).catch(() => undefined); onChange(); };
  const remove = async (id: string) => { await removeSlot(ws, id).catch(() => undefined); onChange(); };

  return (
    <div className="card">
      <div className="card-h"><h3>Posting slots</h3>
        <select className="inp sp" style={{ width: 'auto', padding: '6px 12px', marginLeft: 'auto' }} value={market} onChange={(e) => setMarket(e.target.value)}>
          {markets.map((m) => <option key={m} value={m}>{marketLabel(m)}</option>)}
        </select>
      </div>
      <div className="card-b">
        {loading ? <SkeletonRows rows={2} /> : (
          <>
            <div className="slots">
              {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
                <div className="slotcol" key={dow}>
                  <span className="d">{DOW[dow]}</span>
                  {slots.filter((s) => s.market_timezone === market && s.day_of_week === dow).map((s) => (
                    <button key={s.id} type="button" className="slot filled" title="Remove slot" onClick={() => remove(s.id)}>{s.local_time.slice(0, 5)} ✕</button>
                  ))}
                </div>
              ))}
            </div>
            <div className="row wrapf" style={{ gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
              <select className="inp" style={{ width: 'auto', padding: '8px 12px' }} value={newDow} onChange={(e) => setNewDow(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{DOW[d]}</option>)}
              </select>
              <input className="inp" type="time" style={{ width: 'auto', padding: '8px 12px' }} value={newTime} onChange={(e) => setNewTime(e.target.value)} />
              <button className="btn btn-ghost btn-sm" onClick={add}>＋ Add slot</button>
              <span className="dim sp" style={{ marginLeft: 'auto', fontSize: 12 }}>Removing a slot reflows the market.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
