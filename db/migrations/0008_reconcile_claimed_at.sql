-- db/migrations/0008_reconcile_claimed_at.sql
-- The instant a publish attempt started (state -> publishing). Used to bound the reconciliation
-- candidate set to posts created AT OR AFTER we tried to publish, so an OLDER identical post can
-- never be mistaken for the one we may have just lost. NOT reset by the lease sweeper, so it points
-- at the original attempt even after a reclaim.
ALTER TABLE post_targets ADD COLUMN claimed_at timestamptz;
