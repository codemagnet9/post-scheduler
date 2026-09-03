// src/api/public-routes.ts
// THE PUBLIC API (/v1). Held to a higher bar than the internal console: versioned path prefix, one
// error envelope, cursor pagination, idempotent writes, and per-key auth + rate limiting. A key acts
// for its workspace with service-role 'owner'; the read/write SCOPE is the real gate here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import { consumeRateLimit } from '../auth/rate-limit';
import { ApiError, envelope, httpStatusFor, type ApiErrorCode } from './errors';
import { authenticateApiKey, recordKeyUsage, type AuthenticatedKey, type Scope } from './keys';
import { withIdempotency, type StoredResponse } from './idempotency';
import { decodeCursor, clampLimit, page } from './pagination';
import { buildOpenApiSpec } from './openapi';
import * as posts from '../posts/service';
import * as media from '../media/service';
import { schedulePost } from '../scheduling/schedule';
import * as analytics from '../analytics/service';
import * as webhooks from '../webhooks/service';
import type { ScopedActor } from '../posts/service';
import { ForbiddenError } from '../authz/abilities';
import { PostError } from '../posts/service';
import { MediaError } from '../media/service';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const SYSTEM = '00000000-0000-0000-0000-000000000000';

declare module 'fastify' {
  interface FastifyRequest { apiKey?: AuthenticatedKey }
}

// One context used as BOTH ScopedActor and TenantContext. userId is the key's creator (a real user)
// or the SYSTEM sentinel when they've left — the write services null the sentinel for FK-safe author.
function apiCtx(req: FastifyRequest): ScopedActor & TenantContext {
  const k = req.apiKey!;
  return { workspaceId: k.workspaceId, userId: k.createdBy ?? SYSTEM, role: 'owner' };
}
function requireScope(req: FastifyRequest, scope: Scope): void {
  if (!req.apiKey!.scopes.includes(scope)) throw new ApiError('forbidden', `This API key lacks the '${scope}' scope.`);
}
const idemKey = (req: FastifyRequest): string | undefined => {
  const v = req.headers['idempotency-key'];
  return Array.isArray(v) ? v[0] : v;
};
const send = (reply: FastifyReply, r: StoredResponse): FastifyReply => reply.status(r.status).send(r.body);

// The fan-out shape: a post is its per-account targets, each with an independent state.
async function serializePost(ctx: TenantContext, postId: string): Promise<unknown> {
  return withTenant(ctx, async (tx) => {
    const p = rows<{ id: string; status: string; content: unknown; created_at: string }>(await tx.execute(sql`select id, status, content, created_at from posts where id = ${postId}`))[0];
    if (!p) throw new ApiError('not_found', 'No such post.');
    const targets = rows<{ id: string; connected_account_id: string; provider: string; state: string; provider_post_id: string | null; provider_permalink: string | null; last_error: unknown }>(await tx.execute(sql`
      select pt.id, pt.connected_account_id, ca.provider, pt.state, pt.provider_post_id, pt.provider_permalink, pt.last_error
      from post_targets pt join connected_accounts ca on ca.id = pt.connected_account_id
      where pt.post_id = ${postId} order by ca.provider, pt.id`));
    return {
      id: p.id, status: p.status, content: p.content, created_at: new Date(p.created_at).toISOString(),
      targets: targets.map((t) => ({ id: t.id, account_id: t.connected_account_id, provider: t.provider, state: t.state, provider_post_id: t.provider_post_id, permalink: t.provider_permalink, error: t.last_error })),
    };
  });
}

