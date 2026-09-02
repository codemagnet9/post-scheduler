// src/server.ts
import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { registerRoutes } from './api/routes';
import './providers/adapters/index'; // register the network adapters at bootstrap
import { AuthError } from './auth/service';
import { WorkspaceError } from './workspaces/service';
import { ForbiddenError } from './authz/abilities';
import { RateLimitedError } from './auth/rate-limit';
import { ConnectError } from './accounts/connect';
import { DisconnectError } from './accounts/disconnect';
import { PostError } from './posts/service';
import { MediaError } from './media/service';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(sensible);

  // Map domain errors to HTTP. ForbiddenError => 403 (in-tenant denial); cross-tenant is already
  // a 404 from the tenant resolver, so it never reaches here.
  app.setErrorHandler((err, _req, reply) => {
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
    return reply.send(err);
  });

  app.register(registerRoutes);
  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  const app = buildServer();
  app
    .listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
    .catch((e) => {
      app.log.error(e);
      process.exit(1);
    });
}
