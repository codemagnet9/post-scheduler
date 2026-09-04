// src/screens/app/analytics/ExportPanel.tsx
// CSV export as a background job (src/analytics/export.ts): starting it returns immediately with a
// job id — the server-side worker builds the file. This polls status and only ever shows a download
// link once the server reports 'ready'; it never assumes success and never fabricates a link.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { requestAnalyticsExport, getExportStatus } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';

export function ExportPanel({ ws, from, to, tz }: { ws: string; from: string; to: string; tz: string }): JSX.Element {
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const statusQ = useQuery({
    queryKey: ['export', ws, jobId],
    queryFn: () => getExportStatus(ws, jobId as string),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'ready' || s === 'failed' ? false : 2000; // stop polling once the job settles
    },
  });

  const status = statusQ.data?.status;
  const inFlight = !!jobId && status !== 'ready' && status !== 'failed';

  const start = async () => {
    setStarting(true); setStartError(null);
    try {
      const job = await requestAnalyticsExport(ws, { from, to, tz });
      setJobId(job.id); // the toast below now takes over — no assumption of success yet
    } catch (e) {
      setStartError(e instanceof ApiError ? e.displayMessage : 'Could not start the export.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={start} disabled={starting || inFlight}>
        {starting ? 'Starting…' : inFlight ? 'Preparing export…' : 'Export CSV'}
      </button>

      {jobId && (
        <div className={`hint ${status === 'failed' ? 'h-bad' : status === 'ready' ? 'h-ok' : 'h-info'}`} style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 320, zIndex: 20, alignItems: 'center' }}>
          {status === 'ready' ? (
            <span>
              Your export is ready — <a href={statusQ.data?.downloadUrl ?? undefined} style={{ color: 'var(--brand)', fontWeight: 600 }}>download the CSV</a>
              {' '}({statusQ.data?.rowCount ?? 0} rows).
            </span>
          ) : status === 'failed' ? (
            <span>Export failed: {statusQ.data?.error ?? 'unknown error'}.</span>
          ) : (
            <span>Preparing your export for {from} – {to}… this can take a moment.</span>
          )}
          <button type="button" className="btn btn-quiet btn-sm sp" style={{ marginLeft: 8 }} onClick={() => setJobId(null)}>Dismiss</button>
        </div>
      )}
      {startError && <div className="hint h-bad" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 280, zIndex: 20 }}>{startError}</div>}
    </div>
  );
}
