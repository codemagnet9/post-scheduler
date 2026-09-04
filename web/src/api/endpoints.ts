// src/api/endpoints.ts — thin typed wrappers over the console API paths.
import { get, post, put, patch, del, setAccessToken } from './client';
import type {
  Account, User, Workspace, WorkspaceSummary, Role,
  PostContent, PostDetail, ValidationResponse, OverridePatch, SchedulePatch,
  BoardEvent, Slot, QueueHealth, RescheduleResult,
  AnalyticsDashboard, ProviderGlossaryEntry, ExportJob,
  ApprovalItem, Comment, Member, Invitation, WorkspaceDetail, WorkspaceSettings,
  Session, Notification, NotificationPreferenceRow, NotificationChannel,
  AccountHealth, ProviderCatalog, BeginConnect,
} from './types';

// --- auth ---
export async function login(email: string, password: string): Promise<void> {
  const r = await post<{ accessToken: string }>('/auth/login', { email, password }, false);
  setAccessToken(r.accessToken);
}
export const signup = (input: { email: string; password: string; name?: string }): Promise<{ userId: string }> =>
  post('/auth/signup', input, false);
export const requestPasswordReset = (email: string): Promise<{ ok: true }> =>
  post('/auth/password/reset-request', { email }, false);
export const resetPassword = (token: string, password: string): Promise<void> =>
  post('/auth/password/reset', { token, password }, false);
export const verifyEmail = (token: string): Promise<void> =>
  post('/auth/verify-email', { token }, false);
export const logout = (): Promise<{ ok: true }> => post('/auth/logout', {});
export const me = (): Promise<User> => get<User>('/me');

// --- workspaces ---
export const listWorkspaces = (): Promise<Workspace[]> => get<Workspace[]>('/workspaces');
export const createWorkspace = (name: string, timezone?: string): Promise<{ workspaceId: string; slug: string }> =>
  post('/workspaces', { name, timezone });

// --- shell data ---
export const getSummary = (workspaceId: string): Promise<WorkspaceSummary> =>
  get<WorkspaceSummary>(`/workspaces/${workspaceId}/summary`);
export const listAccounts = (workspaceId: string): Promise<Account[]> =>
  get<Account[]>(`/workspaces/${workspaceId}/accounts`);

// --- composer ---
const base = (ws: string, postId: string) => `/workspaces/${ws}/posts/${postId}`;

export const createDraft = (ws: string, body: { content?: Partial<PostContent>; targetAccountIds: string[] }): Promise<{ postId: string }> =>
  post(`/workspaces/${ws}/posts`, body);
export const getPost = (ws: string, postId: string): Promise<PostDetail> => get<PostDetail>(base(ws, postId));
export const updatePost = (ws: string, postId: string, body: Partial<PostContent>): Promise<{ ok: true }> => patch(base(ws, postId), body);
export const addTarget = (ws: string, postId: string, accountId: string): Promise<{ targetId: string | null }> => post(`${base(ws, postId)}/targets`, { accountId });
export const removeTarget = (ws: string, postId: string, targetId: string): Promise<{ ok: true }> => del(`${base(ws, postId)}/targets/${targetId}`);
export const setOverride = (ws: string, postId: string, targetId: string, body: OverridePatch): Promise<{ ok: true }> => put(`${base(ws, postId)}/targets/${targetId}/override`, body);
export const setSchedule = (ws: string, postId: string, body: SchedulePatch): Promise<{ ok: true }> => put(`${base(ws, postId)}/schedule`, body);
export const validatePost = (ws: string, postId: string): Promise<ValidationResponse> => get<ValidationResponse>(`${base(ws, postId)}/validate`);
export const schedulePost = (ws: string, postId: string): Promise<{ scheduled: number }> => post(`${base(ws, postId)}/schedule`);
export const submitForApproval = (ws: string, postId: string): Promise<{ status: string }> => post(`${base(ws, postId)}/submit`);

