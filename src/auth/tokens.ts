// src/auth/tokens.ts
import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ACCESS_TTL = '15m'; // short: logout-everywhere is immediate at refresh, and <=15m at access.

function secret(): Uint8Array {
  const s = process.env.ACCESS_TOKEN_SECRET;
  if (!s) throw new Error('ACCESS_TOKEN_SECRET required');
  return new TextEncoder().encode(s);
}

// High-entropy opaque tokens for refresh sessions / invites / verification / reset.
// Only the sha256 hash is ever stored; the raw value lives only in the cookie/email link.
export const generateOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export interface AccessClaims { sub: string; sid: string }

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret());
  return { sub: payload.sub as string, sid: payload.sid as string };
}
