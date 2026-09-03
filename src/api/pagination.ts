// src/api/pagination.ts
// Cursor pagination (NOT offset): a cursor is an opaque base64 of the last row's (created_at, id).
// Keyset pagination on (created_at desc, id desc) is stable under inserts — offset would skip or
// repeat rows when new items arrive between pages. The cursor is deterministic and tamper-evident
// enough for its purpose (a bad cursor just 422s).
import { ApiError } from './errors';

export interface Cursor { createdAt: string; id: string }
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function encodeCursor(row: { created_at: string | Date; id: string }): string {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return Buffer.from(`${createdAt}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id) throw new Error('malformed');
    return { createdAt, id };
  } catch {
    throw new ApiError('validation_error', 'Invalid pagination cursor.');
  }
}

export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// Given limit+1 fetched rows, split into the page and the next cursor (null when no more).
export function page<T extends { created_at: string | Date; id: string }>(fetched: T[], limit: number): { data: T[]; nextCursor: string | null } {
  if (fetched.length <= limit) return { data: fetched, nextCursor: null };
  const data = fetched.slice(0, limit);
  return { data, nextCursor: encodeCursor(data[data.length - 1]) };
}
