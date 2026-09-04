// src/api/types.ts — shapes returned by the console API (aligned with the backend services).
export type Role = 'owner' | 'approver' | 'editor' | 'analyst';

export interface User {
  id: string;
  email: string;
  name: string | null;
  email_verified_at: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  default_timezone: string; // the workspace's IANA zone — the ONLY zone times render in
  role: Role;
}

export interface WorkspaceSummary {
  queue: number;
  approvals: number;
  networks: number;
  drafts: number;
  failed: number;
  needsReconnect: number;
}

export interface Account {
  id: string;
  provider: string;
  handle: string | null;
  display_name: string | null;
  status: string; // 'active' | 'auth_expired' | ...
  timezone: string;
}

// --- composer ---
export type ScheduleType = 'fixed_instant' | 'audience_local' | 'queued';

export interface PostContent { text: string; link: string | null; firstComment: string | null; media: string[] }

export interface PostTarget {
  target_id: string;
  connected_account_id: string;
  provider: string;
  handle: string | null;
  display_name: string | null;
  account_status: string;
  text_override: string | null;
  link_override: string | null;
  first_comment_override: string | null;
  media_override: string[] | null;
}

export interface PostSchedule {
  type: ScheduleType | null;
  scheduledAt: string | null;
  localTime: string | null;
  localDate: string | null;
}

export interface PostDetail {
  id: string;
  status: string;
  authorId: string | null;
  content: PostContent;
  schedule: PostSchedule;
  targets: PostTarget[];
}

export type Severity = 'blocker' | 'warning' | 'info';
export interface Finding { targetId: string | null; provider: string | null; code: string; severity: Severity; message: string; suggestion?: string }
export interface CharCount { targetId: string; provider: string; unit: string; count: number; limit: number; remaining: number }
export interface ThreadPreview { targetId: string; provider: string; parts: string[] }
export type PublicationSurface = 'public_feed' | 'follower_broadcast' | 'channel' | 'private';
export interface TargetPreview {
  targetId: string;
  provider: string;
  displayName: string;
  handle: string | null;
  publicationSurface: PublicationSurface;
  timezone: string;
  resolvedAt: string | null;
  hasOverride: boolean;
  text: string;
  link: string | null;
  firstComment: string | null;
  media: { kind: string; altText: string | null }[];
}
export interface ValidationResponse {
  findings: Finding[];
  counts: CharCount[];
  threadPreviews: ThreadPreview[];
  previews: TargetPreview[];
  canSchedule: boolean;
}

export interface OverridePatch { text?: string | null; link?: string | null; firstComment?: string | null; media?: string[] | null }
export interface SchedulePatch { type: ScheduleType; scheduledAt?: string | null; localDate?: string | null; localTime?: string | null; queueMarketTimezone?: string | null; fixedTimezone?: string | null }

// --- calendar / queue board ---
export interface BoardEvent {
  targetId: string;
  postId: string;
  provider: string;
  handle: string | null;
  displayName: string | null;
  timezone: string;      // the target's market zone
  state: string;         // per-target state — NEVER a rolled-up post status
  scheduleType: string | null;
  instant: string | null;    // when it publishes/published, in the target's own market
  scheduledAt: string | null;
  publishedAt: string | null;
  failureCode: string | null;
  reason: string | null;     // the provider's own failure reason
  text: string;
  authorId: string | null;
}
export interface Slot { id: string; market_timezone: string; label: string | null; day_of_week: number; local_time: string }

// One request, one server-side transaction: every target that could legally move is moved together;
// a target refused for a real reason (expired account, no longer scheduled, time now in the past) is
// reported here, not silently dropped or folded into a single boolean.
export interface RescheduleResult { targetId: string; ok: boolean; instant?: string; code?: string; reason?: string }
export interface QueueHealth {
  runwayDays: number;
  slotsPerWeek: number;
  filledThisWeek: number;
  emptyThisWeek: number;
  markets: { market: string; slots: number; queued: number; thin: boolean }[];
}

