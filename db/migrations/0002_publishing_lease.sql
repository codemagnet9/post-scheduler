-- db/migrations/0002_publishing_lease.sql
-- Fix: a worker killed mid-publish stranded the target in 'publishing' forever.
-- Add a lease + a reconcile detour so a sweeper can safely recover it.

-- ALTER TYPE ... ADD VALUE cannot run inside a txn block that also uses the value;
-- run this migration standalone (the runner does one file per txn, this file is enum-only + DDL).
ALTER TYPE target_state ADD VALUE IF NOT EXISTS 'reconciling' AFTER 'publishing';

ALTER TABLE post_targets
  ADD COLUMN lease_expires_at timestamptz,   -- set on claim; null unless in-flight
  ADD COLUMN claimed_by       text;          -- worker identity, for operator diagnosis

-- Sweeper index: mirror of post_targets_due_idx. Partial on "has an active lease", which is
-- exactly the in-flight rows (lease is set on claim, cleared on any terminal transition). This
-- covers BOTH 'publishing' and 'reconciling' — a stuck worker strands a reconciling row
-- identically — and, by not referencing the enum, keeps this migration free of the
-- "unsafe use of new enum value in the same transaction" hazard.
--   SELECT ... FROM post_targets
--   WHERE lease_expires_at <= now() AND state IN ('publishing','reconciling')
--   ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT :batch;
CREATE INDEX post_targets_lease_idx
  ON post_targets (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
