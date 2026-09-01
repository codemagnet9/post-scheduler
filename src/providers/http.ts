// src/providers/http.ts
// Thin fetch wrapper with a timeout. Distinguishes a definite pre-send failure from a possible
// post-send loss: if the request is aborted by timeout AFTER bytes may have been sent, the caller
// decides whether that is AmbiguousFailure (publish) or provider_unavailable (idempotent reads).
export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

export class HttpTimeout extends Error {
  constructor(public url: string) {
    super(`request timed out: ${url}`);
    this.name = 'HttpTimeout';
  }
}

export async function httpRequest(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResponse> {
  const { timeoutMs = 15000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      json<T = unknown>(): T {
        return (text ? JSON.parse(text) : null) as T;
      },
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new HttpTimeout(url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
