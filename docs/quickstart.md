# Meridian API — Quickstart

From an API key to a scheduled, multi-network post in a handful of copy-pasteable calls.

Base URL: `https://api.meridian.example/v1` &nbsp;•&nbsp; Spec: `GET /v1/openapi.json`

## 1. Get an API key

Create one in the console (Settings → Developers → API keys). It is shown **once**:

```
mrdn_live_9f3a1b2c_Xy8...        # store it in a secret manager; we only keep a hash
```

Send it as a Bearer token on every request. Keys have scopes — `read` and/or `write`:

```bash
export MRDN=mrdn_live_9f3a1b2c_Xy8...
alias api='curl -s -H "Authorization: Bearer $MRDN" -H "Content-Type: application/json"'
```

## 2. List the connected accounts you can post to

```bash
api https://api.meridian.example/v1/accounts
```

```json
{ "data": [
    { "id": "6b1e…", "provider": "bluesky", "handle": "acme.bsky.social", "status": "active" },
    { "id": "9c22…", "provider": "line",    "handle": "@acme",           "status": "active" }
  ],
  "next_cursor": null }
```

Pagination is **cursor-based**: pass `?cursor=<next_cursor>&limit=50` to get the next page. Never use offsets.

## 3. Create a post — one call, N independent targets

One create fans out to every account you list. The response is the post **and its per-target rows** —
each target publishes and is tracked **independently**. Treat each `target.state` on its own; a post is
never a single success/failure.

```bash
api -X POST https://api.meridian.example/v1/posts \
  -H "Idempotency-Key: post-launch-2026-01" \
  -d '{ "account_ids": ["6b1e…","9c22…"],
        "content": { "text": "We just shipped!", "link": "https://acme.example/blog" } }'
```

```json
{ "id": "d4…", "status": "draft",
  "targets": [
    { "id": "t1…", "account_id": "6b1e…", "provider": "bluesky", "state": "draft" },
    { "id": "t2…", "account_id": "9c22…", "provider": "line",    "state": "draft" }
  ] }
```

## 4. Schedule it

```bash
api -X POST https://api.meridian.example/v1/posts/d4…/schedule \
  -H "Idempotency-Key: schedule-launch-2026-01" \
  -d '{ "type": "fixed_instant", "scheduled_at": "2026-02-01T15:00:00Z" }'
```

Each target moves to `state: "scheduled"`. Poll `GET /v1/posts/d4…` (or use a webhook, below) to watch
each target go `scheduled → publishing → published`, or `failed` / `needs_review` on its own.

## Idempotency

Every write accepts an `Idempotency-Key` header. The **same key + same body** returns the original
response (so a retried "create post" never creates a second post). The **same key + a different body**
is `409 idempotency_conflict`. Records are retained **24 hours**, then the key is free to reuse.

## Errors

Every non-2xx uses one envelope. Switch on `code` (stable across versions); quote `request_id` to support.

```json
{ "error": { "code": "forbidden", "message": "This API key lacks the 'write' scope.", "request_id": "req-abc123" } }
```

Rate limiting returns `429 rate_limited` with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

## 5. Webhooks (recommended over polling)

Register an endpoint with a `write`-scoped key. The signing **secret is returned once**:

```bash
api -X POST https://api.meridian.example/v1/webhooks \
  -d '{ "url": "https://acme.example/hooks/meridian",
        "events": ["post_target.published","post_target.failed"] }'
# => { "id":"wh…", "url":"…", "events":[…], "secret":"whsec_…" }
```

Each delivery carries a signature header:

```
Meridian-Signature: t=1769950800,v1=6f1c…hexhmac…
```

### Verify every delivery (do this exactly)

1. Read `Meridian-Signature`; parse `t` (unix seconds) and `v1` (hex HMAC).
2. **Reject if `abs(now - t) > 300`** — this is your replay protection; a captured delivery replayed
   later fails here.
3. Compute `expected = HMAC_SHA256(secret, "{t}.{raw_request_body}")` as hex. Use the **raw body bytes**,
   not re-serialized JSON.
4. Constant-time compare `expected` with `v1`. Reject on mismatch.

```js
const crypto = require('crypto');
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(p => p.split('=')));
  if (Math.abs(Date.now()/1000 - Number(t)) > 300) return false;      // replay window
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### Delivery, retries, and the log

We retry failed deliveries with exponential backoff for **24 hours**. An endpoint that fails for the
full window is **automatically disabled**, with the reason recorded — see it (and every attempt) in the
delivery log:

```bash
api https://api.meridian.example/v1/webhooks/wh…/deliveries
```

Fixed your endpoint? Re-arm any delivery (this also re-enables a disabled endpoint):

```bash
api -X POST https://api.meridian.example/v1/webhooks/wh…/deliveries/<deliveryId>/replay
```
