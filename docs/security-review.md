# Security review — Phase 11

Findings, not assurances. Each item says what's actually in place, where, and what's still open.

## 1. Tenant isolation

**In place.** Every workspace-scoped table has RLS with `FORCE ROW LEVEL SECURITY` and a
`workspace_id = current_setting('app.workspace_id')` policy (`db/migrations/0004`). The app connects
as `meridian_app` (`NOSUPERUSER`, `NOBYPASSRLS`); a query run outside `withTenant` sees zero rows
(fail-closed). Cross-tenant reads return **404, not 403** — we never confirm a resource exists to an
outsider.

- Tests: `tenant-isolation.test.ts` proves reads are invisible **and** guards against passing for the
  wrong reason (asserts the role is non-superuser + a BYPASSRLS canary). Phase 11 added
  `hardening.test.ts` → **write** isolation (INSERT tagged with another workspace's id is rejected by
  `WITH CHECK`; UPDATE of a foreign row affects nothing). `public-api.test.ts` proves a key from
  workspace A gets 404 on workspace B.
- **Residual**: the maintenance/admin connection (workers) bypasses RLS by design for discovery scans.
  It is used for reads/claims only; every business write re-enters a tenant context. Worth an
  occasional audit that no new maintenance code writes tenant rows directly.

## 2. Secrets handling

**In place.** OAuth tokens and webhook signing secrets are AES-256-GCM (`src/vault/crypto.ts`) under a
**versioned keyring** with background re-encryption on rotation. API keys are stored as SHA-256 hashes;
the plaintext is shown once and never persisted. The keyring lives in the environment/secrets manager,
never in the DB — a DB dump alone decrypts nothing.

- **Residual / to verify**: there is no automated "grep the codebase/log stream for a token" test. The
  vault never logs plaintext, and adapters build auth headers inline, but this is a convention, not an
  enforced check. Recommend a log-scrubbing middleware + a test that a known token string never
  appears in a serialized response or audit row.

## 3. The OAuth callback

**In place.** State is single-use and bound to the workspace; PKCE `code_verifier` is carried through;
`connect.handleOAuthCallback` recovers the workspace from the state (the callback is authenticated but
not tenant-path-scoped). A replayed/invalid state is a `409 state_invalid_or_replayed`
(`connect-callback.test.ts`). Tokens returned from the exchange go straight into the vault.

- **Residual**: redirect URIs must be an exact allowlist per provider in production config (not
  validated here beyond what each provider enforces). Confirm the `OAUTH_REDIRECT_URI` is pinned and
  that open-redirect params aren't reflected.

## 4. Webhook signature verification (and egress)

**In place.** We sign `HMAC-SHA256(secret, "{t}.{body}")` and send `Meridian-Signature: t=…,v1=…`
(`src/webhooks/signing.ts`); the documented customer procedure rejects timestamps outside 300s
(replay) and constant-time compares. Tested in `public-api.test.ts` (valid verifies, altered body
fails, stale timestamp rejected).

**SSRF (Phase 11, `src/webhooks/ssrf.ts`).** Before connecting we resolve the host and reject loopback,
RFC1918, CGNAT, link-local **including `169.254.169.254`** (the cloud metadata endpoint), and IPv6
equivalents (`::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped `::ffff:`). We re-validate **after every
redirect**, cap redirects (3), response size (64 KB), and connection time (10 s), and cap per-endpoint
deliveries per tick (`ssrf.test.ts` covers a private-resolving URL and a redirect-to-private).

- **Residual (documented in the code)**: a TOCTOU DNS-rebind window remains between our lookup and the
  socket's own resolution. Closing it fully means pinning the connection to the validated IP via an
  undici `Agent` `lookup`. Until then, a determined attacker controlling low-TTL DNS could still race
  us. **This is the top remaining webhook hardening item.**

## 5. Rate limiting on auth endpoints

**In place.** `src/auth/rate-limit.ts` fixed-window limits in Postgres: login 10/min/IP + 5/15min/acct,
signup 5/h/IP, reset 3/h/acct, verify-resend 3/h, refresh 60/min/session. Enforced *before* the
password check (`auth/service.ts`), so failed attempts burn budget. Phase 11 added a test
(`hardening.test.ts`): the 6th account attempt is throttled even with a correct password.

- **Residual**: the window is fixed (not sliding), so an attacker can burst at each boundary. Adequate
  for credential-stuffing deterrence; not a substitute for account lockout/MFA on high-value accounts.

## 6. Personal data in logs

**Partial.** Fastify logs method/URL/status/reqId — no bodies by default. The publish path logs
`post_id/target_id/provider` (ids, not content). Emails appear in audit rows (by design, for the
trail).

- **Residual**: no formal PII classification or log-field allowlist. Provider error bodies stored in
  `last_error`/`response_body_snippet` could contain user content; they're capped (500 chars) but not
  scrubbed. Add a redaction pass before GA and document a log-retention window.

## 7. Dependency audit

`npm audit` at review time: **9 vulnerabilities (3 moderate, 5 high, 1 critical)** — all in
dependencies, none in our code, but real:

| package       | severity | issue                                                        | action |
|---------------|----------|--------------------------------------------------------------|--------|
| fastify ≤5.12 | high     | `X-Forwarded-Proto/Host` spoofing, content-type bypass, DoS  | upgrade to fastify 5 (breaking); until then don't trust `request.host/protocol` and set `trustProxy` explicitly |
| drizzle <0.45 | high     | SQL injection via improperly escaped **identifiers**         | upgrade. We only interpolate *values* as bound params (never identifiers), so not currently reachable — but pin the fix |
| find-my-way   | high     | HTTP/2 DDoS                                                  | transitive via fastify; resolved by the fastify upgrade |
| sharp <0.35   | high     | libvips CVEs                                                 | upgrade sharp; it's an optional dep (media variants) |
| esbuild       | moderate | dev-server request bug                                       | dev-only (tsx/vitest); not in the prod image |

**Action before GA**: schedule the fastify 5 + drizzle + sharp upgrades on a branch with the full
suite as the gate. None are exploitable in the current configuration *as written*, but "not currently
reachable" is not "fixed."

## 8. Stolen API key vs. stolen session

| | **Stolen API key** (`mrdn_live_…`) | **Stolen session** (access token) |
|---|---|---|
| Scope | ONE workspace; bounded by the key's `read`/`write` scopes | the **user's** identity across **all** their workspaces, at their role |
| Powers | call `/v1` (posts, media, analytics, webhooks) within scope | everything the user can do in the console incl. member management, connecting accounts, creating **more** API keys |
| Can it read tokens/secrets? | No — tokens never leave the vault; webhook secret shown once at creation | No plaintext tokens, but can *rotate* them / connect/disconnect accounts |
| Blast radius on connected accounts | can publish/schedule, cannot disconnect or re-auth | can disconnect, reconnect, change everything |
| Revocation | immediate — `revoked_at` re-checked every request (`public-api.test.ts`) | logout / logout-all invalidates sessions; refresh-token reuse triggers theft detection |
| Detection | per-key `last_used_at` + usage counter + rate limit | audit log of session actions; refresh-rotation reuse alarm |

**Verdict:** a stolen **session is strictly worse** — it's the human's full authority across every
workspace and can mint new API keys. An API key is the safer credential to hand to an integration:
single workspace, scoped, instantly revocable, individually observable. Recommendations: short session
lifetimes + refresh rotation (in place), and for keys — support expiry (`expires_at` column exists;
surface it in the console) and per-key IP allowlisting before GA.
