// src/auth/service.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { withUser, SYSTEM_USER_ID } from '../db/tenant';
import { hashPassword, verifyPassword } from './password';
import { generateOpaqueToken, hashToken, signAccessToken, verifyAccessToken } from './tokens';
import { enforce, LIMITS } from './rate-limit';
import { writeAudit } from '../audit/audit';

const SESSION_TTL_DAYS = 30;
const MIN_PASSWORD_LEN = 10;

export class AuthError extends Error {
  constructor(code: string) { super(code); this.name = 'AuthError'; }
}

export interface RequestMeta { ip?: string; userAgent?: string }
export interface TokenPair { accessToken: string; refreshToken: string; sessionId: string }

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

async function sendEmail(to: string, template: string, data: Record<string, unknown>): Promise<void> {
  // Real delivery is wired to the email provider in Phase 8. For now, hand off to logs.
  console.info(`[email:${template}] -> ${to}`, data);
}

async function auditAuthEvent(userId: string, e: { action: string; targetType?: string; targetId?: string; meta?: RequestMeta }): Promise<void> {
  await withUser(userId, (tx) =>
    writeAudit(tx, {
      workspaceId: null, actorUserId: userId === SYSTEM_USER_ID ? null : userId,
      action: e.action, targetType: e.targetType, targetId: e.targetId,
      ip: e.meta?.ip, userAgent: e.meta?.userAgent,
    }),
  ).catch(() => { /* auditing must never block auth */ });
}

// Exported for the OAuth path (src/auth/oauth.ts) to mint sessions after federated verification.
export async function createSession(userId: string, meta: RequestMeta): Promise<TokenPair> {
  const refresh = generateOpaqueToken();
  const r = rows<{ id: string }>(await db.execute(sql`
    insert into sessions (user_id, token_hash, ip, user_agent, expires_at)
    values (${userId}, ${hashToken(refresh)}, ${meta.ip ?? null}, ${meta.userAgent ?? null},
            now() + make_interval(days => ${SESSION_TTL_DAYS}))
    returning id
  `));
  const sessionId = r[0].id;
  return { accessToken: await signAccessToken({ sub: userId, sid: sessionId }), refreshToken: refresh, sessionId };
}

export async function signUp(input: { email: string; password: string; name?: string }, meta: RequestMeta) {
  if (meta.ip) await enforce(`signup:ip:${meta.ip}`, LIMITS.signup_ip);
  if (input.password.length < MIN_PASSWORD_LEN) throw new AuthError('password_too_short');
  const passwordHash = await hashPassword(input.password);
  const verifyToken = generateOpaqueToken();
  const userId = await db.transaction(async (tx) => {
    const existing = rows(await tx.execute(sql`select id from users where email = ${input.email}`));
    if (existing.length) throw new AuthError('email_taken');
    const u = rows<{ id: string }>(await tx.execute(sql`
      insert into users (email, password_hash, name) values (${input.email}, ${passwordHash}, ${input.name ?? null}) returning id
    `));
    await tx.execute(sql`
      insert into user_tokens (user_id, purpose, token_hash, expires_at)
      values (${u[0].id}, 'email_verification', ${hashToken(verifyToken)}, now() + interval '24 hours')
    `);
    return u[0].id;
  });
  await sendEmail(input.email, 'verify-email', { token: verifyToken });
  return { userId };
}

export async function verifyEmail(rawToken: string): Promise<void> {
  await db.transaction(async (tx) => {
    const r = rows<{ id: string; user_id: string }>(await tx.execute(sql`
      select id, user_id from user_tokens
      where token_hash = ${hashToken(rawToken)} and purpose = 'email_verification'
        and consumed_at is null and expires_at > now() for update
    `));
    if (!r.length) throw new AuthError('token_invalid');
    await tx.execute(sql`update users set email_verified_at = now() where id = ${r[0].user_id}`);
    await tx.execute(sql`update user_tokens set consumed_at = now() where id = ${r[0].id}`);
  });
}

export async function login(input: { email: string; password: string }, meta: RequestMeta): Promise<TokenPair> {
  if (meta.ip) await enforce(`login:ip:${meta.ip}`, LIMITS.login_ip);
  await enforce(`login:acct:${input.email.toLowerCase()}`, LIMITS.login_account);
  const r = rows<{ id: string; password_hash: string | null }>(
    await db.execute(sql`select id, password_hash from users where email = ${input.email}`),
  );
  const user = r[0];
  const ok = user?.password_hash ? await verifyPassword(user.password_hash, input.password) : false;
  if (!ok) {
    await auditAuthEvent(user?.id ?? SYSTEM_USER_ID, { action: 'auth.login_failed', meta });
    throw new AuthError('invalid_credentials');
  }
  const pair = await createSession(user.id, meta);
  await auditAuthEvent(user.id, { action: 'auth.login_success', targetType: 'session', targetId: pair.sessionId, meta });
  return pair;
}

