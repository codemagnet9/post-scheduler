// src/api/routes.ts
// The HTTP layer. Its one security job is the tenant chokepoint: resolveTenant() is the SINGLE
// place a workspace id turns into a trusted role, and it is what every tenant route hangs off.
// A forgotten filter in a handler cannot leak data, because the data is already invisible (RLS).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { withUser } from '../db/tenant';
import * as auth from '../auth/service';
import * as workspaces from '../workspaces/service';
import * as connect from '../accounts/connect';
import { disconnectAccount } from '../accounts/disconnect';
import * as posts from '../posts/service';
import * as media from '../media/service';
import * as approvals from '../approvals/service';
import * as comments from '../comments/service';
import * as prefs from '../notifications/preferences';
import * as inbox from '../notifications/inbox';
import * as analytics from '../analytics/service';
import * as apikeys from './keys';
import { schedulePost } from '../scheduling/schedule';
import type { PostContent } from '../posts/content';
import type { Role } from '../authz/abilities';

const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ?? 'http://localhost:3000/connections/callback';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: string; sessionId: string };
    tenant?: { workspaceId: string; userId: string; role: Role };
  }
}

const body = <T>(req: FastifyRequest): T => req.body as T;
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

async function requireUser(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw req.server.httpErrors.unauthorized();
  try {
    req.user = await auth.authenticate(header.slice(7));
  } catch {
    throw req.server.httpErrors.unauthorized();
  }
}

