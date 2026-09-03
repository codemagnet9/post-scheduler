// src/api/client.ts
// The access token lives in MEMORY only (a module variable) — never localStorage, so an XSS payload
// can't read it out of storage, and a page reload simply re-mints it from the httpOnly refresh cookie.
//
// SINGLE-FLIGHT REFRESH: ten requests all 401 at once, they all await ONE /auth/refresh, then retry.
// The same problem the server-side token vault solved (a herd of refreshers logging the user out) —
// here a shared in-flight promise collapses the herd to a single refresh.
import { ApiError, parseError } from './errors';

let accessToken: string | null = null;
let refreshInFlight: Promise<string> | null = null;
let onUnauthorized: (() => void) | null = null;

export const setAccessToken = (t: string | null): void => { accessToken = t; };
export const getAccessToken = (): string | null => accessToken;
// The AuthProvider registers this to raise the re-authentication overlay when a session truly expires.
export const setOnUnauthorized = (cb: (() => void) | null): void => { onUnauthorized = cb; };

async function raw(method: string, path: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(path, {
    method,
    headers,
    credentials: 'include', // send/receive the refresh cookie (same-origin via the dev proxy)
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Get a fresh access token from the refresh cookie. Shared so concurrent callers trigger ONE refresh.
export function refreshSession(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) { accessToken = null; throw await parseError(res); }
      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return data.accessToken;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

interface Options { body?: unknown; auth?: boolean }

export async function apiFetch<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  let res = await raw(method, path, opts.body, useAuth ? accessToken : null);

  if (res.status === 401 && useAuth) {
    try {
      const token = await refreshSession();     // the herd collapses here
      res = await raw(method, path, opts.body, token);
    } catch {
      onUnauthorized?.();
      throw await parseError(res);
    }
    if (res.status === 401) { onUnauthorized?.(); throw await parseError(res); }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

export const get = <T>(path: string, auth = true): Promise<T> => apiFetch<T>('GET', path, { auth });
export const post = <T>(path: string, body?: unknown, auth = true): Promise<T> => apiFetch<T>('POST', path, { body, auth });
export const patch = <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>('PATCH', path, { body });
export const put = <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>('PUT', path, { body });
export const del = <T>(path: string): Promise<T> => apiFetch<T>('DELETE', path, {});

export { ApiError };
