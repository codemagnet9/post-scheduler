// src/screens/app/composer/OverrideTabs.tsx
// One shared editor plus a tab per selected network. "All networks" edits the shared parent text; a
// network tab edits that target's override. A tab that carries an override is marked "edited". The
// per-network character count comes from the API (never counted here). Revert clears the override.
import type { CharCount, PostTarget } from '../../../api/types';

export type Tab = 'all' | string; // 'all' or a targetId

function isOverridden(t: PostTarget): boolean {
  return t.text_override !== null || t.link_override !== null || t.first_comment_override !== null || t.media_override !== null;
}

export function OverrideTabs({ targets, active, onActive, value, onChange, count, showRevert, onRevert, onPickMedia }: {
  targets: PostTarget[];
  active: Tab;
  onActive: (tab: Tab) => void;
  value: string;
  onChange: (value: string) => void;
  count: CharCount | null;
  showRevert: boolean;
  onRevert: () => void;
  onPickMedia: () => void;
}): JSX.Element {
  return (
    <div className="card">
      <div className="tabline" role="tablist">
        <button type="button" role="tab" aria-selected={active === 'all'} className={active === 'all' ? 'on' : ''} onClick={() => onActive('all')}>All networks</button>
        {targets.map((t) => (
          <button type="button" role="tab" key={t.target_id} aria-selected={active === t.target_id} className={active === t.target_id ? 'on' : ''} onClick={() => onActive(t.target_id)}>
            {t.handle ?? t.display_name ?? t.provider}
            {isOverridden(t) && <span className="badge b-info" style={{ padding: '1px 8px', fontSize: 10.5 }}>edited</span>}
          </button>
        ))}
      </div>
      <div className="card-b">
        <textarea
          className="editor"
          aria-label={active === 'all' ? 'Shared post text' : 'Network override text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={active === 'all' ? 'Write your post…' : 'Leave blank to use the shared text'}
        />
        <div className="row wrapf" style={{ gap: 7, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onPickMedia}>＋ Media</button>
          {showRevert && <button type="button" className="btn btn-quiet btn-sm" onClick={onRevert}>Revert to shared</button>}
          {count && (
            <span className="mono sp" style={{ marginLeft: 'auto', fontSize: 12, color: count.remaining < 0 ? 'var(--bad)' : 'var(--ink-dim)' }}>
              {count.count} / {count.limit}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
