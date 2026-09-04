// src/screens/app/analytics/TopPostsTable.tsx
// Ported from the prototype's top-posts table. Every post here already passed the server's own
// "has impressions" filter (see topPostsByEngagementRate), so impressions/engagements are always real
// numbers — but the RATE column still formats through the one shared formatter/definition, never a
// locally recomputed value, so a top post's rate can never drift from the headline's definition.
import type { TopPost } from '../../../api/types';
import { formatCount, formatPercent, providerLabel } from './analyticsLogic';
import { Avatar } from '../../../components/Avatar';

export function TopPostsTable({ data }: { data: TopPost[] }): JSX.Element {
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>No posts with impressions in this range yet.</p>;
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr><th>Post</th><th>Networks</th><th>Impressions</th><th>Engagements</th><th>Rate</th></tr></thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.postId}>
              <td style={{ maxWidth: 380, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.text || <span className="dim" style={{ fontWeight: 400 }}>(no shared caption — per-network overrides only)</span>}
              </td>
              <td>
                <span className="row" style={{ gap: -4 }}>
                  {p.providers.map((prov, i) => (
                    <span key={prov} style={{ marginLeft: i ? -6 : 0, borderRadius: '50%', boxShadow: '0 0 0 2px var(--surface)', display: 'inline-flex' }}>
                      <Avatar name={providerLabel(prov)} seed={prov} size={22} />
                    </span>
                  ))}
                </span>
              </td>
              <td className="num">{formatCount(p.impressions)}</td>
              <td className="num">{formatCount(p.engagements)}</td>
              <td className="num" style={{ fontWeight: 700, color: 'var(--ok)' }}>{formatPercent(p.engagementRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
