// src/auth/oauth.ts
import { sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from '../db/index';
import { createSession, type RequestMeta, type TokenPair, AuthError } from './service';

// We verify a provider-issued id_token that the client obtained via Sign in with Google/Apple.
// The provider's JWKS is fetched and cached by jose. Client IDs come from config.
//
// HONEST NOTES:
//  - Apple only returns the user's NAME on the FIRST authorization, and NOT inside the id_token —
//    the client must forward it separately; we persist it opportunistically.
//  - If you instead use the server-side authorization-code flow, Apple requires a client secret
//    that is itself an ES256 JWT signed with your Apple private key (config, not invented here).
//  - Apple emails may be a private-relay address; that is still a stable, deliverable email.

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

export interface OAuthProfile {
  provider: 'google' | 'apple';
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<OAuthProfile> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: requireEnv('GOOGLE_CLIENT_ID'),
  });
  return {
    provider: 'google',
    subject: payload.sub as string,
    email: (payload.email as string) ?? null,
    emailVerified: payload.email_verified === true,
    name: (payload.name as string) ?? null,
  };
}

export async function verifyAppleIdToken(idToken: string, forwardedName?: string): Promise<OAuthProfile> {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: 'https://appleid.apple.com',
    audience: requireEnv('APPLE_CLIENT_ID'),
  });
  return {
    provider: 'apple',
    subject: payload.sub as string,
    email: (payload.email as string) ?? null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: forwardedName ?? null,
  };
}

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

// Link strictly by (provider, subject). We deliberately do NOT auto-link to an existing password
// user by matching email — that is an account-takeover vector.
export async function signInWithOAuth(profile: OAuthProfile, meta: RequestMeta): Promise<TokenPair> {
  if (!profile.email) throw new AuthError('oauth_no_email');
  const userId = await db.transaction(async (tx) => {
    const existing = rows<{ user_id: string }>(await tx.execute(sql`
      select user_id from user_identities where provider = ${profile.provider} and provider_subject = ${profile.subject}
    `));
    if (existing.length) return existing[0].user_id;
    const verifiedAt = profile.emailVerified ? sql`now()` : sql`null`;
    const u = rows<{ id: string }>(await tx.execute(sql`
      insert into users (email, email_verified_at, name) values (${profile.email}, ${verifiedAt}, ${profile.name ?? null}) returning id
    `));
    await tx.execute(sql`
      insert into user_identities (user_id, provider, provider_subject, email)
      values (${u[0].id}, ${profile.provider}, ${profile.subject}, ${profile.email})
    `);
    return u[0].id;
  });
  return createSession(userId, meta);
}
