// src/lib/accountStatus.ts
// One place that maps a connected-account status to how it reads on screen. Crucially, each status
// carries an ICON and a LABEL, not just a colour — the status is never conveyed by colour alone, so a
// colourblind user reads the same meaning everyone else does. `actionable` drives whether we offer a
// Reconnect button (auth problems are fixable by re-auth; a suspension is not).
export type AccountStatus = 'active' | 'auth_expired' | 'needs_review' | 'revoked' | 'suspended' | 'disconnected';

export interface StatusView { label: string; badge: string; icon: string; detail: string; actionable: boolean }

const MAP: Record<AccountStatus, StatusView> = {
  active:       { label: 'Active',            badge: 'b-ok',   icon: '●', detail: 'Connected and healthy. Tokens refresh automatically.', actionable: false },
  auth_expired: { label: 'Reconnect needed',  badge: 'b-warn', icon: '⟳', detail: 'The login expired. Scheduled posts stay queued and resume once you reconnect.', actionable: true },
  needs_review: { label: 'Needs review',      badge: 'b-warn', icon: '△', detail: 'The provider flagged something to check. Reconnect to re-validate.', actionable: true },
  revoked:      { label: 'Access revoked',    badge: 'b-bad',  icon: '⊘', detail: 'Access was revoked at the provider. Reconnect to restore publishing.', actionable: true },
  suspended:    { label: 'Suspended',         badge: 'b-bad',  icon: '✕', detail: 'The provider suspended this account. Reconnecting won’t help until they lift it.', actionable: false },
  disconnected: { label: 'Disconnected',      badge: 'b-mute', icon: '—', detail: 'No longer connected.', actionable: false },
};

export function statusView(status: string): StatusView {
  return MAP[(status as AccountStatus)] ?? { label: status, badge: 'b-mute', icon: '•', detail: '', actionable: false };
}
