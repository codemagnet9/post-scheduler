// src/screens/app/analytics/RangePicker.tsx
// 7d / 30d / 90d segmented, plus a custom range — the actual date math (what "30 days ending today"
// means) happens in analyticsLogic.presetRange against the WORKSPACE zone's "today", never the
// browser's clock.
import { useState } from 'react';
import type { RangePreset } from './analyticsLogic';

export function RangePicker({ preset, custom, onPreset, onCustom }: {
  preset: RangePreset | 'custom';
  custom: { from: string; to: string };
  onPreset: (p: RangePreset) => void;
  onCustom: (range: { from: string; to: string }) => void;
}): JSX.Element {
  const [showCustom, setShowCustom] = useState(preset === 'custom');
  return (
    <div className="row wrapf" style={{ gap: 8 }}>
      <div className="seg">
        {(['7d', '30d', '90d'] as RangePreset[]).map((p) => (
          <button key={p} type="button" className={preset === p ? 'on' : ''} onClick={() => { setShowCustom(false); onPreset(p); }}>{p}</button>
        ))}
        <button type="button" className={preset === 'custom' ? 'on' : ''} onClick={() => setShowCustom((s) => !s)}>Custom</button>
      </div>
      {showCustom && (
        <div className="row" style={{ gap: 6 }}>
          <input className="inp" type="date" style={{ width: 'auto', padding: '7px 10px' }} value={custom.from} onChange={(e) => onCustom({ ...custom, from: e.target.value })} />
          <span className="dim">–</span>
          <input className="inp" type="date" style={{ width: 'auto', padding: '7px 10px' }} value={custom.to} onChange={(e) => onCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}
