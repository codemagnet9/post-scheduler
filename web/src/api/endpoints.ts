// src/api/endpoints.ts — thin typed wrappers over the console API paths.
import { get, post, put, patch, del, setAccessToken } from './client';
import type {
  Account, User, Workspace, WorkspaceSummary,
  PostContent, PostDetail, ValidationResponse, OverridePatch, SchedulePatch,
  BoardEvent, Slot, QueueHealth,
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
export const retryTarget = (ws: string, targetId: string): Promise<{ ok: true }> => post(`/workspaces/${ws}/targets/${targetId}/retry`);
export const cancelTargets = (ws: string, targetIds: string[]): Promise<{ canceled: number }> => post(`/workspaces/${ws}/targets/cancel`, { targetIds });
export const listSlots = (ws: string): Promise<Slot[]> => get<Slot[]>(`/workspaces/${ws}/slots`);
export const addSlot = (ws: string, body: { market: string; dayOfWeek: number; localTime: string; label?: string }): Promise<{ slotId: string }> => post(`/workspaces/${ws}/slots`, body);
export const moveSlot = (ws: string, slotId: string, body: { dayOfWeek: number; localTime: string }): Promise<void> => patch(`/workspaces/${ws}/slots/${slotId}`, body);
export const removeSlot = (ws: string, slotId: string): Promise<void> => del(`/workspaces/${ws}/slots/${slotId}`);

// media tray
export const createUpload = (ws: string, body: { filename: string; declaredType: string; byteSize: number }): Promise<{ assetId: string; uploadUrl: string; storageKey: string }> => post(`/workspaces/${ws}/media`, body);
export const finalizeUpload = (ws: string, assetId: string): Promise<{ status: string; reason?: string }> => post(`/workspaces/${ws}/media/${assetId}/finalize`);
export const deleteMedia = (ws: string, assetId: string): Promise<{ scrubbedFrom: number }> => del(`/workspaces/${ws}/media/${assetId}`);
