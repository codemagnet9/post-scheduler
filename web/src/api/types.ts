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
export interface QueueHealth {
  runwayDays: number;
  slotsPerWeek: number;
  filledThisWeek: number;
  emptyThisWeek: number;
  markets: { market: string; slots: number; queued: number; thin: boolean }[];
}
