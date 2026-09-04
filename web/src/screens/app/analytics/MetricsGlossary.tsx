// src/screens/app/analytics/MetricsGlossary.tsx
// "How metrics are counted." Per REGISTERED network, exactly which fields are supported and what each
// maps to — rendered VERBATIM from the API (src/analytics/glossary.ts), never reworded here. This is
// what turns "analytics that compare like for like" from a claim into something a user can check.
import type { ProviderGlossaryEntry } from '../../../api/types';
import { providerLabel } from './analyticsLogic';

const FIELD_LABEL: Record<string, string> = {
  impressions: 'Impressions', reach: 'Reach', engagements: 'Engagements', clicks: 'Link clicks', saves: 'Saves', shares: 'Shares',
};

export function MetricsGlossary({ data }: { data: ProviderGlossaryEntry[] }): JSX.Element {
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>No networks connected yet.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {data.map((entry) => (
        <div key={entry.provider}>
          <div className="row" style={{ gap: 9, marginBottom: 6 }}>
            <b style={{ fontSize: 13.5 }}>{providerLabel(entry.provider)}</b>
            <span className={`badge ${entry.supportsMetrics ? 'b-ok' : 'b-mute'} sp`} style={{ marginLeft: 'auto' }}>
              {entry.supportsMetrics ? 'Reports metrics' : 'No metrics'}
            </span>
          </div>
          {/* verbatim server copy — do not template or shorten */}
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{entry.summary}</p>
          <div className="row wrapf" style={{ gap: 6 }}>
            {entry.fields.map((f) => (
              <span key={f.field} className={`badge ${f.status === 'supported' ? 'b-info' : 'b-mute'}`} title={f.note}>
                {FIELD_LABEL[f.field] ?? f.field}
                {f.status === 'unavailable' ? ' — unavailable' : f.note ? ` = ${f.note}` : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
