# Cost estimate

**Scenario:** 100 workspaces · ~10 connected accounts each · 30 *posts* per workspace per month.

**Workload assumption (stated, because it drives everything):** a "post" is composed once and fans out
to several accounts. Assume an average of **4 targets per post** → 100 × 30 × 4 = **~12,000 published
targets/month** (~400/day). Metric snapshots: ~2–15 per target over its 90-day life → the snapshot
table is the largest and fastest-growing row source. If instead every post fans to all 10 accounts,
multiply publish-side numbers by ~2.5.

## Infrastructure — monthly, order-of-magnitude

| Line item | What drives it | Est. / month | Notes |
|---|---|---|---|
| Postgres (managed, ~2 vCPU / 8 GB / 100 GB + PITR) | rows: `metric_snapshots`, `events`, `post_targets` | **$120–220** | the heart of the system; sized for IOPS + backups, not CPU |
| Workers (2× small containers) | publish + snapshot + webhook volume | $30–60 | scales with publishing, not workspaces |
| Web (2× small containers) | request traffic | $30–50 | light at this scale |
| Load balancer + egress | requests + media/webhook egress | $20–40 | |
| Object storage (media) | ~2–4 GB/month growth | $2–20 | R2 (zero egress) ≪ S3 here |
| Email (Resend) | notifications | $0–20 | free tier likely covers it |
| Logs / metrics retention | log volume | $0–50 | depends on retention window |
| **Infra subtotal** | | **~$250–460** | ≈ **$2.50–4.60 per workspace** |

At this scale infrastructure is **cheap and boring** — a few hundred dollars total. You could run 100
workspaces on a single small managed Postgres and two tiny worker/web pairs.

### Fastest-growing infra line: Postgres (specifically `metric_snapshots` + `events`)

Everything else is roughly flat or sub-linear; Postgres storage and IOPS grow with **published targets
× snapshot cadence × retention**. `metric_snapshots` is immutable and append-only (by design), and
`events` grows on every state change (publish, retry, webhook fan-out). This is the first thing you
resize as you add workspaces, and the reason the read models are live-query today with a documented
`metric_rollup_daily` path for when a workspace crosses ~10M snapshots.

## The line that breaks the model: X (Twitter) per-post API pricing

Infrastructure is not what breaks the unit economics — **X's write pricing is.**

- X charges the **app**, not the customer, and it is **capped by write volume**, not per-seat. At time
  of writing the tiers are roughly: Free ≈ 1,500 writes/month, **Basic ≈ $200/month for ~3,000
  writes/month**, **Pro ≈ $5,000/month** for the next tier, Enterprise negotiated. *(Treat these as
  configuration, not gospel — X changes them; the structural point below is what's durable.)*
- In this scenario, if each of the 100 workspaces posts its 30/month to a connected X account, that is
  **3,000 X writes/month — exactly the Basic ceiling ($200/mo).** One more workspace, or anyone posting
  more than once a day to X, pushes the whole app to the **$5,000/month Pro tier.**

**Why this breaks per-seat pricing:** at 200 workspaces you're paying **$5,000/month to X alone** —
**$25/workspace/month just for X writes**, before infra, before margin. You cannot sell a
$10–15/workspace plan and absorb that. The X line is:

- **super-linear in practice** (tier jumps, not smooth $/post),
- **decoupled from your revenue** (a customer paying you $10 can cost you $25 in X writes),
- and **the single largest cost** the moment X usage is non-trivial — it dwarfs the entire infra bill.

**Implications for pricing/product (not built — see WHAT IS NOT DONE):**
1. Meter X writes per workspace and either gate X behind a higher plan or pass the cost through
   explicitly (usage-based add-on).
2. Make X opt-in and surface "X posting uses paid API quota" in the UI.
3. Model each network's API cost as a **per-provider cost descriptor** (same pattern as capability
   descriptors) so the pricing engine reads costs from config, not hard-coded assumptions — X today,
   others tomorrow (Meta, LinkedIn are trending the same way).

Every other network in scope is effectively free to post to at this volume. X is the exception that
dictates the entire pricing strategy.
