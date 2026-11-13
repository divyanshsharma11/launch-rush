-- Clear names for the unnamed table CHECKs from 003 (errors then say which rule failed).
ALTER TABLE orders RENAME CONSTRAINT orders_check  TO orders_real_order_needs_session;
ALTER TABLE orders RENAME CONSTRAINT orders_check1 TO orders_simulated_needs_run;
ALTER TABLE orders RENAME CONSTRAINT orders_check2 TO orders_buyer_ref_iff_run;
