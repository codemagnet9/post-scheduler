// src/api/errors.ts
// The ONE error envelope for the public API. Every non-2xx from /v1 is:
//   { "error": { "code": "<stable_machine_code>", "message": "<human>", "request_id": "<reqId>" } }
// The code is contractual — customers switch on it and it never changes meaning across versions. The
// request_id is the Fastify reqId, which is also in our logs, so support can grep one string.
export type ApiErrorCode =
  | 'unauthorized'        // missing/invalid API key
  | 'forbidden'           // key lacks the scope for this operation
  | 'not_found'           // no such resource in this workspace (also masks cross-tenant)
  | 'validation_error'    // malformed request body/params
  | 'idempotency_conflict'// same Idempotency-Key, different body
  | 'idempotency_in_progress' // same key, original request still running
  | 'conflict'            // resource state conflict (e.g. not schedulable)
  | 'rate_limited'        // per-key rate limit exceeded
  | 'internal';           // unexpected

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 422,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: ApiErrorCode, message: string, readonly headers?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = STATUS[code];
  }
}

export function envelope(code: ApiErrorCode, message: string, requestId: string): { error: { code: ApiErrorCode; message: string; request_id: string } } {
  return { error: { code, message, request_id: requestId } };
}

export const httpStatusFor = (code: ApiErrorCode): number => STATUS[code];