// --- error envelope for the whole /v1 scope ---
function publicErrorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const reqId = req.id;
  if (err instanceof ApiError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
    return reply.status(err.httpStatus).send(envelope(err.code, err.message, reqId));
  }
  if (err instanceof ForbiddenError) return reply.status(403).send(envelope('forbidden', err.message, reqId));
  if (err instanceof PostError) {
    const code: ApiErrorCode = err.message === 'not_found' ? 'not_found'
      : ['not_editable', 'not_schedulable', 'has_blockers', 'no_schedule'].includes(err.message) ? 'conflict' : 'validation_error';
    return reply.status(httpStatusFor(code)).send(envelope(code, err.message, reqId));
  }
  if (err instanceof MediaError) {
    const code: ApiErrorCode = err.message === 'not_found' ? 'not_found' : err.message === 'asset_in_use' ? 'conflict' : 'validation_error';
    return reply.status(httpStatusFor(code)).send(envelope(code, err.message, reqId));
  }
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 400) return reply.status(422).send(envelope('validation_error', 'Malformed request.', reqId));
  req.log.error(err);
  return reply.status(500).send(envelope('internal', 'An unexpected error occurred.', reqId));
}

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  // Public docs — no auth.
  app.get('/v1/openapi.json', (_req, reply) => reply.header('content-type', 'application/json').send(buildOpenApiSpec()));

  app.register(async (v1) => {
    v1.setErrorHandler(publicErrorHandler);
    v1.setNotFoundHandler((req, reply) => reply.status(404).send(envelope('not_found', 'No such endpoint.', req.id)));

    // Auth + per-key rate limit for every /v1 route. Sets X-RateLimit-* on the reply.
    v1.addHook('preHandler', async (req, reply) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new ApiError('unauthorized', 'Provide an API key as a Bearer token.');
      req.apiKey = await authenticateApiKey(header.slice(7)); // throws on revoked/expired/invalid — immediate
      const limit = req.apiKey.rateLimitPerMin;
      const rl = await consumeRateLimit(`apikey:${req.apiKey.keyId}`, limit, 60);
      reply.header('X-RateLimit-Limit', String(limit));
      reply.header('X-RateLimit-Remaining', String(rl.remaining));
      if (!rl.allowed) throw new ApiError('rate_limited', 'Per-key rate limit exceeded.', { 'Retry-After': String(rl.retryAfterSec) });
      void recordKeyUsage(req.apiKey.keyId); // best-effort, non-blocking
    });

    // --- accounts ---
    v1.get('/accounts', async (req, reply) => {
      requireScope(req, 'read');
      const limit = clampLimit((req.query as { limit?: string }).limit);
      const cur = decodeCursor((req.query as { cursor?: string }).cursor);
      const fetched = rows<{ id: string; provider: string; handle: string | null; display_name: string | null; status: string; created_at: string }>(await withTenant(apiCtx(req), (tx) => tx.execute(sql`
        select id, provider, handle, display_name, status, created_at from connected_accounts
        ${cur ? sql`where (created_at, id) < (${cur.createdAt}, ${cur.id})` : sql``}
        order by created_at desc, id desc limit ${limit + 1}`)));
      const { data, nextCursor } = page(fetched, limit);
      return reply.send({ data: data.map((a) => ({ id: a.id, provider: a.provider, handle: a.handle, display_name: a.display_name, status: a.status })), next_cursor: nextCursor });
    });

    // --- posts ---
    v1.get('/posts', async (req, reply) => {
      requireScope(req, 'read');
      const limit = clampLimit((req.query as { limit?: string }).limit);
      const cur = decodeCursor((req.query as { cursor?: string }).cursor);
      const fetched = rows<{ id: string; status: string; created_at: string }>(await withTenant(apiCtx(req), (tx) => tx.execute(sql`
        select id, status, created_at from posts
        ${cur ? sql`where (created_at, id) < (${cur.createdAt}, ${cur.id})` : sql``}
        order by created_at desc, id desc limit ${limit + 1}`)));
      const { data, nextCursor } = page(fetched, limit);
      return reply.send({ data: data.map((p) => ({ id: p.id, status: p.status, created_at: new Date(p.created_at).toISOString() })), next_cursor: nextCursor });
    });

    v1.post('/posts', async (req, reply) => {
      requireScope(req, 'write');
      const b = req.body as { account_ids?: string[]; content?: { text?: string; link?: string; first_comment?: string; media?: string[] } };
      if (!Array.isArray(b.account_ids) || !b.account_ids.length) throw new ApiError('validation_error', 'account_ids must be a non-empty array.');
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'POST', path: '/v1/posts', body: req.body }, async () => {
        const { postId } = await posts.createDraft(apiCtx(req), {
          content: { text: b.content?.text, link: b.content?.link, firstComment: b.content?.first_comment, media: b.content?.media },
          targetAccountIds: b.account_ids!,
        });
        return { status: 201, body: await serializePost(apiCtx(req), postId) };
      });
      return send(reply, result);
    });

    v1.get('/posts/:id', async (req, reply) => {
      requireScope(req, 'read');
      return reply.send(await serializePost(apiCtx(req), (req.params as { id: string }).id));
    });

    v1.delete('/posts/:id', async (req, reply) => {
      requireScope(req, 'write');
      const id = (req.params as { id: string }).id;
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'DELETE', path: `/v1/posts/${id}`, body: null }, async () => {
        await posts.deletePost(apiCtx(req), id);
        return { status: 200, body: { id, deleted: true } };
      });
      return send(reply, result);
    });

    v1.post('/posts/:id/schedule', async (req, reply) => {
      requireScope(req, 'write');
      const id = (req.params as { id: string }).id;
      const b = req.body as { type?: 'fixed_instant' | 'audience_local' | 'queued'; scheduled_at?: string; local_time?: string; local_date?: string; queue_market_timezone?: string };
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'POST', path: `/v1/posts/${id}/schedule`, body: req.body }, async () => {
        await posts.setSchedule(apiCtx(req), id, { type: b.type ?? 'fixed_instant', scheduledAt: b.scheduled_at ?? null, localTime: b.local_time ?? null, localDate: b.local_date ?? null, queueMarketTimezone: b.queue_market_timezone ?? null });
        await schedulePost(apiCtx(req), id);
        return { status: 200, body: await serializePost(apiCtx(req), id) };
      });
      return send(reply, result);
    });

    // --- media ---
    v1.post('/media', async (req, reply) => {
      requireScope(req, 'write');
      const b = req.body as { filename?: string; content_type?: string; byte_size?: number };
      if (!b.filename || !b.content_type || !b.byte_size) throw new ApiError('validation_error', 'filename, content_type and byte_size are required.');
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'POST', path: '/v1/media', body: req.body }, async () => {
        const r = await media.createUpload(apiCtx(req), { filename: b.filename!, declaredType: b.content_type!, byteSize: b.byte_size! });
        return { status: 201, body: { asset_id: r.assetId, upload_url: r.uploadUrl, storage_key: r.storageKey } };
      });
      return send(reply, result);
    });

    // --- analytics ---
    v1.get('/analytics', async (req, reply) => {
      requireScope(req, 'read');
      return reply.send(await analytics.dashboard(apiCtx(req), analytics.parseRange(req.query as { from?: string; to?: string })));
    });
    v1.post('/analytics/exports', async (req, reply) => {
      requireScope(req, 'write');
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'POST', path: '/v1/analytics/exports', body: req.body ?? {} }, async () => {
        const r = await analytics.requestExport(apiCtx(req), analytics.parseRange(req.query as { from?: string; to?: string }));
        return { status: 202, body: r };
      });
      return send(reply, result);
    });

    // --- webhooks ---
    v1.post('/webhooks', async (req, reply) => {
      requireScope(req, 'write');
      const b = req.body as { url?: string; events?: webhooks.WebhookEvent[] };
      const result = await withIdempotency(apiCtx(req), idemKey(req), { method: 'POST', path: '/v1/webhooks', body: req.body }, async () => {
        const r = await webhooks.registerWebhook(apiCtx(req), { url: b.url as string, events: (b.events ?? []) as webhooks.WebhookEvent[] });
        return { status: 201, body: r };
      });
      return send(reply, result);
    });
    v1.get('/webhooks', async (req, reply) => {
      requireScope(req, 'read');
      return reply.send({ data: await webhooks.listWebhooks(apiCtx(req)) });
    });
    v1.delete('/webhooks/:id', async (req, reply) => {
      requireScope(req, 'write');
      return reply.send(await webhooks.deleteWebhook(apiCtx(req), (req.params as { id: string }).id));
    });
    v1.get('/webhooks/:id/deliveries', async (req, reply) => {
      requireScope(req, 'read');
      const limit = clampLimit((req.query as { limit?: string }).limit);
      const cur = decodeCursor((req.query as { cursor?: string }).cursor);
      const fetched = await webhooks.listDeliveries(apiCtx(req), (req.params as { id: string }).id, { limit, cursor: cur });
      const { data, nextCursor } = page(fetched as Array<{ created_at: string; id: string }>, limit);
      return reply.send({ data, next_cursor: nextCursor });
    });
    v1.post('/webhooks/:id/deliveries/:deliveryId/replay', async (req, reply) => {
      requireScope(req, 'write');
      const p = req.params as { id: string; deliveryId: string };
      return reply.send(await webhooks.replayDelivery(apiCtx(req), p.id, p.deliveryId));
    });
  }, { prefix: '/v1' });
}
