// src/api/errors.ts
// One typed error for every API failure. The /v1 public API returns { error: { code, message,
// request_id } }; the console API returns Fastify/sensible's { statusCode, error, message } plus an
// x-request-id header we add server-side. We normalise BOTH into ApiError so every failure a user sees
// can quote a request id that appears in our logs.
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  // What we actually show a person: the message plus the id support can grep for.
  get displayMessage(): string {
    return this.requestId ? `${this.message} (ref: ${this.requestId})` : this.message;
  }
}

interface V1Envelope { error?: { code?: string; message?: string; request_id?: string } }
interface SensibleError { statusCode?: number; error?: string; message?: string }

export async function parseError(res: Response): Promise<ApiError> {
  const headerId = res.headers.get('x-request-id');
  let code = `http_${res.status}`;
  let message = res.statusText || 'Something went wrong.';
  try {
    const data = (await res.clone().json()) as V1Envelope & SensibleError;
    if (data?.error && typeof data.error === 'object') {
      const env = data.error as NonNullable<V1Envelope['error']>;
      return new ApiError(env.code ?? code, env.message ?? message, res.status, env.request_id ?? headerId);
    }
    if (data?.message) {
      message = data.message;
      code = (data.error ?? code).toLowerCase().replace(/\s+/g, '_');
    }
  } catch {
    /* non-JSON body — keep the status-based defaults */
  }
  return new ApiError(code, message, res.status, headerId);
}
