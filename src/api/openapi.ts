// src/api/openapi.ts
// The OpenAPI 3.1 spec, ASSEMBLED IN CODE from the shared error/pagination/fan-out shapes so it can
// never drift from a hand-written doc file. Served at GET /v1/openapi.json.
import { WEBHOOK_EVENTS } from '../webhooks/service';
import { ALL_SCOPES } from './keys';

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'request_id'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable code; switch on this.' },
        message: { type: 'string' },
        request_id: { type: 'string', description: 'Also present in Meridian logs; quote it to support.' },
      },
    },
  },
} as const;

// The fan-out shape, made obvious in the very first example: one create -> N independently-tracked
// targets, each with its own id and state. A post is NEVER a single pass/fail unit.
const POST_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['draft', 'scheduled', 'published', 'partially_published', 'failed'] },
    content: { type: 'object' },
    targets: {
      type: 'array',
      description: 'One entry per connected account. Each publishes and is tracked INDEPENDENTLY.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          account_id: { type: 'string', format: 'uuid' },
          provider: { type: 'string' },
          state: { type: 'string', enum: ['draft', 'scheduled', 'publishing', 'published', 'failed', 'needs_review'] },
          provider_post_id: { type: 'string', nullable: true },
          permalink: { type: 'string', nullable: true },
          error: { type: 'object', nullable: true },
        },
      },
    },
  },
} as const;

const PAGE = (itemsRef: string) => ({
  type: 'object',
  properties: { data: { type: 'array', items: { $ref: itemsRef } }, next_cursor: { type: 'string', nullable: true } },
});

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description: 'Safe-retry key. Same key + same body replays the original response; same key + different body is 409. Retained 24h.',
};
const CURSOR_PARAM = { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from a prior response\'s next_cursor.' };
const LIMIT_PARAM = { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 25, maximum: 100 } };

const errorResponses = {
  '401': { description: 'unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '403': { description: 'forbidden (scope)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '404': { description: 'not_found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '409': { description: 'conflict / idempotency', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '422': { description: 'validation_error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '429': { description: 'rate_limited', headers: { 'Retry-After': { schema: { type: 'integer' } }, 'X-RateLimit-Limit': { schema: { type: 'integer' } }, 'X-RateLimit-Remaining': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};

const jsonBody = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const okJson = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });

export function buildOpenApiSpec(): unknown {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Meridian API',
      version: '1.0.0',
      description: 'Schedule posts across social networks. Authenticate with `Authorization: Bearer mrdn_live_…`. Every error uses one envelope; every write accepts an Idempotency-Key; lists use cursor pagination.',
    },
    servers: [{ url: '/v1' }],
    components: {
      securitySchemes: { ApiKey: { type: 'http', scheme: 'bearer', description: `Scopes: ${ALL_SCOPES.join(', ')}. GET needs read; writes need write.` } },
      schemas: { Error: ERROR_SCHEMA, Post: POST_SCHEMA, PostPage: PAGE('#/components/schemas/Post') },
    },
    security: [{ ApiKey: [] }],
    paths: {
      '/accounts': { get: { summary: 'List connected accounts', parameters: [CURSOR_PARAM, LIMIT_PARAM], responses: { '200': okJson({ type: 'object' }), ...errorResponses } } },
      '/posts': {
        get: { summary: 'List posts', parameters: [CURSOR_PARAM, LIMIT_PARAM], responses: { '200': okJson({ $ref: '#/components/schemas/PostPage' }), ...errorResponses } },
        post: {
          summary: 'Create a post fanned out to N accounts',
          description: 'Returns the post AND its per-account targets. Each target publishes independently — read target.state, not a single post-level success.',
          parameters: [IDEMPOTENCY_HEADER],
          requestBody: jsonBody({ type: 'object', required: ['account_ids'], properties: { account_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, content: { type: 'object', properties: { text: { type: 'string' }, link: { type: 'string' }, media: { type: 'array', items: { type: 'string' } } } } } }),
          responses: { '201': okJson({ $ref: '#/components/schemas/Post' }, 'Created'), ...errorResponses },
        },
      },
      '/posts/{id}': {
        get: { summary: 'Get a post with its targets', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': okJson({ $ref: '#/components/schemas/Post' }), ...errorResponses } },
        delete: { summary: 'Delete a draft post', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, IDEMPOTENCY_HEADER], responses: { '200': okJson({ type: 'object' }), ...errorResponses } },
      },
      '/posts/{id}/schedule': {
        post: { summary: 'Schedule a post (fixed instant, audience-local, or queued)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, IDEMPOTENCY_HEADER], requestBody: jsonBody({ type: 'object', properties: { type: { type: 'string', enum: ['fixed_instant', 'audience_local', 'queued'] }, scheduled_at: { type: 'string', format: 'date-time' }, local_time: { type: 'string' }, local_date: { type: 'string' } } }), responses: { '200': okJson({ $ref: '#/components/schemas/Post' }), ...errorResponses } },
      },
      '/media': {
        post: { summary: 'Presign a direct-to-storage media upload', parameters: [IDEMPOTENCY_HEADER], requestBody: jsonBody({ type: 'object', required: ['filename', 'content_type', 'byte_size'], properties: { filename: { type: 'string' }, content_type: { type: 'string' }, byte_size: { type: 'integer' } } }), responses: { '201': okJson({ type: 'object' }, 'Created'), ...errorResponses } },
      },
      '/analytics': { get: { summary: 'Dashboard read models for a date range', parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { '200': okJson({ type: 'object' }), ...errorResponses } },
      },
      '/analytics/exports': { post: { summary: 'Start a CSV export (background job)', parameters: [IDEMPOTENCY_HEADER], responses: { '202': okJson({ type: 'object' }, 'Accepted'), ...errorResponses } } },
      '/webhooks': {
        get: { summary: 'List webhook endpoints', responses: { '200': okJson({ type: 'object' }), ...errorResponses } },
        post: { summary: 'Register a webhook endpoint (secret returned once)', parameters: [IDEMPOTENCY_HEADER], requestBody: jsonBody({ type: 'object', required: ['url', 'events'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS] } } } }), responses: { '201': okJson({ type: 'object' }, 'Created'), ...errorResponses } },
      },
      '/webhooks/{id}': { delete: { summary: 'Delete a webhook endpoint', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': okJson({ type: 'object' }), ...errorResponses } } },
      '/webhooks/{id}/deliveries': { get: { summary: 'The delivery log for an endpoint', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, CURSOR_PARAM, LIMIT_PARAM], responses: { '200': okJson({ type: 'object' }), ...errorResponses } } },
      '/webhooks/{id}/deliveries/{deliveryId}/replay': { post: { summary: 'Manually replay a delivery', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': okJson({ type: 'object' }), ...errorResponses } } },
    },
  };
}
