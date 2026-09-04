// src/screens/app/analytics/Headline.tsx
// The four headline figures (.stat, ported verbatim — the 54px numeral size lives in the CSS and is
// never overridden here). Every value and every period-over-period change comes straight from the
// API; unavailable is "—", never 0. The engagement-rate definition is stated ONCE, directly under its
// own figure, in the same words the server used to compute it.
import type { Headline as HeadlineData } from '../../../api/types';
import { formatCompact, formatPercent, formatChange } from './analyticsLogic';

const FIGURES: { key: keyof HeadlineData; label: string; percent?: boolean }[] = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'engagements', label: 'Engagements' },
  { key: 'engagementRate', label: 'Engagement rate', percent: true },
  { key: 'linkClicks', label: 'Link clicks' },
];

export function Headline({ data }: { data: HeadlineData }): JSX.Element {
  return (
    <div className="grid g4">
      {FIGURES.map(({ key, label, percent }) => {
        const figure = data[key];
        const change = formatChange(figure.changePct);
        return (
          <div className="stat" key={key}>
            <div className="l">{label}</div>
            <div className="v">{percent ? formatPercent(figure.value) : formatCompact(figure.value)}</div>
            <div className={`d${change.direction ? ` ${change.direction}` : ''}`}>
              {change.direction === 'up' ? '▲ ' : change.direction === 'down' ? '▼ ' : ''}{change.text}
            </div>
            {key === 'engagementRate' && (
              <p className="dim" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.4 }}>
                Engagements ÷ impressions — the same definition used everywhere on this page, in top posts, and in the export.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
