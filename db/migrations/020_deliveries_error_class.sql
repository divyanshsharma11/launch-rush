-- How the last failed attempt of a delivery was classified (design §7): the live stream tells the page that a step
-- "failed and will retry" (§8.3 delivery.retrying). Cleared when the next attempt starts. next_retry_at is set only
-- when the upstream named a time (rateLimited); BullMQ picks the delay of a plain retry after our code has returned.
ALTER TABLE deliveries
  ADD COLUMN error_class text,
  ADD CONSTRAINT deliveries_error_class_valid CHECK (error_class IN ('retryable', 'rateLimited', 'permanent'));
