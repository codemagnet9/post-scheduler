// src/server.ts
import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { registerRoutes } from './api/routes';
import { registerPublicRoutes } from './api/public-routes';
import { ApiError, envelope } from './api/errors';
import './providers/adapters/index'; // register the network adapters at bootstrap
import { AuthError } from './auth/service';
import { WorkspaceError } from './workspaces/service';
import { ForbiddenError } from './authz/abilities';
import { RateLimitedError } from './auth/rate-limit';
import { ConnectError } from './accounts/connect';
import { DisconnectError } from './accounts/disconnect';
import { PostError } from './posts/service';
import { MediaError } from './media/service';
import { ApprovalError } from './approvals/service';
import { CommentError } from './comments/service';
import { initMediaBackends } from './media/bootstrap';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(sensible);

  // Map domain errors to HTTP. ForbiddenError => 403 (in-tenant denial); cross-tenant is already
  // a 404 from the tenant resolver, so it never reaches here.
  app.setErrorHandler((err, req, reply) => {
    // The public API's ApiError can also surface on the console key routes — keep the envelope.
    if (err instanceof ApiError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.status(err.httpStatus).send(envelope(err.code, err.message, req.id));
    }
    if (err instanceof ForbiddenError) return reply.forbidden(err.message);
    if (err instanceof RateLimitedError) {
      reply.header('Retry-After', String(err.retryAfterSec));
      return reply.tooManyRequests('rate_limited');
    }
    if (err instanceof AuthError) return reply.unauthorized(err.message);
    if (err instanceof WorkspaceError) return reply.badRequest(err.message);
    if (err instanceof DisconnectError) return reply.notFound(err.message);
    if (err instanceof ConnectError) {
      return err.message === 'state_invalid_or_replayed' ? reply.conflict(err.message) : reply.badRequest(err.message);
    }
    if (err instanceof PostError) {
      if (err.message === 'not_found') return reply.notFound(err.message);
      if (err.message === 'not_editable') return reply.conflict(err.message);
      return reply.badRequest(err.message);
    }
    if (err instanceof MediaError) {
      if (err.message === 'not_found') return reply.notFound(err.message);
      if (err.message === 'asset_in_use') return reply.conflict(err.message);
      return reply.badRequest(err.message);
    }
    if (err instanceof ApprovalError) {
      if (err.message === 'not_found') return reply.notFound(err.message);
      if (err.message === 'not_pending' || err.message === 'not_submittable') return reply.conflict(err.message);
      return reply.badRequest(err.message);
    }
    if (err instanceof CommentError) return err.message === 'not_found' ? reply.notFound(err.message) : reply.badRequest(err.message);
    return reply.send(err);
  });

  // Ops metrics (Prometheus text). Fleet-wide, so it needs the admin connection — imported LAZILY so
  // the web process still boots without admin creds unless this endpoint is actually configured+hit.
  // Gated by a shared ops token; unset or wrong => 404 (never reveal the endpoint exists).
  app.get('/internal/metrics', async (req, reply) => {
    const token = process.env.OPS_METRICS_TOKEN;
    if (!token || req.headers['x-ops-token'] !== token) return reply.callNotFound();
    try {
      const [{ maintenanceDb }, { collectMetrics, renderPrometheus }] = await Promise.all([import('./db/maintenance'), import('./obs/metrics')]);
      return reply.header('content-type', 'text/plain; version=0.0.4').send(renderPrometheus(await collectMetrics(maintenanceDb)));
    } catch (e) {
      req.log.error(e);
      return reply.internalServerError('metrics_unavailable');
    }
  });

  app.register(registerRoutes);
  app.register(registerPublicRoutes);
  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  initMediaBackends(); // storage + sharp/ffmpeg + ffprobe (fails fast if prod is on memory storage)
  const app = buildServer();
  app
    .listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
    .catch((e) => {
      app.log.error(e);
      process.exit(1);
    });
}