// --- analytics ---
// A figure that's unavailable (the network doesn't report it, or there's no data yet) is `null` — the
// frontend must render that as "—", never as 0, and must never compute `value` itself from other
// numbers. `changePct` is the server's period-over-period RELATIVE change, already computed.
export interface HeadlineFigure { value: number | null; previous: number | null; changePct: number | null }
export interface Headline {
  impressions: HeadlineFigure;
  engagements: HeadlineFigure;
  engagementRate: HeadlineFigure; // = engagements ÷ impressions, computed server-side — never recomputed here
  linkClicks: HeadlineFigure;
}
export interface DailyPoint { provider: string; day: string; engagements: number | null; impressions: number | null }
export interface NetworkPostCount { provider: string; posts: number; metricsSupported: boolean }
export interface TopPost { postId: string; text: string; providers: string[]; engagements: number | null; impressions: number | null; engagementRate: number | null }
export interface HeatCell { dow: number; hour: number; avgEngagements: number | null; posts: number }
export interface AnalyticsDashboard {
  range: { from: string; to: string };
  timezone: string; // the zone the server resolved the range + heatmap in — echoed back, never assumed
  headline: Headline;
  dailySeriesByNetwork: DailyPoint[];
  postsPerNetwork: NetworkPostCount[];
  topPosts: TopPost[];
  engagementHeatmap: HeatCell[];
}

export interface MetricFieldMapping { field: string; status: 'supported' | 'unavailable'; note?: string }
export interface ProviderGlossaryEntry { provider: string; displayName: string; supportsMetrics: boolean; fields: MetricFieldMapping[]; summary: string }

export interface ExportJob { id: string; status: string; rowCount?: number | null; downloadUrl?: string | null; error?: string | null }

// --- approvals inbox (Phase 5) ---
// One pending post awaiting review, carrying the four awkward cases as first-class server-computed
// fields so the UI never has to re-derive a rule: editedSinceSubmit (Phase 8 voids the approval),
// schedulePassed (the slot lapsed while it waited), requiredApprovals + approvals[] (the two-approver
// promotion split), and isMember flags on approver/requester (someone left mid-request).
export interface ApprovalApprover { approverId: string | null; name: string | null; email: string | null; isMember: boolean }
export interface ApprovalItem {
  postId: string;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
  editedSinceSubmit: boolean;
  isPaidPromotion: boolean;
  requiredApprovals: number;
  approvals: ApprovalApprover[];
  requesterId: string | null;
  requesterName: string | null;
  requesterIsMember: boolean;
  scheduleType: string | null;
  scheduledAt: string | null;
  schedulePassed: boolean;
}

export interface Comment { id: string; author_id: string | null; author_name: string | null; author_email: string | null; body: string; mentions: string[]; created_at: string; edited_at: string | null }

// --- networks (Phase 6) ---
export interface CapabilityNote { surface: string; charLimit: number; firstComment: boolean; threads: string }
export interface AccountHealth {
  id: string;
  provider: string;
  displayName: string | null;
  handle: string | null;
  status: string; // active | auth_expired | needs_review | revoked | suspended
  timezone: string;
  lastPublishedAt: string | null;
  queuedCount: number;
  capabilities: CapabilityNote | null;
}
export interface CatalogEntry { provider: string; displayName: string; capabilities: CapabilityNote }
export interface ComingSoonEntry { name: string; blockedOn: string }
export interface ProviderCatalog { available: CatalogEntry[]; comingSoon: ComingSoonEntry[] }
// The connect handshake: an OAuth network sends you to a URL; a credential network asks for fields.
export type BeginConnect =
  | { kind: 'oauth_redirect'; url: string }
  | { kind: 'credentials'; provider: string; fields: { key: string; label: string; secret: boolean }[] };

// --- team + settings (Phase 5) ---
export interface Member { userId: string; name: string | null; email: string; role: Role; joinedAt: string; lastActiveAt: string | null }
export interface Invitation { id: string; email: string; role: Role; invitedBy: string | null; createdAt: string; expiresAt: string }
export interface WorkspaceDetail { id: string; name: string; slug: string; defaultTimezone: string; planTier: string; settings: WorkspaceSettings }
// Free-form workspace preferences (jsonb server-side). All optional; absent means "coded default".
// slackWebhookUrl gates the Slack notification channel — without it a user can't switch on delivery to
// nowhere (there's no webhook-management UI yet, so it stays unset — see the Notifications tab note).
export interface WorkspaceSettings { weekStartsOn?: number; defaultScheduleBasis?: 'audience' | 'workspace' | 'utc'; requireApprovalForEditors?: boolean; autoQueueFill?: boolean; slackWebhookUrl?: string }

export interface Session { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string; current: boolean }

// --- notifications (Phase 5) ---
export interface Notification { id: string; event_type: string; title: string; body: string | null; deep_link: string | null; read_at: string | null; created_at: string }
export type NotificationChannel = 'in_app' | 'email' | 'slack';
export interface NotificationPreferenceRow { event: string; channels: Record<NotificationChannel, boolean> }
