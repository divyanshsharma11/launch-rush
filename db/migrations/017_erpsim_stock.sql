-- ERP simulator's own data: a separate schema, like paysim (013), so it behaves like an outside system:
-- our app code never reads it, only the simulator's HTTP API does (design §5.3).
CREATE SCHEMA erpsim;

CREATE TABLE erpsim.items (
  item_code text PRIMARY KEY                       -- one Item per game, item_code = games.id (§5.3)
);

CREATE TABLE erpsim.customers (
  name text PRIMARY KEY                            -- one seeded "Demo Customer" for every order (§5.3)
);

-- Available quantity per item. scope 'shop' = the shop; 'run:<uuid>' = one demo run's own quantity (§5.3, §5.5).
CREATE TABLE erpsim.item_stock (
  scope     text    NOT NULL,
  item_code text    NOT NULL REFERENCES erpsim.items (item_code),
  available integer NOT NULL,
  PRIMARY KEY (scope, item_code),
  CONSTRAINT item_stock_scope_valid
    CHECK (scope = 'shop' OR scope ~ '^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT item_stock_available_not_negative CHECK (available >= 0)
);

-- One-time copy of the catalog, like 012 seeds games. A game added later needs its own migration.
INSERT INTO erpsim.items (item_code) SELECT id FROM public.games;
INSERT INTO erpsim.item_stock (scope, item_code, available) SELECT 'shop', id, stock_total FROM public.games;
INSERT INTO erpsim.customers (name) VALUES ('Demo Customer');
