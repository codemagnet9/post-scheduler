// src/providers/http.ts
// Low-level HTTP for adapters. DELIBERATELY does NOT expose an `ok` boolean or a success-implying
// `.json()` — several providers (notably Asian platform APIs, i.e. our regional differentiator)
// return HTTP 200 with an error IN THE BODY. An adapter MUST parse the body and decide success
// explicitly; there is no "the status was 2xx so it worked" escape hatch here.
export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export class HttpTimeout extends Error {
  constructor(public url: string) {
    super(`request timed out: ${url}`);
    this.name = 'HttpTimeout';
  }
}

export async function httpRequest(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  const { timeoutMs = 15000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new HttpTimeout(url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Parse a JSON body, or null if empty/unparseable. Adapters inspect the result for provider-level
// error fields BEFORE treating any response as success.
export function parseJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