// The chokepoint. Resolves the caller's membership in :workspaceId. Non-members get 404 — we never
// confirm the workspace exists to someone outside it (memberships RLS lets a user see only their own rows).
async function resolveTenant(req: FastifyRequest): Promise<void> {
  const { workspaceId } = req.params as { workspaceId: string };
  const userId = req.user!.userId;
  const rows = (await withUser(userId, (tx) =>
    tx.execute(sql`select role from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`),
  )) as unknown as Array<{ role: Role }>;
  if (!rows.length) throw req.server.httpErrors.notFound();
  req.tenant = { workspaceId, userId, role: rows[0].role };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- unauthenticated auth endpoints (rate-limited inside the service) ---
  app.post('/auth/signup', (req, reply) => auth.signUp(body(req), meta(req)).then((r) => reply.send(r)));
  app.post('/auth/login', (req, reply) => auth.login(body(req), meta(req)).then((r) => reply.send(r)));
  app.post('/auth/verify-email', (req) => auth.verifyEmail(body<{ token: string }>(req).token));
  app.post('/auth/refresh', (req) => auth.refresh(body<{ refreshToken: string }>(req).refreshToken, meta(req)));
  app.post('/auth/password/reset-request', (req) => auth.requestPasswordReset(body<{ email: string }>(req).email, meta(req)));
  app.post('/auth/password/reset', (req) => auth.resetPassword(body<{ token: string }>(req).token, body<{ password: string }>(req).password));

  // --- authenticated, non-tenant ---
  app.post('/auth/logout', { preHandler: requireUser }, (req) => auth.logout(req.user!.sessionId));
  app.post('/auth/logout-all', { preHandler: requireUser }, (req) => auth.logoutEverywhere(req.user!.userId));
  app.get('/workspaces', { preHandler: requireUser }, (req) => workspaces.listMyWorkspaces(req.user!.userId));
  app.post('/workspaces', { preHandler: requireUser }, (req) => workspaces.createWorkspace(req.user!.userId, body<{ name: string }>(req).name, meta(req)));
  app.post('/invitations/accept', { preHandler: requireUser }, (req) => workspaces.acceptInvite(req.user!.userId, body<{ token: string }>(req).token));

  // OAuth callback — authenticated but NOT tenant-scoped: the provider redirects here with just
  // ?state&code, and the workspace is recovered from the (single-use) state.
  app.get('/connections/callback', { preHandler: requireUser }, (req) =>
    connect.handleOAuthCallback(req.user!.userId, req.query as { state?: string; code?: string; error?: string }));

  // --- tenant-scoped: every route here passes through requireUser + resolveTenant ---
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);
    scoped.addHook('preHandler', resolveTenant);

    scoped.post('/workspaces/:workspaceId/invitations', (req) =>
      workspaces.inviteMember(req.tenant!, body<{ email: string; role: Role }>(req).email, body<{ email: string; role: Role }>(req).role, meta(req)));
    scoped.patch('/workspaces/:workspaceId/members/:userId/role', (req) =>
      workspaces.changeRole(req.tenant!, (req.params as { userId: string }).userId, body<{ role: Role }>(req).role, meta(req)));
    scoped.delete('/workspaces/:workspaceId/members/:userId', (req) =>
      workspaces.removeMember(req.tenant!, (req.params as { userId: string }).userId, meta(req)));
    scoped.post('/workspaces/:workspaceId/ownership/transfer', (req) =>
      workspaces.transferOwnership(req.tenant!, body<{ toUserId: string }>(req).toUserId, meta(req)));
    scoped.post('/workspaces/:workspaceId/leave', (req) => workspaces.leaveWorkspace(req.tenant!));

    // Connecting accounts is gated by the account:connect ability (Owner + Approver) inside the service.
    scoped.post('/workspaces/:workspaceId/connections/:provider/start', (req) =>
      connect.beginConnect(req.tenant!, (req.params as { provider: string }).provider, OAUTH_REDIRECT_URI));
    scoped.post('/workspaces/:workspaceId/connections/:provider/complete', (req) =>
      connect.completeCredentialConnect(req.tenant!, (req.params as { provider: string }).provider, body<{ fields: Record<string, string> }>(req).fields));
    scoped.delete('/workspaces/:workspaceId/connections/:accountId', (req) =>
      disconnectAccount(req.tenant!, (req.params as { accountId: string }).accountId));

    // Composer: account picker, posts CRUD, targets, overrides, schedule, and validation.
    const postId = (req: FastifyRequest) => (req.params as { postId: string }).postId;
    scoped.get('/workspaces/:workspaceId/accounts', (req) => posts.listAccounts(req.tenant!));
    scoped.post('/workspaces/:workspaceId/posts', (req) => posts.createDraft(req.tenant!, body<{ content?: Partial<PostContent>; targetAccountIds: string[] }>(req)));
    scoped.get('/workspaces/:workspaceId/posts/:postId', (req) => posts.getPost(req.tenant!, postId(req)));
    scoped.patch('/workspaces/:workspaceId/posts/:postId', (req) => posts.updatePost(req.tenant!, postId(req), body<Partial<PostContent>>(req)));
    scoped.delete('/workspaces/:workspaceId/posts/:postId', (req) => posts.deletePost(req.tenant!, postId(req)));
    scoped.post('/workspaces/:workspaceId/posts/:postId/duplicate', (req) => posts.duplicatePost(req.tenant!, postId(req)));
    scoped.post('/workspaces/:workspaceId/posts/:postId/targets', (req) => posts.addTarget(req.tenant!, postId(req), body<{ accountId: string }>(req).accountId));
    scoped.delete('/workspaces/:workspaceId/posts/:postId/targets/:targetId', (req) => posts.removeTarget(req.tenant!, postId(req), (req.params as { targetId: string }).targetId));
    scoped.put('/workspaces/:workspaceId/posts/:postId/targets/:targetId/override', (req) => posts.setOverride(req.tenant!, postId(req), (req.params as { targetId: string }).targetId, body<posts.OverridePatch>(req)));
    scoped.put('/workspaces/:workspaceId/posts/:postId/schedule', (req) => posts.setSchedule(req.tenant!, postId(req), body(req)));
    scoped.get('/workspaces/:workspaceId/posts/:postId/validate', (req) => posts.validatePostService(req.tenant!, postId(req)));

    // Media tray: presign a direct-to-storage upload, finalize (verify + probe), delete.
    scoped.post('/workspaces/:workspaceId/media', (req) => media.createUpload(req.tenant!, body<{ filename: string; declaredType: string; byteSize: number }>(req)));
    scoped.post('/workspaces/:workspaceId/media/:assetId/finalize', (req) => media.finalizeUpload(req.tenant!, (req.params as { assetId: string }).assetId));
    scoped.delete('/workspaces/:workspaceId/media/:assetId', (req) => media.deleteMedia(req.tenant!, (req.params as { assetId: string }).assetId));

    // Scheduling + approvals. Editors lack post:schedule, so /schedule 403s for them — the gate.
    scoped.post('/workspaces/:workspaceId/posts/:postId/schedule', (req) => schedulePost(req.tenant!, postId(req)));
    scoped.post('/workspaces/:workspaceId/posts/:postId/submit', (req) => approvals.submitForApproval(req.tenant!, postId(req)));
    scoped.post('/workspaces/:workspaceId/posts/:postId/approve', (req) => approvals.approve(req.tenant!, postId(req)));
    scoped.post('/workspaces/:workspaceId/posts/:postId/request-changes', (req) => approvals.requestChanges(req.tenant!, postId(req), body<{ note?: string }>(req).note));

    // Comments + mentions.
    scoped.post('/workspaces/:workspaceId/posts/:postId/comments', (req) => comments.addComment(req.tenant!, postId(req), body<{ body: string; mentions?: string[] }>(req).body, body<{ body: string; mentions?: string[] }>(req).mentions ?? []));
    scoped.get('/workspaces/:workspaceId/posts/:postId/comments', (req) => comments.listComments(req.tenant!, postId(req)));

    // Notifications: inbox + preferences matrix.
    scoped.get('/workspaces/:workspaceId/notifications', (req) => inbox.listNotifications(req.tenant!));
    scoped.put('/workspaces/:workspaceId/notifications/:id/read', (req) => inbox.markNotificationRead(req.tenant!, (req.params as { id: string }).id));
    scoped.get('/workspaces/:workspaceId/notification-preferences', (req) => prefs.getPreferencesMatrix(req.tenant!));
    scoped.put('/workspaces/:workspaceId/notification-preferences', (req) => prefs.setPreference(req.tenant!, body<{ event: prefs.NotificationEvent; channel: prefs.Channel; enabled: boolean }>(req).event, body<{ event: prefs.NotificationEvent; channel: prefs.Channel; enabled: boolean }>(req).channel, body<{ event: prefs.NotificationEvent; channel: prefs.Channel; enabled: boolean }>(req).enabled));

    // Analytics: the dashboard read models, plus CSV export as a background job (poll status for the link).
    const range = (req: FastifyRequest) => analytics.parseRange(req.query as { from?: string; to?: string });
    scoped.get('/workspaces/:workspaceId/analytics', (req) => analytics.dashboard(req.tenant!, range(req)));
    scoped.post('/workspaces/:workspaceId/analytics/exports', (req) => analytics.requestExport(req.tenant!, range(req)));
    scoped.get('/workspaces/:workspaceId/analytics/exports/:id', (req) => analytics.exportStatus(req.tenant!, (req.params as { id: string }).id));
    scoped.post('/workspaces/:workspaceId/analytics/backfill', (req) => analytics.backfill(req.tenant!));

    // Developer console: API keys (create returns the plaintext ONCE). Owner-only, enforced in the service.
    scoped.get('/workspaces/:workspaceId/api-keys', (req) => apikeys.listApiKeys(req.tenant!));
    scoped.post('/workspaces/:workspaceId/api-keys', (req) => apikeys.createApiKey(req.tenant!, body<{ name: string; scopes: apikeys.Scope[]; rateLimitPerMin?: number }>(req)));
    scoped.delete('/workspaces/:workspaceId/api-keys/:keyId', (req) => apikeys.revokeApiKey(req.tenant!, (req.params as { keyId: string }).keyId));
  });
}
