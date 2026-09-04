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
import * as catalog from '../accounts/catalog';
import * as posts from '../posts/service';
import * as media from '../media/service';
import * as approvals from '../approvals/service';
import * as comments from '../comments/service';
import * as prefs from '../notifications/preferences';
import * as inbox from '../notifications/inbox';
import * as analytics from '../analytics/service';
import * as apikeys from './keys';
import * as summary from '../summary/service';
import * as board from '../scheduling/board';
import * as queue from '../scheduling/queue';
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

// The refresh token lives ONLY in an httpOnly cookie — the browser never exposes it to JS, so an XSS
// bug can steal the 15-minute access token at worst, not the long-lived session. sameSite=lax means a
// cross-site POST won't carry it (CSRF defence for /auth/refresh); the access token is a Bearer header,
// immune to CSRF by construction.
const REFRESH_COOKIE = 'mrdn_rt';
const refreshCookieOpts = {
  httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production',
  path: '/', maxAge: 30 * 24 * 3600,
};
function setRefreshCookie(reply: import('fastify').FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, refreshCookieOpts);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- unauthenticated auth endpoints (rate-limited inside the service) ---
  app.post('/auth/signup', (req, reply) => auth.signUp(body(req), meta(req)).then((r) => reply.send(r)));
  // login/refresh: set the refresh cookie, return ONLY the access token in the body.
  app.post('/auth/login', async (req, reply) => {
    const pair = await auth.login(body(req), meta(req));
    setRefreshCookie(reply, pair.refreshToken);
    return reply.send({ accessToken: pair.accessToken });
  });
  app.post('/auth/refresh', async (req, reply) => {
    const fromCookie = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    const token = fromCookie ?? body<{ refreshToken?: string }>(req)?.refreshToken;
    if (!token) throw req.server.httpErrors.unauthorized();
    const pair = await auth.refresh(token, meta(req));
    setRefreshCookie(reply, pair.refreshToken); // rotation: the new token replaces the old cookie
    return reply.send({ accessToken: pair.accessToken });
  });
  app.post('/auth/verify-email', (req) => auth.verifyEmail(body<{ token: string }>(req).token));
  app.post('/auth/password/reset-request', (req) => auth.requestPasswordReset(body<{ email: string }>(req).email, meta(req)));
  app.post('/auth/password/reset', (req) => auth.resetPassword(body<{ token: string }>(req).token, body<{ password: string }>(req).password));

  // --- authenticated, non-tenant ---
  app.post('/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await auth.logout(req.user!.sessionId);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
  app.post('/auth/logout-all', { preHandler: requireUser }, async (req, reply) => {
    await auth.logoutEverywhere(req.user!.userId);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
  // Security tab: the caller's own active sessions, and revoke-one. Not tenant-scoped (a session
  // belongs to a user, not a workspace); the service scopes every query to req.user.userId.
  app.get('/auth/sessions', { preHandler: requireUser }, (req) => auth.listSessions(req.user!.userId, req.user!.sessionId));
  app.delete('/auth/sessions/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await auth.revokeSession(req.user!.userId, id);
    // Revoking your CURRENT session is a logout — clear the cookie so the browser doesn't keep replaying it.
    if (id === req.user!.sessionId) reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
  // The current user, for the shell's user menu (login only returns a token).
  app.get('/me', { preHandler: requireUser }, (req) =>
    withUser(req.user!.userId, (tx) => tx.execute(sql`select id, email, name, email_verified_at from users where id = ${req.user!.userId}`)).then((r) => (r as unknown as unknown[])[0]));
  app.get('/workspaces', { preHandler: requireUser }, (req) => workspaces.listMyWorkspaces(req.user!.userId));
  app.post('/workspaces', { preHandler: requireUser }, (req) => workspaces.createWorkspace(req.user!.userId, body<{ name: string; timezone?: string }>(req).name, { ...meta(req), timezone: body<{ timezone?: string }>(req).timezone }));
  app.post('/invitations/accept', { preHandler: requireUser }, (req) => workspaces.acceptInvite(req.user!.userId, body<{ token: string }>(req).token));

  // OAuth callback — authenticated but NOT tenant-scoped: the provider redirects here with just
  // ?state&code, and the workspace is recovered from the (single-use) state.
  app.get('/connections/callback', { preHandler: requireUser }, (req) =>
    connect.handleOAuthCallback(req.user!.userId, req.query as { state?: string; code?: string; error?: string }));

  // --- tenant-scoped: every route here passes through requireUser + resolveTenant ---
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);
    scoped.addHook('preHandler', resolveTenant);

    // Team screen read models + workspace settings.
    scoped.get('/workspaces/:workspaceId/members', (req) => workspaces.listMembers(req.tenant!));
    scoped.get('/workspaces/:workspaceId/invitations', (req) => workspaces.listInvitations(req.tenant!));
    scoped.get('/workspaces/:workspaceId', (req) => workspaces.getWorkspace(req.tenant!));
    scoped.patch('/workspaces/:workspaceId', (req) => workspaces.updateWorkspace(req.tenant!, body<{ name?: string; timezone?: string; settings?: Record<string, unknown> }>(req), meta(req)));
    // Danger zone: the client must echo the workspace name to confirm; the service does the delete.
    scoped.delete('/workspaces/:workspaceId', async (req) => {
      const confirm = body<{ confirmName?: string }>(req).confirmName;
      const ws = await workspaces.getWorkspace(req.tenant!);
      if (confirm !== ws.name) throw req.server.httpErrors.badRequest('confirm_name_mismatch');
      return workspaces.deleteWorkspace(req.tenant!, meta(req));
    });
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
    // Networks screen: per-account health (status, last publish, queued dependents, capability notes)
    // and the catalog of connectable + coming-soon networks.
    scoped.get('/workspaces/:workspaceId/accounts/health', (req) => catalog.accountHealth(req.tenant!));
    scoped.get('/workspaces/:workspaceId/provider-catalog', () => catalog.providerCatalog());

    // The shell's live counts, in ONE request (rail badges: queue / approvals / networks).
    scoped.get('/workspaces/:workspaceId/summary', (req) => summary.getSummary(req.tenant!));

    // Calendar + Queue board (per-target; never rolled up).
    scoped.get('/workspaces/:workspaceId/calendar', (req) => board.listCalendar(req.tenant!, req.query as { from: string; to: string }));
    scoped.get('/workspaces/:workspaceId/queue', (req) => board.listQueue(req.tenant!, req.query as { group?: string; provider?: string; authorId?: string; cursor?: string; limit?: number }));
    scoped.get('/workspaces/:workspaceId/queue-health', (req) => board.queueHealth(req.tenant!));
    scoped.post('/workspaces/:workspaceId/targets/cancel', (req) => board.cancelTargets(req.tenant!, body<{ targetIds: string[] }>(req).targetIds));
    // Bulk reschedule: ONE request, ONE transaction. Returns a per-target result — never a single
    // boolean — so the UI can show exactly which targets moved and which were refused, and why.
    scoped.post('/workspaces/:workspaceId/targets/reschedule', (req) => board.rescheduleTargets(req.tenant!, body<{ targetIds: string[]; localDate: string; localTime: string; zone: string }>(req).targetIds, body<{ localDate: string; localTime: string; zone: string }>(req)));
    scoped.post('/workspaces/:workspaceId/targets/:targetId/reschedule', (req) => board.rescheduleTarget(req.tenant!, (req.params as { targetId: string }).targetId, body<{ localDate: string; localTime: string; zone: string }>(req)));
    scoped.post('/workspaces/:workspaceId/targets/:targetId/retry', (req) => board.retryTarget(req.tenant!, (req.params as { targetId: string }).targetId));

    // Queue slots (per market): list / add / move / remove — remove & move reflow the market.
    scoped.get('/workspaces/:workspaceId/slots', (req) => board.listSlots(req.tenant!));
    scoped.post('/workspaces/:workspaceId/slots', (req) => queue.addSlot(req.tenant!, body<{ market: string; dayOfWeek: number; localTime: string; label?: string }>(req).market, body<{ dayOfWeek: number }>(req).dayOfWeek, body<{ localTime: string }>(req).localTime, body<{ label?: string }>(req).label));
    scoped.patch('/workspaces/:workspaceId/slots/:slotId', (req) => queue.moveSlot(req.tenant!, (req.params as { slotId: string }).slotId, body<{ dayOfWeek: number }>(req).dayOfWeek, body<{ localTime: string }>(req).localTime));
    scoped.delete('/workspaces/:workspaceId/slots/:slotId', (req) => queue.removeSlot(req.tenant!, (req.params as { slotId: string }).slotId));

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
    scoped.get('/workspaces/:workspaceId/approvals', (req) => approvals.listApprovals(req.tenant!));
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

    // Analytics: the dashboard read models, plus CSV export as a background job (poll status for the
    // link). The console ALWAYS sends ?tz=<workspace zone> so the range and the heatmap resolve in
    // the same zone the page is labelled "Showing" in — never the browser's, never a silent UTC.
    const analyticsQuery = (req: FastifyRequest) => req.query as { from?: string; to?: string; tz?: string };
    const range = (req: FastifyRequest) => analytics.parseRange(analyticsQuery(req));
    scoped.get('/workspaces/:workspaceId/analytics', (req) => analytics.dashboard(req.tenant!, range(req), analyticsQuery(req).tz || 'UTC'));
    scoped.post('/workspaces/:workspaceId/analytics/exports', (req) => analytics.requestExport(req.tenant!, range(req)));
    scoped.get('/workspaces/:workspaceId/analytics/exports/:id', (req) => analytics.exportStatus(req.tenant!, (req.params as { id: string }).id));
    scoped.post('/workspaces/:workspaceId/analytics/backfill', (req) => analytics.backfill(req.tenant!));
    scoped.get('/workspaces/:workspaceId/analytics/glossary', (req) => analytics.glossary(req.tenant!));

    // Developer console: API keys (create returns the plaintext ONCE). Owner-only, enforced in the service.
    scoped.get('/workspaces/:workspaceId/api-keys', (req) => apikeys.listApiKeys(req.tenant!));
    scoped.post('/workspaces/:workspaceId/api-keys', (req) => apikeys.createApiKey(req.tenant!, body<{ name: string; scopes: apikeys.Scope[]; rateLimitPerMin?: number }>(req)));
    scoped.delete('/workspaces/:workspaceId/api-keys/:keyId', (req) => apikeys.revokeApiKey(req.tenant!, (req.params as { keyId: string }).keyId));
  });
}
