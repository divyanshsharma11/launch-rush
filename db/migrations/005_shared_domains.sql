-- One definition for rules used by several tables (order states: §2; currency codes: §4).
CREATE DOMAIN order_state AS text CONSTRAINT order_state_valid CHECK (VALUE IN (
  'reserved', 'payment_pending', 'paid', 'so_submitted', 'invoiced', 'completed',
  'waitlisted', 'waitlist_ended', 'reservation_expired', 'refund_pending', 'refunded', 'failed'));
CREATE DOMAIN currency_code AS text CONSTRAINT currency_code_valid CHECK (VALUE ~ '^[A-Z]{3}$');

ALTER TABLE orders DROP CONSTRAINT orders_state_check,    ALTER COLUMN state    TYPE order_state;
ALTER TABLE orders DROP CONSTRAINT orders_currency_check, ALTER COLUMN currency TYPE currency_code;
ALTER TABLE games  DROP CONSTRAINT games_currency_check,  ALTER COLUMN currency TYPE currency_code;
