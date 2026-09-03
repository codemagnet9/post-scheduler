// src/screens/app/composer/PreviewList.tsx
// One preview per selected network, rendering exactly what will publish (merged content from the API,
// never merged client-side). Each shows its market and the API-RESOLVED local publish time — for
// audience-local that's the same wall-clock in different zones, i.e. different instants per market,
// the product's signature moment. A non-public surface (follower broadcast / channel) is labelled so
// a user never mistakes a LINE post for a publicly discoverable one. A returned thread split is shown
// as numbered parts so the user agrees to it before scheduling.
import type { PublicationSurface, TargetPreview, ThreadPreview } from '../../../api/types';
import { formatTime, zoneAbbrev } from '../../../lib/datetime';
import { marketLabel } from './logic';
import { Avatar } from '../../../components/Avatar';

function surfaceNote(s: PublicationSurface): string | null {
  if (s === 'follower_broadcast') return 'Sent to your followers — not a public feed';
  if (s === 'channel') return 'Posts to your channel — not a public feed';
  if (s === 'private') return 'Private — not publicly visible';
  return null;
}

function whenLabel(p: TargetPreview): string {
  const market = marketLabel(p.timezone);
  if (!p.resolvedAt) return `${market} · not scheduled yet`;
  return `${market} · ${formatTime(p.resolvedAt, p.timezone)} ${zoneAbbrev(p.timezone)}`;
}

export function PreviewList({ previews, threadPreviews }: { previews: TargetPreview[]; threadPreviews: ThreadPreview[] }): JSX.Element {
  if (!previews.length) return <p className="dim" style={{ fontSize: 13 }}>Select a network to see its preview.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {previews.map((p) => {
        const thread = threadPreviews.find((t) => t.targetId === p.targetId);
        const surface = surfaceNote(p.publicationSurface);
        return (
          <div className="prev" key={p.targetId}>
            <div className="ph">
              <Avatar name={p.handle ?? p.displayName} seed={p.targetId} size={34} />
              <span>
                <span style={{ fontWeight: 700, fontSize: 13, display: 'block', lineHeight: 1.2 }}>{p.handle ?? p.displayName}</span>
                <span className="dim mono" style={{ fontSize: 10.5 }}>{whenLabel(p)}</span>
              </span>
              {p.hasOverride && <span className="badge b-info" style={{ marginLeft: 'auto' }}>Override</span>}
            </div>

            {surface && <div className="badge b-mute" style={{ marginBottom: 9 }}>{surface}</div>}

            {thread ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {thread.parts.map((part, i) => (
                  <p key={i} className="body">
                    <span className="mono dim" style={{ marginRight: 6 }}>{i + 1}/{thread.parts.length}</span>{part}
                  </p>
                ))}
              </div>
            ) : (
              <p className="body">{p.text || <span className="dim">No caption for this network.</span>}</p>
            )}

            {p.media.length > 0 && <div className="media" style={{ height: 90, marginTop: 10 }}>{p.media.length} {p.media.length === 1 ? 'media item' : 'media items'}</div>}
            {p.firstComment && <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>First comment: {p.firstComment}</p>}
          </div>
        );
      })}
    </div>
  );
}