// --- calendar / queue board ---
export const listCalendar = (ws: string, from: string, to: string): Promise<BoardEvent[]> =>
  get<BoardEvent[]>(`/workspaces/${ws}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const listQueue = (ws: string, params: { group?: string; provider?: string; authorId?: string; cursor?: string; limit?: number }): Promise<{ data: BoardEvent[]; nextCursor: string | null }> => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)); });
  return get(`/workspaces/${ws}/queue?${q.toString()}`);
};
export const queueHealth = (ws: string): Promise<QueueHealth> => get<QueueHealth>(`/workspaces/${ws}/queue-health`);
export const rescheduleTarget = (ws: string, targetId: string, body: { localDate: string; localTime: string; zone: string }): Promise<{ targetId: string; instant: string }> => post(`/workspaces/${ws}/targets/${targetId}/reschedule`, body);
// Bulk: ONE request/ONE server transaction. Returns a per-target outcome — never a single boolean —
// so a genuine partial result (some targets refused) can be shown honestly instead of assumed.
export const rescheduleTargets = (ws: string, targetIds: string[], body: { localDate: string; localTime: string; zone: string }): Promise<{ results: RescheduleResult[] }> => post(`/workspaces/${ws}/targets/reschedule`, { targetIds, ...body });
export const retryTarget = (ws: string, targetId: string): Promise<{ ok: true }> => post(`/workspaces/${ws}/targets/${targetId}/retry`);
export const cancelTargets = (ws: string, targetIds: string[]): Promise<{ canceled: number }> => post(`/workspaces/${ws}/targets/cancel`, { targetIds });
export const listSlots = (ws: string): Promise<Slot[]> => get<Slot[]>(`/workspaces/${ws}/slots`);
export const addSlot = (ws: string, body: { market: string; dayOfWeek: number; localTime: string; label?: string }): Promise<{ slotId: string }> => post(`/workspaces/${ws}/slots`, body);
export const moveSlot = (ws: string, slotId: string, body: { dayOfWeek: number; localTime: string }): Promise<void> => patch(`/workspaces/${ws}/slots/${slotId}`, body);
export const removeSlot = (ws: string, slotId: string): Promise<void> => del(`/workspaces/${ws}/slots/${slotId}`);

// --- analytics ---
// Every call sends ?tz=<workspace zone> so the range boundaries AND the heatmap buckets resolve in
// the zone the page is labelled "Showing" in — the server does the resolving, never the browser.
export const getAnalytics = (ws: string, params: { from: string; to: string; tz: string }): Promise<AnalyticsDashboard> =>
  get(`/workspaces/${ws}/analytics?${new URLSearchParams(params).toString()}`);
export const getMetricsGlossary = (ws: string): Promise<ProviderGlossaryEntry[]> =>
  get(`/workspaces/${ws}/analytics/glossary`);
export const requestAnalyticsExport = (ws: string, params: { from: string; to: string; tz: string }): Promise<ExportJob> =>
  post(`/workspaces/${ws}/analytics/exports?${new URLSearchParams(params).toString()}`);
export const getExportStatus = (ws: string, id: string): Promise<ExportJob> =>
  get(`/workspaces/${ws}/analytics/exports/${id}`);

// --- networks / connected accounts ---
export const getAccountHealth = (ws: string): Promise<AccountHealth[]> => get<AccountHealth[]>(`/workspaces/${ws}/accounts/health`);
export const getProviderCatalog = (ws: string): Promise<ProviderCatalog> => get<ProviderCatalog>(`/workspaces/${ws}/provider-catalog`);
// Start a connect: an OAuth network returns a URL to send the browser to; a credential network returns
// the fields to collect. Reconnect uses the SAME start — the callback reattaches to the existing row.
export const startConnect = (ws: string, provider: string): Promise<BeginConnect> => post(`/workspaces/${ws}/connections/${provider}/start`);
export const completeCredentialConnect = (ws: string, provider: string, fields: Record<string, string>): Promise<{ status: string; accountId: string }> =>
  post(`/workspaces/${ws}/connections/${provider}/complete`, { fields });
// Voluntary disconnect: skips queued targets loudly and returns how many — the confirmation surfaces it.
export const disconnectAccount = (ws: string, accountId: string): Promise<{ skippedTargets: number }> =>
  del(`/workspaces/${ws}/connections/${accountId}`);
// The OAuth return: the provider redirects the browser back with ?state&code (or ?error). The backend
// consumes the single-use state and either reattaches/creates the account or reports the failure; any
// error carries the request id via ApiError so the user can quote it to support.
export const finishOAuthConnect = (query: { state?: string; code?: string; error?: string }): Promise<{ status: 'connected' | 'reconnected' | 'denied'; accountId?: string }> => {
  const q = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => { if (v) q.set(k, v); });
  return get(`/connections/callback?${q.toString()}`);
};

// --- approvals inbox ---
export const listApprovals = (ws: string): Promise<ApprovalItem[]> => get<ApprovalItem[]>(`/workspaces/${ws}/approvals`);
// Approve (and, once the required count is met, schedule) or bounce back for changes. Non-optimistic:
// callers refetch the list on success rather than assuming the post moved.
export const approvePost = (ws: string, postId: string): Promise<{ status: string; approvals?: number; required?: number }> =>
  post(`${base(ws, postId)}/approve`);
export const requestChanges = (ws: string, postId: string, note: string): Promise<{ status: string }> =>
  post(`${base(ws, postId)}/request-changes`, { note });
export const listComments = (ws: string, postId: string): Promise<Comment[]> => get<Comment[]>(`${base(ws, postId)}/comments`);
export const addComment = (ws: string, postId: string, body: string, mentions: string[] = []): Promise<{ commentId: string }> =>
  post(`${base(ws, postId)}/comments`, { body, mentions });

// --- team (members + invitations, all through the server's ability layer) ---
export const listMembers = (ws: string): Promise<Member[]> => get<Member[]>(`/workspaces/${ws}/members`);
export const listInvitations = (ws: string): Promise<Invitation[]> => get<Invitation[]>(`/workspaces/${ws}/invitations`);
export const inviteMember = (ws: string, email: string, role: Role): Promise<{ invitationId: string }> =>
  post(`/workspaces/${ws}/invitations`, { email, role });
export const changeMemberRole = (ws: string, userId: string, role: Role): Promise<void> =>
  patch(`/workspaces/${ws}/members/${userId}/role`, { role });
export const removeMember = (ws: string, userId: string): Promise<void> => del(`/workspaces/${ws}/members/${userId}`);
export const transferOwnership = (ws: string, toUserId: string): Promise<void> => post(`/workspaces/${ws}/ownership/transfer`, { toUserId });
export const leaveWorkspace = (ws: string): Promise<void> => post(`/workspaces/${ws}/leave`);

// --- workspace settings + danger zone ---
export const getWorkspaceDetail = (ws: string): Promise<WorkspaceDetail> => get<WorkspaceDetail>(`/workspaces/${ws}`);
export const updateWorkspace = (ws: string, patchBody: { name?: string; timezone?: string; settings?: WorkspaceSettings }): Promise<WorkspaceDetail> =>
  patch(`/workspaces/${ws}`, patchBody);
// The client must echo the exact workspace name; the server refuses a mismatch (never a silent delete).
export const deleteWorkspace = (ws: string, confirmName: string): Promise<{ deleted: true }> =>
  del<{ deleted: true }>(`/workspaces/${ws}`, { confirmName });

// --- security: this user's own sessions ---
export const listSessions = (): Promise<Session[]> => get<Session[]>('/auth/sessions');
export const revokeSession = (id: string): Promise<{ ok: true }> => del(`/auth/sessions/${id}`);

// --- notifications ---
export const listNotifications = (ws: string): Promise<Notification[]> => get<Notification[]>(`/workspaces/${ws}/notifications`);
export const markNotificationRead = (ws: string, id: string): Promise<{ ok: true }> => put(`/workspaces/${ws}/notifications/${id}/read`, {});
export const getNotificationPreferences = (ws: string): Promise<NotificationPreferenceRow[]> => get<NotificationPreferenceRow[]>(`/workspaces/${ws}/notification-preferences`);
export const setNotificationPreference = (ws: string, event: string, channel: NotificationChannel, enabled: boolean): Promise<{ ok: true }> =>
  put(`/workspaces/${ws}/notification-preferences`, { event, channel, enabled });

// media tray
export const createUpload = (ws: string, body: { filename: string; declaredType: string; byteSize: number }): Promise<{ assetId: string; uploadUrl: string; storageKey: string }> => post(`/workspaces/${ws}/media`, body);
export const finalizeUpload = (ws: string, assetId: string): Promise<{ status: string; reason?: string }> => post(`/workspaces/${ws}/media/${assetId}/finalize`);
export const deleteMedia = (ws: string, assetId: string): Promise<{ scrubbedFrom: number }> => del(`/workspaces/${ws}/media/${assetId}`);
