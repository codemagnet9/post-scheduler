// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Headline } from './Headline';
import { LineChart } from './LineChart';
import { MetricsGlossary } from './MetricsGlossary';
import { ExportPanel } from './ExportPanel';
import { buildSeries } from './analyticsLogic';
import type { Headline as HeadlineData, DailyPoint, NetworkPostCount, ProviderGlossaryEntry } from '../../../api/types';

afterEach(cleanup);

// --- Headline: unavailable renders as "—", the definition is stated once ---
describe('Headline', () => {
  const zeroFigure = { value: 0, previous: 0, changePct: null };
  const data: HeadlineData = {
    impressions: { value: null, previous: null, changePct: null }, // never reported by any network in range
    engagements: { value: 950, previous: 800, changePct: 0.1875 },
    engagementRate: { value: null, previous: null, changePct: null }, // undefined without impressions
    linkClicks: zeroFigure,
  };

  it('renders an unavailable figure as "—", never 0', () => {
    render(<Headline data={data} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2); // impressions AND engagement rate
  });

  it('a genuine zero (link clicks) still reads as 0, distinct from unavailable', () => {
    render(<Headline data={data} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('states the engagement-rate definition once, right under the figure', () => {
    render(<Headline data={data} />);
    expect(screen.getByText(/Engagements ÷ impressions/)).toBeTruthy();
  });
});

// --- LineChart: a network with no data is omitted from the chart, not drawn at 0 ---
describe('LineChart', () => {
  const networks: NetworkPostCount[] = [
    { provider: 'bluesky', posts: 4, metricsSupported: true },
    { provider: 'x', posts: 2, metricsSupported: true },
  ];
  const points: DailyPoint[] = [
    { provider: 'bluesky', day: '2026-08-01', engagements: 20, impressions: null },
    { provider: 'bluesky', day: '2026-08-02', engagements: 30, impressions: null },
    // 'x' has no rows at all for this metric range.
  ];

  it('omits the data-less network from the drawn lines but still names it in the legend', () => {
    const { lines, legend } = buildSeries(points, networks, 'engagements');
    const { container } = render(<LineChart lines={lines} legend={legend} days={['2026-08-01', '2026-08-02']} metricLabel="engagements" />);
    // The legend explicitly names BOTH networks (Bluesky also appears as the chart's end-of-line
    // label, so scope this query to the legend itself rather than the whole document).
    const legendEl = container.querySelector('.legend') as HTMLElement;
    expect(within(legendEl).getByText('Bluesky')).toBeTruthy();
    expect(within(legendEl).getByText('X')).toBeTruthy();
    expect(within(legendEl).getByText(/no data this period/)).toBeTruthy();
    // ...but only one <path> (line) was actually drawn — 'x' gets no line at all, not one pinned at 0.
    const paths = container.querySelectorAll('svg path');
    expect(paths).toHaveLength(1);
  });
});

// --- MetricsGlossary: renders the server's own copy verbatim ---
describe('MetricsGlossary', () => {
  const data: ProviderGlossaryEntry[] = [
    { provider: 'bluesky', displayName: 'Bluesky', supportsMetrics: true, summary: 'The AT Protocol exposes no impressions, reach, clicks or saves — only engagement counts and reposts.', fields: [{ field: 'engagements', status: 'supported', note: 'likeCount + repostCount + replyCount' }, { field: 'impressions', status: 'unavailable' }] },
    { provider: 'line', displayName: 'LINE', supportsMetrics: false, summary: 'LINE exposes no publishing metrics at all — every field is unavailable, not zero.', fields: [{ field: 'impressions', status: 'unavailable' }] },
  ];

  it('renders the exact server summary text for each network, unmodified', () => {
    render(<MetricsGlossary data={data} />);
    expect(screen.getByText(data[0].summary)).toBeTruthy();
    expect(screen.getByText(data[1].summary)).toBeTruthy();
  });
});

// --- Export: enqueues immediately and shows the download link once the job is ready ---
vi.mock('../../../api/endpoints', () => ({
  requestAnalyticsExport: vi.fn(),
  getExportStatus: vi.fn(),
}));
import { requestAnalyticsExport, getExportStatus } from '../../../api/endpoints';

function withClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ExportPanel', () => {
  it('starting an export enqueues a job and shows it is preparing — never assumes success', async () => {
    vi.mocked(requestAnalyticsExport).mockResolvedValue({ id: 'exp_1', status: 'pending' });
    vi.mocked(getExportStatus).mockResolvedValue({ id: 'exp_1', status: 'processing' });

    withClient(<ExportPanel ws="ws1" from="2026-08-01" to="2026-08-30" tz="Asia/Kolkata" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(requestAnalyticsExport).toHaveBeenCalledWith('ws1', { from: '2026-08-01', to: '2026-08-30', tz: 'Asia/Kolkata' }));
    await waitFor(() => expect(screen.getByText(/preparing your export/i)).toBeTruthy());
    expect(screen.queryByText(/download the csv/i)).toBeNull(); // no link yet — nothing to download
  });

  it('shows a download link once the server reports the job ready — with the real URL and row count', async () => {
    vi.mocked(requestAnalyticsExport).mockResolvedValue({ id: 'exp_2', status: 'pending' });
    vi.mocked(getExportStatus).mockResolvedValue({ id: 'exp_2', status: 'ready', downloadUrl: 'https://storage.example/exports/exp_2.csv', rowCount: 42 });

    withClient(<ExportPanel ws="ws1" from="2026-08-01" to="2026-08-30" tz="Asia/Kolkata" />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    const link = await screen.findByRole('link', { name: /download the csv/i });
    expect(link.getAttribute('href')).toBe('https://storage.example/exports/exp_2.csv');
    expect(screen.getByText(/42 rows/)).toBeTruthy();
  });
});
