-- One visitor's sandbox run (rush and/or faults); design-v1 §4, §5.5.
CREATE TABLE demo_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid        NOT NULL REFERENCES sessions (id),
  game_id          text        NOT NULL REFERENCES games (id),   -- the game the visitor picked (any listed game, checked by the API, §5.5)
  stock_total      integer     NOT NULL CHECK (stock_total >= 0),
  buyers_requested integer     NOT NULL CHECK (buyers_requested >= 0),
  faults           jsonb       NOT NULL DEFAULT '{}',
  status           text        NOT NULL CHECK (status IN ('running', 'finished', 'stopped')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz NOT NULL
);

-- One active run per session (§4, §5.5: 409 run_active).
CREATE UNIQUE INDEX demo_runs_one_running_per_session ON demo_runs (session_id) WHERE status = 'running';
