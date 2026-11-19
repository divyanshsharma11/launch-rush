-- KEYS: stock, holds, waitlist, grants, receipts. ARGV: receiptId, qty.
-- One restock receipt (design §1.2 step 3). Copies go to the earliest waiters first, exactly as Release hands one on,
-- the rest to stock. Returns the order ids of the waiters that were handed a copy.
-- A receipt id that was applied before adds nothing.
if redis.call('SADD', KEYS[5], ARGV[1]) == 0 then return {} end

local handed = {}
local left = tonumber(ARGV[2])
while left > 0 do
  local waiter = redis.call('ZPOPMIN', KEYS[3])
  if #waiter == 0 then break end
  redis.call('HSET', KEYS[2], waiter[1], redis.call('INCR', KEYS[4]))
  handed[#handed + 1] = waiter[1]
  left = left - 1
end

if left > 0 then redis.call('INCRBY', KEYS[1], left) end
return handed
