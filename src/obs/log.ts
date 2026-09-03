// src/obs/log.ts
// Minimal structured (JSON-line) logger for the worker/publish path, where there is no Fastify request
// logger. The CORRELATION KEY that follows a post from the API call to the provider response is the
// durable aggregate id — target_id (and its post_id) — because an HTTP request id does NOT survive the
// async hop through the job queue, but the target does. The API logs {request_id, post_id} at create
// (Fastify's reqId), and every publish-path line below carries {post_id, target_id, provider}; joining
// on post_id/target_id reconstructs the full trace: API call -> claim -> attempt -> provider result.
type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, msg: string, fields: LogFields): void {
  if (process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TEST) return; // keep the test output clean
  const line = JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f: LogFields = {}) => emit('debug', msg, f),
  info: (msg: string, f: LogFields = {}) => emit('info', msg, f),
  warn: (msg: string, f: LogFields = {}) => emit('warn', msg, f),
  error: (msg: string, f: LogFields = {}) => emit('error', msg, f),
};

// The publish-path event shape, so every stage logs the SAME correlation fields.
export interface PublishLogCtx { post_id: string; target_id: string; provider: string; attempt: number }
export const publishLog = (ctx: PublishLogCtx) => ({
  claimed: () => log.info('publish.claimed', { ...ctx, event: 'claimed' }),
  published: (providerPostId: string, latencyMs: number) => log.info('publish.published', { ...ctx, event: 'published', provider_post_id: providerPostId, latency_ms: latencyMs }),
  failed: (code: string, retryable: boolean) => log.warn('publish.failed', { ...ctx, event: 'failed', failure_code: code, retryable }),
  needsReview: () => log.warn('publish.needs_review', { ...ctx, event: 'needs_review' }),
});
