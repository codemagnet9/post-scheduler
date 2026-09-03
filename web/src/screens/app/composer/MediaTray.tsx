// src/screens/app/composer/MediaTray.tsx
// Upload via the presigned flow (createUpload -> PUT bytes -> finalize). Each item shows its state:
// processing / ready / failed-with-reason. An item that isn't ready blocks scheduling — that shows up
// as a blocker in "Before you schedule", and per-network crop/format issues surface there as findings
// too, not as separate UI here.
import type { CSSProperties, RefObject } from 'react';

export interface Upload { tempId: string; filename: string; status: 'uploading' | 'ready' | 'failed'; reason?: string; assetId?: string }

const box: CSSProperties = { width: 96, minHeight: 74, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-2)', padding: 8, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 11 };

export function MediaTray({ mediaIds, uploads, inputRef, onFiles }: {
  mediaIds: string[];
  uploads: Upload[];
  inputRef: RefObject<HTMLInputElement>;
  onFiles: (files: File[]) => void;
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-h"><h3>Media</h3><span className="dim sp" style={{ fontSize: 12 }}>{mediaIds.length} attached</span></div>
      <div className="card-b">
        <div className="row wrapf" style={{ gap: 9, alignItems: 'stretch' }}>
          {mediaIds.map((id) => (
            <div key={id} style={box}>
              <span className="mono dim" style={{ wordBreak: 'break-all' }}>{id.slice(0, 8)}</span>
              <span className="badge b-ok"><span className="d" />ready</span>
            </div>
          ))}
          {uploads.filter((u) => u.status !== 'ready').map((u) => (
            <div key={u.tempId} style={box} title={u.reason}>
              <span style={{ wordBreak: 'break-all' }}>{u.filename}</span>
              {u.status === 'uploading'
                ? <span className="badge b-warn"><span className="d" />processing…</span>
                : <span className="badge b-bad"><span className="d" />{u.reason ?? 'failed'}</span>}
            </div>
          ))}
          <button type="button" className="apick" style={{ minHeight: 74, width: 96, justifyContent: 'center' }} onClick={() => inputRef.current?.click()}>＋ Add</button>
        </div>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept="image/*,video/*"
          onChange={(e) => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = ''; }}
        />
        <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>An item still processing blocks scheduling — you'll see why in “Before you schedule”. Per-network crop or format warnings appear there too.</p>
      </div>
    </div>
  );
}
