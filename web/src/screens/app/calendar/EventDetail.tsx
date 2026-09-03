// src/screens/app/calendar/EventDetail.tsx
// Clicking an event opens this. It lists ALL of the post's targets with their OWN instants — so an
// audience-local post that fans out to several markets is never shown as one instant: each row shows
// the target's local time in its market AND, in brackets, that same moment in the viewing zone.
import type { BoardEvent } from '../../../api/types';
import { formatDateTime, formatTime, zoneAbbrev } from '../../../lib/datetime';
import { marketLabel } from '../composer/logic';
import { Avatar } from '../../../components/Avatar';

const STATE_BADGE: Record<string, string> = { published: 'b-ok', scheduled: 'b-warn', failed: 'b-bad', needs_review: 'b-bad', draft: 'b-mute', canceled: 'b-mute' };

export function EventDetail({ siblings, viewZone, onClose, onRetry }: {
  siblings: BoardEvent[];
  viewZone: string;
  onClose: () => void;
  onRetry?: (targetId: string) => void;
}): JSX.Element {
  const title = siblings[0]?.text || 'Post';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(25,25,23,.28)', display: 'grid', placeItems: 'center', zIndex: 90, padding: 20 }} onClick={onClose}>
      <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 26, width: 'min(560px, 100%)', boxShadow: '0 24px 60px -18px rgba(25,25,23,.4)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 19, marginBottom: 4 }}>Scheduled across {siblings.length} {siblings.length === 1 ? 'network' : 'networks'}</h3>
        <p className="dim" style={{ fontSize: 13.5, marginBottom: 18 }}>{title}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {siblings.map((e) => (
            <div key={e.targetId} className="row" style={{ gap: 11, alignItems: 'flex-start' }}>
              <Avatar name={e.handle ?? e.provider} seed={e.targetId} size={30} square />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 13, display: 'block', lineHeight: 1.2 }}>{e.handle ?? e.displayName ?? e.provider}</span>
                {e.instant
                  ? <span className="mono dim" style={{ fontSize: 11.5 }}>
                      {marketLabel(e.timezone)} · {formatTime(e.instant, e.timezone)} {zoneAbbrev(e.timezone)}
                      {e.timezone !== viewZone && <> &nbsp;({formatTime(e.instant, viewZone)} in {marketLabel(viewZone)})</>}
                    </span>
                  : <span className="dim" style={{ fontSize: 11.5 }}>Not scheduled</span>}
                {e.reason && <span className="dim" style={{ display: 'block', fontSize: 11.5, color: 'var(--bad)' }}>{e.reason}</span>}
              </span>
              <span className="row sp" style={{ marginLeft: 'auto', gap: 8 }}>
                <span className={`badge ${STATE_BADGE[e.state] ?? 'b-mute'}`}>{e.state.replace('_', ' ')}</span>
                {onRetry && (e.state === 'failed' || e.state === 'needs_review') && <button type="button" className="btn btn-primary btn-sm" onClick={() => onRetry(e.targetId)}>Retry</button>}
              </span>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end', gap: 9 }}>
          {siblings[0] && <span className="dim mono sp" style={{ marginRight: 'auto', fontSize: 11.5 }}>{siblings[0].instant ? formatDateTime(siblings[0].instant, viewZone) : ''}</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
