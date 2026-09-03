// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BeforeYouSchedule } from './BeforeYouSchedule';
import { ScheduleActions } from './ScheduleActions';
import { PreviewList } from './PreviewList';
import type { Finding, TargetPreview } from '../../../api/types';

afterEach(cleanup);
const noop = () => {};

describe('findings render verbatim', () => {
  it('shows the exact API message for each finding — no rewording', () => {
    const findings: Finding[] = [
      { targetId: 't1', provider: 'bluesky', code: 'text_too_long', severity: 'blocker', message: 'Bluesky caption is 320, 300 max. Trim 20 characters.' },
      { targetId: 't2', provider: 'linkedin', code: 'aspect_ratio', severity: 'warning', message: 'LinkedIn may crop this — it isn’t one of the sizes LinkedIn shows uncropped.' },
      { targetId: 't3', provider: 'line', code: 'surface_not_public', severity: 'info', message: 'LINE posts this to your channel, not a public feed.' },
    ];
    render(<BeforeYouSchedule findings={findings} />);
    for (const f of findings) expect(screen.getByText(f.message)).toBeTruthy();
  });
});

describe('scheduling gate', () => {
  it('a blocker disables scheduling; a warning does not', () => {
    const { rerender } = render(<ScheduleActions role="owner" canSchedule={false} onSchedule={noop} onSubmit={noop} />);
    expect((screen.getByRole('button', { name: /schedule post/i }) as HTMLButtonElement).disabled).toBe(true);
    // canSchedule=true models "only warnings, no blockers" — the API sets canSchedule off ONLY for blockers.
    rerender(<ScheduleActions role="owner" canSchedule onSchedule={noop} onSubmit={noop} />);
    expect((screen.getByRole('button', { name: /schedule post/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an Editor never sees the direct schedule action', () => {
    render(<ScheduleActions role="editor" canSchedule onSchedule={noop} onSubmit={noop} />);
    expect(screen.queryByRole('button', { name: /schedule post/i })).toBeNull();
    expect(screen.getByRole('button', { name: /send for approval/i })).toBeTruthy();
  });
});

describe('audience-local previews', () => {
  it('resolves to a different instant per market', () => {
    // 09:30 audience-local => 04:00Z in Kolkata (+5:30) and 02:30Z in Ho Chi Minh (+7).
    const previews: TargetPreview[] = [
      { targetId: 'a', provider: 'x', displayName: 'India', handle: '@in', publicationSurface: 'public_feed', timezone: 'Asia/Kolkata', resolvedAt: '2026-09-01T04:00:00.000Z', hasOverride: false, text: 'hi', link: null, firstComment: null, media: [] },
      { targetId: 'b', provider: 'zalo', displayName: 'Vietnam', handle: '@vn', publicationSurface: 'public_feed', timezone: 'Asia/Ho_Chi_Minh', resolvedAt: '2026-09-01T02:30:00.000Z', hasOverride: false, text: 'hi', link: null, firstComment: null, media: [] },
    ];
    render(<PreviewList previews={previews} threadPreviews={[]} />);
    const kolkata = screen.getByText(/KOLKATA/).textContent ?? '';
    const hcm = screen.getByText(/HO CHI MINH/).textContent ?? '';
    expect(kolkata).toContain('09:30'); // each shows its own market's local wall-clock
    expect(hcm).toContain('09:30');
    expect(kolkata).not.toBe(hcm);      // ...but they are different resolved instants/zones
  });

  it('labels a non-public surface so a channel post is not mistaken for a public feed', () => {
    const previews: TargetPreview[] = [
      { targetId: 'c', provider: 'line', displayName: 'LINE', handle: '@line', publicationSurface: 'channel', timezone: 'Asia/Tokyo', resolvedAt: null, hasOverride: false, text: 'hi', link: null, firstComment: null, media: [] },
    ];
    render(<PreviewList previews={previews} threadPreviews={[]} />);
    expect(screen.getByText(/not a public feed/i)).toBeTruthy();
  });
});
