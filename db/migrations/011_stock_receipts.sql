-- One shop restock: timer (§1.2) or admin refill (§5.4). Recorded before any copies are added (§1.2 step 1).
CREATE TABLE stock_receipts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),   -- the key for the ERP add and the Redis add (§1.2 steps 2-3)
  game_id          text        NOT NULL REFERENCES games (id),
  dedupe_key       text        NOT NULL,
  qty              integer     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  erp_applied_at   timestamptz,
  redis_applied_at timestamptz,
  CONSTRAINT stock_receipts_dedupe_key_unique UNIQUE (dedupe_key),       -- one timer receipt per game per window (§1.2)
  CONSTRAINT stock_receipts_dedupe_key_format CHECK (dedupe_key ~ '^(timer|admin):.+'),
  CONSTRAINT stock_receipts_qty_positive      CHECK (qty > 0),           -- a refill of 0 or less does nothing (§5.4)
  CONSTRAINT stock_receipts_erp_before_redis  CHECK (redis_applied_at IS NULL OR erp_applied_at IS NOT NULL)  -- §1.2 order
);

-- Each tick re-runs steps 2-5 for receipts not yet done (§1.2 crash safety); the reconciler counts them as in progress.
CREATE INDEX stock_receipts_pending ON stock_receipts (id) WHERE redis_applied_at IS NULL;
-- Scoreboard: starting stock + all receipts, per game (§1.2).
CREATE INDEX stock_receipts_game_id ON stock_receipts (game_id);
