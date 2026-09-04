// src/screens/app/analytics/LineChart.tsx
// Multi-series daily chart, ported from the prototype's lineChart(). Colours come ONLY from the c1-c4
// tokens (analyticsLogic.colorFor); a network with no data for the selected metric draws NO line — a
// gap, never a zero — and reads as "no data" in the legend instead of vanishing silently. Hovering
// shows a crosshair + tooltip with each network's value that day; a network absent that day is simply
// left out of the tooltip, never shown as 0.
import { useMemo, useRef, useState, type MouseEventHandler } from 'react';
import type { SeriesLine, LegendEntry } from './analyticsLogic';
import { formatYMD, formatCompact, providerLabel } from './analyticsLogic';

const W = 760;
const H = 250;
const PAD = { t: 16, r: 88, b: 26, l: 44 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

interface Hover { idx: number; leftPx: number; topPx: number }

export function LineChart({ lines, legend, days, metricLabel }: { lines: SeriesLine[]; legend: LegendEntry[]; days: string[]; metricLabel: string }): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const max = useMemo(() => {
    const all = lines.flatMap((l) => l.points.map((p) => p.value));
    return all.length ? Math.max(1, ...all) : 1;
  }, [lines]);

  const X = (i: number): number => PAD.l + (days.length > 1 ? (i / (days.length - 1)) * IW : IW / 2);
  const Y = (v: number): number => PAD.t + IH - (v / max) * IH;

  const dayIndex = useMemo(() => new Map(days.map((d, i) => [d, i])), [days]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xTickIdx = days.length <= 1 ? [0] : [...new Set([0, Math.floor((days.length - 1) / 3), Math.floor(((days.length - 1) * 2) / 3), days.length - 1])];

  const onMove: MouseEventHandler<SVGRectElement> = (e) => {
    const svg = svgRef.current;
    if (!svg || days.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    const px = (e.clientX - rect.left) / scale;
    let i = Math.round(((px - PAD.l) / IW) * (days.length - 1));
    i = Math.max(0, Math.min(days.length - 1, i));
    setHover({ idx: i, leftPx: X(i) * scale, topPx: PAD.t * scale + 8 });
  };

  if (lines.length === 0) {
    return <p className="dim" style={{ fontSize: 13, padding: '24px 0' }}>No {metricLabel} data yet for this range.</p>;
  }

  return (
    <div className="chart-wrap">
      <div className="legend">
        {legend.map((e) => (
          <span className="lg" key={e.provider} style={{ opacity: e.hasData ? 1 : 0.55 }}>
            <span className="sw" style={{ background: e.color }} />
            {providerLabel(e.provider)}
            {!e.hasData && (
              <span className="dim" style={{ fontSize: 11 }}>
                {' '}— {e.reason === 'not_supported' ? 'metrics not available on this network' : 'no data this period'}
              </span>
            )}
          </span>
        ))}
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }} role="img" aria-label={`Daily ${metricLabel} by network`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={PAD.l + IW} y1={Y(t)} y2={Y(t)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={PAD.l - 9} y={Y(t) + 3.5} textAnchor="end" fontFamily="JetBrains Mono" fontSize={9.5} fill="var(--ink-dim)">{formatCompact(t)}</text>
          </g>
        ))}
        {xTickIdx.map((i) => (
          <text key={i} x={X(i)} y={H - 7} textAnchor="middle" fontFamily="JetBrains Mono" fontSize={9.5} fill="var(--ink-dim)">{formatYMD(days[i])}</text>
        ))}
        {hover && <line x1={X(hover.idx)} x2={X(hover.idx)} y1={PAD.t} y2={PAD.t + IH} stroke="var(--ink-dim)" strokeWidth={1} strokeDasharray="3 3" />}

        {lines.map((line) => {
          const pts = line.points.map((p) => ({ i: dayIndex.get(p.day) ?? 0, v: p.value })).sort((a, b) => a.i - b.i);
          const d = pts.map((p, idx) => `${idx ? 'L' : 'M'}${X(p.i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
          const last = pts[pts.length - 1];
          const hoverPoint = hover ? pts.find((p) => p.i === hover.idx) : undefined;
          return (
            <g key={line.provider}>
              <path d={d} fill="none" stroke={line.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {last && (
                <>
                  <circle cx={X(last.i)} cy={Y(last.v)} r={3.5} fill={line.color} stroke="var(--surface)" strokeWidth={2} />
                  <text x={X(last.i) + 9} y={Y(last.v) + 3.5} fontFamily="JetBrains Mono" fontSize={9.5} fontWeight={600} fill="var(--ink-2)">{providerLabel(line.provider)}</text>
                </>
              )}
              {hoverPoint && <circle cx={X(hoverPoint.i)} cy={Y(hoverPoint.v)} r={4} fill={line.color} stroke="var(--surface)" strokeWidth={2} />}
            </g>
          );
        })}
        <rect x={PAD.l} y={PAD.t} width={IW} height={IH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>

      {hover && (
        <div className="tip" style={{ opacity: 1, left: hover.leftPx, top: hover.topPx }}>
          <div className="th">{formatYMD(days[hover.idx]).toUpperCase()}</div>
          {lines.map((line) => {
            const p = line.points.find((pp) => pp.day === days[hover.idx]);
            if (!p) return null; // this network has no value that day — omit the row, never show 0
            return (
              <div className="tr" key={line.provider}>
                <span className="sw" style={{ background: line.color }} />
                {providerLabel(line.provider)}
                <span className="v">{formatCompact(p.value)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