// Rotating refresh with theft detection. DB work happens in one tx; auditing/throwing after commit.
export async function refresh(rawRefresh: string, meta: RequestMeta): Promise<TokenPair> {
  const h = hashToken(rawRefresh);
  const outcome = await db.transaction(async (tx): Promise<
    | { kind: 'ok'; pair: TokenPair }
    | { kind: 'reuse'; userId: string; sessionId: string }
    | { kind: 'invalid' }
  > => {
    const cur = rows<{ id: string; user_id: string }>(await tx.execute(sql`
      select id, user_id from sessions
      where token_hash = ${h} and revoked_at is null and expires_at > now() for update
    `));
    if (cur.length) {
      await enforce(`refresh:sid:${cur[0].id}`, LIMITS.refresh_session);
      const next = generateOpaqueToken();
      await tx.execute(sql`
        update sessions set previous_token_hash = token_hash, token_hash = ${hashToken(next)},
               rotated_at = now(), last_used_at = now() where id = ${cur[0].id}
      `);
      return {
        kind: 'ok',
        pair: { accessToken: await signAccessToken({ sub: cur[0].user_id, sid: cur[0].id }), refreshToken: next, sessionId: cur[0].id },
      };
    }
    // A previously-rotated token replayed => likely theft. Revoke the whole session.
    const reused = rows<{ id: string; user_id: string }>(await tx.execute(sql`
      select id, user_id from sessions where previous_token_hash = ${h} for update
    `));
    if (reused.length) {
      await tx.execute(sql`update sessions set revoked_at = now() where id = ${reused[0].id}`);
      return { kind: 'reuse', userId: reused[0].user_id, sessionId: reused[0].id };
    }
    return { kind: 'invalid' };
  });

  if (outcome.kind === 'ok') return outcome.pair;
  if (outcome.kind === 'reuse') {
    await auditAuthEvent(outcome.userId, { action: 'auth.refresh_reuse_detected', targetType: 'session', targetId: outcome.sessionId, meta });
    throw new AuthError('refresh_reuse_detected');
  }
  throw new AuthError('refresh_invalid');
}

export async function logout(sessionId: string): Promise<void> {
  await db.execute(sql`update sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`);
}

export async function logoutEverywhere(userId: string): Promise<void> {
  await db.execute(sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
}

export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<{ ok: true }> {
  if (meta.ip) await enforce(`reset:ip:${meta.ip}`, LIMITS.reset_ip);
  await enforce(`reset:acct:${email.toLowerCase()}`, LIMITS.reset_account);
  const r = rows<{ id: string }>(await db.execute(sql`select id from users where email = ${email}`));
  if (r.length) {
    const token = generateOpaqueToken();
    await db.execute(sql`
      insert into user_tokens (user_id, purpose, token_hash, expires_at)
      values (${r[0].id}, 'password_reset', ${hashToken(token)}, now() + interval '1 hour')
    `);
    await sendEmail(email, 'password-reset', { token });
  }
  return { ok: true }; // Always 200 — never reveal whether the account exists.
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LEN) throw new AuthError('password_too_short');
  const hash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const r = rows<{ id: string; user_id: string }>(await tx.execute(sql`
      select id, user_id from user_tokens
      where token_hash = ${hashToken(rawToken)} and purpose = 'password_reset'
        and consumed_at is null and expires_at > now() for update
    `));
    if (!r.length) throw new AuthError('token_invalid');
    await tx.execute(sql`update users set password_hash = ${hash} where id = ${r[0].user_id}`);
    await tx.execute(sql`update user_tokens set consumed_at = now() where id = ${r[0].id}`);
    // Reset invalidates every existing session (defends against an attacker who set the reset up).
    await tx.execute(sql`update sessions set revoked_at = now() where user_id = ${r[0].user_id} and revoked_at is null`);
  });
}

// Called by the API auth guard on every authenticated request. The session lookup makes
// logout-everywhere take effect immediately rather than waiting out the 15-min access TTL.
export async function authenticate(accessToken: string): Promise<{ userId: string; sessionId: string }> {
  const claims = await verifyAccessToken(accessToken);
  const r = rows(await db.execute(sql`
    select id from sessions where id = ${claims.sid} and revoked_at is null and expires_at > now()
  `));
  if (!r.length) throw new AuthError('session_revoked');
  return { userId: claims.sub, sessionId: claims.sid };
}
