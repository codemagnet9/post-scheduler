// src/screens/app/analytics/Heatmap.tsx
// Day-by-hour engagement heatmap, ported from the prototype's heatmap(). The DAY is the WORKSPACE-ZONE
// day — the server buckets it that way (see engagementHeatmap's `timezone` param), never UTC. A cell
// with no posts published in that hour gets NO colour at all, never a zero-intensity green — "nothing
// happened here" and "it happened but performed poorly" are genuinely different facts.
import { Fragment } from 'react';
import type { HeatCell } from '../../../api/types';

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first display, over Postgres's 0=Sunday encoding
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const LABEL_HOURS = new Set([0, 3, 6, 9, 12, 15, 18, 21]);

export function Heatmap({ data }: { data: HeatCell[] }): JSX.Element {
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>Not enough published posts yet to show a pattern.</p>;

  const byCell = new Map(data.map((c) => [`${c.dow}-${c.hour}`, c]));
  const max = Math.max(1, ...data.map((c) => c.avgEngagements ?? 0));

  return (
    <>
      <div className="heat" style={{ gridTemplateColumns: `auto repeat(${HOURS.length}, 1fr)` }}>
        <span />
        {HOURS.map((h) => (
          <span className="hl" key={h} style={{ textAlign: 'center' }}>{LABEL_HOURS.has(h) ? String(h).padStart(2, '0') : ''}</span>
        ))}
        {DOW_ORDER.map((dow) => (
          <Fragment key={dow}>
            <span className="hl">{DOW_LABEL[dow]}</span>
            {HOURS.map((h) => {
              const cell = byCell.get(`${dow}-${h}`);
              const has = cell != null && cell.avgEngagements !== null;
              const alpha = has ? 0.12 + (cell!.avgEngagements! / max) * 0.83 : 0;
              const title = has
                ? `${DOW_LABEL[dow]} ${String(h).padStart(2, '0')}:00 · avg ${cell!.avgEngagements!.toFixed(1)} engagements (${cell!.posts} ${cell!.posts === 1 ? 'post' : 'posts'})`
                : `${DOW_LABEL[dow]} ${String(h).padStart(2, '0')}:00 · no posts published then`;
              return (
                <span
                  key={h}
                  className="hc"
                  title={title}
                  style={{ background: has ? `color-mix(in srgb, var(--ok) ${Math.round(alpha * 100)}%, var(--surface-2))` : 'var(--line-soft)' }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8, fontSize: 11, color: 'var(--ink-dim)' }}>
        <span className="mono">LOW</span>
        {[0.15, 0.35, 0.55, 0.75, 0.95].map((a) => (
          <span key={a} style={{ width: 22, height: 9, borderRadius: 2, background: `color-mix(in srgb, var(--ok) ${a * 100}%, var(--surface-2))` }} />
        ))}
        <span className="mono">HIGH</span>
        <span style={{ marginLeft: 'auto' }}>Average engagement per post, by hour published — blank means no posts then</span>
      </div>
    </>
  );
}
