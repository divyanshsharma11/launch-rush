-- Indexes for queries the design defines (a FK does not create one; PG docs §5.5.5).
CREATE INDEX orders_run_id          ON orders (run_id);                -- run cleanup cascade, run summary (§4, §5.5)
CREATE INDEX orders_session_id      ON orders (session_id);            -- My orders, SSE per session (§5.1, §8.4, §8.5)
CREATE INDEX orders_hold_expiry     ON orders (reserved_until) WHERE state IN ('reserved', 'payment_pending');  -- sweeper (§1)
CREATE INDEX orders_wait_expiry     ON orders (waitlist_until) WHERE state = 'waitlisted';                      -- wait end (§1.1)
CREATE INDEX orders_email_purge     ON orders (email_saved_at) WHERE buyer_email IS NOT NULL;                   -- purge (§1)
CREATE INDEX order_transitions_paid ON order_transitions (order_id) WHERE to_state = 'paid';                 -- scoreboard "sold" (§1.2)
