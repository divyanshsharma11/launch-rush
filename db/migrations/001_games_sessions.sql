-- Shop catalog (luduscore ids) plus the fictional launch game; design-v1 §4.
CREATE TABLE games (
  id             text    PRIMARY KEY,   -- luduscore slug, or our own slug for the launch game
  title          text    NOT NULL,
  price_minor    integer NOT NULL CHECK (price_minor >= 0),
  currency       text    NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  stock_total    integer NOT NULL CHECK (stock_total >= 0),
  listed_in_shop boolean NOT NULL
);

-- Anonymous visitor; the id is sent as X-Session-Id (design-v1 §5.1).
CREATE TABLE sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
