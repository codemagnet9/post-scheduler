import { describe, it, expect } from 'vitest';
import { statusView } from './accountStatus';

// Accessibility: an account's status is never conveyed by colour alone — every status carries a
// non-colour ICON and a text LABEL, so a colourblind user reads the same meaning. This locks that in.
describe('account status views carry a non-colour indicator', () => {
  const statuses = ['active', 'auth_expired', 'needs_review', 'revoked', 'suspended', 'disconnected'];

  it('every status has an icon and a label (not colour alone)', () => {
    for (const s of statuses) {
      const v = statusView(s);
      expect(v.icon.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('offers reconnect only for auth problems, never for a suspension', () => {
    expect(statusView('auth_expired').actionable).toBe(true);
    expect(statusView('revoked').actionable).toBe(true);
    expect(statusView('needs_review').actionable).toBe(true);
    expect(statusView('suspended').actionable).toBe(false); // reconnecting won't lift a suspension
    expect(statusView('active').actionable).toBe(false);
  });

  it('an unknown status degrades gracefully rather than throwing', () => {
    const v = statusView('something_new');
    expect(v.label).toBe('something_new');
    expect(v.actionable).toBe(false);
  });
});
